import {
  ADDRESS_CLAMP_TO_EDGE,
  Color,
  Entity,
  EVENT_PRERENDER_LAYER,
  FILTER_NEAREST,
  Layer,
  PIXELFORMAT_DEPTHSTENCIL,
  PIXELFORMAT_RGBA8,
  QuadRender,
  RenderTarget,
  SEMANTIC_POSITION,
  ShaderUtils,
  Texture,
} from 'playcanvas';
import type { CameraComponent, GraphicsDevice } from 'playcanvas';

import type { PostFXFrameConfig, PostFXInstallContext, PostFXPass } from '../postfx';
import type { Scene } from '../../scene';
import {
  upscaleFragmentGLSL,
  upscaleFragmentWGSL,
} from './pixelart-shaders';

export interface PixelartEffectOptions {
  /** Integer downscale factor for the FINE scale (character resolution).
   *  The single low-res RT is sized `device.{w,h} / scale`. Default 4. */
  scale?: number;
  /** Integer downscale factor for environment pixels. Defaults to `scale`
   *  (uniform pixelisation). When greater than `scale`, environment
   *  pixels in the upscale shader snap their source coord to a coarser
   *  grid (`environmentScale / scale` × `environmentScale / scale`),
   *  giving the environment a chunkier look than tagged characters.
   *  Must be an integer multiple of `scale`. */
  environmentScale?: number;
  /** Optional per-channel colour quantisation. `levels` is the number of
   *  steps per channel (e.g. 6 → six discrete values from 0..1). Pass null
   *  or omit to disable. Default null. */
  quantize?: { levels: number } | null;
  /** Optional Bayer-4×4 ordered dither, applied BEFORE quantisation.
   *  `strength` is in units of the quant step - 1.0 (recommended) gives the
   *  classic ±0.5-step amplitude that fully breaks colour banding into a
   *  retro dot pattern. Lower for subtler texture. No-op unless `quantize`
   *  is also enabled (without a quant step there's nothing to dither
   *  across). Pass null or omit to disable. Default null. */
  dither?: { strength: number } | null;
  /** Override the compose layer's debug name. Default 'pixelart-compose'. */
  composeLayerName?: string;
  /** Override the character mask layer's debug name. Default
   *  'pixelart-char-mask'. */
  characterMaskLayerName?: string;
  /** Optional crisp outline drawn around tagged-character silhouettes.
   *  Reuses the depth-correct char mask - no extra render pass. The
   *  outline LINE is sharp at backbuffer resolution; the outline shape
   *  follows the chunky low-res mask edges (which visually matches the
   *  pixel-art aesthetic). `thicknessPx` is in backbuffer pixels;
   *  effective minimum is roughly the value of `scale`. `mode` chooses
   *  where the band sits - 'outer' makes characters look slightly
   *  larger, 'inner' eats into the silhouette, 'both' is a 2-thickness
   *  band straddling the edge. Default mode: 'outer'. Pass null or omit
   *  to disable. */
  outline?: {
    color: Color;
    thicknessPx?: number;
    mode?: 'outer' | 'inner' | 'both';
    /** Smoothstep softness on the ring-alpha → outline-alpha mapping.
     *  0 (default) = hard step, identical to the binary threshold.
     *  ~0.3-0.5 gives a visibly soft outline that follows the gsplat's
     *  natural Gaussian falloff at silhouette edges. Larger values
     *  produce a more diffuse glow. Sensible range 0..0.5. */
    smoothness?: number;
  } | null;
  /** Optional whole-frame colour grade applied as the last step of the
   *  compose shader. `lift` is added to every pixel (so pure black is
   *  pushed up to this colour - useful for the "warm dark background"
   *  look where the scene's actual black becomes a tinted near-black).
   *  `gain` is multiplied with every pixel (tints highlights / overall).
   *  Final = clamp(c * gain + lift, 0, 1). Outline is included in the
   *  grade - it's a whole-frame filter. Defaults: lift = (0,0,0),
   *  gain = (1,1,1) = identity. */
  colorGrade?: { lift?: Color; gain?: Color } | null;
  /**
   * Whether to enable PC's scene-depth prepass for this effect. The
   * prepass writes a scene-wide depth texture that GLB cosmetic meshes
   * sample to depth-compose against gsplat splats - required for any
   * scene where standard PC meshes need to occlude / be occluded by
   * splats correctly.
   *
   * Cost: a full depth-only pass over every visible mesh + splat. On
   * skinned-splat-heavy scenes this measures at ~2-3 ms per ~100 chars.
   * Disable it (`false`) when the scene has no mesh-on-splat depth
   * compositing - e.g. headless bench scenes, splat-only previews,
   * cosmetic-free crowd shots - to skip that cost entirely. A game that
   * puts GLB cosmetics on the player must leave it on.
   *
   * Default: `true` (preserves the existing behaviour).
   */
  requireSceneDepth?: boolean;
}

const OUTLINE_MODE_VALUE: Record<'outer' | 'inner' | 'both', number> = {
  outer: 0,
  inner: 1,
  both: 2,
};

/**
 * Tag bookkeeping for an entity registered via `addCharacter`. Caches
 * each tagged component's original `layers` array so removeCharacter can
 * restore exactly. Covers both `gsplat` (char splats) and `render` (mesh
 * cosmetics / GLB attachments) components - anything that exposes a
 * mutable `layers: number[]`.
 */
/** A gsplat or render component: both carry the layer ids they draw into. */
type LayeredComponent = { layers: readonly number[] };

interface CharTagEntry {
  entity: Entity;
  compRestores: Array<{ comp: LayeredComponent; original: number[] }>;
  destroyListener: () => void;
}

/**
 * Pixel-art post-process for the gsplat scene.
 *
 * Rebinds the main camera to a low-resolution offscreen RT, then a
 * dedicated compose camera draws a fullscreen quad sampling that RT
 * with nearest-neighbour upscaling to the backbuffer. Splat edges
 * collapse into clean pixel blocks; outlines, sprites, and VFX that
 * already flow through the main camera's layer stack inherit the
 * pixelation for free.
 *
 * ── Two-scale mode ──────────────────────────────────────────────────
 * When `environmentScale > scale`, the effect supports rendering tagged
 * "character" entities at the fine scale while environment pixels are
 * snapped to a coarser grid. The scene still renders to a SINGLE RT
 * (at the fine scale) so depth-occlusion between char and env is
 * automatic and free - there's just one depth buffer. A second mask RT,
 * sharing that depth buffer, captures the silhouette of tagged char
 * entities; the upscale shader uses the mask to decide per-pixel
 * whether to sample the RT at fine granularity (char) or snap to the
 * coarser env grid before sampling.
 *
 * Tag char entities via `pixelart.addCharacter(entity)`. Both `gsplat`
 * and `render` components on the entity (or its subtree, by default) are
 * tagged - so a character built from a splat body + GLB cosmetic
 * attachments shows a single unified silhouette outline. Pass
 * `recursive: false` to tag only the entity's own components.
 *
 * Architecture mirrors {@link OutlineEffect}: dedicated cameras + custom
 * RTs + EVENT_PRERENDER_LAYER quad. See `outline-system.ts` for the
 * pattern this is built on.
 */
export class PixelartEffect implements PostFXPass {
  /** PostFX uses this to classify the pass and wire its input from the
   *  scene capture RT instead of an upstream pass. */
  readonly capturesScene = true;

  // ── Option-derived state (set in constructor, immutable until live edits) ──
  private scale: number;
  private envSnap: number;
  private quantLevels: number;
  private ditherStrengthVal: number; // 0 disables.
  private outlineColor: Color;
  private outlineThicknessPx: number; // 0 disables
  private _outlineMode: number; // 0 outer, 1 inner, 2 both
  private outlineSmoothnessVal: number; // 0 hard step. >0 = smoothstep width.
  private gradeLift: Color;            // Added to final. Default (0,0,0).
  private gradeGain: Color;            // Multiplied with final. Default (1,1,1).
  private envDarkenVal: number = 0;    // 0..1, multiplies env pixels by (1-v). 0 = no-op.
  private readonly _opts: PixelartEffectOptions;

  // ── Runtime state (populated on configureFrame / install) ─────────────────
  private scene: Scene | null = null;
  private device: GraphicsDevice | null = null;

  // Single scene RT (rendered at the fine scale). Color + sampleable
  // depth - depth is shared with the mask RT so the mask is occlusion-
  // tested against the real scene.
  private lowResRT: RenderTarget | null = null;
  private lowResTex: Texture | null = null;
  private sharedDepthTex: Texture | null = null;
  private rtW = 0;
  private rtH = 0;

  // Mask RT (1-channel char silhouette). Same dims as lowResRT, shares
  // the same depth texture (depth-tests against the main scene depth so
  // tagged splats only land in the mask where they're actually visible).
  private maskRT: RenderTarget | null = null;
  private maskTex: Texture | null = null;
  private maskLayer: Layer | null = null;
  private maskLayerId: number = -1;
  private maskCameraEntity: Entity | null = null;

  private composeLayer: Layer | null = null;
  private composeLayerId: number = -1;
  private composeCameraEntity: Entity | null = null;

  private mainCameraEntity: Entity | null = null;

  // Where the compose camera writes the upscaled + dithered + graded output.
  // Set by `install` from `ctx.outputTarget`: null = backbuffer (last in
  // chain), otherwise the next capturing pass's input RT.
  private _composeOutputTarget: RenderTarget | null = null;

  private postQuad: QuadRender | null = null;

  private charTags = new Map<Entity, CharTagEntry>();

  private _prerenderLayerHandler: ((camera: CameraComponent, layer: Layer, transparent: boolean) => void) | null = null;
  private _appPrerenderHandler: (() => void) | null = null;
  private _installed = false;
  private _destroyed = false;

  /**
   * Back-compat factory. Equivalent to:
   *
   * ```ts
   * scene.postfx.add(new PixelartEffect(opts));
   * ```
   *
   * Prefer the explicit `scene.postfx.add(...)` form when composing multiple
   * effects; this one-shot stays as the simplest way to enable pixelart on a
   * fresh scene.
   */
  static create(scene: Scene, opts: PixelartEffectOptions = {}): PixelartEffect {
    return scene.postfx.add(new PixelartEffect(opts));
  }

  /** Construct a (detached) effect. Attach via `scene.postfx.add(this)`. */
  constructor(opts: PixelartEffectOptions = {}) {
    this._opts = opts;
    this.scale = Math.max(1, Math.floor(opts.scale ?? 4));
    const envScale = Math.max(this.scale, Math.floor(opts.environmentScale ?? this.scale));
    this.envSnap = Math.max(1, Math.round(envScale / this.scale));
    this.quantLevels = opts.quantize ? Math.max(2, Math.floor(opts.quantize.levels)) : 0;
    this.ditherStrengthVal = opts.dither ? Math.max(0, opts.dither.strength) : 0;
    this.outlineColor = opts.outline?.color ?? new Color(0, 0, 0, 1);
    this.outlineThicknessPx = opts.outline ? Math.max(1, Math.floor(opts.outline.thicknessPx ?? 2)) : 0;
    this._outlineMode = OUTLINE_MODE_VALUE[opts.outline?.mode ?? 'outer'];
    this.outlineSmoothnessVal = Math.max(0, opts.outline?.smoothness ?? 0);
    this.gradeLift = opts.colorGrade?.lift ?? new Color(0, 0, 0, 1);
    this.gradeGain = opts.colorGrade?.gain ?? new Color(1, 1, 1, 1);
  }

  // ── PostFXPass lifecycle ───────────────────────────────────────────────
  //
  // Critical contract: `install` and `uninstall` must be a REVERSIBLE pair.
  // PostFX rebuilds the chain on every add/remove/resize by calling
  // `uninstall` on the previous snapshot and `install` on the new one - the
  // SAME pass instance may be uninstalled and re-installed many times.
  // `uninstall` therefore must NOT set permanent "destroyed" state. Final
  // teardown (including releasing GPU-owned RTs) goes through `destroy()`
  // below, which is what the consumer calls when removing the effect for
  // good.

  /**
   * Phase 1 (pre-CameraFrame): cache scene/device refs and request the
   * scene-depth prepass.
   *
   * Runs ONCE per `postfx.add(this)`. RT allocation happens lazily in
   * `getSceneCaptureRT` / `install` so we naturally reallocate after an
   * `uninstall` cycle (which frees them) or a device resize (which changes
   * their size).
   */
  configureFrame(scene: Scene, rendering: PostFXFrameConfig): void {
    this.scene = scene;
    this.device = scene.graphicsDevice;
    this.mainCameraEntity = scene.cameraEntity;
    if (!this.mainCameraEntity.camera) {
      throw new Error('[PixelartEffect] scene.cameraEntity has no camera component');
    }
    // Depth prepass: (a) PC standard meshes (GLB cosmetics) depth-compose
    // against the gsplat compute rasterizer via `uSceneDepthMap`. The
    // mask camera's depth-test against `sharedDepthTex` (the lowResRT's
    // depth attachment) is independent of this prepass - the main
    // camera's gsplat rasterize writes that depth attachment naturally.
    //
    // Cost is non-trivial (~2-3 ms per ~100 skinned chars); when the
    // scene has no mesh-on-splat depth compositing (no GLB cosmetics)
    // the caller can opt out via `requireSceneDepth: false`.
    rendering.sceneDepthMap = this._opts.requireSceneDepth ?? true;
  }

  /**
   * Expose the low-res scene capture RT to PostFX. When this pass is the
   * FIRST capturing pass in the chain, PostFX stamps
   * `cam.renderTarget = lowResRT` before CameraFrame is constructed, so
   * its compose pass writes the composed scene into lowResRT directly.
   *
   * Allocates the RT on demand - PostFX may call this after a prior
   * `uninstall` cycle freed the previous one.
   */
  getSceneCaptureRT(): RenderTarget | null {
    this._ensureRTs();
    return this.lowResRT;
  }

  /**
   * Phase 2 (CameraFrame live): attach layers / cameras / event hooks.
   *
   * `ctx.outputTarget` is where this pass writes its upscaled, dithered,
   * graded, outline-composited output: `null` = backbuffer (we're the last
   * capturing pass), or the next capturing pass's input RT when chained.
   */
  install(scene: Scene, ctx: PostFXInstallContext): void {
    if (this._installed) return;
    const mainCam = scene.cameraEntity.camera!;
    const device = scene.graphicsDevice;
    this._composeOutputTarget = ctx.outputTarget;
    // Re-ensure RTs in case a prior uninstall freed them, or the device
    // resized since the last install. `_ensureRTs` is a no-op when size
    // and existence already match.
    this._ensureRTs();

    // Leave `frame.rendering.renderTargetScale` at the default (1).
    // CameraFrame sizes its internal HDR scene RT as
    // `resizeSource (= cam.renderTarget = lowResRT) × renderTargetScale`.
    // Since lowResRT is ALREADY at `device/scale`, scaleX=1 yields a
    // `device/scale`-sized scene render that composes 1:1 into lowResRT
    // - the chunky pixel-art look without any double-downsampling.

    // ── Mask layer (char clones add themselves here) ────────────────
    this.maskLayer = new Layer({
      name: this._opts.characterMaskLayerName ?? 'pixelart-char-mask',
      clearColorBuffer: false,
      clearDepthBuffer: false,
      passThrough: false,
    });
    const composition = scene.app.scene.layers;
    composition.push(this.maskLayer);
    this.maskLayerId = this.maskLayer.id;

    // ── Mask camera ─────────────────────────────────────────────────
    // Parented to the main camera so transform stays locked without
    // per-frame sync. Projection params still need copying every frame
    // (fov / aspect / near / far changes). Renders ONLY the mask layer
    // into maskRT, depth-tested against the shared depth that main
    // camera just wrote - so char splats land in the mask only where
    // they're actually visible (not behind walls).
    this.maskCameraEntity = new Entity('pixelart-mask-camera');
    this.mainCameraEntity!.addChild(this.maskCameraEntity);
    this.maskCameraEntity.addComponent('camera', {
      clearColor: new Color(0, 0, 0, 0),
      clearColorBuffer: true,
      // CRITICAL: do NOT clear depth - we want main camera's depth
      // intact so the mask is depth-tested against the real scene.
      clearDepthBuffer: false,
      clearStencilBuffer: false,
      renderTarget: this.maskRT!,
      layers: [this.maskLayerId],
      priority: (mainCam.priority ?? 0) + 1,
    });
    // PC 2.18 escape hatch (same as outline-system.ts:170).
    this.maskCameraEntity.camera!.renderTarget = this.maskRT!;
    // Idle: enabled only when at least one char is tagged.
    this.maskCameraEntity.enabled = false;

    // ── Compose layer (anchor for the post quad - no meshes) ────────
    this.composeLayer = new Layer({
      name: this._opts.composeLayerName ?? 'pixelart-compose',
      clearColorBuffer: false,
      clearDepthBuffer: false,
      passThrough: false,
    });
    composition.push(this.composeLayer);
    this.composeLayerId = this.composeLayer.id;

    // ── Compose camera ──────────────────────────────────────────────
    // `renderTarget` is null when we're the last (or only) capturing
    // pass - compose writes straight to backbuffer. When chained, PostFX
    // hands us the next pass's input RT and the compose lands there.
    this.composeCameraEntity = new Entity('pixelart-compose-camera');
    scene.app.root.addChild(this.composeCameraEntity);
    this.composeCameraEntity.addComponent('camera', {
      clearColor: new Color(0, 0, 0, 1),
      clearColorBuffer: true,
      clearDepthBuffer: false,
      clearStencilBuffer: false,
      renderTarget: this._composeOutputTarget as unknown as RenderTarget,
      layers: [this.composeLayerId],
      priority: (mainCam.priority ?? 0) + 2,
    });
    // PC 2.18 escape hatch: the addComponent path treats null specially;
    // cast to silence the non-null setter and stick the actual value.
    this.composeCameraEntity.camera!.renderTarget = this._composeOutputTarget as unknown as RenderTarget;

    // ── Upscale shader + fullscreen quad ────────────────────────────
    const shader = ShaderUtils.createShader(device, {
      uniqueName: 'pixelart-upscale-v4',
      attributes: { vertex_position: SEMANTIC_POSITION },
      vertexChunk: 'fullscreenQuadVS',
      fragmentGLSL: upscaleFragmentGLSL,
      fragmentWGSL: upscaleFragmentWGSL,
    });
    this.postQuad = new QuadRender(shader);

    // ── Event hooks ─────────────────────────────────────────────────
    this._appPrerenderHandler = this._syncMaskCamera.bind(this);
    scene.app.on('prerender', this._appPrerenderHandler);

    this._prerenderLayerHandler = this._onPrerenderLayer.bind(this);
    scene.app.scene.on(EVENT_PRERENDER_LAYER, this._prerenderLayerHandler);

    // No pixelart-owned `resizecanvas` listener: PostFX owns resize via
    // its own rebuild path, which calls our `uninstall` → frees RTs →
    // `install` → reallocates them at the new size. Doing both creates a
    // race where the pixelart-owned reallocation completes before PostFX
    // tears CameraFrame down, leaving CameraFrame's compose pointing at
    // the freed RT.
    //
    // The upstream branch maintained a pixelart-owned handler that called
    // `scene.destroyCameraFrame()` + `getOrCreateCameraFrame()` directly;
    // that path now bypasses PostFX's `_installed` snapshot and would
    // desync its bookkeeping (passes left in `_installed` but their RTs
    // freed). Anything that previously needed that handler - including
    // the `pixelScale` setter's live-tune teardown - should call
    // `scene.postfx.rebuild()` (or remove+re-add this pass) so all
    // installed passes get a chance to reallocate together.

    this._installed = true;
  }

  /**
   * Reversible teardown. PostFX calls this every time the chain is rebuilt;
   * the SAME pass instance may be uninstalled and re-installed many times.
   * Releases all GPU- and PC-owned state - cameras, layers, hooks, quad,
   * AND the RTs - so the next `install` starts from a clean slate. Does
   * NOT set `_destroyed`.
   */
  uninstall(_scene: Scene): void {
    if (!this._installed) return;
    this._releaseInstance();
  }

  /** Live-tunable fine pixel scale. Rebuilds RTs. */
  get pixelScale(): number { return this.scale; }
  set pixelScale(s: number) {
    const next = Math.max(1, Math.floor(s));
    if (next === this.scale || this._destroyed) return;
    this.scale = next;

    // CameraFrame must be torn down BEFORE the RT swap, otherwise PC
    // warns on the renderTarget setter and the pass chain holds onto
    // the about-to-be-destroyed colorBuffer.
    //
    // CAVEAT: this setter swaps pixelart's INTERNAL RTs only - it does
    // not rebuild the full PostFX chain. If you have downstream
    // capturing passes (CRT, tint, etc.), their PostFX-allocated input
    // RTs are unaffected. Pixelart's compose camera keeps writing to
    // its existing `_composeOutputTarget`, so the chain still flows.
    // For a full rebuild use `scene.postfx.remove(this)` + add a fresh
    // PixelartEffect with the new scale.
    this.scene?.destroyCameraFrame?.();

    this._ensureRTs();
    const cam = this.mainCameraEntity?.camera;
    if (cam && this.lowResRT) cam.renderTarget = this.lowResRT;
    if (this.maskCameraEntity?.camera && this.maskRT) {
      this.maskCameraEntity.camera.renderTarget = this.maskRT;
    }

    this.scene?.getOrCreateCameraFrame?.();
  }

  /** Snap factor for environment pixels (>= 1). 1 = uniform. */
  get environmentSnap(): number { return this.envSnap; }
  set environmentSnap(s: number) {
    this.envSnap = Math.max(1, Math.round(s));
  }

  /** Levels per channel, or 0 to disable quantisation. */
  get quantizationLevels(): number { return this.quantLevels; }
  set quantizationLevels(lv: number) {
    this.quantLevels = lv > 0 ? Math.max(2, Math.floor(lv)) : 0;
  }

  /** Bayer-4×4 dither amplitude in quant-step units. 0 disables. */
  get ditherStrength(): number { return this.ditherStrengthVal; }
  set ditherStrength(v: number) { this.ditherStrengthVal = Math.max(0, v); }

  /** Live-tunable outline thickness (BB pixels). 0 disables. */
  get outlineThickness(): number { return this.outlineThicknessPx; }
  set outlineThickness(px: number) {
    this.outlineThicknessPx = px > 0 ? Math.max(1, Math.floor(px)) : 0;
  }

  /** Live-tunable outline colour. Takes effect next frame. */
  getOutlineColor(): Color { return this.outlineColor; }
  setOutlineColor(c: Color): void { this.outlineColor = c; }

  /** Live-tunable outline mode. 'outer' / 'inner' / 'both'. */
  get outlineMode(): 'outer' | 'inner' | 'both' {
    return (['outer', 'inner', 'both'] as const)[this._outlineMode] ?? 'outer';
  }
  set outlineMode(m: 'outer' | 'inner' | 'both') {
    this._outlineMode = OUTLINE_MODE_VALUE[m];
  }

  /** Live-tunable smoothstep softness on the outline (0..~0.5). 0 = hard. */
  get outlineSmoothness(): number { return this.outlineSmoothnessVal; }
  set outlineSmoothness(v: number) { this.outlineSmoothnessVal = Math.max(0, v); }

  /** Live-tunable colour-grade lift (added to every pixel). */
  getColorGradeLift(): Color { return this.gradeLift; }
  setColorGradeLift(c: Color): void { this.gradeLift = c; }

  /** Live-tunable colour-grade gain (multiplied with every pixel). */
  getColorGradeGain(): Color { return this.gradeGain; }
  setColorGradeGain(c: Color): void { this.gradeGain = c; }

  /** Env-only darken amount in [0, 1]. 0 = no-op; 1 = env pixels fully
   *  black. Char-tagged pixels (player + tagged enemies) are untouched.
   *  Drives the death cutscene's "map + enemies fade out" phase. */
  getEnvDarken(): number { return this.envDarkenVal; }
  setEnvDarken(v: number): void { this.envDarkenVal = Math.max(0, Math.min(1, v)); }

  /**
   * Tag a character (or raw entity subtree) as "character" - appears in
   * the mask and gets sampled at the fine scale instead of the env-snapped
   * coarser grid. Covers both `gsplat` and `render` components, so a
   * character built from a splat body + GLB cosmetic attachments gets
   * a unified silhouette outline.
   *
   * Mesh entities paint into the mask as fully-opaque white wherever
   * they're visible (depth-tested against `sharedDepthTex`); the compose
   * shader's ring detector treats their edges the same as splat edges.
   *
   * `target` accepts either:
   *   - **A `Character`** (or any object with a `splats: Array<{ entity }>`
   *     field) - every loaded LOD entity is tagged so the outline tracks
   *     whichever level is currently active per Character's render-LOD
   *     system. Required because PC's `setRenderingEnabled(false)` on
   *     non-active LODs disables the splat for ALL cameras, so tagging
   *     only one LOD would leave chars at other distances un-masked.
   *   - **A raw `Entity`** - original entity-walking path. Use this for
   *     non-Character subtrees (props, manually-built rigs) where there's
   *     no LOD pyramid to choose from.
   *
   * Idempotent - re-tagging the same target rebuilds its tag entries.
   */
  addCharacter(
    target: Entity | { splats: Array<{ entity: Entity }> },
    opts: { recursive?: boolean } = {},
  ): void {
    if (this._destroyed) return;

    // Duck-typed Character detection. Importing the concrete `Character`
    // class would introduce a circular dep (Character → effects); the
    // structural check is sufficient and lets non-engine code pass any
    // compatible shape.
    const splatArr = (target as { splats?: Array<{ entity?: Entity }> }).splats;
    if (Array.isArray(splatArr) && splatArr.length > 0 && splatArr[0]?.entity) {
      // Tag every LOD entity. We tried a 'coarsest-only' policy to cut
      // mask-camera splat count by ~5-10× per char - visually it failed
      // because PC's render-LOD `setRenderingEnabled(false)` disables a
      // splat across every camera that would otherwise render it. Tagging
      // only the coarsest left chars at L0/L1 with no mask coverage.
      // Per-camera enable would fix it but isn't exposed by PC 2.18.
      for (const s of splatArr) {
        if (s?.entity) this._addCharacterEntity(s.entity, opts);
      }
      return;
    }

    this._addCharacterEntity(target as Entity, opts);
  }

  /**
   * Internal entity-walking path. Adds the mask layer to every `gsplat`
   * and `render` component under `entity`. Tracked in `charTags` so
   * `removeCharacter` can restore the original layer lists.
   */
  private _addCharacterEntity(entity: Entity, opts: { recursive?: boolean }): void {
    if (this.charTags.has(entity)) this._removeCharacterEntity(entity);

    const recursive = opts.recursive ?? true;
    const destroyListener = () => this._removeCharacterEntity(entity);
    const entry: CharTagEntry = { entity, compRestores: [], destroyListener };

    const tagLayers = (comp: LayeredComponent | undefined) => {
      if (!comp?.layers) return;
      const original: number[] = [...comp.layers];
      if (original.includes(this.maskLayerId)) return;
      comp.layers = [...original, this.maskLayerId];
      entry.compRestores.push({ comp, original });
    };

    const visit = (node: Entity) => {
      tagLayers(node.gsplat);
      tagLayers(node.render);
      if (!recursive) return;
      for (const child of node.children ?? []) {
        if (child.tags !== undefined) visit(child as Entity);
      }
    };
    visit(entity);

    // Self-clean when the entity is destroyed (enemy death, etc.) so
    // the charTags map doesn't accumulate stale references.
    entity.once('destroy', destroyListener);

    this.charTags.set(entity, entry);
    if (this.maskCameraEntity) this.maskCameraEntity.enabled = true;
  }

  /**
   * Untag a character or entity. No-op if nothing matched.
   *
   * Passing a `Character` (or splats-bearing object) routes through every
   * loaded LOD entity - safe even when `addCharacter` only tagged the
   * coarsest one, because `_removeCharacterEntity` skips entries that
   * weren't tagged.
   */
  removeCharacter(target: Entity | { splats: Array<{ entity: Entity }> }): void {
    const splatArr = (target as { splats?: Array<{ entity?: Entity }> }).splats;
    if (Array.isArray(splatArr) && splatArr.length > 0 && splatArr[0]?.entity) {
      for (const s of splatArr) {
        if (s?.entity) this._removeCharacterEntity(s.entity);
      }
      return;
    }
    this._removeCharacterEntity(target as Entity);
  }

  private _removeCharacterEntity(entity: Entity): void {
    const entry = this.charTags.get(entity);
    if (!entry) return;
    for (const r of entry.compRestores) {
      try { r.comp.layers = r.original; } catch { /* ignore */ }
    }
    try { entity.off('destroy', entry.destroyListener); } catch { /* ignore */ }
    this.charTags.delete(entity);
    if (this.charTags.size === 0 && this.maskCameraEntity) {
      this.maskCameraEntity.enabled = false;
    }
  }

  /** Untag every entity at once. */
  clearCharacters(): void {
    for (const e of Array.from(this.charTags.keys())) this.removeCharacter(e);
  }

  /**
   * Final teardown - call this when the effect should be permanently gone.
   * Routes through `PostFX.remove` if attached so the manager's bookkeeping
   * stays consistent (and so the chain rebuilds without us); direct callers
   * (tests, scripts using `static create` then bypassing postfx) still get
   * a full clean-up.
   *
   * Distinct from `uninstall` - `destroy` sets `_destroyed = true`, which
   * locks the instance. The chain-rebuild path uses `uninstall`/`install`
   * cycles and must keep `_destroyed = false`.
   */
  destroy(): void {
    if (this._destroyed) return;
    if (this.scene && this._installed) {
      // Route through postfx - its `remove` calls our `uninstall`, which
      // releases everything except the `_destroyed` flag.
      this.scene.postfx.remove(this);
    } else if (this._installed) {
      // Direct destroy without a scene reference (unusual). Release in-place.
      this._releaseInstance();
    }
    this._destroyed = true;
  }

  /**
   * Release every PC/GPU resource owned by this effect - cameras, layers,
   * event hooks, the upscale quad, AND the RTs. Idempotent: safe to call
   * when nothing is allocated. Does NOT set `_destroyed`; that's `destroy`'s
   * job. Called from both `uninstall` (chain rebuild - install will run
   * again on this instance) and `destroy` (final teardown).
   */
  private _releaseInstance(): void {
    this.clearCharacters();

    if (this.scene) {
      if (this._appPrerenderHandler) this.scene.app.off('prerender', this._appPrerenderHandler);
      if (this._prerenderLayerHandler) {
        this.scene.app.scene.off(EVENT_PRERENDER_LAYER, this._prerenderLayerHandler);
      }
    }
    this._appPrerenderHandler = null;
    this._prerenderLayerHandler = null;

    // We never stamp `cam.renderTarget` ourselves any more - PostFX owns
    // that via `getSceneCaptureRT` and clears it on rebuild.

    if (this.maskCameraEntity) {
      if (this.maskCameraEntity.parent) {
        this.maskCameraEntity.parent.removeChild(this.maskCameraEntity);
      }
      try { this.maskCameraEntity.destroy(); } catch { /* already freed */ }
      this.maskCameraEntity = null;
    }

    if (this.composeCameraEntity) {
      if (this.composeCameraEntity.parent) {
        this.composeCameraEntity.parent.removeChild(this.composeCameraEntity);
      }
      try { this.composeCameraEntity.destroy(); } catch { /* already freed */ }
      this.composeCameraEntity = null;
    }

    if (this.scene) {
      const composition = this.scene.app.scene.layers;
      if (composition?.remove) {
        if (this.maskLayer) composition.remove(this.maskLayer);
        if (this.composeLayer) composition.remove(this.composeLayer);
      }
    }
    this.maskLayer = null;
    this.composeLayer = null;
    this.postQuad = null;

    if (this.lowResRT) this.lowResRT.destroy();
    if (this.lowResTex) this.lowResTex.destroy();
    if (this.maskRT) this.maskRT.destroy();
    if (this.maskTex) this.maskTex.destroy();
    if (this.sharedDepthTex) this.sharedDepthTex.destroy();
    this.lowResRT = null;
    this.lowResTex = null;
    this.maskRT = null;
    this.maskTex = null;
    this.sharedDepthTex = null;
    this.rtW = 0;
    this.rtH = 0;

    this._installed = false;
  }

  // ── internals ────────────────────────────────────────────────────

  private _ensureRTs(): void {
    const device = this.device;
    if (!device) return; // pre-configureFrame; nothing to allocate yet.
    const w = Math.max(1, Math.floor(device.width / this.scale));
    const h = Math.max(1, Math.floor(device.height / this.scale));
    if (this.lowResRT && this.rtW === w && this.rtH === h) return;

    if (this.lowResRT) this.lowResRT.destroy();
    if (this.lowResTex) this.lowResTex.destroy();
    if (this.maskRT) this.maskRT.destroy();
    if (this.maskTex) this.maskTex.destroy();
    if (this.sharedDepthTex) this.sharedDepthTex.destroy();

    // Shared depth texture - depth-stencil so PC backends accept it as
    // a depth attachment uniformly across WebGL2 and WebGPU. Not sampled
    // by any shader (we only share it between two RTs for depth-test);
    // sampling support varies by backend and isn't needed here.
    this.sharedDepthTex = new Texture(device, {
      name: 'pixelart-shared-depth',
      width: w,
      height: h,
      format: PIXELFORMAT_DEPTHSTENCIL,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });

    this.lowResTex = new Texture(device, {
      name: 'pixelart-scene-color',
      width: w,
      height: h,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    this.lowResRT = new RenderTarget({
      name: 'pixelart-scene-rt',
      colorBuffer: this.lowResTex,
      depthBuffer: this.sharedDepthTex,
      stencil: false,
      samples: 1,
    });

    this.maskTex = new Texture(device, {
      name: 'pixelart-char-mask',
      width: w,
      height: h,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    this.maskRT = new RenderTarget({
      name: 'pixelart-char-mask-rt',
      colorBuffer: this.maskTex,
      depthBuffer: this.sharedDepthTex,
      stencil: false,
      samples: 1,
    });

    this.rtW = w;
    this.rtH = h;
  }

  private _syncMaskCamera(): void {
    if (this._destroyed) return;
    const mainCam = this.mainCameraEntity?.camera;
    const maskCam = this.maskCameraEntity?.camera;
    if (!mainCam || !maskCam) return;
    // Parent handles position/rotation; copy projection state every
    // frame so fov / aspect / ortho changes propagate. Mirrors
    // OutlineEffect._syncCameras().
    maskCam.fov = mainCam.fov;
    maskCam.nearClip = mainCam.nearClip;
    maskCam.farClip = mainCam.farClip;
    maskCam.aspectRatio = mainCam.aspectRatio;
    maskCam.aspectRatioMode = mainCam.aspectRatioMode;
    maskCam.projection = mainCam.projection;
    maskCam.orthoHeight = mainCam.orthoHeight;
    maskCam.horizontalFov = mainCam.horizontalFov;
    maskCam.priority = (mainCam.priority ?? 0) + 1;

    // Keep the mask camera's managers sorting: a new worldState draws only
    // once sorted (sortedBefore). Its skinned characters re-render on their
    // own, as WORKBUFFER_UPDATE_ALWAYS is checked per manager.
    // director.camerasMap is keyed by the inner Camera (`entity.camera.camera`),
    // not the CameraComponent.
    if (this.charTags.size === 0 || !this.scene) return;
    const director = this.scene.app.renderer?.gsplatDirector;
    const cameraData = director?.camerasMap?.get(maskCam.camera);
    if (!cameraData?.layersMap) return;
    cameraData.layersMap.forEach((layerData) => {
      const mgr = layerData?.gsplatManager;
      if (!mgr) return;
      mgr.sortNeeded = true;
    });
  }

  private _onPrerenderLayer(_camera: CameraComponent, layer: Layer, transparent: boolean): void {
    if (this._destroyed) return;
    if (!this.lowResTex || !this.maskTex) return;
    if (layer?.id !== this.composeLayerId) return;
    // EVENT_PRERENDER_LAYER fires for both opaque and transparent sub-
    // passes. The compose layer has no meshes; pick one to dedupe.
    if (transparent) return;

    const device = this.device;
    const postQuad = this.postQuad;
    if (!device || !postQuad) return;

    const dstW = Math.max(1, device.width);
    const dstH = Math.max(1, device.height);
    const sx = this.rtW / dstW;
    const sy = this.rtH / dstH;

    // Outline is only drawable when at least one char is tagged - the
    // mask is otherwise all-zero and the ring detector can never fire.
    // Cheap to set unconditionally though; the shader's early-out on
    // uOutlineThicknessPx == 0 keeps the no-outline path branch-free.
    const oc = this.outlineColor;

    const scope = device.scope;
    scope.resolve('uSourceTex').setValue(this.lowResTex);
    scope.resolve('uMaskTex').setValue(this.maskTex);
    scope.resolve('uScale').setValue([sx, sy]);
    scope.resolve('uEnvSnap').setValue(this.envSnap);
    scope.resolve('uQuantLevels').setValue(this.quantLevels);
    scope.resolve('uDitherStrength').setValue(this.ditherStrengthVal);
    scope.resolve('uOutlineColor').setValue([oc.r, oc.g, oc.b, oc.a]);
    scope.resolve('uOutlineThicknessPx').setValue(this.outlineThicknessPx);
    scope.resolve('uOutlineMode').setValue(this._outlineMode);
    scope.resolve('uOutlineSmoothness').setValue(this.outlineSmoothnessVal);
    const gl = this.gradeLift;
    const gg = this.gradeGain;
    scope.resolve('uGradeLift').setValue([gl.r, gl.g, gl.b]);
    scope.resolve('uGradeGain').setValue([gg.r, gg.g, gg.b]);
    scope.resolve('uEnvDarken').setValue(this.envDarkenVal);

    postQuad.render();
  }
}
