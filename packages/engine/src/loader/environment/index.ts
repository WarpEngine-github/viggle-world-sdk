import {
  ADDRESS_CLAMP_TO_EDGE,
  Asset,
  Entity,
  FILTER_NEAREST,
  PIXELFORMAT_R32F,
  Texture,
  Vec3,
} from 'playcanvas';
import type { GSplatComponent, GSplatData, Mat4 } from 'playcanvas';

type ParamTarget = { setParameter: (n: string, v: unknown) => void };

import type { GroundProbeParams, GroundProbeResult } from './ground-probe';
import { probeGround } from './ground-probe';
import type { Scene } from '../../scene';
import { SceneDestroyedError } from '../../scene';
import { bakeEnvRevealDistances, envRevealRadius } from '../../splat/env-reveal-bake';
import { DEFAULT_ENV_REVEAL_LOOK, packRevealLook } from '../../splat/reveal-look';
import type { RevealLook } from '../../splat/reveal-look';
import { ENV_WORK_BUFFER_MODIFIER_GLSL, ENV_WORK_BUFFER_MODIFIER_WGSL } from '../../splat/splat-shader';
import { Splat } from '../../splat/splat';
import { loadSplatAsset } from '../shared/asset-loader';
import { canRebuildStreams, dropCpuCopy, dropStreamCopies, rebuildStreams } from '../shared/texture-cpu-copy';
import { seedRelightDefaults } from '../../relight/relight-placeholder';

// Sentinel "no clip" value. Real ±Infinity would propagate as NaN through
// matrix multiplies inside the env modifier shader; a finite-but-very-large
// box has the same "always inside" behaviour in practice. Anything outside
// ±1e9 is well past anything a game world will ever place.
const CLIP_INF = 1e9;

// The same sentinel for the radial clip band, which compares squared
// distances so the shader needs no per-splat sqrt. 1e18 is still exact in the
// f32 a uniform carries.
const CLIP_DIST_INF_SQ = CLIP_INF * CLIP_INF;

// smoothstep(edge0, edge1, x) is undefined when edge0 == edge1 - never let a
// fade band reach zero width.
const MIN_CULL_FADE = 1e-3;

/** The slice of PC's gsplat component {@link Environment._installEnvModifier}
 *  touches. The component itself reaches us untyped; naming the one member
 *  used keeps the cast honest. */
interface EnvModifierTarget {
  setWorkBufferModifier: (source: { glsl: string; wgsl: string }) => void;
}

/** A file added with {@link Environment.attach}; `reveal` is its own distance texture. */
type EnvPart = { entity: Entity; asset: Asset; reveal: Texture | null };

/** What a reveal bake reads off a file: its CPU positions and texture size. */
type RevealSource = { xs: ArrayLike<number>; ys: ArrayLike<number>; zs: ArrayLike<number>; count: number; width: number; height: number };

/** Null when `asset` keeps no CPU positions (a streaming LOD bundle). */
function revealSource(asset: Asset): RevealSource | null {
  const resource = asset.resource as { gsplatData?: GSplatData; textureDimensions?: { x: number; y: number } } | null;
  const data = resource?.gsplatData;
  const dims = resource?.textureDimensions;
  const xs = data?.getProp('x');
  const ys = data?.getProp('y');
  const zs = data?.getProp('z');
  if (!data || !dims || !xs || !ys || !zs) return null;
  return { xs, ys, zs, count: data.numSplats, width: dims.x, height: dims.y };
}

/** The tint channel's neutral colour - see {@link Environment.setTint}. */
const WHITE_TINT = { r: 1, g: 1, b: 1 } as const;

/**
 * A strided sample of an environment's splat centres, with the per-splat alpha
 * of the SAME splats beside them. What {@link Environment.sampleWorldSample}
 * returns.
 *
 * The two arrays are index-aligned by construction - they come out of one loop -
 * and that is the whole reason this is a method rather than something a caller
 * assembles. Reaching `asset.resource.gsplatData.getProp('opacity')` is easy;
 * lining it up with a sample means re-deriving the stride, and a stride that
 * drifts out of step mislabels every splat with no error anywhere.
 *
 * @group Environment
 */
export interface WorldPointSample {
  /** `[x,y,z] * count`, world space. Empty when the resource carries no
   *  position data. */
  positions: Float32Array;
  /**
   * Per-splat ALPHA in `[0,1]`, one entry per point of {@link positions},
   * sigmoid of the stored logit. Null when the file carries no opacity
   * property; a caller with a threshold should then count every splat rather
   * than none.
   */
  alpha: Float32Array | null;
}

/**
 * Camera-occlusion cutaway parameters. Splats whose along-view distance from
 * `pos` (projected on `dir`) is below `maxT` AND whose world Y is above
 * `floorY` are faded to zero scale - walls between the camera and its target
 * vanish while the floor stays.
 *
 * @group Environment
 */
export interface EnvCameraCullParams {
  /** Camera world position. */
  pos: { x: number; y: number; z: number };
  /** Normalized camera view direction. */
  dir: { x: number; y: number; z: number };
  /** Cull splats with along-view t < maxT (metres from `pos`). */
  maxT: number;
  /** Splats below this world Y are kept regardless of t (floor gate). */
  floorY: number;
  /** Fade band width (metres) on the along-view boundary. */
  fadeAlong: number;
  /** Fade band width (metres) on the floor-gate boundary. */
  fadeFloor: number;
}

/** @group Environment */
export interface LoadEnvironmentOptions {
  /** Entity name. Default: basename of the URL. */
  name?: string;
  /** World position. Default: origin. */
  position?: { x: number; y: number; z: number };
  /** Euler angles in degrees. Default: no rotation. */
  rotation?: { x: number; y: number; z: number };
  /** Uniform scale. Default: 1. */
  scale?: number;
  /** Explicit filename for extension detection on URLs without one. */
  filename?: string;
  /** The reveal's radius in file units, used when > 0 instead of measuring this file. For a file
   *  that is part of a larger scene, the whole scene's radius, so parts attached later fall inside
   *  the sweep. */
  revealRadius?: number;
}

/** @group Environment */
export interface LoadLodBundleOptions {
  /** Entity name. Default: 'lod_environment'. */
  name?: string;
  /** World position. Default: origin. */
  position?: { x: number; y: number; z: number };
  /** Authored euler angles in degrees. The loader stacks the bundle's
   *  RDF→Y-up correction (+180° around X) on top - pass the same rotation
   *  you would give {@link Environment.load} for the monolithic splat. */
  rotation?: { x: number; y: number; z: number };
  /** Uniform scale. Default: 1. */
  scale?: number;
  /** Camera distance (world units) of the first LOD transition. Successive
   *  thresholds are `lodBaseDistance * lodMultiplier^(i-1)` for level i.
   *  Default: 8. */
  lodBaseDistance?: number;
  /** Geometric ratio between successive LOD distance thresholds. Default: 3. */
  lodMultiplier?: number;
  /** Max ms the LOD range stays pinned to the coarsest level waiting for it
   *  to stream in (guards a stalled stream). Counted from the first rendered
   *  frame, not from load - see _openLodRangeWhenCoarseReady. Default: 8000. */
  coarseTimeoutMs?: number;
}

/**
 * Gaussian-splat environment loaded into a scene.
 *
 * Unlike the low-level `loadSplatAsset` + manual `addComponent` flow,
 * `Environment.load` installs the engine's environment work-buffer modifier:
 * render clip bounds, the camera cutaway, and relighting. An environment
 * keeps its baked colours until a {@link SplatRelight} lights it - add it as a
 * target and give it strength 0 and shadow strength 1, and the capture keeps
 * its own lighting and darkens only where a character blocks the light.
 *
 * Construct via {@link Environment.load} - the constructor is internal.
 *
 * @group Environment
 */
export class Environment {
  readonly entity: Entity;
  readonly asset: Asset;
  private _scene: Scene;
  private _clipMin = new Vec3(-CLIP_INF, -CLIP_INF, -CLIP_INF);
  private _clipMax = new Vec3( CLIP_INF,  CLIP_INF,  CLIP_INF);
  private _clipMinArr: [number, number, number] = [-CLIP_INF, -CLIP_INF, -CLIP_INF];
  private _clipMaxArr: [number, number, number] = [ CLIP_INF,  CLIP_INF,  CLIP_INF];
  private _clipDistMin = 0;
  private _clipDistMax = Infinity;
  private _clipDistOrigin = new Vec3(0, 0, 0);
  private _splatSizeMax = Infinity;
  private _clipDistOriginArr: [number, number, number] = [0, 0, 0];
  private _cullPosArr: [number, number, number] = [0, 0, 0];
  private _cullDirArr: [number, number, number] = [0, 0, 1];
  private _cullFadeArr: [number, number] = [MIN_CULL_FADE, MIN_CULL_FADE];
  private _tintArr: [number, number, number, number] = [1, 1, 1, 0];
  /** The reveal's local radius: this file's p98, measured once, unless seeded by
   *  `revealRadius`. `null` until something asks; `0` when there is nothing to
   *  measure. See {@link prepareReveal}. */
  private _radiusLocal: number | null = null;
  private _revealEnabled = false;
  private _revealBaked = false;
  /** The sweep's front, and whether it is read inverted - see
   *  {@link setReveal}. Kept here rather than pushed straight at the
   *  component so {@link _pushRevealUniforms} can seed BOTH on the frame the
   *  reveal is compiled in: WebGPU rejects a draw with an unbound uniform. */
  private _revealAmount = 1;
  private _revealInverse = 0;
  private _revealDistanceTexture: Texture | null = null;
  private _revealBand = new Float32Array(4);
  private _revealSketch = new Float32Array(4);
  private _revealTint = new Float32Array(4);
  private _dirtyOnly: Set<unknown> | null = null;
  /** Files added after this one (`attach`), drawn with it under its transform. `reveal` is
   *  the part's own distance texture, baked against this file's radius so one front sweeps both. */
  private _parts: EnvPart[] = [];
  private _sampleRevision = 0;
  private _cullMaxT = -CLIP_INF;
  private _cullFloorY = CLIP_INF;
  private _restoreListening = false;
  private _destroyed = false;

  private constructor(scene: Scene, entity: Entity, asset: Asset) {
    this._scene = scene;
    this.entity = entity;
    this.asset = asset;
    packRevealLook(DEFAULT_ENV_REVEAL_LOOK, this._revealBand, this._revealSketch, this._revealTint);
    this._pushClipUniforms();
    this._pushClipDistanceUniforms();
    this._pushSplatSizeUniform();
    // Seeded, not left to default: a uniform PC never saw a value for reads
    // as whatever the backend zero-fills, and `tint.a` is the one component
    // whose zero has to be guaranteed for an untinted capture to look
    // untouched.
    this.setTint(0);
    this.setCameraCull(null);
    // The textures are uploaded by now; keep only `gsplatData` and rebuild from it on a restore.
    if (dropStreamCopies(asset.resource)) {
      scene.graphicsDevice.on('devicerestored', this._onDeviceRestored, this);
      this._restoreListening = true;
    }
  }

  /** This file's gsplat and every attached part's: the uniforms they share. */
  private _gsplats<T = ParamTarget>(): T[] {
    const out: T[] = [];
    for (const e of [this.entity, ...this._parts.map((p) => p.entity)]) {
      const gsplat = (e as unknown as { gsplat?: T }).gsplat;
      if (gsplat) out.push(gsplat);
    }
    return out;
  }

  /** How many files `attach` has added. */
  get partCount(): number { return this._parts.length; }

  /** Draws the first `n` attached files and hides the rest; samples still include them all. */
  setVisibleParts(n: number): void {
    this._parts.forEach((part, i) => { part.entity.enabled = i < n; });
    this._markDirty();
  }

  /** Bumped when the splats a sample can see change (`attach`). */
  get sampleRevision(): number { return this._sampleRevision; }

  /**
   * Add another file under this one's transform (a split scene's chunk). It shares clip, cull,
   * tint, size limit and the reveal, baked against this file's radius so it can land mid-sweep.
   * Samples include it from here on. A no-op once destroyed.
   */
  async attach(url: string, opts?: { filename?: string }): Promise<void> {
    const asset = await loadSplatAsset(this._scene.app, url, opts?.filename);
    // app.destroy has already unloaded every registered asset and nulled the registry.
    if (this._scene.destroyed) return;
    if (this._destroyed) {
      this._scene.app.assets.remove(asset);
      asset.unload();
      return;
    }
    const entity = new Entity(`${this.entity.name}_part${this._parts.length + 1}`, this._scene.app);
    entity.addComponent('gsplat', { asset });
    entity.gsplat!.layers = [this._scene.envLayerId];
    Environment._initEnvGsplat(this._scene, entity.gsplat!);
    this.entity.addChild(entity);
    const part: EnvPart = { entity, asset, reveal: null };
    this._parts.push(part);
    this._bakePartReveal(part);
    if (dropStreamCopies(asset.resource) && !this._restoreListening) {
      this._scene.graphicsDevice.on('devicerestored', this._onDeviceRestored, this);
      this._restoreListening = true;
    }
    this._dirtyOnly = null;
    this._sampleRevision++;
    // Seeded before its first draw, at wherever the front is now.
    if (part.reveal) this._pushRevealUniforms();
    this._pushClipUniforms();
    this._pushClipDistanceUniforms();
    this._pushSplatSizeUniform();
    this._pushCullUniforms();
    for (const gsplat of this._gsplats()) gsplat.setParameter('uEnvTint', this._tintArr);
    this._markDirty();
  }

  /**
   * A strided sample of the splat means in **world space** (the entity's
   * rotation, position and scale applied), packed as xyz triples, with each
   * sampled splat's alpha beside it.
   *
   * At most `count` points, evenly strided over this file and its attached parts
   * so the sample keeps their spatial distribution. Nothing is cached, so call it once
   * and keep the result.
   *
   * The two consumers want very different counts, and both are right. Camera
   * placement and a metric-scale estimate are percentile work, which does not
   * improve with more points - 20,000 is plenty. The voxel collider's answer is
   * a function of DENSITY, so it wants ten times that; see
   * `COLLIDER_SAMPLE_POINTS`. Nothing here decides for them.
   *
   * ALPHA, NOT THE STORED LOGIT. Every container we load keeps the 3DGS logit
   * (`spz-js` applies `invSigmoid` on `.spz`, a `.ply` carries the raw field),
   * and a threshold in `[0,1]` is the only one a caller can reason about, so the
   * sigmoid happens here, once. `alpha` is null when the file has no opacity
   * property at all.
   *
   * Returns empty arrays when the resource carries no CPU-side position data,
   * which is what a streaming LOD bundle looks like: its chunks are loaded
   * `minimalMemory` and keep none.
   */
  sampleWorldSample(count = 20_000): WorldPointSample {
    const sources: { data: GSplatData; world: Mat4 }[] = [];
    for (const [asset, entity] of [[this.asset, this.entity], ...this._parts.map((p) => [p.asset, p.entity] as const)] as const) {
      const data = (asset.resource as { gsplatData?: GSplatData } | null)?.gsplatData;
      if (data?.getProp('x') && data.getProp('y') && data.getProp('z')) sources.push({ data, world: entity.getWorldTransform() });
    }
    const total = sources.reduce((n, src) => n + src.data.numSplats, 0);
    if (sources.length === 0 || total === 0) return { positions: new Float32Array(0), alpha: null };
    const stride = Math.max(1, Math.floor(total / Math.max(1, count)));
    const m = sources.reduce((n, src) => n + Math.floor(src.data.numSplats / stride), 0);
    const out = new Float32Array(m * 3);
    const hasAlpha = !!sources[0]!.data.getProp('opacity');
    const alpha = hasAlpha ? new Float32Array(m) : null;
    const p = new Vec3();
    let j = 0;
    for (const { data, world } of sources) {
      const xs = data.getProp('x')!, ys = data.getProp('y')!, zs = data.getProp('z')!;
      const os = data.getProp('opacity');
      const ms = Math.floor(data.numSplats / stride);
      for (let i = 0; i < ms; i++, j++) {
        const k = i * stride;
        p.set(xs[k], ys[k], zs[k]);
        world.transformPoint(p, p);
        out[j * 3] = p.x; out[j * 3 + 1] = p.y; out[j * 3 + 2] = p.z;
        if (alpha) alpha[j] = os ? 1 / (1 + Math.exp(-os[k])) : 1;
      }
    }
    return { positions: out, alpha };
  }

  /**
   * What a character standing at the capture point would have under their
   * feet, in the FILE's own units - see `ground-probe.ts` for the method.
   *
   * ON THIS CLASS AND NOT ON A CALLER, because it needs the WHOLE cloud. The
   * probe gathers a cylinder 5% of the floor depth wide and waits for five
   * splats' worth of opacity to accumulate inside it; over a 20,000-point
   * sample of a million-splat scene that cylinder holds one or two, and
   * nothing ever commits. `gsplatData` is right here and strided access to it
   * is what {@link sampleWorldSample} exists to stop callers from doing. It reads
   * this file alone, so for a split scene it measures the view file.
   *
   * UNTRANSFORMED, which is the other reason. Metres-per-unit is derived from
   * this depth, and the entity's scale is derived from metres-per-unit, so a
   * depth measured in world units would be measured through the answer.
   *
   * `downSign` has no default on purpose: +1 where the file is Y-down and -1
   * where it is +Y up, and the provider has written both. A probe pointed the
   * wrong way reports the sky as a floor without failing.
   */
  probeGroundDepth(downSign: 1 | -1, params?: GroundProbeParams): GroundProbeResult | null {
    const data = (this.asset.resource as { gsplatData?: GSplatData } | null)?.gsplatData;
    const x = data?.getProp('x');
    const y = data?.getProp('y');
    const z = data?.getProp('z');
    const opacity = data?.getProp('opacity');
    if (!data || !x || !y || !z || !opacity) return null;
    return probeGround({ count: data.numSplats, x, y, z, opacity }, downSign, params);
  }

  /**
   * {@link Environment.sampleWorldSample}'s positions alone, for a consumer that
   * has no use for the alpha. One traversal either way - this is a delegate, not
   * a second sampler.
   */
  sampleWorldPoints(count = 20_000): Float32Array {
    return this.sampleWorldSample(count).positions;
  }

  /**
   * Lower world-space corner of the render clip box. Splats whose center
   * (after `matrix_model`) is below `clipBoundsMin` on any axis are
   * collapsed to zero scale by the env work-buffer modifier and contribute
   * no pixels. ±Infinity is normalised to a finite sentinel (≈1e9) so the
   * shader math stays well-defined.
   *
   * Default: -Infinity on every axis (no clipping).
   */
  get clipBoundsMin(): Vec3 { return this._clipMin; }
  /** Upper world-space corner of the render clip box. See {@link clipBoundsMin}. */
  get clipBoundsMax(): Vec3 { return this._clipMax; }

  /**
   * Set both clip corners at once. ±Infinity is accepted and normalised to
   * the finite sentinel internally.
   */
  setClipBounds(min: Vec3, max: Vec3): void {
    this._clipMin.copy(min);
    this._clipMax.copy(max);
    this._pushClipUniforms();
  }

  /**
   * Convenience: shortcut for the common "clip everything above world-Y = `y`"
   * case (sky/ceiling removal). Lower bound stays at -Infinity.
   */
  setClipMaxY(y: number): void {
    this._clipMax.y = y;
    this._pushClipUniforms();
  }

  /**
   * Inner radius of the radial clip band, in world units, measured from
   * {@link clipDistanceOrigin}. Default `0`: no near cull.
   */
  get clipDistanceMin(): number { return this._clipDistMin; }
  /**
   * Outer radius of the radial clip band. Default `Infinity`: no far cull.
   * See {@link clipDistanceMin}.
   */
  get clipDistanceMax(): number { return this._clipDistMax; }
  /**
   * The point the radial clip band is measured from. Default: the world
   * origin. See {@link setClipDistanceOrigin}.
   */
  get clipDistanceOrigin(): Vec3 { return this._clipDistOrigin; }

  /**
   * Keep only the splats whose center lies in the spherical shell
   * `[min, max)` around {@link clipDistanceOrigin}. Anything nearer than
   * `min`, or at or beyond `max`, is collapsed to zero scale by the env
   * work-buffer modifier and contributes no pixels.
   *
   * The radial sibling of {@link setClipBounds}, for the shapes an
   * axis-aligned box cannot express: peeling a capture into depth layers
   * around a viewpoint, a dome of sky past some radius, a bubble of interior
   * around the player. It composes with the clip box rather than replacing it -
   * a splat has to survive both.
   *
   * The band is HALF-OPEN on purpose. Successive bands (`[0, 1)`, `[1, 2)`,
   * ...) then tile the scene with every splat in exactly one of them, which is
   * what slicing a capture into layers needs; a closed upper bound would draw
   * the splats sitting on a seam into two layers.
   *
   * Degenerate cases:
   *  - the default (`0`, `Infinity`) clips nothing, and `setClipDistance(0)`
   *    puts it back there;
   *  - `min` and `max` are clamped at `0`, since a negative radius means
   *    nothing;
   *  - `max <= min` is an EMPTY band and renders nothing. That is the honest
   *    reading of the interval, not an error;
   *  - `Infinity` for `max` is normalised to a finite sentinel, for the reason
   *    {@link clipBoundsMin} gives: real infinity reaches the shader as a NaN
   *    the moment it meets a subtraction.
   *
   * NOTE: pushing uniforms alone does not re-render an env work buffer
   * (env splats use `WORKBUFFER_UPDATE_AUTO`), the same caveat
   * {@link setCameraCull} carries. A caller that changes the band per frame
   * must follow up with `Splat.markEnvWorkBuffersDirty()`.
   */
  setClipDistance(min: number, max = Infinity): void {
    this._clipDistMin = Math.max(0, min);
    this._clipDistMax = Math.max(0, max);
    this._pushClipDistanceUniforms();
  }

  /** Size cap set by {@link setSplatSizeMax}. Default `Infinity`. */
  get splatSizeMax(): number { return this._splatSizeMax; }

  /**
   * Clamp every splat axis to `max`, in the splat file's own units (divide a
   * world size by the entity's scale); for ortho, which draws perspective-sized
   * scenery at full size. Per axis, so a long thin splat keeps its width and
   * covers more than an evenly shrunk one. `Infinity` leaves every splat alone.
   * Same re-render caveat as {@link setClipDistance}.
   */
  setSplatSizeMax(max: number): void {
    this._splatSizeMax = Math.max(0, max);
    this._pushSplatSizeUniform();
  }

  /**
   * Set the world-space point {@link setClipDistance} measures from. Defaults
   * to the world origin; pass the camera or player position for a band that
   * follows the viewer. Carries the same re-render caveat as
   * {@link setClipDistance}.
   */
  setClipDistanceOrigin(origin: Vec3): void {
    this._clipDistOrigin.copy(origin);
    this._pushClipDistanceUniforms();
  }

  /**
   * Set (or clear, with `null`) the camera-occlusion cutaway. `null` pushes
   * the -CLIP_INF sentinel on `maxT`, which saturates the shader's along-view
   * fade to "keep" for every real-world splat.
   *
   * NOTE: pushing uniforms alone does not re-render an env work buffer
   * (env splats use WORKBUFFER_UPDATE_AUTO). Per-frame callers must follow up
   * with `Splat.markEnvWorkBuffersDirty()`.
   */
  setCameraCull(params: EnvCameraCullParams | null): void {
    let maxT = -CLIP_INF;
    let floorY = CLIP_INF;
    if (params) {
      this._cullPosArr[0] = params.pos.x;
      this._cullPosArr[1] = params.pos.y;
      this._cullPosArr[2] = params.pos.z;
      this._cullDirArr[0] = params.dir.x;
      this._cullDirArr[1] = params.dir.y;
      this._cullDirArr[2] = params.dir.z;
      maxT = params.maxT;
      floorY = params.floorY;
      this._cullFadeArr[0] = Math.max(params.fadeAlong, MIN_CULL_FADE);
      this._cullFadeArr[1] = Math.max(params.fadeFloor, MIN_CULL_FADE);
    }
    this._cullMaxT = maxT;
    this._cullFloorY = floorY;
    this._pushCullUniforms();
  }

  private _pushCullUniforms(): void {
    for (const gsplat of this._gsplats()) {
      gsplat.setParameter('uCamCullPos', this._cullPosArr);
      gsplat.setParameter('uCamCullDir', this._cullDirArr);
      gsplat.setParameter('uCamCullMaxT', this._cullMaxT);
      gsplat.setParameter('uCamCullFloorY', this._cullFloorY);
      gsplat.setParameter('uCamCullFade', this._cullFadeArr);
    }
    this._scene.app.renderNextFrame = true;
  }

  /**
   * Set the capture-wide tint. `intensity` is the blend factor (0 = leave the
   * capture's colours untouched, 1 = fully replace with `color`); `color`
   * defaults to white, so the single-argument form is the "lift towards
   * white" channel a selection flash wants. The shader does
   * `mix(splatRgb, tint.rgb, tint.a)` per fragment.
   *
   * The same signature and the same blend as `Splat.setTint`, because the two
   * are one effect seen on two subjects and a caller lifting a scene should
   * not have to learn a second shape. Unlike the character's, this one marks
   * the work buffer dirty itself: an env splat renders its work buffer on
   * PC's AUTO schedule, which pushed uniforms alone do not trip (the caveat
   * {@link setClipDistance} spells out), and a tint driven per frame would
   * otherwise never reach the screen.
   */
  setTint(
    intensity: number,
    color: { r: number; g: number; b: number } = WHITE_TINT,
  ): void {
    this._tintArr[0] = color.r;
    this._tintArr[1] = color.g;
    this._tintArr[2] = color.b;
    this._tintArr[3] = intensity;
    for (const gsplat of this._gsplats()) gsplat.setParameter('uEnvTint', this._tintArr);
    this._markDirty();
  }

  /**
   * Bake the per-splat reveal distances and compile the reveal in, so the
   * first frame of a sweep does not pay for either. Returns whether the bake
   * landed: `false` means this environment cannot reveal and
   * {@link setReveal} will do nothing, so a caller should show it outright.
   *
   * The case that returns false in practice is the one
   * {@link sampleWorldSample} documents: a streaming LOD bundle holds no
   * CPU-side positions (its chunks load `minimalMemory` and keep none), so
   * there is nothing to measure a radius from. Revealing it anyway would
   * sweep a texture of 1s, which is a scene that stays invisible until the
   * sweep ends and then appears all at once - worse than no reveal at all.
   */
  prepareReveal(): boolean {
    if (this._revealBaked) return true;
    const src = revealSource(this.asset);
    // Measured BEFORE anything is allocated, so a cloud with no radius to
    // normalise against - every splat sitting on the capture point - pays for
    // neither the texture nor the recompile.
    if (!src || !(this._measureRadius() > 0)) return false;

    this._enableReveal(src.width, src.height);
    const texture = this._revealDistanceTexture;
    if (!texture || !this._bakeReveal(texture, src)) return false;
    this._revealBaked = true;
    for (const part of this._parts) this._bakePartReveal(part);
    this._pushRevealUniforms();
    return true;
  }

  /** Bake `src`'s distances against this file's radius into `texture`, in place. */
  private _bakeReveal(texture: Texture, src: RevealSource): boolean {
    const ok = bakeEnvRevealDistances(texture.lock() as Float32Array, src.xs, src.ys, src.zs, src.count, this._measureRadius());
    texture.unlock();
    if (ok) dropCpuCopy(texture);
    return ok;
  }

  /** A part's reveal distances, against this file's radius. No-op until this file has baked. */
  private _bakePartReveal(part: EnvPart): void {
    if (!this._revealBaked || part.reveal) return;
    const src = revealSource(part.asset);
    const gsplat = (part.entity as unknown as { gsplat?: EnvModifierTarget }).gsplat;
    if (!src || !gsplat) return;
    const texture = this._newRevealTexture(src.width, src.height);
    if (!this._bakeReveal(texture, src)) {
      texture.destroy();
      return;
    }
    part.reveal = texture;
    Environment._installEnvModifier(gsplat, true);
  }

  private _newRevealTexture(width: number, height: number): Texture {
    return new Texture(this._scene.graphicsDevice, {
      name: 'envRevealDistance',
      width,
      height,
      format: PIXELFORMAT_R32F,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
  }

  /** A restored WebGL context re-uploads textures from CPU copies that load
   *  dropped, so refill them from the splat data (WebGPU fires no event). */
  private _onDeviceRestored(): void {
    for (const resource of [this.asset.resource, ...this._parts.map((p) => p.asset.resource)]) {
      if (canRebuildStreams(resource)) rebuildStreams(resource);
    }
    if (!this._revealBaked) return;
    const targets = [[this._revealDistanceTexture, this.asset] as const, ...this._parts.map((p) => [p.reveal, p.asset] as const)];
    for (const [texture, asset] of targets) {
      const src = revealSource(asset);
      if (texture && src) this._bakeReveal(texture, src);
    }
    this._pushRevealUniforms();
  }

  /**
   * Reveal amount in `[0, 1]`. At 1 (the default) the capture renders
   * unchanged. Below 1 a bright front walks OUTWARD from the capture point,
   * with sparse dots just ahead of it; at 0 the scene is invisible.
   *
   * Radial distance, not height and not depth from the camera, because that
   * is the order a Flow2D capture was reconstructed in: the room assembles
   * the way it was built, near surfaces first and the far wall last. Ground-up
   * would read as a curtain on a subject the viewer is standing inside, and
   * camera-relative would re-sweep itself every time the camera moved.
   *
   * The first call below 1 opts the scene in: it bakes the per-splat
   * distances and recompiles the work-buffer shader, which costs a frame on a
   * large capture. Call {@link prepareReveal} on load to pay that up front. A
   * scene that never reveals pays nothing - no texture, no samplers, and none
   * of the reveal compiled into its shader.
   *
   * `inverse` reads that same front the other way round, the twin of
   * `Splat.setReveal`'s: AHEAD of the front the capture is untouched, behind
   * it a band fades it out and then it is gone. It is how a scene that gains
   * a new version replaces itself rather than disappearing and arriving -
   * hold both captures, drive the incoming one forward and the outgoing one
   * inverted on the same clock, and destroy the outgoing one when the clock
   * runs out. The fronts are normalised radii of the same room, so the two
   * tile it with no overlap to blend: inside the front only the new version
   * draws, outside it only the old one.
   *
   * At `amount` 0 an inverse sweep is the capture untouched and at 1 it is
   * nothing, so a caller holding two captures spends no extra frame hiding
   * either of them.
   */
  setReveal(amount: number, inverse = false): void {
    if (!this._revealEnabled && (amount < 1 || inverse) && !this.prepareReveal()) return;
    this._revealAmount = Math.min(1, Math.max(0, amount));
    this._revealInverse = inverse ? 1 : 0;
    this._pushRevealUniforms();
  }

  /**
   * Change how the reveal looks. Unset fields keep their current value; the
   * starting look is {@link DEFAULT_ENV_REVEAL_LOOK}, which is the
   * character's numbers re-tuned for a subject the viewer is inside. Cheap;
   * no recompile.
   */
  setRevealLook(look: RevealLook): void {
    packRevealLook(look, this._revealBand, this._revealSketch, this._revealTint);
    if (this._revealEnabled) this._pushRevealUniforms();
  }

  /** Whether the reveal has been opted into - see {@link setReveal}. */
  get revealEnabled(): boolean { return this._revealEnabled; }

  /**
   * Allocate the per-splat distances and compile the reveal in. Once.
   *
   * `Splat._enableReveal` cannot be reused for this: it keys the allocation
   * off `splatWeights`, a skinned character's bone influences, and an
   * environment has none - it would take the enable and skip the texture,
   * leaving the recompiled shader with an unbound sampler.
   *
   * Filled with 1, so a scene whose bake has not run (or has refused) stays
   * hidden until the sweep completes rather than revealing whatever the
   * allocation happened to contain.
   */
  private _enableReveal(width: number, height: number): void {
    if (this._revealEnabled) return;
    this._revealEnabled = true;
    this._revealDistanceTexture = this._newRevealTexture(width, height);
    const d = this._revealDistanceTexture.lock() as Float32Array;
    d.fill(1);
    this._revealDistanceTexture.unlock();
    const gsplat = (this.entity as unknown as { gsplat?: EnvModifierTarget }).gsplat;
    if (gsplat) Environment._installEnvModifier(gsplat, true);
    this._pushRevealUniforms();
  }

  /**
   * The capture's p98 radius about its own origin, in LOCAL units. Measured
   * once and remembered - including the `0` that means "nothing to measure",
   * so a streaming LOD bundle is asked once and then answered from the field.
   */
  private _measureRadius(): number {
    if (this._radiusLocal !== null) return this._radiusLocal;
    const data = (this.asset.resource as { gsplatData?: GSplatData } | null)?.gsplatData;
    const xs = data?.getProp('x');
    const ys = data?.getProp('y');
    const zs = data?.getProp('z');
    const r = data && xs && ys && zs ? envRevealRadius(xs, ys, zs, data.numSplats) : 0;
    this._radiusLocal = Number.isFinite(r) && r > 0 ? r : 0;
    return this._radiusLocal;
  }



  private _pushRevealUniforms(): void {
    if (!this._revealDistanceTexture) return;
    const targets = [[this.entity, this._revealDistanceTexture] as const, ...this._parts.map((p) => [p.entity, p.reveal] as const)];
    for (const [entity, texture] of targets) {
      const gsplat = (entity as unknown as { gsplat?: { setParameter: (n: string, v: unknown) => void } }).gsplat;
      if (!gsplat || !texture) continue;
      gsplat.setParameter('splatRevealDistanceTex', texture);
      gsplat.setParameter('uEnvReveal', this._revealAmount);
      gsplat.setParameter('uEnvRevealInverse', this._revealInverse);
      gsplat.setParameter('uRevealBand', this._revealBand);
      gsplat.setParameter('uRevealSketch', this._revealSketch);
      gsplat.setParameter('uRevealTint', this._revealTint);
    }
    this._markDirty();
  }

  /**
   * Re-render THIS environment's work buffer next frame. Scoped to our own
   * component rather than calling the registry-wide form bare: a page can
   * hold a second scene (the World Builder runs a walk preview beside its map
   * editor), and one scene's per-frame reveal has no business re-rendering
   * the other's.
   */
  private _markDirty(): void {
    this._dirtyOnly ??= new Set<unknown>(this._gsplats<unknown>());
    if (this._dirtyOnly.size > 0) Splat.markEnvWorkBuffersDirty(this._dirtyOnly);
    this._scene.app.renderNextFrame = true;
  }

  private _pushClipUniforms(): void {
    this._clipMinArr[0] = Number.isFinite(this._clipMin.x) ? this._clipMin.x : -CLIP_INF;
    this._clipMinArr[1] = Number.isFinite(this._clipMin.y) ? this._clipMin.y : -CLIP_INF;
    this._clipMinArr[2] = Number.isFinite(this._clipMin.z) ? this._clipMin.z : -CLIP_INF;
    this._clipMaxArr[0] = Number.isFinite(this._clipMax.x) ? this._clipMax.x :  CLIP_INF;
    this._clipMaxArr[1] = Number.isFinite(this._clipMax.y) ? this._clipMax.y :  CLIP_INF;
    this._clipMaxArr[2] = Number.isFinite(this._clipMax.z) ? this._clipMax.z :  CLIP_INF;
    for (const gsplat of this._gsplats()) {
      gsplat.setParameter('uEnvClipMin', this._clipMinArr);
      gsplat.setParameter('uEnvClipMax', this._clipMaxArr);
    }
    this._scene.app.renderNextFrame = true;
  }

  private _pushSplatSizeUniform(): void {
    for (const gsplat of this._gsplats()) gsplat.setParameter('uEnvSplatSizeMax', Math.min(this._splatSizeMax, CLIP_INF));
    this._scene.app.renderNextFrame = true;
  }

  private _pushClipDistanceUniforms(): void {
    // Squared here so the shader can compare a dot product directly. The
    // upper bound is capped at the sentinel either way: an absurd finite
    // radius would square past what an f32 uniform can hold.
    const minSq = this._clipDistMin * this._clipDistMin;
    const maxSq = Math.min(this._clipDistMax * this._clipDistMax, CLIP_DIST_INF_SQ);
    this._clipDistOriginArr[0] = this._clipDistOrigin.x;
    this._clipDistOriginArr[1] = this._clipDistOrigin.y;
    this._clipDistOriginArr[2] = this._clipDistOrigin.z;
    for (const gsplat of this._gsplats()) {
      gsplat.setParameter('uEnvClipDistMinSq', minSq);
      gsplat.setParameter('uEnvClipDistMaxSq', maxSq);
      gsplat.setParameter('uEnvClipDistOrigin', this._clipDistOriginArr);
    }
    this._scene.app.renderNextFrame = true;
  }

  /**
   * Load a Gaussian splat file as an environment and add it to the scene.
   */
  static async load(
    scene: Scene,
    url: string,
    opts?: LoadEnvironmentOptions,
  ): Promise<Environment> {
    const asset = await loadSplatAsset(scene.app, url, opts?.filename);
    // Same race as Character.load: the fetch above can outlive the scene, and
    // everything below this line touches the GPU.
    if (scene.destroyed) throw new SceneDestroyedError('Environment.load');

    const name = opts?.name ?? asset.name ?? 'environment';
    // Bind to the scene's OWN app: a bare `new Entity()` resolves through a global
    // "current application", so with two live scenes on a page (the World Builder
    // runs a walk preview beside the map editor) the splat silently lands in the
    // other app - it loads fine and renders nowhere.
    const entity = new Entity(name, scene.app);
    entity.addComponent('gsplat', { asset });
    // Route env splats to the dedicated env layer so they share their own
    // GSplatManager and sort worker, separate from the character World layer.
    entity.gsplat!.layers = [scene.envLayerId];

    if (opts?.position) {
      entity.setPosition(opts.position.x, opts.position.y, opts.position.z);
    }
    if (opts?.rotation) {
      entity.setEulerAngles(opts.rotation.x, opts.rotation.y, opts.rotation.z);
    }
    if (opts?.scale !== undefined) {
      entity.setLocalScale(opts.scale, opts.scale, opts.scale);
    }

    Environment._initEnvGsplat(scene, entity.gsplat!);

    scene.contentRoot.addChild(entity);

    const env = new Environment(scene, entity, asset);
    if (opts?.revealRadius !== undefined && opts.revealRadius > 0) env._radiusLocal = opts.revealRadius;
    return env;
  }

  /**
   * Shared env-splat wiring for {@link load} and {@link loadLodBundle}:
   * installs the environment work-buffer modifier, registers the component
   * for on-demand work-buffer re-renders, and seeds the relight uniforms.
   */
  private static _initEnvGsplat(scene: Scene, gsplat: GSplatComponent): void {
    Environment._installEnvModifier(gsplat, false);

    // Track env gsplat so `Splat.markEnvWorkBuffersDirty` - the relight
    // pass's refresh, the cutaway's callers - can re-render its work buffer.
    Splat._envGsplatComponents.add(gsplat);

    // Seed the relight chunk's samplers and knobs immediately, so the first
    // work-buffer render has valid bindings: it can fire before any relight
    // pass has published, and WebGPU rejects a draw with an unbound sampler.
    seedRelightDefaults(gsplat, scene.graphicsDevice);
  }

  /**
   * (Re-)install the env work-buffer modifier with the current compile-time
   * defines. Called once at load with the reveal OFF, and again from
   * {@link _enableReveal} - the mirror of `Splat._installWorkBufferModifier`,
   * and opt-in for the same reason: a scene that never reveals compiles none
   * of the reveal and binds none of its samplers.
   */
  private static _installEnvModifier(gsplat: EnvModifierTarget, reveal: boolean): void {
    const defines = reveal ? '#define USE_REVEAL\n' : '';
    gsplat.setWorkBufferModifier({
      glsl: defines + ENV_WORK_BUFFER_MODIFIER_GLSL,
      wgsl: defines + ENV_WORK_BUFFER_MODIFIER_WGSL,
    });
  }

  /**
   * Load a streaming LOD bundle (`lod-meta.json` octree manifest) as an
   * environment and add it to the scene.
   *
   * Unlike {@link load}, the splat data is NOT one monolithic file: the
   * manifest describes a spatial octree of `.webp` gaussian chunks which
   * PlayCanvas streams on demand, picking a detail level per node by camera
   * distance every frame. The promise resolves once the manifest is loaded
   * and the entity attached; streaming then proceeds in the background,
   * coarsest level first (the full LOD range opens once it's in, or after
   * `coarseTimeoutMs` of rendered frames - callers never stall on chunk
   * downloads).
   *
   * The coarse-first pin drives the scene-global gsplat LOD range, so only
   * one bundle should be live at a time (per-bundle ranges would need
   * engine-level support in PlayCanvas).
   *
   * Returns a regular {@link Environment} - clip bounds, `entity`, and
   * `destroy()` work the same as for a monolithic splat.
   */
  static async loadLodBundle(
    scene: Scene,
    url: string,
    opts?: LoadLodBundleOptions,
  ): Promise<Environment> {
    const app = scene.app;

    // The 'gsplat' handler dispatches on the URL basename: 'lod-meta.json'
    // loads a GSplatOctreeResource that resolves every chunk meta + tile URL
    // internally. No extension sniffing needed (unlike loadSplatAsset).
    const asset = new Asset(url, 'gsplat', { url });
    app.assets.add(asset);
    await new Promise<void>((resolve, reject) => {
      asset.once('load', () => resolve());
      asset.once('error', (err: string) => reject(new Error(String(err))));
      app.assets.load(asset);
    });

    const entity = new Entity(opts?.name ?? 'lod_environment', app);
    entity.addComponent('gsplat', { asset });
    // Same env-layer routing as `load` - see the comment there.
    entity.gsplat!.layers = [scene.envLayerId];

    if (opts?.position) {
      entity.setPosition(opts.position.x, opts.position.y, opts.position.z);
    }
    // splat-transform writes the bundle's SOG in RDF (Y-down) - 180° around X
    // brings it into PlayCanvas's Y-up world. Stacked on the authored rotation.
    const rot = opts?.rotation ?? { x: 0, y: 0, z: 0 };
    entity.setEulerAngles(rot.x + 180, rot.y, rot.z);
    if (opts?.scale !== undefined) {
      entity.setLocalScale(opts.scale, opts.scale, opts.scale);
    }

    const gsplat = entity.gsplat!;
    Environment._initEnvGsplat(scene, gsplat);

    // Distance thresholds for per-node LOD selection: level i kicks in at
    // `lodBaseDistance * lodMultiplier^(i-1)` world units from the camera.
    gsplat.lodBaseDistance = opts?.lodBaseDistance ?? 8;
    gsplat.lodMultiplier   = opts?.lodMultiplier   ?? 3;

    scene.contentRoot.addChild(entity);

    // Coarse-first: pin the whole octree to the coarsest level so SOMETHING
    // renders as soon as possible, then open the full range (so per-node
    // distance-based selection takes over) once that level has streamed in.
    // The wait runs in the background: frames may not even be rendering yet
    // (e.g. a scene that starts after asset bootstrap), so blocking here
    // would stall boot until the timeout for no benefit.
    const lodLevels = (asset.resource as { octree?: { lodLevels: number } } | null)?.octree?.lodLevels ?? 1;
    const coarsest  = Math.max(0, lodLevels - 1);
    gsplat.lodRangeMin = coarsest;
    gsplat.lodRangeMax = coarsest;
    Environment._openLodRangeWhenCoarseReady(gsplat, coarsest, opts?.coarseTimeoutMs ?? 8000);

    return new Environment(scene, entity, asset);
  }

  /**
   * Open the LOD range to `0..coarsest` once the gsplat system reports
   * a fully-streamed frame - i.e. the pinned coarsest level is fully in, so
   * SOMETHING paints before the range opens and the engine starts chasing the
   * (much larger) fine levels.
   *
   * The stall-guard timeout is armed on the FIRST `frame:ready` event, not at
   * load: the octree only streams during rendered frames, and a game may
   * render none between map load and gameplay start (loading bar / pick UI).
   * A timer started at load would expire in the menu, un-pinning the range
   * before the first visible frame - the engine would then skip the cheap
   * coarse pass and black-screen until the big fine-level chunks arrive.
   */
  private static _openLodRangeWhenCoarseReady(gsplat: GSplatComponent, coarsest: number, timeoutMs: number): void {
    const gsplatSystem = gsplat.system;
    const app = gsplatSystem.app;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      gsplatSystem.off('frame:ready', onFrameReady);
      if (timer !== null) clearTimeout(timer);
      gsplat.lodRangeMin = 0;
      gsplat.lodRangeMax = coarsest;
      // The range change reaches only the first camera's manager; a scene-wide dirty makes every one
      // re-pick. Set at the next frame's start: mid-frame (from `frame:ready`), frameEnd clears it.
      app.once('update', () => { app.scene.gsplat.dirty = true; });
    };
    const onFrameReady = (
      _cam: unknown, _layer: unknown, ready: boolean, loadingCount: number,
    ): void => {
      if (timer === null) timer = setTimeout(finish, timeoutMs); // frames are flowing - arm the stall guard
      if (ready && loadingCount === 0) finish();
    };
    gsplatSystem.on('frame:ready', onFrameReady);
  }

  destroy(): void {
    this._destroyed = true;
    this._scene.graphicsDevice.off('devicerestored', this._onDeviceRestored, this);
    // Parts' gsplat registrations, textures and assets outlive their entities, so release them
    // while the part entities (children of this one) still exist.
    for (const part of this._parts) {
      if (part.entity.gsplat) Splat._envGsplatComponents.delete(part.entity.gsplat);
      part.entity.destroy();
      part.reveal?.destroy();
      this._scene.app.assets.remove(part.asset);
      part.asset.unload();
    }
    this._parts = [];
    if (this.entity.gsplat) Splat._envGsplatComponents.delete(this.entity.gsplat);
    this._revealDistanceTexture?.destroy();
    this._revealDistanceTexture = null;
    this.entity.destroy();
    this._scene.app.assets.remove(this.asset);
    this.asset.unload();
  }
}
