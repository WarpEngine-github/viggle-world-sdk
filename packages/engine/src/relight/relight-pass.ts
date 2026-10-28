import {
  ADDRESS_CLAMP_TO_EDGE,
  Color,
  Entity,
  EVENT_PRERENDER_LAYER,
  FILTER_LINEAR,
  GAMMA_NONE,
  Layer,
  Mat4,
  MeshInstance,
  PIXELFORMAT_RGBA16F,
  PIXELFORMAT_RG16F,
  QuadRender,
  RenderTarget,
  SEMANTIC_POSITION,
  ShaderUtils,
  StandardMaterial,
  Texture,
  TONEMAP_NONE,
  ASPECT_MANUAL,
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

import type { Environment } from '../loader/environment';
import type { Scene } from '../scene';
import { Splat } from '../splat/splat';
import { getRelightPlaceholder } from './relight-placeholder';
import { COMPOSE_GLSL, COMPOSE_WGSL } from './relight-shaders';

/** Per-consumer relight knobs. See {@link RelightPass.setConsumerParams}. */
export interface RelightParams {
  /**
   * How much of the splat's baked colour is replaced by proxy lighting.
   * `0` (default) skips the texture fetch entirely, so the effect costs
   * nothing until it is dialled up.
   */
  strength?: number;
  /** Tints the received light only, never the base colour. Default white. */
  tint?: { r: number; g: number; b: number };
  /** Floor under the light term so unlit faces do not go black. Default `0`. */
  ambient?: number;
  /**
   * Cast-shadow depth, sampled from the visibility channel. `0` (default) is
   * off; `1` takes a fully shadowed splat to black. Requires
   * {@link RelightPassOptions.visibility}.
   */
  shadowStrength?: number;
  /**
   * Paint every splat with the outcome of its own relight sample instead of
   * lighting it: magenta = no texture published, yellow = behind the camera,
   * red = projects off-screen, blue = the sampled texel has no proxy coverage,
   * orange = coverage found at the MIRRORED row (which convicts the y-flip
   * specifically), greys = the real sample.
   *
   * `2` paints the shadow-visibility sample instead: greys = the ratio,
   * magenta = no proxy coverage at that texel.
   */
  debug?: boolean | number;
}

/** Options for {@link RelightPass.create}. */
export interface RelightPassOptions {
  /**
   * Lighting-texture size as a fraction of the canvas. Default `0.5`.
   * Lighting is low-frequency and is sampled once per splat rather than per
   * pixel, so half resolution is normally indistinguishable and costs a
   * quarter of the bandwidth. Settable later via
   * {@link RelightPass.resolutionScale}.
   */
  resolutionScale?: number;
  /**
   * The proxy brightness that counts as "normally lit". Sampled lighting is
   * divided by this, so `strength` changes lighting CONTRAST rather than
   * overall brightness. Default `1`.
   */
  referenceLuminance?: number;
  /**
   * Run the 3x3 tent blur. Default `true`. This is what keeps the lighting
   * temporally stable while the proxy animates; turn it off only to see the
   * raw bake.
   *
   * Shorthand for the two radii below: `true` is 1 on each, `false` is 0.
   * Whichever of the three is given last wins.
   */
  blur?: boolean;
  /**
   * Radius of the tent over the LIGHTING, in texels of the proxy target.
   * Default `1`, the original tent; `0` is a single tap.
   *
   * This is the one that softens a cast shadow being read through
   * {@link SplatRelight.strength} alone - the shadow map is in this channel -
   * and it softens the terminator across the subject with it, because that is
   * in the same channel. See the compose shader's header.
   */
  blurRadius?: number;
  /**
   * Radius of the tent over the SHADOW-VISIBILITY channel, in texels of the
   * proxy target. Default `1`. Inert unless `visibility` is on and
   * {@link SplatRelight.shadowStrength} is above 0.
   *
   * Raise this alone for a soft cast shadow over a subject whose lit/unlit
   * edge stays crisp.
   */
  shadowBlurRadius?: number;
  /**
   * Allocate the second proxy draw that makes the shadow-visibility channel
   * work. Default `false`, because it costs a second half-res proxy render
   * AND a second directional shadow-map render per frame (PlayCanvas renders
   * directional shadows once per camera). Without it `shadowStrength` is inert
   * and the visibility channel reads a constant 1.
   */
  visibility?: boolean;
  /**
   * Camera the lighting texture is rendered from. Default `scene.cameraEntity`.
   * The proxy cameras are parented to it, so it must be the camera the splats
   * are viewed through - the lookup is screen-space.
   */
  mainCamera?: Entity;
  /** See {@link EnvironmentRefreshMode}. Default `auto`. */
  environmentRefresh?: EnvironmentRefreshMode;
}

/**
 * When environment splats re-copy their work buffer - which is the only time
 * their relit colour changes.
 *
 * Characters need none of this: they re-copy every frame. Environments are
 * `WORKBUFFER_UPDATE_AUTO` and keep whatever colour their last copy computed,
 * and a copy re-runs the colour for the WHOLE environment (for an LOD bundle,
 * every active octree placement).
 *
 * - `auto` - re-copy on the frames where the lighting texture an environment
 *   samples can have changed: the camera moved, a knob moved, the texture
 *   became valid or went away, or the {@link RelightPass.changeProbe} reports a
 *   proxy or light moved - plus {@link REFRESH_TRAILING_FRAMES} after the last
 *   such frame, because a copy samples the texture rendered the frame BEFORE.
 *   Only environments whose knobs make them sample the texture are re-copied,
 *   except on a knob change, which re-copies all of them once.
 * - `always` - every frame, unconditionally.
 * - `never` - only on {@link RelightPass.invalidateEnvironments}.
 */
export type EnvironmentRefreshMode = 'auto' | 'always' | 'never';

/**
 * Frames re-copied after the last change. One is the minimum - the copy on a
 * change frame samples the texture from before it, so the frame after is the
 * first that sees it - and the second covers a probe that fires one frame late
 * because its source updated after `prerender`.
 */
export const REFRESH_TRAILING_FRAMES = 2;

/** Something whose relight knobs can be overridden. */
export type RelightConsumer = Splat | Environment;

/**
 * Screen-space relighting of gaussian splats from a proxy mesh.
 *
 * A proxy mesh of the same subject - a voxelized shell, or the one-box-per-bone
 * stand-in the dev page uses - is rendered with PlayCanvas's real lights into an
 * offscreen half-resolution texture. Every splat then samples the texel it
 * projects to and blends that lighting over its own baked appearance.
 *
 * Screen-space and not per-splat N.L on purpose: every splat along a view ray
 * reads the SAME texel, so overlapping semi-transparent splats agree and the
 * per-frame depth re-sort cannot expose a contrast between them. The cost is
 * view dependence - you see the shading of the surfaces that face you.
 *
 * ── The pipeline ──────────────────────────────────────────────────────────
 *
 *   1. `proxyLayer` + `proxyCamera` (priority `main - 4`) render the proxy with
 *      a white lambertian material whose `ambient` is BLACK, into `_litRT`:
 *      rgb = sum over lights of `colour * N.L * attenuation * shadow`,
 *      a = 1 (the coverage mask).
 *   2. Optionally `visibilityLayer` + `visibilityCamera` (priority `main - 3`)
 *      render a twin of the same geometry with `receiveShadow = false` into
 *      `_rawRT`: the same sum with every shadow map ignored.
 *   3. `composeLayer` + `composeCamera` (priority `main - 2`) run one fullscreen
 *      quad into an MRT pair - `lightingTexture` (RGBA16F, rgb = lighting,
 *      a = coverage) and `visibilityTexture` (RG16F, r = visibility,
 *      g = coverage) - applying the tent blur, un-premultiplying by coverage,
 *      and adding the scene ambient back in.
 *   4. `app.prerender` publishes the pair, plus the view-projection they were
 *      rendered with, to every live gsplat component.
 *
 * ── The one-frame lag ─────────────────────────────────────────────────────
 * Splat colour is computed in `gsplatDirector.update()`, which runs inside
 * `ForwardRenderer.update()` - BEFORE the frame graph executes any camera. The
 * texture a splat samples on frame N is therefore the one rendered on frame
 * N-1. The view-projection is published as a matched pair with it, so a static
 * subject is pixel-exact regardless; only geometry that moved between the two
 * frames is off, by one frame of its own motion, which the tent blur absorbs.
 *
 * ── Why two draws and not MRT on the proxy ────────────────────────────────
 * Unity gets `lighting` and `visibility` out of one draw because it writes its
 * own fragment shader against URP's light loop. Here `lighting` comes from a
 * `StandardMaterial`, which is the only way to reach PlayCanvas's real lights
 * (clustered on WebGPU, forward on WebGL2) without forking the renderer - and
 * PlayCanvas's generated lit fragment shader writes exactly one output, with no
 * supported hook to add a second. The visibility ratio is instead recovered
 * from a second draw of the same geometry with `receiveShadow = false`
 * (`SHADERDEF_NOSHADOW`, which also drops `CLUSTER_SHADOWS`), which is
 * arithmetically identical - see `relight-shaders.ts`. MRT IS used, in the
 * compose pass, where the shader is ours.
 *
 * Built per scene, never as a module global: multi-scene pages have been bitten
 * by device-keyed singletons before.
 *
 * ── Resize ────────────────────────────────────────────────────────────────
 * Not handled here. The owner, {@link SplatRelight}, is a `PostFXPass`, and
 * PostFX answers a canvas resize by uninstalling and reinstalling every pass -
 * which destroys this pass and builds a fresh one at the new size. A second,
 * pass-owned `resizecanvas` listener would race that rebuild.
 *
 * Internal. Consumers use {@link SplatRelight}.
 */
export class RelightPass {
  /**
   * Put proxy mesh instances on this layer. They are invisible to the main
   * camera - the layer is in the composition but not in the main camera's
   * `layers` - and they still cast into the main camera's shadow map, because
   * PlayCanvas gathers shadow casters from every layer that holds the light,
   * not from the rendering camera's layers.
   */
  readonly proxyLayerId: number;
  /** Skinning remains active here, but no receiver camera draws this layer. */
  readonly shadowCasterLayerId: number;

  /**
   * Every layer a light must be a member of for the proxy to be lit by it.
   *
   * PlayCanvas filters lights against meshes three ways at once - the light's
   * `layers`, the `LightComponent.mask` / `MeshInstance.mask` pair, and the
   * layer's membership in some camera - and a proxy that fails any one of them
   * renders unlit with no error at all. Spreading this into a light's `layers`
   * alongside the app's own is the first of those three.
   */
  readonly lightLayerIds: readonly number[];

  /** The material proxy meshes must be drawn with. See {@link proxyMaterial}. */
  readonly proxyMaterial: StandardMaterial;

  private readonly _scene: Scene;
  private readonly _device: GraphicsDevice;
  private readonly _mainCamera: Entity;

  private readonly _proxyLayer: Layer;
  private readonly _shadowCasterLayer: Layer;
  private readonly _visibilityLayer: Layer | null;
  private readonly _composeLayer: Layer;

  private _proxyCamera: Entity | null = null;
  private _visibilityCamera: Entity | null = null;
  private _composeCamera: Entity | null = null;

  private _litTex: Texture | null = null;
  private _rawTex: Texture | null = null;
  private _lightingTex: Texture | null = null;
  private _visibilityTex: Texture | null = null;
  private _litRT: RenderTarget | null = null;
  private _rawRT: RenderTarget | null = null;
  private _composeRT: RenderTarget | null = null;
  private _rtWidth = 0;
  private _rtHeight = 0;

  private readonly _quad: QuadRender;
  /** Registered proxies -> their unshadowed twin, when visibility is on. */
  private readonly _proxies = new Map<MeshInstance, MeshInstance | null>();

  private _resolutionScale: number;
  private _referenceLuminance: number;
  private _blurRadius: number;
  private _shadowBlurRadius: number;
  private readonly _visibility: boolean;
  private _environmentRefresh: EnvironmentRefreshMode;
  private _flipY = false;
  private _enabled = true;
  private _destroyed = false;

  /** Scene-wide defaults, overridden per {@link Splat} by `setSplatParams`. */
  private readonly _defaults: Required<RelightParams> = {
    strength: 0,
    tint: { r: 1, g: 1, b: 1 },
    ambient: 0,
    shadowStrength: 0,
    debug: 0,
  };
  // Keyed by the Splat, or by an environment's gsplat component - which is
  // what the publish loop holds for environments. Weak: a destroyed consumer
  // must not be kept alive by an override nobody cleared. Neither map is ever
  // iterated, only looked up.
  private readonly _overrides = new WeakMap<object, RelightParams>();
  private readonly _merged = new WeakMap<object, Required<RelightParams>>();

  // ── Environment refresh ──
  /** Bumped by every knob that changes what a splat computes from the texture. */
  private _stateVersion = 0;
  private _refreshedVersion = -1;
  private readonly _vpLast = new Float32Array(16);
  private _lastValid = false;
  private readonly _ambientLast = new Color(-1, -1, -1);
  /** Frames still to re-copy, and whether they re-copy every environment. */
  private _refreshFrames = 0;
  private _refreshAll = false;
  private _environmentRefreshFrames = 0;
  private readonly _liveEnvs = new Set<unknown>();
  private _sharedLighting: Texture | null = null;
  private _sharedVisibility: Texture | null = null;

  /**
   * Asked once a frame in `auto` mode: has anything this pass cannot see moved
   * - a proxy, a light? The owner ({@link SplatRelight}) answers for its
   * targets and lights.
   */
  changeProbe: (() => boolean) | null = null;

  /**
   * The view-projection the currently PUBLISHED texture was rendered with, and
   * the one the render about to happen this frame will use. Two buffers because
   * `ScopeId.setValue` keeps the array by reference until the draw commits.
   */
  private readonly _vpPublished = new Float32Array(16);
  private readonly _vpPending = new Float32Array(16);
  private _framesRendered = 0;

  private readonly _params = new Float32Array(4);
  /** One tint buffer per distinct parameter set - see `tintBuffer`. */
  private readonly _tints = new WeakMap<Required<RelightParams>, Float32Array>();
  private readonly _composeParams = new Float32Array(4);
  private readonly _composeAmbient = new Float32Array(3);
  private readonly _tmpView = new Mat4();
  private readonly _tmpVP = new Mat4();
  private readonly _ambientColor = new Color();

  private readonly _prerenderHandler: () => void;
  private readonly _prerenderLayerHandler: (
    camera: unknown, layer: unknown, transparent: boolean,
  ) => void;
  private readonly _mainCameraDestroyHandler: () => void;

  /**
   * Build the pass and install it in the scene's layer composition.
   *
   * Throws when the device cannot render to half-float, which the lighting
   * texture requires - lighting legitimately exceeds 1 and clamping it would
   * flatten exactly the highlights relighting exists for.
   */
  static create(scene: Scene, opts: RelightPassOptions = {}): RelightPass {
    return new RelightPass(scene, opts);
  }

  private constructor(scene: Scene, opts: RelightPassOptions) {
    this._scene = scene;
    this._device = scene.graphicsDevice;
    const device = this._device as GraphicsDevice & { textureHalfFloatRenderable?: boolean };
    if (device.textureHalfFloatRenderable === false) {
      throw new Error(
        '[RelightPass] the device cannot render to half-float textures, which the ' +
        'lighting target requires (lighting exceeds 1 and must not be clamped).',
      );
    }

    const mainCamera = opts.mainCamera ?? scene.cameraEntity;
    if (!mainCamera?.camera) {
      throw new Error('[RelightPass] mainCamera has no camera component');
    }
    this._mainCamera = mainCamera;

    this._resolutionScale = clamp(opts.resolutionScale ?? 0.5, 0.05, 1);
    this._referenceLuminance = Math.max(opts.referenceLuminance ?? 1, 1e-4);
    // `blur` is the old boolean surface and still works; a radius given
    // explicitly overrides whatever it implied.
    const blurDefault = (opts.blur ?? true) ? 1 : 0;
    this._blurRadius = Math.max(0, opts.blurRadius ?? blurDefault);
    this._shadowBlurRadius = Math.max(0, opts.shadowBlurRadius ?? blurDefault);
    this._visibility = opts.visibility ?? false;
    this._environmentRefresh = opts.environmentRefresh ?? 'auto';

    // ── Layers ──────────────────────────────────────────────────────────
    // Pushed into the composition so the proxy cameras can find them, but NOT
    // into the main camera's layers array - the player never sees the proxy.
    const composition = (scene.app.scene as unknown as { layers: {
      push: (l: Layer) => void; remove?: (l: Layer) => void;
    } }).layers;
    this._proxyLayer = new Layer({
      name: 'relight-proxy',
      clearColorBuffer: false,
      clearDepthBuffer: false,
      passThrough: false,
    });
    composition.push(this._proxyLayer);
    this.proxyLayerId = this._proxyLayer.id;
    this._shadowCasterLayer = new Layer({ name: 'relight-shadow-casters' });
    composition.push(this._shadowCasterLayer);
    this.shadowCasterLayerId = this._shadowCasterLayer.id;

    if (this._visibility) {
      this._visibilityLayer = new Layer({
        name: 'relight-proxy-noshadow',
        clearColorBuffer: false,
        clearDepthBuffer: false,
        passThrough: false,
      });
      composition.push(this._visibilityLayer);
    } else {
      this._visibilityLayer = null;
    }

    this.lightLayerIds = this._visibilityLayer
      ? [this._proxyLayer.id, this._visibilityLayer.id, this._shadowCasterLayer.id]
      : [this._proxyLayer.id, this._shadowCasterLayer.id];

    this._composeLayer = new Layer({
      name: 'relight-compose',
      clearColorBuffer: false,
      clearDepthBuffer: false,
      passThrough: false,
    });
    composition.push(this._composeLayer);

    // ── Proxy material ──────────────────────────────────────────────────
    // A white lambertian with NO ambient, so its fragment output is exactly
    // `sum over lights of colour * N.L * attenuation * shadow`. PlayCanvas
    // applies `material_ambient` to `dDiffuseLight` BEFORE the light loop
    // runs, so a black ambient removes the ambient term and leaves the direct
    // lights untouched. The ambient is added back in the compose pass from a
    // uniform, which is what lets the visibility ratio be computed without it.
    //
    // There is deliberately no material override slot on this class: the
    // output contract (direct light only, alpha = coverage) is what the splat
    // chunk assumes, and an arbitrary material here bakes the proxy's own
    // surface appearance into the texture - blotches on the character that
    // flicker during animation.
    const mat = new StandardMaterial();
    mat.name = 'relight-proxy';
    mat.diffuse = new Color(1, 1, 1);
    mat.ambient = new Color(0, 0, 0);
    mat.specular = new Color(0, 0, 0);
    mat.emissive = new Color(0, 0, 0);
    mat.gloss = 0;
    mat.useMetalness = false;
    mat.useSkybox = false;
    mat.useFog = false;
    mat.update();
    this.proxyMaterial = mat;

    // ── Targets ─────────────────────────────────────────────────────────
    this._ensureTargets();

    // ── Cameras ─────────────────────────────────────────────────────────
    const basePriority = mainCamera.camera.priority ?? 0;
    this._proxyCamera = this._addCamera(
      'relight-proxy-camera', this._proxyLayer.id, this._litRT, basePriority - 4,
    );
    if (this._visibilityLayer) {
      this._visibilityCamera = this._addCamera(
        'relight-visibility-camera', this._visibilityLayer.id, this._rawRT, basePriority - 3,
      );
    }
    this._composeCamera = this._addCamera(
      'relight-compose-camera', this._composeLayer.id, this._composeRT, basePriority - 2,
    );

    // ── Compose quad ────────────────────────────────────────────────────
    // MRT: two outputs, `vec4` lighting + coverage and `vec2` visibility +
    // coverage. PlayCanvas defines COLOR_ATTACHMENT_n / outType_n from
    // `fragmentOutputTypes`, so the shader writes pcFragColor0/1 in GLSL and
    // `output.color` / `output.color1` in WGSL.
    const shader = ShaderUtils.createShader(this._device, {
      uniqueName: 'relight-compose',
      attributes: { vertex_position: SEMANTIC_POSITION },
      vertexChunk: 'fullscreenQuadVS',
      fragmentGLSL: COMPOSE_GLSL,
      fragmentWGSL: COMPOSE_WGSL,
      fragmentOutputTypes: ['vec4', 'vec2'],
    });
    this._quad = new QuadRender(shader);

    // ── Hooks ───────────────────────────────────────────────────────────
    // `app.prerender` fires before `ForwardRenderer.update()`, which is where
    // the splat work buffer is re-copied. Publishing here is what makes the
    // texture reach THIS frame's splat colours (one frame old - see the class
    // comment).
    this._prerenderHandler = () => this._onPrerender();
    scene.app.on('prerender', this._prerenderHandler);

    this._prerenderLayerHandler = (_camera, layer, transparent) => {
      if (this._destroyed || !this._enabled) return;
      if ((layer as { id?: number } | null)?.id !== this._composeLayer.id) return;
      if (transparent) return;
      this._compose();
    };
    scene.app.scene.on(EVENT_PRERENDER_LAYER, this._prerenderLayerHandler);

    // Self-destruct if the main camera goes away underneath us: PlayCanvas's
    // recursive destroy would free the parented proxy cameras silently while
    // these listeners kept firing against freed render targets.
    this._mainCameraDestroyHandler = () => this.destroy();
    mainCamera.once?.('destroy', this._mainCameraDestroyHandler);
  }

  // ── Public surface ──────────────────────────────────────────────────────

  /**
   * The composed lighting texture: `rgb` = full lighting, `a` = proxy
   * coverage. Null until the first frame has rendered. Exposed for debug
   * overlays; the splat path reads it through published uniforms.
   */
  get lightingTexture(): Texture | null { return this._lightingTex; }

  /** `r` = shadow visibility, `g` = proxy coverage. See {@link lightingTexture}. */
  get visibilityTexture(): Texture | null { return this._visibilityTex; }

  /** `[width, height]` of the lighting texture. */
  get resolution(): [number, number] { return [this._rtWidth, this._rtHeight]; }

  /** Lighting-texture size as a fraction of the canvas. Reallocates. */
  get resolutionScale(): number { return this._resolutionScale; }
  set resolutionScale(v: number) {
    const next = clamp(v, 0.05, 1);
    if (next === this._resolutionScale) return;
    this._resolutionScale = next;
    this._ensureTargets();
    this._restampRenderTargets();
  }

  /** See {@link RelightPassOptions.referenceLuminance}. Uniform-only. */
  get referenceLuminance(): number { return this._referenceLuminance; }
  set referenceLuminance(v: number) {
    const next = Math.max(v, 1e-4);
    if (next === this._referenceLuminance) return;
    this._referenceLuminance = next;
    this._stateVersion++;
  }

  /**
   * Whether either tent runs at all. Reading it asks "is anything blurred";
   * writing it sets both radii to 1 or 0. Uniform-only.
   */
  get blur(): boolean { return this._blurRadius > 0 || this._shadowBlurRadius > 0; }
  set blur(v: boolean) {
    this.blurRadius = v ? 1 : 0;
    this.shadowBlurRadius = v ? 1 : 0;
  }

  /** Tent radius over the lighting, in proxy-target texels. Uniform-only. */
  get blurRadius(): number { return this._blurRadius; }
  set blurRadius(v: number) {
    const next = Math.max(0, v);
    if (next === this._blurRadius) return;
    this._blurRadius = next;
    this._stateVersion++;
  }

  /** Tent radius over the shadow-visibility channel. Uniform-only. */
  get shadowBlurRadius(): number { return this._shadowBlurRadius; }
  set shadowBlurRadius(v: number) {
    const next = Math.max(0, v);
    if (next === this._shadowBlurRadius) return;
    this._shadowBlurRadius = next;
    this._stateVersion++;
  }

  /** Whether the shadow-visibility channel is live (fixed at construction). */
  get visibilityEnabled(): boolean { return this._visibility; }

  /**
   * Mirror the sampled row of the lighting texture.
   *
   * `false` on BOTH backends, which is the measured answer rather than the
   * predicted one. The reasoning that says otherwise - WebGPU's framebuffer
   * origin is top-left, so NDC +1 lands in texel row 0 while `v = 0` samples
   * that same row - is wrong somewhere in PlayCanvas 2.18's render-target
   * path: with `flipY` true on WebGPU the lighting lands upside down, and the
   * debug paint reports orange (coverage at the MIRRORED row) across the whole
   * character. PlayCanvas's own `fullscreenQuadVS` makes the same assumption -
   * it maps position to uv identically on both backends - so this is the
   * convention the rest of the engine already relies on.
   *
   * Kept settable because it is exactly the knob you want when a future
   * PlayCanvas version changes that behaviour: flip it, look for the orange to
   * turn grey.
   */
  get flipY(): boolean { return this._flipY; }
  set flipY(v: boolean) { this._flipY = v; this._stateVersion++; }

  /** See {@link EnvironmentRefreshMode}. */
  get environmentRefresh(): EnvironmentRefreshMode { return this._environmentRefresh; }
  set environmentRefresh(v: EnvironmentRefreshMode) {
    if (v === this._environmentRefresh) return;
    this._environmentRefresh = v;
    this.invalidateEnvironments();
  }

  /**
   * Re-copy every environment this frame and the trailing frames after it.
   * For what the pass cannot detect itself - a mesh that casts into the key
   * light's shadow map moving, say - in any refresh mode.
   */
  invalidateEnvironments(): void {
    this._refreshFrames = REFRESH_TRAILING_FRAMES + 1;
    this._refreshAll = true;
  }

  /** Frames on which environments were re-copied, since creation. A cost probe. */
  get environmentRefreshFrames(): number { return this._environmentRefreshFrames; }

  /**
   * Stop rendering the proxy. Consumers fall back to their baked colour on the
   * next frame (the published `valid` flag goes to 0), so this is a true
   * no-op, not a frozen last frame.
   */
  get enabled(): boolean { return this._enabled; }
  set enabled(v: boolean) {
    if (this._enabled === v) return;
    this._enabled = v;
    this._stateVersion++;
    this._setCameraEnabled(v);
    if (!v) this._framesRendered = 0;
  }

  /** Scene-wide relight defaults, applied to every splat without an override. */
  setDefaults(params: RelightParams): void {
    const next = stripUndefined(params);
    if (!sameParams(this._defaults, next)) this._stateVersion++;
    Object.assign(this._defaults, next);
  }

  /** Read back the scene-wide defaults. */
  getDefaults(): Required<RelightParams> {
    return { ...this._defaults, tint: { ...this._defaults.tint } };
  }

  /**
   * Override the relight knobs for one {@link Splat} or {@link Environment}.
   * Pass `null` to drop the override and fall back to {@link setDefaults}.
   */
  setConsumerParams(consumer: RelightConsumer, params: RelightParams | null): void {
    const key = consumerKey(consumer);
    if (!key) return;
    const prev = this._overrides.get(key);
    if (params === null) {
      if (!prev) return;
      this._overrides.delete(key);
      this._merged.delete(key);
    } else {
      const next = stripUndefined(params);
      if (prev && sameParams(prev, next)) return;
      this._overrides.set(key, { ...prev, ...next });
    }
    this._stateVersion++;
  }

  /**
   * Register a proxy mesh instance. Receivers use {@link proxyLayerId};
   * caster-only proxies use {@link shadowCasterLayerId} instead.
   *
   * Only needed when {@link RelightPassOptions.visibility} is on: it creates
   * the unshadowed twin that the visibility ratio is measured against. The twin
   * shares the source's mesh, node and skin instance, so a skinned proxy needs
   * no second skinning pass. Idempotent.
   */
  addProxy(meshInstance: MeshInstance, lightingReceiver = true): void {
    if (this._destroyed || this._proxies.has(meshInstance)) return;
    if (!lightingReceiver) {
      // Keep a real mesh-list entry: PlayCanvas updates CPU skin matrices from
      // layer.meshInstances, not its separate shadowCasters list. No lighting
      // camera sees this layer, but the light gathers its animated casters.
      this._proxyLayer.removeMeshInstances([meshInstance]);
      this._shadowCasterLayer.addMeshInstances([meshInstance]);
      this._proxies.set(meshInstance, null);
      return;
    }
    let twin: MeshInstance | null = null;
    if (this._visibilityLayer) {
      twin = new MeshInstance(meshInstance.mesh!, this.proxyMaterial, meshInstance.node);
      // The whole point of the twin: same lighting, shadow maps ignored. PC
      // turns this into SHADERDEF_NOSHADOW -> litOptions.noShadow, which drops
      // both the per-light shadow sampling and CLUSTER_SHADOWS.
      twin.receiveShadow = false;
      twin.castShadow = false;
      // Shared, not cloned: the twin is the same geometry in the same pose,
      // and a second skin instance would mean a second palette upload.
      twin.skinInstance = meshInstance.skinInstance;
      twin.cull = meshInstance.cull;
      this._visibilityLayer.addMeshInstances([twin]);
    }
    this._proxies.set(meshInstance, twin);
  }

  /** Drop a proxy registered with {@link addProxy}. No-op if unknown. */
  removeProxy(meshInstance: MeshInstance): void {
    if (!this._proxies.has(meshInstance)) return;
    const twin = this._proxies.get(meshInstance);
    // Dropped, never destroyed: the mesh and the skin instance belong to the
    // caller's proxy, and freeing either would take the real one down with it.
    if (twin) this._visibilityLayer?.removeMeshInstances([twin]);
    this._proxyLayer.removeShadowCasters([meshInstance]);
    this._shadowCasterLayer.removeMeshInstances([meshInstance]);
    this._proxies.delete(meshInstance);
  }

  /** Tear everything down. Safe to call twice. */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;

    for (const mi of Array.from(this._proxies.keys())) this.removeProxy(mi);

    this._scene.app.off('prerender', this._prerenderHandler);
    this._scene.app.scene.off(EVENT_PRERENDER_LAYER, this._prerenderLayerHandler);
    this._mainCamera?.off?.('destroy', this._mainCameraDestroyHandler);

    for (const cam of [this._proxyCamera, this._visibilityCamera, this._composeCamera]) {
      if (!cam) continue;
      cam.parent?.removeChild(cam);
      try { cam.destroy(); } catch { /* already freed with the main camera */ }
    }
    this._proxyCamera = null;
    this._visibilityCamera = null;
    this._composeCamera = null;

    const composition = (this._scene.app.scene as unknown as {
      layers: { remove?: (l: Layer) => void };
    }).layers;
    composition?.remove?.(this._proxyLayer);
    composition?.remove?.(this._shadowCasterLayer);
    if (this._visibilityLayer) composition?.remove?.(this._visibilityLayer);
    composition?.remove?.(this._composeLayer);

    this._quad.destroy();
    this._releaseTargets();
    this.proxyMaterial.destroy();

    // Leave every consumer reading its baked colour rather than a freed
    // texture: the placeholder binding in `Splat` keeps the sampler valid.
    this._publish(false);
    this._applyEnvironments(null);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private _addCamera(
    name: string, layerId: number, rt: RenderTarget | null, priority: number,
  ): Entity {
    const entity = new Entity(name);
    this._mainCamera.addChild(entity);
    entity.addComponent('camera', {
      clearColor: new Color(0, 0, 0, 0),
      clearColorBuffer: true,
      clearDepthBuffer: true,
      clearStencilBuffer: false,
      layers: [layerId],
      priority,
    });
    // Set here, not in the addComponent options, which have dropped it. The
    // setter is typed non-null; `_ensureTargets` has already run.
    entity.camera!.renderTarget = rt as RenderTarget;
    // Linear HDR straight into the float target. The splat chunk expects the
    // same linear light values Unity's `half4(lighting, 1)` carries, and the
    // default sRGB encode + exposure would be a non-linear distortion the
    // reference-luminance knob could not undo.
    entity.camera!.gammaCorrection = GAMMA_NONE;
    entity.camera!.toneMapping = TONEMAP_NONE;
    entity.camera!.aspectRatioMode = ASPECT_MANUAL;
    return entity;
  }

  private _setCameraEnabled(on: boolean): void {
    if (this._proxyCamera) this._proxyCamera.enabled = on;
    if (this._visibilityCamera) this._visibilityCamera.enabled = on;
    if (this._composeCamera) this._composeCamera.enabled = on;
  }

  private _makeTexture(name: string, format: number): Texture {
    return new Texture(this._device, {
      name,
      width: this._rtWidth,
      height: this._rtHeight,
      format,
      mipmaps: false,
      // Bilinear, not point: an animated splat's screen position drifts across
      // this texture every frame and a point read pops at texel boundaries.
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
  }

  /** Idempotent, size-guarded allocator. No-op when the size already matches. */
  private _ensureTargets(): void {
    const w = Math.max(1, Math.round(this._device.width * this._resolutionScale));
    const h = Math.max(1, Math.round(this._device.height * this._resolutionScale));
    if (this._litRT && w === this._rtWidth && h === this._rtHeight) return;

    this._releaseTargets();
    this._rtWidth = w;
    this._rtHeight = h;
    // Environments hold the old textures until their next write - in every
    // refresh mode, since a freed texture is not a stale colour but an error.
    this.invalidateEnvironments();

    this._litTex = this._makeTexture('relight-proxy-lit', PIXELFORMAT_RGBA16F);
    // Depth on the proxy targets: proxies are opaque geometry that has to
    // occlude itself - an arm in front of a torso must win.
    this._litRT = new RenderTarget({
      name: 'relight-proxy-lit-rt',
      colorBuffer: this._litTex,
      depth: true,
      stencil: false,
      samples: 1,
    });

    if (this._visibility) {
      this._rawTex = this._makeTexture('relight-proxy-raw', PIXELFORMAT_RGBA16F);
      this._rawRT = new RenderTarget({
        name: 'relight-proxy-raw-rt',
        colorBuffer: this._rawTex,
        depth: true,
        stencil: false,
        samples: 1,
      });
    }

    this._lightingTex = this._makeTexture('relight-lighting', PIXELFORMAT_RGBA16F);
    // Visibility and coverage are both 0..1 but half-float rather than RG8:
    // the compose divides one by the other, and 8-bit coverage quantizes that
    // ratio into visible banding across a soft shadow edge.
    this._visibilityTex = this._makeTexture('relight-visibility', PIXELFORMAT_RG16F);
    this._composeRT = new RenderTarget({
      name: 'relight-compose-rt',
      colorBuffers: [this._lightingTex, this._visibilityTex],
      depth: false,
      stencil: false,
      samples: 1,
    });

    // A freshly sized target holds nothing; make consumers fall back to their
    // baked colour until the next compose fills it.
    this._framesRendered = 0;
  }

  private _restampRenderTargets(): void {
    if (this._proxyCamera?.camera && this._litRT) {
      this._proxyCamera.camera.renderTarget = this._litRT;
    }
    if (this._visibilityCamera?.camera && this._rawRT) {
      this._visibilityCamera.camera.renderTarget = this._rawRT;
    }
    if (this._composeCamera?.camera && this._composeRT) {
      this._composeCamera.camera.renderTarget = this._composeRT;
    }
  }

  private _releaseTargets(): void {
    this._litRT?.destroy();
    this._rawRT?.destroy();
    this._composeRT?.destroy();
    this._litTex?.destroy();
    this._rawTex?.destroy();
    this._lightingTex?.destroy();
    this._visibilityTex?.destroy();
    this._litRT = this._rawRT = this._composeRT = null;
    this._litTex = this._rawTex = this._lightingTex = this._visibilityTex = null;
  }

  /**
   * The parameter set one splat should see, defaults merged with its override.
   *
   * Merged into a STABLE object per splat rather than a fresh literal, so the
   * per-set buffers keyed off it survive from frame to frame.
   */
  private _resolved(key: object): Required<RelightParams> {
    const override = this._overrides.get(key);
    if (!override) return this._defaults;
    let merged = this._merged.get(key);
    if (!merged) {
      merged = { ...this._defaults, tint: { ...this._defaults.tint } };
      this._merged.set(key, merged);
    }
    Object.assign(merged, this._defaults, override);
    return merged;
  }

  private _onPrerender(): void {
    if (this._destroyed) return;

    // Parenting handles position and rotation; the projection has to be copied
    // each frame so fov changes and aspect-on-resize propagate. Aspect is taken
    // from the TARGET, not the canvas: the half-res rounding can differ from
    // the canvas ratio by a fraction of a percent, and the splat lookup uses
    // this same matrix.
    const main = this._mainCamera.camera;
    const aspect = this._rtHeight > 0 ? this._rtWidth / this._rtHeight : 1;
    for (const cam of [this._proxyCamera, this._visibilityCamera]) {
      const c = cam?.camera;
      if (!c || !main) continue;
      c.fov = main.fov;
      c.nearClip = main.nearClip;
      c.farClip = main.farClip;
      c.projection = main.projection;
      c.orthoHeight = main.orthoHeight;
      c.horizontalFov = main.horizontalFov;
      c.aspectRatio = aspect;
      c.priority = (main.priority ?? 0) - (cam === this._proxyCamera ? 4 : 3);
    }
    if (this._composeCamera?.camera && main) {
      this._composeCamera.camera.priority = (main.priority ?? 0) - 2;
    }

    // Publish LAST frame's pair, then stage this frame's matrix. Two buffers
    // because the published array is read at draw time, after this returns.
    this._vpPublished.set(this._vpPending);
    const valid = this._enabled && this._framesRendered > 0;
    this._publish(valid);
    this._stagePendingVP();

    this._refreshEnvironments(valid);
  }

  /**
   * Decide whether environments re-copy this frame, and mark them. Runs after
   * `_publish`, so `_liveEnvs` is this frame's.
   */
  private _refreshEnvironments(valid: boolean): void {
    if (Splat._envGsplatComponents.size === 0) return;
    const mode = this._environmentRefresh;
    if (mode === 'always') {
      this._refreshFrames = Math.max(this._refreshFrames, 1);
      this._refreshAll = true;
    } else if (mode === 'auto') {
      let changed = false;
      let all = false;
      if (this._stateVersion !== this._refreshedVersion || valid !== this._lastValid) {
        this._refreshedVersion = this._stateVersion;
        this._lastValid = valid;
        changed = all = true;
      }
      // Only while something samples the texture: an idle pass leaves every
      // environment at its baked colour, which no camera move can change.
      if (valid && this._liveEnvs.size > 0) {
        if (!equalArrays(this._vpPending, this._vpLast)) changed = true;
        const ambient = this._scene.app.scene.ambientLight;
        if (!ambient.equals(this._ambientLast)) {
          this._ambientLast.copy(ambient);
          changed = true;
        }
        if (this.changeProbe?.()) changed = true;
      }
      this._vpLast.set(this._vpPending);
      if (changed) {
        this._refreshFrames = REFRESH_TRAILING_FRAMES + 1;
        this._refreshAll = this._refreshAll || all;
      }
    }

    if (this._refreshFrames <= 0) return;
    this._refreshFrames--;
    if (this._refreshAll) this._applyEnvironments(null);
    else if (this._liveEnvs.size > 0) this._applyEnvironments(this._liveEnvs);
    else return;
    if (this._refreshFrames === 0) this._refreshAll = false;
    this._environmentRefreshFrames++;
  }

  /** view-projection of the proxy camera for the render about to happen. */
  private _stagePendingVP(): void {
    const cam = this._proxyCamera?.camera;
    if (!cam) return;
    this._tmpView.copy(this._proxyCamera!.getWorldTransform()).invert();
    this._tmpVP.mul2(cam.projectionMatrix, this._tmpView);
    this._vpPending.set(this._tmpVP.data);
  }

  private _compose(): void {
    if (!this._litTex || !this._lightingTex) return;
    const scope = this._device.scope;
    this._composeParams[0] = 1 / this._rtWidth;
    this._composeParams[1] = 1 / this._rtHeight;
    this._composeParams[2] = this._blurRadius;
    this._composeParams[3] = this._shadowBlurRadius;

    // The ambient the proxy material was denied, added back here. Same value
    // PlayCanvas would have put in `light_globalAmbient`: the scene ambient,
    // linearized. Deliberately not exposure-scaled - the proxy cameras render
    // with TONEMAP_NONE, which is the tonemap that does not apply exposure.
    this._ambientColor.linear(this._scene.app.scene.ambientLight);
    this._composeAmbient[0] = this._ambientColor.r;
    this._composeAmbient[1] = this._ambientColor.g;
    this._composeAmbient[2] = this._ambientColor.b;

    scope.resolve('uProxyLitTex').setValue(this._litTex);
    scope.resolve('uProxyRawTex').setValue(this._rawTex ?? this._litTex);
    scope.resolve('uComposeParams').setValue(this._composeParams);
    scope.resolve('uComposeHasRaw').setValue(this._visibility && this._rawTex ? 1 : 0);
    scope.resolve('uComposeAmbient').setValue(this._composeAmbient);
    this._quad.render();
    this._framesRendered++;
  }

  /**
   * Push the texture pair and its parameters to every live gsplat component
   * AND to global scope.
   *
   * Both channels are needed: `device.scope` alone does not reach the
   * work-buffer shader on WebGL, because PlayCanvas copies each gsplat
   * component's own parameters over scope at draw time.
   */
  private _publish(valid: boolean): void {
    const device = this._device;
    const scope = device.scope;
    this._stageShared(valid);

    scope.resolve('uRelightTex').setValue(this._sharedLighting);
    scope.resolve('uRelightShadowTex').setValue(this._sharedVisibility);
    scope.resolve('uRelightVP').setValue(this._vpPublished);
    scope.resolve('uRelightParams').setValue(this._params);
    scope.resolve('uRelightFlipY').setValue(this._flipY ? 1 : 0);

    // Scope defaults, for any consumer without per-component values.
    scope.resolve('uRelightStrength').setValue(this._defaults.strength);
    scope.resolve('uRelightTint').setValue(this._tintBuffer(this._defaults));
    scope.resolve('uRelightAmbient').setValue(this._defaults.ambient);
    scope.resolve('uRelightShadowStrength').setValue(
      this._visibility ? this._defaults.shadowStrength : 0);
    scope.resolve('uRelightDebug').setValue(debugMode(this._defaults.debug));

    for (const splat of Splat._liveInstances) {
      const gsplat = (splat.entity as unknown as { gsplat?: GsplatParams }).gsplat;
      this._apply(gsplat, this._resolved(splat));
    }

    // Environments are NOT written here. `GSplatComponent.setParameter` marks
    // the component's placement render-dirty, so writing an environment's
    // uniforms every frame re-copies the whole environment every frame - which
    // is exactly what `_refreshEnvironments` exists to avoid. They are written
    // on the frames it re-copies them, and only then; a copy is the only time
    // their values are read.
    this._liveEnvs.clear();
    for (const gsplat of Splat._envGsplatComponents) {
      const params = this._resolved(gsplat as object);
      if (valid && (params.strength > 0 || (this._visibility && params.shadowStrength > 0)
        || debugMode(params.debug) > 0)) {
        this._liveEnvs.add(gsplat);
      }
    }
  }

  /** The values every consumer shares this frame. */
  private _stageShared(valid: boolean): void {
    const device = this._device;
    this._sharedLighting = this._lightingTex ?? getRelightPlaceholder(device);
    this._sharedVisibility = this._visibilityTex ?? getRelightPlaceholder(device);
    this._params[0] = this._rtWidth > 0 ? 1 / this._rtWidth : 0;
    this._params[1] = this._rtHeight > 0 ? 1 / this._rtHeight : 0;
    this._params[2] = 1 / this._referenceLuminance;
    this._params[3] = valid ? 1 : 0;
  }

  /** Write one gsplat component's relight uniforms. Marks it render-dirty. */
  private _apply(gsplat: GsplatParams | null | undefined, params: Required<RelightParams>): void {
    if (!gsplat?.setParameter) return;
    gsplat.setParameter('uRelightTex', this._sharedLighting);
    gsplat.setParameter('uRelightShadowTex', this._sharedVisibility);
    gsplat.setParameter('uRelightVP', this._vpPublished);
    gsplat.setParameter('uRelightParams', this._params);
    gsplat.setParameter('uRelightFlipY', this._flipY ? 1 : 0);
    gsplat.setParameter('uRelightStrength', params.strength);
    gsplat.setParameter('uRelightTint', this._tintBuffer(params));
    gsplat.setParameter('uRelightAmbient', params.ambient);
    gsplat.setParameter('uRelightShadowStrength', this._visibility ? params.shadowStrength : 0);
    gsplat.setParameter('uRelightDebug', debugMode(params.debug));
  }

  /**
   * `setParameter` keeps the array by reference until the draw commits, so
   * each distinct parameter set needs its own buffer - but one per SET, not
   * one per component per frame, which would be pure GC churn on a scene full
   * of characters.
   */
  private _tintBuffer(params: Required<RelightParams>): Float32Array {
    let buf = this._tints.get(params);
    if (!buf) { buf = new Float32Array(3); this._tints.set(params, buf); }
    buf[0] = params.tint.r;
    buf[1] = params.tint.g;
    buf[2] = params.tint.b;
    return buf;
  }

  /** Write every environment in `set` (all of them when `null`) and mark them for a re-copy. */
  private _applyEnvironments(set: ReadonlySet<unknown> | null): void {
    for (const gsplat of Splat._envGsplatComponents) {
      if (set && !set.has(gsplat)) continue;
      this._apply(gsplat as GsplatParams, this._resolved(gsplat as object));
    }
    // The write already dirties each component's root placement; an LOD
    // bundle's streamed child placements need the walk.
    Splat.markEnvWorkBuffersDirty(set ?? undefined);
  }
}

/** The slice of `GSplatComponent` the publish path writes. */
type GsplatParams = { setParameter?: (name: string, value: unknown) => void };

/** The override-map key: the Splat itself, or an environment's gsplat component. */
function consumerKey(consumer: RelightConsumer): object | null {
  if (consumer instanceof Splat) return consumer;
  return ((consumer.entity as unknown as { gsplat?: object }).gsplat) ?? null;
}

/** Whether applying `next` over `base` would change nothing. */
function sameParams(base: RelightParams, next: RelightParams): boolean {
  for (const k of Object.keys(next) as (keyof RelightParams)[]) {
    const a = base[k], b = next[k];
    if (k === 'tint') {
      const ta = a as RelightParams['tint'], tb = b as RelightParams['tint'];
      if (!ta || !tb || ta.r !== tb.r || ta.g !== tb.g || ta.b !== tb.b) return false;
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

function equalArrays(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `true` means the lighting paint; a number selects the mode directly. */
function debugMode(v: boolean | number): number {
  return typeof v === 'number' ? v : v ? 1 : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
