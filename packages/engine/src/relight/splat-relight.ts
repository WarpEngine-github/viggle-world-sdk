import {
  Color,
  Entity,
  LAYERID_IMMEDIATE,
  LAYERID_WORLD,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  SHADOW_PCF1_32F,
  SHADOW_PCF3_32F,
  SHADOW_PCF5_32F,
  SHADOW_VSM_16F,
  SHADOW_VSM_32F,
  StandardMaterial,
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

import type { Character } from '../character';
import type { PostFXFrameConfig, PostFXInstallContext, PostFXPass } from '../effects/postfx';
import { Environment } from '../loader/environment';
import { cropInputToWorldBox } from '../proxy/environment-input';
import { maxAxisScale, proxyInputFromEnvironment } from '../proxy/environment-source';
import type { EnvironmentProxySource } from '../proxy/environment-source';
import { ProxyMeshDebug } from '../proxy/proxy-debug';
import { proxyInputFromSplat } from '../proxy/splat-source';
import { buildProxyMesh, defaultProxySettings } from '../proxy/voxelizer';
import type { ProxyMeshInput, ProxyMeshResult, ProxySurfaceStyle } from '../proxy/voxelizer';
import type { Scene } from '../scene';
import { ArmatureSkinAdapter } from '../skeletal/armature-skin-adapter';
import type { SkinnedMeshData } from '../skeletal/armature-skin-adapter';
import type { Splat } from '../splat/splat';
import { RelightPass } from './relight-pass';
import type { EnvironmentRefreshMode, RelightConsumer } from './relight-pass';

/**
 * What {@link SplatRelight.preview} shows.
 *
 * - `off` - nothing.
 * - `voxels` - the exact voxel cell boundary as lines, blocky and unsmoothed
 *   whatever surface the proxy uses. This is what `voxelSize` is judged
 *   against.
 * - `mesh` - the proxy surface the lighting is rendered from, solid, with its
 *   own material and its own camera headlight, drawn over the splats and
 *   skinned by the same palette as the real proxy.
 *
 * @group Lighting
 */
export type RelightPreviewMode = 'off' | 'voxels' | 'mesh';

/**
 * Something {@link SplatRelight.add} can light: a {@link Character}, whose
 * proxy is skinned by its armature; a lone {@link Splat}, whose proxy is a
 * static mesh under the splat's entity; or an {@link Environment}, whose proxy
 * is a static mesh under the environment's entity, voxelized coarser and with
 * a solid floor - see {@link ENVIRONMENT_PROXY_DEFAULTS}.
 *
 * @group Lighting
 */
export type RelightTarget = Character | Splat | Environment;

/**
 * {@link RelightLightOptions.shadowType} as PlayCanvas's own constants.
 *
 * Named rather than numeric on the option, because the numbers are an internal
 * enum whose spelling has changed across PlayCanvas versions (`SHADOW_VSM16`
 * is now `SHADOW_VSM_16F`) and a consumer should not have to track that to ask
 * for a soft shadow.
 */
const SHADOW_TYPES = {
  pcf1: SHADOW_PCF1_32F,
  pcf3: SHADOW_PCF3_32F,
  pcf5: SHADOW_PCF5_32F,
  vsm16: SHADOW_VSM_16F,
  vsm32: SHADOW_VSM_32F,
} as const;

/**
 * The voxelizer settings an {@link Environment} target takes in place of the
 * component-wide ones, unless {@link RelightTargetOptions.proxy} overrides
 * them. Every other knob follows the component.
 *
 * - `voxelSize: 0.1` m. The character default of 0.025 m resolves a finger; a
 *   receiver for a character's shadow needs the floor and the walls, not their
 *   texture. Measured on the bundled `chamber.spz` (1.2M splats) cropped to its
 *   room: 0.03 m is ~500k triangles and ~100 ms to build; 0.1 m is 91k
 *   triangles in ~33 ms, and the shadow edge on the floor is set by the
 *   character's proxy and the capture's splat size, not by this.
 * - `castShadows: false` - see {@link RelightTargetOptions.castShadows}.
 * - `floorFill: true`. A raw voxelization of a capture is a shell: the ground
 *   is one voxel thick, with pinholes wherever the capture was sparse, and a
 *   shadow falls straight through them.
 *
 * Voxel sizes are in WORLD metres for every static target: an environment
 * loaded at scale 2 is voxelized at half the size in its own units.
 *
 * @group Lighting
 */
export const ENVIRONMENT_PROXY_DEFAULTS: Readonly<Pick<RelightProxySettings, 'voxelSize' | 'floorFill'>> =
  Object.freeze({ voxelSize: 0.1, floorFill: true });

/**
 * The LOD level an environment bundle's proxy is voxelized from when
 * {@link RelightTargetOptions.lod} is omitted: `auto`, the coarsest level that
 * is dense enough for the voxel size.
 *
 * Neither end is right on its own. Measured on PlayCanvas's `playbot` bundle
 * (7 levels, 500k splats at level 0), against the finest level's surface:
 *
 * | voxel | level | splats | read   | covers |
 * |-------|-------|--------|--------|--------|
 * | 0.1   | 0     | 500k   | 674 ms | 100%   |
 * | 0.1   | 6     | 1.9k   | 13 ms  | 99.96% |
 * | 0.03  | 3     | 31k    | 59 ms  | 99.9%  |
 * | 0.03  | 5     | 3k     | 12 ms  | 87%    |
 * | 0.03  | 6     | 1.9k   | 13 ms  | 70%    |
 *
 * The finest level is 50x the read for nothing a proxy can resolve; the
 * coarsest leaks as soon as the voxel is small against its splat spacing.
 * What decides it is density, so that is what `auto` measures.
 *
 * @group Lighting
 */
export const ENVIRONMENT_DEFAULT_LOD: number | 'coarsest' | 'auto' = 'auto';

/**
 * Per-target options for {@link SplatRelight.add}.
 *
 * @group Lighting
 */
export interface RelightTargetOptions {
  /**
   * Voxelizer settings for this target only, over the component's (and, for
   * an environment, over {@link ENVIRONMENT_PROXY_DEFAULTS}). Rebuilds only
   * this target. See {@link SplatRelight.setTargetProxySettings}.
   */
  proxy?: Partial<RelightProxySettings>;
  /**
   * Environment only: the world-space box the proxy is built from. Splats
   * outside it are ignored, and so is anything outside the environment's own
   * render clip bounds.
   *
   * The voxelizer builds one dense grid over everything it is given, and a
   * capture's extent is set by its floaters: `chamber.spz`'s room is 6 m wide
   * but its splats span 21 m, which coarsens a 0.03 m request to 0.15 m. On a
   * whole game map (`survivor_map.spz` spans 560 x 350 x 830 m) no voxel size
   * is both buildable and useful - crop it to where characters walk.
   */
  bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  /**
   * Environment LOD bundles only: the level to voxelize. `0` is the finest;
   * `'coarsest'` the last; `'auto'` the coarsest that is dense enough for the
   * voxel size, re-chosen when the voxel size or opacity threshold moves.
   * Default {@link ENVIRONMENT_DEFAULT_LOD}.
   */
  lod?: number | 'coarsest' | 'auto';
  /**
   * Whether this target's proxy casts into the lights' shadow maps. Default
   * `true` for a character or a splat, `false` for an
   * environment.
   *
   * A capture's own occlusion is already in its baked colours - a wall's
   * shadow on the floor is IN the floor's colour - so an environment that also
   * cast would darken it twice. Worse, a closed room's walls and ceiling put
   * its whole interior, and every character in it, in the key light's shadow.
   * What a capture is missing is the shadow of what moves through it, which is
   * what the default keeps. Turn it on to have a character walk into a
   * capture's shade.
   */
  castShadows?: boolean;
  /**
   * Draw this proxy into the screen-space lighting/visibility receiver maps.
   * Default true. Set false for a shadow-only caster whose splats keep their
   * baked appearance: its coarse silhouette must not overwrite lighting on
   * environment splats behind it. It still casts into the shadow maps.
   */
  lightingReceiver?: boolean;
}

/**
 * Where a target's proxy geometry came from. See {@link SplatRelight.proxySource}.
 *
 * @group Lighting
 */
export interface RelightProxySource {
  /** Splats handed to the voxelizer, after any crop. */
  splats: number;
  /** Splats read from the target, before the crop. */
  sourceSplats: number;
  /** LOD level read, `null` unless the target is an LOD bundle. */
  lodLevel: number | null;
  /** Levels available; `1` unless the target is an LOD bundle. */
  lodLevels: number;
  /** Milliseconds reading the source took - fetches included for a bundle. */
  loadMs: number;
}

/**
 * The voxelizer knobs {@link SplatRelight} exposes. Every one of them rebuilds
 * the proxy mesh. See {@link ProxySettings} for what each does.
 *
 * @group Lighting
 */
export interface RelightProxySettings {
  /** `blocky` keeps voxel faces; `smooth` runs surface nets. Default `smooth`. */
  surface: ProxySurfaceStyle;
  /** Voxel edge, metres. Default `0.025`. */
  voxelSize: number;
  /** Splats below this alpha do not occupy a voxel. Default `0.04`. */
  opacityThreshold: number;
  /** Voxel rings grown around the occupied set. Default `0`. */
  dilate: number;
  /** Relaxation passes over the surface. Default `3`. */
  smoothIterations: number;
  /** Close the underside of the lowest occupied layer. Default `false`. */
  floorFill: boolean;
}

/**
 * The key light {@link SplatRelight} owns, as a real PlayCanvas directional
 * light that both meshes and the proxy see.
 *
 * @group Lighting
 */
export interface RelightLightOptions {
  /** Azimuth in degrees. 0 = +Z, 90 = +X. Default `30`. */
  azimuth?: number;
  /** Elevation in degrees. 0 = horizon, 90 = overhead. Default `60`. */
  elevation?: number;
  /** CSS hex or a `Color`. Default `#fff2d9`. */
  color?: string | Color;
  /** Default `1`. */
  intensity?: number;
  /** Shadow map for meshes AND the proxy's cast shadows. Default `true`. */
  castShadows?: boolean;
  /** Metres the shadow map covers from the camera. PlayCanvas default when omitted. */
  shadowDistance?: number;
  /** Shadow map texels a side. PlayCanvas default when omitted. */
  shadowResolution?: number;
  /** PlayCanvas default when omitted. */
  shadowBias?: number;
  /** PlayCanvas default when omitted. */
  normalOffsetBias?: number;
  /**
   * How the shadow map is filtered, which is where a soft shadow EDGE comes
   * from. PlayCanvas default (`pcf3`) when omitted.
   *
   * This is the lever to reach for before the compose blur. The softness
   * happens in the shadow test, so it widens the penumbra and leaves the
   * terminator across the subject exactly as sharp as it was;
   * {@link SplatRelight.blurRadius} cannot separate the two, because by the
   * time it runs they are the same channel.
   *
   * `vsm16`/`vsm32` are the genuinely soft ones and take
   * {@link vsmBlurSize} with them. They can light-leak through thin geometry,
   * which a voxelized proxy has none of - its thinnest wall is a voxel.
   */
  shadowType?: 'pcf1' | 'pcf3' | 'pcf5' | 'vsm16' | 'vsm32';
  /** Blur kernel for the `vsm` shadow types. PlayCanvas default when omitted. */
  vsmBlurSize?: number;
  /**
   * How dark the shadow map is allowed to make a surface, `0..1`. PlayCanvas
   * default (`1`) when omitted.
   *
   * The other half of "the shadow is too black": this lifts it at the light,
   * so it applies to the proxy render and therefore to everything read out of
   * the lighting channel - meshes in the scene included.
   */
  shadowIntensity?: number;
  /**
   * The app's own layers this light also lights, beside the relight layers
   * the component adds itself. Default `[LAYERID_WORLD]`.
   */
  layers?: number[];
}

/**
 * A point light. See {@link SplatRelight.addPointLight}.
 *
 * @group Lighting
 */
export interface RelightPointLightOptions {
  position?: { x: number; y: number; z: number };
  /** CSS hex or a `Color`. Default white. */
  color?: string | Color;
  /** Default `1`. */
  intensity?: number;
  /** Hard cutoff distance, metres. Default `5`. */
  range?: number;
  /** Default `false`: omni shadows are six renders a frame. */
  castShadows?: boolean;
  /** App layers it also lights. Default `[LAYERID_WORLD]`. */
  layers?: number[];
}

/**
 * Per-target overrides of the scene-wide relight knobs. See
 * {@link SplatRelight.setParams}.
 *
 * @group Lighting
 */
export interface RelightTargetParams {
  strength?: number;
  shadowStrength?: number;
  ambient?: number;
  tint?: string | Color;
}

/**
 * Options for {@link SplatRelight.create}. Every one of them is also a live
 * property; the property notes say which rebuild.
 *
 * @group Lighting
 */
export interface SplatRelightOptions {
  /** See {@link SplatRelight.strength}. Default `1`. */
  strength?: number;
  /** See {@link SplatRelight.shadowStrength}. Default `1`. */
  shadowStrength?: number;
  /** See {@link SplatRelight.setTint}. Default white. */
  tint?: string | Color;
  /** See {@link SplatRelight.ambient}. Default `0`. */
  ambient?: number;
  /** See {@link SplatRelight.referenceLuminance}. Default `1`. */
  referenceLuminance?: number;
  /** See {@link SplatRelight.blur}. Default `true`. */
  blur?: boolean;
  /** See {@link SplatRelight.blurRadius}. Default `1`. */
  blurRadius?: number;
  /** See {@link SplatRelight.shadowBlurRadius}. Default `1`. */
  shadowBlurRadius?: number;
  /**
   * The owned key light. Default: one at the {@link RelightLightOptions}
   * defaults. `null` owns none - bring your own and hand them to
   * {@link SplatRelight.addLight}.
   */
  light?: RelightLightOptions | null;
  /**
   * Sky fill. Written to the scene's
   * ambient light, which is what both meshes and the relight compose read, so
   * the two can never disagree. Omit to leave the scene's ambient alone.
   */
  sky?: { color?: string | Color; intensity?: number };
  /** See {@link SplatRelight.resolutionScale}. Default `0.5`. */
  resolutionScale?: number;
  /** See {@link SplatRelight.receiveShadows}. Default `false`. */
  receiveShadows?: boolean;
  /** Voxelizer knobs. Defaults are {@link defaultProxySettings}. */
  proxy?: Partial<RelightProxySettings>;
  /** See {@link SplatRelight.preview}. Default `off`. */
  preview?: RelightPreviewMode;
  /** Camera the splats are viewed through. Default `scene.cameraEntity`. */
  mainCamera?: Entity;
  /** See {@link SplatRelight.environmentRefresh}. Default `auto`. */
  environmentRefresh?: EnvironmentRefreshMode;
}

/**
 * Where the `mesh` preview draws. Immediate is already in every camera and
 * renders AFTER World's transparent sublayer, where the splats are - so the
 * preview sits over them on both backends, and no new layer has to be slotted
 * into the composition's render order. It is not a relight layer, which is
 * what keeps the preview out of the lighting.
 */
const PREVIEW_LAYER = LAYERID_IMMEDIATE;

/** Tags on the entities this component creates - identity, never visibility. */
const PROXY_TAG = 'splat-relight-proxy';
const PREVIEW_TAG = 'splat-relight-preview';

/** One lit subject, and everything built for it. */
interface TargetEntry {
  readonly target: RelightTarget;
  readonly character: Character | null;
  readonly environment: Environment | null;
  /** The node a static proxy is built in the local space of; `null` for a character. */
  readonly node: Entity | null;
  params: RelightTargetParams | null;
  /** Splats the params were last pushed to - re-pushed when LODs arrive. */
  pushedSplats: number;
  /** This target's voxelizer overrides. */
  proxy: Partial<RelightProxySettings>;
  readonly bounds: RelightTargetOptions['bounds'];
  readonly lod: number | 'coarsest' | 'auto';
  readonly castShadows: boolean;
  readonly lightingReceiver: boolean;

  // ── CPU, survives install cycles ──
  /** An environment's uncropped read, once it has arrived. */
  source: EnvironmentProxySource | null;
  /** What `source` was read for; a different key re-reads. */
  sourceKey: string;
  /** The key of the read in flight, `''` when none is. */
  sourcePending: string;
  input: ProxyMeshInput | null;
  /** The crop `input` was cut with - clip bounds included. */
  inputKey: string;
  mesh: ProxyMeshResult | null;
  meshKey: string;
  voxels: ProxyMeshResult | null;
  voxelsKey: string;
  /** Settled once `mesh` is first built, or when the source fails. */
  readonly ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (err: unknown) => void;
  /** Last pose or world transform seen by the change probe. */
  motion: Float32Array | null;
  /** Internal geometry swap, for A/B-ing the voxelizer on the dev page. */
  override: SkinnedMeshData | null;

  // ── GPU, only while installed ──
  gpuKey: string;
  adapter: ArmatureSkinAdapter | null;
  staticEntity: Entity | null;
  staticMesh: Mesh | null;
  proxyInstance: MeshInstance | null;
  previewEntity: Entity | null;
  previewInstance: MeshInstance | null;
  debug: ProxyMeshDebug | null;
  /** What `debug` was last handed - `setVoxels` re-derives the edge list. */
  debugVoxels: ProxyMeshResult | null;

  readonly destroyNode: Entity;
  readonly onDestroy: () => void;
}

interface LightEntry {
  /** The light's layers without any relight layer in them. */
  base: number[];
  /** Created by this component, so destroyed by it. */
  owned: boolean;
  onDestroy: () => void;
  /** Last state seen by the change probe. */
  snapshot: Float32Array;
}

/**
 * Relighting for gaussian splats: one component that voxelizes a proxy mesh
 * from the splats, renders it with real PlayCanvas lights into a screen-space
 * lighting texture, and has every splat sample that texture.
 *
 * ```ts
 * const relight = SplatRelight.create(scene, {
 *   light: { azimuth: 38, elevation: 38, intensity: 2.2 },
 *   receiveShadows: true,
 * });
 * relight.add(character);
 * relight.voxelSize = 0.04;   // rebuilds the proxy next frame
 * relight.strength = 0.5;     // uniform, next frame
 * relight.preview = 'mesh';
 * ```
 *
 * ── Two kinds of parameter ────────────────────────────────────────────────
 * Uniform-only knobs - `strength`, `shadowStrength`, `ambient`, tint,
 * `referenceLuminance`, `blur`, the key light's direction, colour and
 * intensity, the sky fill - are plain clamped setters and take effect on the
 * next frame with nothing reallocated.
 *
 * Resource-shape knobs - `resolutionScale`, `receiveShadows`, and every
 * voxelizer setting - only mark the component dirty. One idempotent allocator
 * runs at the start of the next frame (or on {@link rebuild}): it re-voxelizes
 * what is stale, tears down whatever holds a reference to the old resource
 * FIRST (the pass's shadowless twins, the preview's shared skin), and only
 * then builds the replacement. Several knobs moved in one frame cost one
 * rebuild.
 *
 * ── Lifecycle ─────────────────────────────────────────────────────────────
 * A non-capturing {@link PostFXPass}: {@link create} adds it to
 * `scene.postfx`, whose chain rebuilds (a resize, another effect added) cycle
 * it through `uninstall` / `install`. Uninstall releases every GPU resource;
 * the voxelized geometry, the targets and every setting survive, so a
 * reinstall rebuilds GPU state without re-voxelizing. {@link destroy} is final.
 * All state lives on the instance - never in module globals.
 *
 * ── Why generation lives here ─────────────────────────────────────────────
 * The proxy exists for lighting only. A collision mesh cannot share it (a
 * convex collider is capped at 255 hull polygons; lighting wants the detail),
 * so there is no second consumer to split a mesh component out for, and no
 * mesh override, build-at-runtime or save-mesh switch to bridge one.
 *
 * @group Lighting
 */
export class SplatRelight implements PostFXPass {
  readonly capturesScene = false;

  // ── Uniform-only ──
  private _strength: number;
  private _shadowStrength: number;
  private readonly _tint = new Color(1, 1, 1);
  private _ambient: number;
  private _referenceLuminance: number;
  private _blurRadius: number;
  private _shadowBlurRadius: number;
  private _debug = 0;
  private _enabled = true;
  private _environmentRefresh: EnvironmentRefreshMode;
  private _lightAzimuth: number;
  private _lightElevation: number;
  private readonly _lightColor = new Color(1, 0.95, 0.85);
  private _lightIntensity: number;
  private readonly _skyColor: Color | null;
  private _skyIntensity: number;

  // ── Resource-shape ──
  private _resolutionScale: number;
  private _receiveShadows: boolean;
  private readonly _proxy: RelightProxySettings;
  private _proxyKey: string;
  private _dirty = true;

  // ── Preview ──
  private _preview: RelightPreviewMode;

  private readonly _lightOpts: RelightLightOptions | null;
  private readonly _mainCameraOpt: Entity | undefined;

  // ── Runtime ──
  private _scene: Scene | null = null;
  private _pass: RelightPass | null = null;
  private _previewMaterial: StandardMaterial | null = null;
  private _headlight: Entity | null = null;
  private _keyLight: Entity | null = null;
  private readonly _targets = new Map<RelightTarget, TargetEntry>();
  private readonly _lights = new Map<Entity, LightEntry>();
  private readonly _lightScratch = new Float32Array(LIGHT_SNAPSHOT);
  private _updateHandler: (() => void) | null = null;
  private _installed = false;
  private _destroyed = false;
  private _lastRebuildMs = 0;

  /**
   * Build the component and add it to `scene.postfx`, which installs it.
   *
   * Install throws (and PostFX logs it) when the device cannot render to
   * half-float - lighting exceeds 1 and the target must not clamp it.
   */
  static create(scene: Scene, opts: SplatRelightOptions = {}): SplatRelight {
    return scene.postfx.add(new SplatRelight(opts));
  }

  /** Construct a detached component. Attach with `scene.postfx.add(this)`. */
  constructor(opts: SplatRelightOptions = {}) {
    this._strength = clamp01(opts.strength ?? 1);
    this._shadowStrength = clamp01(opts.shadowStrength ?? 1);
    if (opts.tint !== undefined) setColor(this._tint, opts.tint);
    this._ambient = Math.max(0, opts.ambient ?? 0);
    this._referenceLuminance = Math.max(opts.referenceLuminance ?? 1, 1e-4);
    const blurDefault = (opts.blur ?? true) ? 1 : 0;
    this._blurRadius = Math.max(0, opts.blurRadius ?? blurDefault);
    this._shadowBlurRadius = Math.max(0, opts.shadowBlurRadius ?? blurDefault);
    this._environmentRefresh = opts.environmentRefresh ?? 'auto';

    this._lightOpts = opts.light === null ? null : { ...opts.light };
    this._lightAzimuth = opts.light?.azimuth ?? 30;
    this._lightElevation = opts.light?.elevation ?? 60;
    if (opts.light?.color !== undefined) setColor(this._lightColor, opts.light.color);
    this._lightIntensity = Math.max(0, opts.light?.intensity ?? 1);

    this._skyColor = opts.sky ? new Color(0.55, 0.62, 0.78) : null;
    if (opts.sky?.color !== undefined && this._skyColor) setColor(this._skyColor, opts.sky.color);
    this._skyIntensity = Math.max(0, opts.sky?.intensity ?? 0.35);

    this._resolutionScale = clamp(opts.resolutionScale ?? 0.5, 0.05, 1);
    this._receiveShadows = opts.receiveShadows ?? false;
    this._proxy = {
      surface: opts.proxy?.surface ?? defaultProxySettings.surface,
      voxelSize: opts.proxy?.voxelSize ?? defaultProxySettings.voxelSize,
      opacityThreshold: opts.proxy?.opacityThreshold ?? defaultProxySettings.opacityThreshold,
      dilate: opts.proxy?.dilate ?? defaultProxySettings.dilate,
      smoothIterations: opts.proxy?.smoothIterations ?? defaultProxySettings.smoothIterations,
      floorFill: opts.proxy?.floorFill ?? defaultProxySettings.floorFill,
    };
    this._sanitizeProxy();
    this._proxyKey = proxyKey(this._proxy);

    this._preview = opts.preview ?? 'off';
    this._mainCameraOpt = opts.mainCamera;
  }

  // ── PostFXPass lifecycle ────────────────────────────────────────────────

  /** Caches the scene. Requests nothing from CameraFrame. */
  configureFrame(scene: Scene, _rendering: PostFXFrameConfig): void {
    this._scene = scene;
  }

  /** Builds the pass, the key light, and every target's proxy and preview. */
  install(scene: Scene, _ctx: PostFXInstallContext): void {
    if (this._installed || this._destroyed) return;
    this._scene = scene;

    const mat = new StandardMaterial();
    mat.name = 'splat-relight-preview';
    mat.diffuse = new Color(0.13, 0.62, 0.72);
    // A floor under the lit shade, so a preview facing away from every light
    // still reads as a surface rather than a hole in the frame.
    mat.emissive = new Color(0.03, 0.12, 0.15);
    mat.specular = new Color(0, 0, 0);
    mat.gloss = 0;
    mat.useMetalness = false;
    mat.useSkybox = false;
    mat.useFog = false;
    mat.update();
    this._previewMaterial = mat;

    // The preview's own light: parented to the camera so the surface always
    // reads, and a member of the preview layer ONLY - no relight layer, so it
    // cannot reach the proxy, and not World, so it cannot touch the scene.
    const camera = this._mainCameraOpt ?? scene.cameraEntity;
    const headlight = new Entity('splat-relight-preview-light');
    headlight.addComponent('light', {
      type: 'directional',
      color: new Color(1, 1, 1),
      intensity: 1.2,
      castShadows: false,
      layers: [PREVIEW_LAYER],
    });
    camera.addChild(headlight);
    // Local -Y is the shine direction; this tips it to down the view axis
    // from above-left, steep enough that folds and limbs keep their relief. A
    // light straight down the view axis shades the proxy flat.
    headlight.setLocalEulerAngles(45, -45, 0);
    headlight.enabled = this._preview === 'mesh';
    this._headlight = headlight;

    if (this._lightOpts && !this._keyLight) this._createKeyLight(scene);
    this._applySky();

    this._updateHandler = () => this._onUpdate();
    scene.app.on('update', this._updateHandler);

    this._installed = true;
    this._dirty = true;
    try {
      this._ensure();
    } catch (err) {
      // Leave nothing half-built behind for PostFX's next rebuild to trip on.
      this._release();
      throw err;
    }
  }

  /** Releases every GPU resource. Settings, targets and geometry survive. */
  uninstall(_scene: Scene): void {
    if (!this._installed) return;
    this._release();
  }

  /** Final teardown. Routes through `scene.postfx` when attached. Safe twice. */
  destroy(): void {
    if (this._destroyed) return;
    if (this._installed && this._scene) this._scene.postfx.remove(this);
    if (this._installed) this._release();
    this._destroyed = true;

    for (const entry of this._targets.values()) entry.destroyNode.off('destroy', entry.onDestroy);
    this._targets.clear();

    for (const [light, entry] of this._lights) {
      light.off('destroy', entry.onDestroy);
      if (entry.owned) light.destroy();
    }
    this._lights.clear();
    this._keyLight = null;
  }

  // ── Targets ─────────────────────────────────────────────────────────────

  /**
   * Light a character, a splat or an environment. A character or a splat is
   * voxelized now (a few to a few tens of milliseconds, by voxel size), so its
   * proxy is lit on the next frame. An environment's splats are read first -
   * for an LOD bundle that is a fetch - and it is voxelized on the first frame
   * after they arrive.
   *
   * Idempotent: a second call returns the first call's promise and ignores its
   * options. Drops the target when its entity is destroyed.
   *
   * @returns Settles once the target's proxy is first built; rejects when an
   *   environment's splats cannot be read.
   */
  add(target: RelightTarget, opts: RelightTargetOptions = {}): Promise<void> {
    const existing = this._targets.get(target);
    if (existing) return existing.ready;
    if (this._destroyed) return Promise.reject(new Error('[SplatRelight] add after destroy'));
    const environment = target instanceof Environment ? target : null;
    const character = !environment && isCharacter(target) ? target : null;
    const node = character ? null : (target as Splat | Environment).entity;
    const destroyNode = character ? character.armature.entity : node!;
    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const entry: TargetEntry = {
      target,
      character,
      environment,
      node,
      params: null,
      pushedSplats: -1,
      proxy: stripUndefined(opts.proxy ?? {}),
      bounds: opts.bounds ?? null,
      lod: opts.lod ?? ENVIRONMENT_DEFAULT_LOD,
      castShadows: opts.castShadows ?? !environment,
      lightingReceiver: opts.lightingReceiver ?? true,
      source: null,
      sourceKey: '',
      sourcePending: '',
      input: null,
      inputKey: '',
      mesh: null,
      meshKey: '',
      voxels: null,
      voxelsKey: '',
      ready,
      resolveReady,
      rejectReady,
      motion: null,
      override: null,
      gpuKey: '',
      adapter: null,
      staticEntity: null,
      staticMesh: null,
      proxyInstance: null,
      previewEntity: null,
      previewInstance: null,
      debug: null,
      debugVoxels: null,
      destroyNode,
      onDestroy: () => this.remove(target),
    };
    destroyNode.once('destroy', entry.onDestroy);
    this._targets.set(target, entry);
    this._dirty = true;
    this._ensure();
    return ready;
  }

  /** Stop lighting a target and free its proxy. No-op when unknown. */
  remove(target: RelightTarget): void {
    const entry = this._targets.get(target);
    if (!entry) return;
    entry.destroyNode.off('destroy', entry.onDestroy);
    this._releaseTarget(entry);
    for (const consumer of consumersOf(entry)) this._pass?.setConsumerParams(consumer, null);
    this._targets.delete(target);
    this._pushParams();
    // A removed environment's proxy no longer occludes anything, and a removed
    // character no longer shadows the environments that are left.
    this._pass?.invalidateEnvironments();
  }

  /**
   * What one target is actually lit with: its overrides resolved against the
   * scene-wide knobs, every field present. `null` when the target is unknown.
   *
   * The pair to {@link setParams}, and what a panel over these knobs reads so
   * it does not have to keep a second copy of them. A copy is what goes stale:
   * a target added without overrides follows the component, and a panel
   * holding its own numbers would keep showing the ones it last wrote while
   * the scene moved underneath. The tint is a copy, so mutating it changes
   * nothing.
   */
  params(target: RelightTarget): Required<Omit<RelightTargetParams, 'tint'>> & { tint: Color } | null {
    const entry = this._targets.get(target);
    if (!entry) return null;
    const p = entry.params;
    return {
      strength: clamp01(p?.strength ?? this._strength),
      shadowStrength: clamp01(p?.shadowStrength ?? this._shadowStrength),
      ambient: Math.max(0, p?.ambient ?? this._ambient),
      tint: p?.tint !== undefined ? setColor(new Color(), p.tint) : this._tint.clone(),
    };
  }

  /**
   * Override the scene-wide knobs for one target, across all its LOD and
   * variant splats. `null` drops the override. Uniform-only.
   */
  setParams(target: RelightTarget, params: RelightTargetParams | null): void {
    const entry = this._targets.get(target);
    if (!entry) return;
    entry.params = params ? { ...entry.params, ...stripUndefined(params) } : null;
    entry.pushedSplats = -1;
    this._pushParams();
  }

  /**
   * The voxelized proxy for a target - vertex and triangle counts, voxel
   * grid, build time. `null` for an unknown target or before its first build.
   */
  proxyMesh(target: RelightTarget): ProxyMeshResult | null {
    return this._targets.get(target)?.mesh ?? null;
  }

  /**
   * What a target's proxy was built from: splat counts before and after the
   * crop, and for an environment bundle the LOD level read and what reading it
   * cost. `null` for an unknown target or before its source is in.
   */
  proxySource(target: RelightTarget): RelightProxySource | null {
    const entry = this._targets.get(target);
    if (!entry?.input) return null;
    const splats = Math.floor(entry.input.positions.length / 3);
    const src = entry.source;
    return {
      splats,
      sourceSplats: src ? Math.floor(src.input.positions.length / 3) : splats,
      lodLevel: src?.lodLevel ?? null,
      lodLevels: src?.lodLevels ?? 1,
      loadMs: src?.loadMs ?? 0,
    };
  }

  /**
   * The voxelizer settings one target is built with: the component's, then
   * {@link ENVIRONMENT_PROXY_DEFAULTS} for an environment, then the target's
   * own. A copy; `null` for an unknown target.
   */
  targetProxySettings(target: RelightTarget): RelightProxySettings | null {
    const entry = this._targets.get(target);
    return entry ? this._settingsFor(entry) : null;
  }

  /**
   * Override voxelizer settings for one target; `null` drops every override.
   * Only that target rebuilds, on the next frame or {@link rebuild}.
   */
  setTargetProxySettings(target: RelightTarget, next: Partial<RelightProxySettings> | null): void {
    const entry = this._targets.get(target);
    if (!entry) return;
    entry.proxy = next ? { ...entry.proxy, ...stripUndefined(next) } : {};
    this._dirty = true;
  }

  // ── Lights ──────────────────────────────────────────────────────────────

  /**
   * The owned directional key light, or `null` when built with
   * `light: null` or not yet installed. For the rarer PlayCanvas settings -
   * cascades, shadow type - that this component does not wrap.
   */
  get keyLight(): Entity | null { return this._keyLight; }

  /**
   * Have an existing PlayCanvas light reach the proxy.
   *
   * A light only reaches a mesh when the light's `layers` include the mesh's
   * layer; the proxy's layers belong to this component and are recreated on
   * every install, so the component re-stamps registered lights itself. Change
   * a registered light's `layers` by removing and re-adding it.
   */
  addLight(light: Entity): void {
    this._registerLight(light, false);
  }

  /** Undo {@link addLight}: restores the light's own layers. */
  removeLight(light: Entity): void {
    const entry = this._lights.get(light);
    if (!entry) return;
    light.off('destroy', entry.onDestroy);
    if (light.light) light.light.layers = entry.base;
    this._lights.delete(light);
    if (light === this._keyLight) this._keyLight = null;
  }

  /**
   * Create an omni light that reaches both the app's layers and the proxy.
   * Owned: destroyed with the component. Toggle it with `entity.enabled`.
   */
  addPointLight(opts: RelightPointLightOptions = {}): Entity {
    const scene = this._scene;
    if (!scene) throw new Error('[SplatRelight] addPointLight before the component was added to a scene');
    const color = new Color(1, 1, 1);
    if (opts.color !== undefined) setColor(color, opts.color);
    const entity = new Entity('splat-relight-point');
    entity.addComponent('light', {
      type: 'omni',
      color,
      intensity: opts.intensity ?? 1,
      range: opts.range ?? 5,
      castShadows: opts.castShadows ?? false,
      layers: [...(opts.layers ?? [LAYERID_WORLD])],
    });
    if (opts.position) entity.setPosition(opts.position.x, opts.position.y, opts.position.z);
    scene.app.root.addChild(entity);
    this._registerLight(entity, true);
    return entity;
  }

  // ── Uniform-only knobs ──────────────────────────────────────────────────

  /**
   * How far the proxy lighting replaces the baked look, 0..1. Independent of
   * {@link shadowStrength}: strength 0 with shadow strength 1 keeps the baked
   * colours and darkens only where a proxy blocks the light - the look for an
   * environment capture, whose baked lighting is real. With both at `0` on
   * every target the pass stops rendering altogether - a true no-op in pixels
   * and in cost.
   */
  get strength(): number { return this._strength; }
  set strength(v: number) { this._strength = clamp01(v); this._pushParams(); }

  /**
   * Cast-shadow depth on the splats, 0..1, independent of {@link strength}.
   * Inert unless {@link receiveShadows} is on.
   */
  get shadowStrength(): number { return this._shadowStrength; }
  set shadowStrength(v: number) { this._shadowStrength = clamp01(v); this._pushParams(); }

  /** Floor under the light term, so faces turned from every light are not black. */
  get ambient(): number { return this._ambient; }
  set ambient(v: number) { this._ambient = Math.max(0, v); this._pushParams(); }

  /** Tint on the received light only, never the base colour. */
  getTint(): Color { return this._tint.clone(); }
  setTint(c: string | Color): void { setColor(this._tint, c); this._pushParams(); }

  /**
   * The proxy brightness that counts as "normally lit". Lighting is divided
   * by it, so strength moves contrast rather than exposure. Calibrate it to
   * the scene's key light.
   */
  get referenceLuminance(): number { return this._referenceLuminance; }
  set referenceLuminance(v: number) {
    this._referenceLuminance = Math.max(v, 1e-4);
    this._pushParams();
  }

  /** The 3x3 tent over the lighting texture that keeps animated lighting stable. */
  get blur(): boolean { return this._blurRadius > 0 || this._shadowBlurRadius > 0; }
  set blur(v: boolean) {
    this._blurRadius = v ? 1 : 0;
    this._shadowBlurRadius = v ? 1 : 0;
    this._pushParams();
  }

  /**
   * Radius of the tent over the lighting, in texels of the proxy target.
   * Default `1`; `0` is a single tap and the raw bake.
   *
   * The knob that softens a cast shadow being read through {@link strength}
   * alone - the shadow map lives in this channel - and it softens the
   * terminator across the subject with it. For a soft shadow and a crisp
   * subject, raise {@link shadowBlurRadius} instead, or filter the shadow map
   * itself with {@link RelightLightOptions.shadowType}.
   */
  get blurRadius(): number { return this._blurRadius; }
  set blurRadius(v: number) { this._blurRadius = Math.max(0, v); this._pushParams(); }

  /**
   * Radius of the tent over the shadow-visibility channel, in texels of the
   * proxy target. Default `1`.
   *
   * Inert while {@link shadowStrength} is 0 or the pass was built without
   * `receiveShadows`, because nothing reads that channel then.
   */
  get shadowBlurRadius(): number { return this._shadowBlurRadius; }
  set shadowBlurRadius(v: number) { this._shadowBlurRadius = Math.max(0, v); this._pushParams(); }

  /** Suspend the effect without dropping anything. */
  get enabled(): boolean { return this._enabled; }
  set enabled(v: boolean) { this._enabled = v; this._pushParams(); }

  /**
   * When environments re-copy their work buffer, which is what moves their
   * relit colour - see {@link EnvironmentRefreshMode}. Default `auto`: on the
   * frames where a target, a registered light, the camera or a knob moved,
   * and never while all of them hold still.
   *
   * A re-copy recomputes the WHOLE environment, so in `auto` an environment
   * under a walking character re-copies every frame the character moves. That
   * is the price of its shadow moving with it.
   */
  get environmentRefresh(): EnvironmentRefreshMode { return this._environmentRefresh; }
  set environmentRefresh(v: EnvironmentRefreshMode) { this._environmentRefresh = v; this._pushParams(); }

  /**
   * Re-copy every environment now and for the next few frames. For changes
   * the component cannot see: a mesh this component does not know of that
   * casts into the key light's shadow map, moving or toggling.
   */
  invalidateEnvironments(): void { this._pass?.invalidateEnvironments(); }

  /** Frames on which environments re-copied, since the pass was last built. A cost probe. */
  get environmentRefreshFrames(): number { return this._pass?.environmentRefreshFrames ?? 0; }

  /**
   * Paint the splats with the relight sample instead of lighting them:
   * `1` the lighting, `2` the shadow visibility, `0` off. Diagnostic.
   */
  get debug(): number { return this._debug; }
  set debug(v: number) { this._debug = v === 1 || v === 2 ? v : 0; this._pushParams(); }

  /** Key light azimuth, degrees. 0 = +Z, 90 = +X. */
  get lightAzimuth(): number { return this._lightAzimuth; }
  set lightAzimuth(v: number) { this._lightAzimuth = v; this._applyKeyLight(); }

  /** Key light elevation, degrees, -90..90. */
  get lightElevation(): number { return this._lightElevation; }
  set lightElevation(v: number) { this._lightElevation = clamp(v, -90, 90); this._applyKeyLight(); }

  /** Key light intensity. */
  get lightIntensity(): number { return this._lightIntensity; }
  set lightIntensity(v: number) { this._lightIntensity = Math.max(0, v); this._applyKeyLight(); }

  getLightColor(): Color { return this._lightColor.clone(); }
  setLightColor(c: string | Color): void { setColor(this._lightColor, c); this._applyKeyLight(); }

  /**
   * How dark the key light's shadow map is allowed to make a surface, `0..1`.
   *
   * Live, and the first thing to reach for when a cast shadow reads as a hole
   * rather than as shade. It lifts the shadow where it is MADE, so everything
   * downstream sees the lifted value - the proxy render, and therefore the
   * lighting channel every splat samples. Reads `1` when there is no key
   * light; setting it is then a no-op.
   */
  get lightShadowIntensity(): number { return this._keyLight?.light?.shadowIntensity ?? 1; }
  set lightShadowIntensity(v: number) {
    const light = this._keyLight?.light;
    if (light) light.shadowIntensity = clamp01(v);
  }

  /**
   * How the key light's shadow map is filtered. See
   * {@link RelightLightOptions.shadowType} - this is where a soft shadow EDGE
   * comes from, as against {@link blurRadius}, which softens the whole
   * channel. Reads `pcf3` when there is no key light.
   */
  get lightShadowType(): keyof typeof SHADOW_TYPES {
    const type = this._keyLight?.light?.shadowType;
    const hit = (Object.keys(SHADOW_TYPES) as Array<keyof typeof SHADOW_TYPES>)
      .find(k => SHADOW_TYPES[k] === type);
    return hit ?? 'pcf3';
  }
  set lightShadowType(v: keyof typeof SHADOW_TYPES) {
    const light = this._keyLight?.light;
    if (light) light.shadowType = SHADOW_TYPES[v];
  }

  /** Blur kernel for the `vsm` shadow types. Inert under `pcf`. */
  get lightVsmBlurSize(): number { return this._keyLight?.light?.vsmBlurSize ?? 11; }
  set lightVsmBlurSize(v: number) {
    const light = this._keyLight?.light;
    if (light) light.vsmBlurSize = Math.max(1, Math.round(v));
  }

  /** Sky fill intensity. No-op unless built with `sky`. Scene-wide. */
  get skyIntensity(): number { return this._skyIntensity; }
  set skyIntensity(v: number) { this._skyIntensity = Math.max(0, v); this._applySky(); }

  /** Sky fill colour, or `null` when built without `sky`. */
  getSkyColor(): Color | null { return this._skyColor?.clone() ?? null; }
  setSkyColor(c: string | Color): void {
    if (!this._skyColor) return;
    setColor(this._skyColor, c);
    this._applySky();
  }

  // ── Resource-shape knobs ────────────────────────────────────────────────

  /** Lighting-texture size as a fraction of the canvas, 0.05..1. Reallocates. */
  get resolutionScale(): number { return this._resolutionScale; }
  set resolutionScale(v: number) {
    const next = clamp(v, 0.05, 1);
    if (next === this._resolutionScale) return;
    this._resolutionScale = next;
    this._dirty = true;
  }

  /**
   * Cast shadows on the splats. Costs a second proxy render and a second
   * directional shadow render a frame, so it is a rebuild: the pass is
   * replaced.
   */
  get receiveShadows(): boolean { return this._receiveShadows; }
  set receiveShadows(v: boolean) {
    if (v === this._receiveShadows) return;
    this._receiveShadows = v;
    this._dirty = true;
  }

  get surface(): ProxySurfaceStyle { return this._proxy.surface; }
  set surface(v: ProxySurfaceStyle) { this.setProxySettings({ surface: v }); }

  get voxelSize(): number { return this._proxy.voxelSize; }
  set voxelSize(v: number) { this.setProxySettings({ voxelSize: v }); }

  get opacityThreshold(): number { return this._proxy.opacityThreshold; }
  set opacityThreshold(v: number) { this.setProxySettings({ opacityThreshold: v }); }

  get dilate(): number { return this._proxy.dilate; }
  set dilate(v: number) { this.setProxySettings({ dilate: v }); }

  get smoothIterations(): number { return this._proxy.smoothIterations; }
  set smoothIterations(v: number) { this.setProxySettings({ smoothIterations: v }); }

  get floorFill(): boolean { return this._proxy.floorFill; }
  set floorFill(v: boolean) { this.setProxySettings({ floorFill: v }); }

  /** Every voxelizer knob at once. A copy. */
  get proxySettings(): RelightProxySettings { return { ...this._proxy }; }

  /** Set several voxelizer knobs; one rebuild however many change. */
  setProxySettings(next: Partial<RelightProxySettings>): void {
    Object.assign(this._proxy, stripUndefined(next));
    this._sanitizeProxy();
    const key = proxyKey(this._proxy);
    if (key === this._proxyKey) return;
    this._proxyKey = key;
    this._dirty = true;
  }

  /**
   * Apply pending resource-shape changes now rather than at the start of the
   * next frame - for a script that screenshots the result straight after.
   */
  rebuild(): void {
    this._dirty = true;
    this._ensure();
  }

  /** Milliseconds the last rebuild that did work took, voxelizing included. */
  get lastRebuildMs(): number { return this._lastRebuildMs; }

  // ── Preview ─────────────────────────────────────────────────────────────

  /**
   * Off / voxels / mesh. Runtime-switchable, and never part of the lighting:
   * voxels are immediate-mode lines, and the mesh preview is a separate mesh
   * instance with its own material and headlight on the Immediate layer,
   * never on a relight layer. The first switch to `voxels` builds the cell
   * overlay.
   */
  get preview(): RelightPreviewMode { return this._preview; }
  set preview(v: RelightPreviewMode) {
    if (v === this._preview) return;
    this._preview = v;
    if (v === 'voxels') this._dirty = true;
    this._syncPreview();
  }

  // ── Introspection ───────────────────────────────────────────────────────

  /** The composed lighting texture, `rgb` light and `a` coverage. Debug only. */
  get lightingTexture() { return this._pass?.lightingTexture ?? null; }

  /** `[width, height]` of the lighting texture; `[0, 0]` while uninstalled. */
  get resolution(): [number, number] { return this._pass?.resolution ?? [0, 0]; }

  /**
   * The layer the proxies render on, `-1` while uninstalled. Changes on every
   * install. Adding it to a camera shows the raw proxy - a debugging aid.
   */
  get proxyLayerId(): number { return this._pass?.proxyLayerId ?? -1; }

  /** Whether the pass is rendering this frame (off with every strength and shadow strength at 0). */
  get active(): boolean { return this._pass?.enabled ?? false; }

  /**
   * Replace a character's proxy geometry, bypassing the voxelizer. `null`
   * restores the voxelized proxy. The voxelizer still runs, so
   * {@link proxyMesh} keeps reporting its build.
   *
   * @internal Dev-page A/B only - not a proxy mesh override.
   */
  _setGeometryOverride(target: RelightTarget, mesh: SkinnedMeshData | null): void {
    const entry = this._targets.get(target);
    if (!entry || !entry.character) return;
    entry.override = mesh;
    entry.gpuKey = '';
    this._dirty = true;
    this._ensure();
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private _onUpdate(): void {
    // An environment's clip bounds are part of its crop; they are plain
    // setters on the environment, so they are polled here.
    for (const entry of this._targets.values()) {
      if (entry.environment && entry.source && this._inputKeyFor(entry) !== entry.inputKey) this._dirty = true;
    }
    if (this._dirty) this._ensure();
    // LOD levels and variants arrive after `add`; their params have to follow.
    for (const entry of this._targets.values()) {
      if (entry.params && splatCount(entry) !== entry.pushedSplats) this._pushTargetParams(entry);
    }
  }

  /**
   * The allocator. Idempotent: brings every resource-shape resource in line
   * with the settings and does nothing where it already is.
   */
  private _ensure(): void {
    const scene = this._scene;
    if (!scene || this._destroyed || !this._dirty) return;
    const t0 = performance.now();
    let work = false;

    // 1. Geometry. CPU-only, so it runs whether or not the pass is installed.
    for (const entry of this._targets.values()) {
      const settings = this._settingsFor(entry);
      // Static proxies are built in their node's local units; the knob is in
      // world metres.
      const scale = entry.node ? maxAxisScale(entry.node.getWorldTransform()) : 1;
      const local = { ...settings, voxelSize: settings.voxelSize / scale };
      if (!this._ensureInput(entry, scene, local)) continue;
      const key = `${proxyKey(settings)}|${scale}|${entry.inputKey}`;
      if (entry.meshKey !== key) {
        const before = entry.mesh;
        entry.mesh = buildProxyMesh(entry.input!, local);
        entry.meshKey = key;
        work = true;
        if (!before) entry.resolveReady();
        warnIfCoarsened(entry, local.voxelSize);
      }
      if (this._preview === 'voxels' && entry.voxelsKey !== key) {
        // The cell boundary is blocky and unsmoothed whatever the surface is;
        // when the proxy already is exactly that, it is the same build.
        const exact = local.surface === 'blocky' && local.smoothIterations === 0;
        entry.voxels = exact
          ? entry.mesh
          : buildProxyMesh(entry.input!, { ...local, surface: 'blocky', smoothIterations: 0 });
        entry.voxelsKey = key;
        work = true;
      }
    }

    if (!this._installed) {
      if (work) this._lastRebuildMs = performance.now() - t0;
      return;
    }

    // 2. The pass. Visibility is fixed per pass, so a change replaces it - and
    // every proxy goes first, because each holds the old pass's material and
    // shadowless twin.
    if (this._pass && this._pass.visibilityEnabled !== this._receiveShadows) {
      for (const entry of this._targets.values()) this._releaseTarget(entry);
      this._unstampLights();
      this._pass.destroy();
      this._pass = null;
    }
    if (!this._pass) {
      this._pass = RelightPass.create(scene, {
        resolutionScale: this._resolutionScale,
        referenceLuminance: this._referenceLuminance,
        blurRadius: this._blurRadius,
        shadowBlurRadius: this._shadowBlurRadius,
        visibility: this._receiveShadows,
        mainCamera: this._mainCameraOpt,
        environmentRefresh: this._environmentRefresh,
      });
      this._pass.changeProbe = () => this._probeMotion();
      for (const entry of this._targets.values()) entry.pushedSplats = -1;
      this._stampLights();
      work = true;
    }
    // Size-guarded inside: a no-op unless the scale moved.
    this._pass.resolutionScale = this._resolutionScale;

    // 3. Proxies on the GPU.
    let attached = false;
    for (const entry of this._targets.values()) {
      if (!entry.mesh && !entry.override) continue;
      const key = entry.override ? 'override' : entry.meshKey;
      if (entry.gpuKey === key) continue;
      this._releaseTarget(entry);
      this._attachTarget(entry, this._pass, scene.graphicsDevice);
      entry.gpuKey = key;
      work = true;
      attached = true;
    }
    // A new or rebuilt proxy occludes and shadows differently everywhere.
    if (attached) this._pass.invalidateEnvironments();

    this._syncPreview();
    this._pushParams();
    this._dirty = false;
    if (work) this._lastRebuildMs = performance.now() - t0;
  }

  private _attachTarget(entry: TargetEntry, pass: RelightPass, device: GraphicsDevice): void {
    const material = this._previewMaterial!;
    if (entry.character) {
      const data = entry.override ?? (entry.mesh ? skinnedDataOf(entry.mesh) : null);
      if (!data || data.indices.length === 0) return;
      const armature = entry.character.armature;
      const adapter = ArmatureSkinAdapter.attach(armature, {
        mesh: data,
        material: pass.proxyMaterial,
        layers: [entry.lightingReceiver ? pass.proxyLayerId : pass.shadowCasterLayerId],
        // PlayCanvas only uploads graph-node palettes for meshes seen by a
        // forward camera. A caster-only layer has none, so upload directly.
        route: entry.lightingReceiver ? 'graph-nodes' : 'direct-palette',
        // Casts into the key light's shadow map, which is how the subject
        // shadows the floor while the proxy itself is never seen.
        castShadows: entry.castShadows,
        receiveShadows: true,
        name: 'splat-relight-proxy',
      });
      adapter.entity.tags.add(PROXY_TAG);
      entry.adapter = adapter;
      entry.proxyInstance = adapter.meshInstance;

      const preview = new Entity('splat-relight-preview');
      armature.entity.addChild(preview);
      const mi = new MeshInstance(adapter.meshInstance.mesh!, material, preview);
      // Shared, not a second skin: one palette, and the preview can never
      // drift from the proxy it previews.
      mi.skinInstance = adapter.meshInstance.skinInstance;
      entry.previewInstance = mi;
      entry.previewEntity = preview;
    } else {
      const result = entry.mesh;
      if (!result || result.indices.length === 0) return;
      const node = entry.node!;
      const mesh = new Mesh(device);
      mesh.setPositions(result.positions, 3, result.vertexCount);
      mesh.setNormals(result.normals, 3, result.vertexCount);
      mesh.setIndices(result.indices);
      mesh.update(PRIMITIVE_TRIANGLES);

      const entity = new Entity('splat-relight-proxy');
      entity.tags.add(PROXY_TAG);
      node.addChild(entity);
      const mi = new MeshInstance(mesh, pass.proxyMaterial, entity);
      entity.addComponent('render', {
        meshInstances: [mi],
        layers: [entry.lightingReceiver ? pass.proxyLayerId : pass.shadowCasterLayerId],
        castShadows: entry.castShadows,
        receiveShadows: true,
      });
      entry.staticEntity = entity;
      entry.staticMesh = mesh;
      entry.proxyInstance = mi;

      const preview = new Entity('splat-relight-preview');
      node.addChild(preview);
      entry.previewInstance = new MeshInstance(mesh, material, preview);
      entry.previewEntity = preview;
    }

    // The preview: its own material, its own layer, no shadows in either
    // direction. Not registered with the pass, so it has no shadowless twin,
    // and not on a relight layer, so no proxy camera ever draws it.
    const preview = entry.previewEntity!;
    preview.tags.add(PREVIEW_TAG);
    preview.addComponent('render', {
      meshInstances: [entry.previewInstance!],
      layers: [PREVIEW_LAYER],
      castShadows: false,
      receiveShadows: false,
    });

    pass.addProxy(entry.proxyInstance!, entry.lightingReceiver);

    const debug = ProxyMeshDebug.create(this._scene!, { mode: 'off' });
    debug.armature = entry.character?.armature ?? null;
    debug.node = entry.node;
    entry.debug = debug;
  }

  /** Free one target's GPU state, holders of references first. */
  private _releaseTarget(entry: TargetEntry): void {
    // The pass's twin references the proxy's mesh and skin: unregister before
    // either goes away.
    if (entry.proxyInstance) this._pass?.removeProxy(entry.proxyInstance);
    entry.proxyInstance = null;

    if (entry.previewEntity) {
      // A destroyed MeshInstance destroys its skin instance - which is the
      // proxy's. Detach it so the preview cannot take the proxy's palette
      // down with it.
      if (entry.previewInstance) entry.previewInstance.skinInstance = null;
      safeDestroy(entry.previewEntity);
    }
    entry.previewEntity = null;
    entry.previewInstance = null;

    entry.debug?.destroy();
    entry.debug = null;
    entry.debugVoxels = null;

    if (entry.adapter) {
      try { entry.adapter.destroy(); } catch { /* freed with its armature */ }
    }
    entry.adapter = null;
    if (entry.staticEntity) safeDestroy(entry.staticEntity);
    entry.staticEntity = null;
    entry.staticMesh?.destroy();
    entry.staticMesh = null;
    entry.gpuKey = '';
  }

  private _release(): void {
    for (const entry of this._targets.values()) this._releaseTarget(entry);
    this._unstampLights();
    this._pass?.destroy();
    this._pass = null;
    this._previewMaterial?.destroy();
    this._previewMaterial = null;
    if (this._headlight) safeDestroy(this._headlight);
    this._headlight = null;
    if (this._updateHandler && this._scene) this._scene.app.off('update', this._updateHandler);
    this._updateHandler = null;
    this._installed = false;
    this._dirty = true;
  }

  private _syncPreview(): void {
    if (this._headlight) this._headlight.enabled = this._preview === 'mesh';
    for (const entry of this._targets.values()) {
      if (entry.previewEntity) entry.previewEntity.enabled = this._preview === 'mesh';
      if (!entry.debug) continue;
      const show = this._preview === 'voxels' && entry.voxelsKey === entry.meshKey;
      if (show && entry.debugVoxels !== entry.voxels) {
        entry.debug.setVoxels(entry.voxels);
        entry.debugVoxels = entry.voxels;
      }
      entry.debug.mode = show ? 'voxels' : 'off';
    }
  }

  /** Push every uniform-only knob to the pass. Cheap; no allocation per call. */
  private _pushParams(): void {
    const pass = this._pass;
    if (!pass) return;
    pass.setDefaults({
      strength: this._strength,
      shadowStrength: this._shadowStrength,
      ambient: this._ambient,
      tint: { r: this._tint.r, g: this._tint.g, b: this._tint.b },
      debug: this._debug,
    });
    pass.referenceLuminance = this._referenceLuminance;
    pass.blurRadius = this._blurRadius;
    pass.shadowBlurRadius = this._shadowBlurRadius;
    pass.environmentRefresh = this._environmentRefresh;

    const samples = (strength: number, shadow: number) =>
      strength > 0 || (this._receiveShadows && shadow > 0);
    let live = samples(this._strength, this._shadowStrength);
    for (const entry of this._targets.values()) {
      if (entry.params) {
        this._pushTargetParams(entry);
        const p = entry.params;
        if (samples(p.strength ?? this._strength, p.shadowStrength ?? this._shadowStrength)) live = true;
      }
    }
    // Nothing samples the texture with both knobs at 0 (the debug paint
    // does), so the pass stops rendering rather than baking lighting nobody
    // reads.
    pass.enabled = this._enabled && (live || this._debug > 0);
  }

  private _pushTargetParams(entry: TargetEntry): void {
    const pass = this._pass;
    const p = entry.params;
    if (!pass || !p) return;
    const strength = clamp01(p.strength ?? this._strength);
    const tint = p.tint !== undefined ? setColor(new Color(), p.tint) : this._tint;
    const resolved = {
      strength,
      shadowStrength: clamp01(p.shadowStrength ?? this._shadowStrength),
      ambient: Math.max(0, p.ambient ?? this._ambient),
      tint: { r: tint.r, g: tint.g, b: tint.b },
    };
    for (const consumer of consumersOf(entry)) pass.setConsumerParams(consumer, resolved);
    entry.pushedSplats = splatCount(entry);
  }

  /**
   * Make `entry.input` current. `false` while an environment's splats are
   * still being read, or when reading them failed.
   */
  private _ensureInput(entry: TargetEntry, scene: Scene, local: RelightProxySettings): boolean {
    const env = entry.environment;
    if (!env) {
      if (!entry.input) {
        const splat = entry.character ? entry.character.splats[0] : (entry.target as Splat);
        entry.input = proxyInputFromSplat(splat, entry.character?.armature ?? null, scene);
      }
      return true;
    }
    // `auto` picks its level by density at the voxel size, so a voxel knob
    // that moves can move the level too. Every other request reads once.
    const bundle = !!(env.asset.resource as { octree?: unknown } | null)?.octree;
    const sourceKey = bundle && entry.lod === 'auto'
      ? `auto|${local.voxelSize}|${local.opacityThreshold}`
      : String(entry.lod);
    if (entry.sourceKey !== sourceKey && entry.sourcePending !== sourceKey) {
      entry.sourcePending = sourceKey;
      proxyInputFromEnvironment(env, {
        lod: entry.lod,
        voxelSize: local.voxelSize,
        opacityThreshold: local.opacityThreshold,
      }).then(
        (source) => {
          // Superseded by a later request, or the target is gone.
          if (this._targets.get(entry.target) !== entry || entry.sourcePending !== sourceKey) return;
          entry.source = source;
          entry.sourceKey = sourceKey;
          entry.sourcePending = '';
          this._dirty = true;
        },
        (err: unknown) => {
          if (this._targets.get(entry.target) !== entry || entry.sourcePending !== sourceKey) return;
          entry.sourcePending = '';
          // Remembered as read, so a failing fetch is not retried every frame.
          entry.sourceKey = sourceKey;
          // eslint-disable-next-line no-console
          console.error('[SplatRelight] could not read the environment\'s splats', err);
          entry.rejectReady(err);
        },
      );
    }
    // Until the first read lands there is nothing to build; after it, the
    // previous read keeps the proxy up while a new level loads.
    if (!entry.source) return false;
    const key = this._inputKeyFor(entry);
    if (entry.input && entry.inputKey === key) return true;
    const box = cropBoxFor(entry);
    entry.input = box
      ? cropInputToWorldBox(entry.source.input, env.entity.getWorldTransform().data, box.min, box.max)
      : entry.source.input;
    entry.inputKey = key;
    return true;
  }

  /** The crop an environment's input is cut with, as a comparable string. */
  private _inputKeyFor(entry: TargetEntry): string {
    const box = cropBoxFor(entry);
    if (!box) return `${entry.sourceKey}|uncropped`;
    const w = entry.environment!.entity.getWorldTransform().data;
    return `${entry.sourceKey}|${box.min.x},${box.min.y},${box.min.z}|${box.max.x},${box.max.y},${box.max.z}|`
      + Array.prototype.join.call(w, ',');
  }

  private _settingsFor(entry: TargetEntry): RelightProxySettings {
    const out: RelightProxySettings = {
      ...this._proxy,
      ...(entry.environment ? ENVIRONMENT_PROXY_DEFAULTS : {}),
      ...entry.proxy,
    };
    sanitizeProxy(out);
    return out;
  }

  /**
   * The environment refresh's change probe: did any target's proxy or any
   * registered light move since the last call? Walks everything, so every
   * snapshot stays current. A character's pose is 16 floats a bone - 1.4k
   * compares for an 86-bone rig.
   */
  private _probeMotion(): boolean {
    let changed = false;
    for (const entry of this._targets.values()) {
      if (entry.character) {
        const bones = entry.character.armature.boneWorldMatrices;
        if (!entry.motion || entry.motion.length !== bones.length * 16) {
          entry.motion = new Float32Array(bones.length * 16);
          changed = true;
        }
        for (let b = 0; b < bones.length; b++) {
          if (copyIfChanged(entry.motion, b * 16, bones[b].data, 16)) changed = true;
        }
      } else if (entry.node) {
        entry.motion ??= new Float32Array(17);
        if (copyIfChanged(entry.motion, 0, entry.node.getWorldTransform().data, 16)) changed = true;
        const on = entry.node.enabled ? 1 : 0;
        if (entry.motion[16] !== on) { entry.motion[16] = on; changed = true; }
      }
    }
    for (const [light, entry] of this._lights) {
      const l = light.light;
      const snap = this._lightScratch;
      snap.set(light.getWorldTransform().data, 0);
      snap[16] = light.enabled && l?.enabled ? 1 : 0;
      snap[17] = l?.intensity ?? 0;
      snap[18] = l?.color.r ?? 0;
      snap[19] = l?.color.g ?? 0;
      snap[20] = l?.color.b ?? 0;
      snap[21] = l?.range ?? 0;
      snap[22] = l?.castShadows ? 1 : 0;
      if (copyIfChanged(entry.snapshot, 0, snap, snap.length)) changed = true;
    }
    return changed;
  }

  private _createKeyLight(scene: Scene): void {
    const o = this._lightOpts!;
    const entity = new Entity('splat-relight-key-light');
    entity.addComponent('light', {
      type: 'directional',
      color: this._lightColor.clone(),
      intensity: this._lightIntensity,
      castShadows: o.castShadows ?? true,
      layers: [...(o.layers ?? [LAYERID_WORLD])],
      ...(o.shadowDistance !== undefined ? { shadowDistance: o.shadowDistance } : {}),
      ...(o.shadowResolution !== undefined ? { shadowResolution: o.shadowResolution } : {}),
      ...(o.shadowBias !== undefined ? { shadowBias: o.shadowBias } : {}),
      ...(o.normalOffsetBias !== undefined ? { normalOffsetBias: o.normalOffsetBias } : {}),
      ...(o.shadowType !== undefined ? { shadowType: SHADOW_TYPES[o.shadowType] } : {}),
      ...(o.vsmBlurSize !== undefined ? { vsmBlurSize: o.vsmBlurSize } : {}),
      ...(o.shadowIntensity !== undefined ? { shadowIntensity: o.shadowIntensity } : {}),
    });
    scene.app.root.addChild(entity);
    this._keyLight = entity;
    this._registerLight(entity, true);
    this._applyKeyLight();
  }

  private _applyKeyLight(): void {
    const entity = this._keyLight;
    if (!entity?.light) return;
    // A directional light shines down its local -Y. Pitching +Y by
    // (90 - elevation) and yawing by azimuth lands +Y on the toward-the-light
    // vector (cosE sinA, sinE, cosE cosA).
    entity.setEulerAngles(90 - this._lightElevation, this._lightAzimuth, 0);
    entity.light.color = this._lightColor;
    entity.light.intensity = this._lightIntensity;
  }

  private _applySky(): void {
    if (!this._skyColor || !this._scene) return;
    const k = this._skyIntensity;
    this._scene.app.scene.ambientLight.set(
      this._skyColor.r * k, this._skyColor.g * k, this._skyColor.b * k,
    );
  }

  private _registerLight(light: Entity, owned: boolean): void {
    if (this._destroyed || !light.light || this._lights.has(light)) return;
    const relightIds = new Set(this._pass?.lightLayerIds ?? []);
    const entry: LightEntry = {
      base: light.light.layers.filter((id) => !relightIds.has(id)),
      owned,
      // NaN never compares equal, so the probe's first look reports a change.
      snapshot: new Float32Array(LIGHT_SNAPSHOT).fill(NaN),
      onDestroy: () => {
        this._lights.delete(light);
        if (light === this._keyLight) this._keyLight = null;
      },
    };
    light.once('destroy', entry.onDestroy);
    this._lights.set(light, entry);
    if (this._pass) this._stampLight(light, entry, this._pass);
  }

  private _stampLights(): void {
    const pass = this._pass;
    if (!pass) return;
    for (const [light, entry] of this._lights) this._stampLight(light, entry, pass);
  }

  private _stampLight(light: Entity, entry: LightEntry, pass: RelightPass): void {
    if (light.light) light.light.layers = [...entry.base, ...pass.lightLayerIds];
  }

  private _unstampLights(): void {
    for (const [light, entry] of this._lights) {
      if (light.light) light.light.layers = entry.base;
    }
  }

  private _sanitizeProxy(): void {
    sanitizeProxy(this._proxy);
  }
}

/** World transform (16), enabled, intensity, rgb, range, castShadows. */
const LIGHT_SNAPSHOT = 23;

/**
 * A crop that coarsens a request this much means the bounds are the problem,
 * not the voxel size.
 */
const COARSEN_WARN_RATIO = 2;

function sanitizeProxy(p: RelightProxySettings): void {
  p.voxelSize = clamp(p.voxelSize, 0.001, 10);
  p.opacityThreshold = clamp01(p.opacityThreshold);
  p.dilate = Math.max(0, Math.round(p.dilate));
  p.smoothIterations = Math.max(0, Math.round(p.smoothIterations));
  p.surface = p.surface === 'smooth' ? 'smooth' : 'blocky';
  p.floorFill = !!p.floorFill;
}

function isCharacter(t: RelightTarget): t is Character {
  return (t as Character).armature !== undefined && Array.isArray((t as Character).splats);
}

function consumersOf(entry: TargetEntry): RelightConsumer[] {
  const c = entry.character;
  return c ? [...c.splats, ...c.variantSplats] : [entry.target as Splat | Environment];
}

/**
 * An environment's crop: its `bounds` option intersected with its render clip
 * box. `null` when neither bounds anything.
 */
function cropBoxFor(entry: TargetEntry): { min: Vec3Like; max: Vec3Like } | null {
  const env = entry.environment;
  if (!env) return null;
  const b = entry.bounds;
  const cmin = env.clipBoundsMin, cmax = env.clipBoundsMax;
  const min = {
    x: Math.max(b?.min.x ?? -Infinity, cmin.x),
    y: Math.max(b?.min.y ?? -Infinity, cmin.y),
    z: Math.max(b?.min.z ?? -Infinity, cmin.z),
  };
  const max = {
    x: Math.min(b?.max.x ?? Infinity, cmax.x),
    y: Math.min(b?.max.y ?? Infinity, cmax.y),
    z: Math.min(b?.max.z ?? Infinity, cmax.z),
  };
  const bounded = [min.x, min.y, min.z, max.x, max.y, max.z].some((v) => Number.isFinite(v) && Math.abs(v) < 1e9);
  return bounded ? { min, max } : null;
}

type Vec3Like = { x: number; y: number; z: number };

/** Copy `n` values into `out` at `at`, reporting whether any differed. */
function copyIfChanged(out: Float32Array, at: number, src: ArrayLike<number>, n: number): boolean {
  let changed = false;
  for (let i = 0; i < n; i++) {
    const v = src[i];
    if (out[at + i] !== v) { out[at + i] = v; changed = true; }
  }
  return changed;
}

/**
 * The voxelizer's grid ceiling coarsens silently. On a static target that
 * almost always means a crop is missing, which is worth one line in the
 * console - the proxy is otherwise just quietly worse.
 */
function warnIfCoarsened(entry: TargetEntry, requested: number): void {
  const used = entry.mesh?.voxelSize ?? requested;
  if (!entry.node || used <= requested * COARSEN_WARN_RATIO) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[SplatRelight] ${entry.node.name}: voxel size coarsened from ${requested.toPrecision(3)} to `
    + `${used.toPrecision(3)} (local units) to fit the voxel grid ceiling. Crop the target with `
    + '`bounds` to where characters walk.',
  );
}

function splatCount(entry: TargetEntry): number {
  const c = entry.character;
  return c ? c.splats.length + c.variantSplats.length : 1;
}

/** The voxelizer's result in the skin adapter's vertex format. */
function skinnedDataOf(result: ProxyMeshResult): SkinnedMeshData {
  const n = result.vertexCount;
  return {
    positions: result.positions,
    normals: result.normals,
    indices: result.indices,
    // No weights means the splats carried none. Weight 0 everywhere pins the
    // proxy at bind, which is exactly where those splats stay too.
    boneIndices: result.boneIndices ?? new Float32Array(n * 4),
    boneWeights: result.boneWeights ?? new Float32Array(n * 4),
  };
}

function proxyKey(p: RelightProxySettings): string {
  return `${p.surface}|${p.voxelSize}|${p.opacityThreshold}|${p.dilate}|${p.smoothIterations}|${p.floorFill}`;
}

function safeDestroy(entity: Entity): void {
  try { entity.destroy(); } catch { /* already freed with its parent */ }
}

function setColor(out: Color, c: string | Color): Color {
  if (typeof c === 'string') out.fromString(c);
  else out.copy(c);
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
