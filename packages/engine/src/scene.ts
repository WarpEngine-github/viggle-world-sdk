import {
  AppBase,
  AppOptions,
  CameraComponentSystem,
  CameraFrame,
  CollisionComponentSystem,
  Color,
  ContainerHandler,
  createGraphicsDevice,
  Entity,
  GSPLAT_BUDGET_LIMIT,
  GSplatComponentSystem,
  GSplatHandler,
  Layer,
  LightComponentSystem,
  ParticleSystemComponentSystem,
  RenderComponentSystem,
  RenderHandler,
  RigidBodyComponentSystem,
  TextureHandler,
  Vec3,
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';

import type { Animation } from './animation';
import type { AnimLodPreset } from './armature';
import { PostFX } from './effects/postfx';
import { loadSkeletonLibrary } from './loader/skeleton';
import type { SkeletonLibrary } from './loader/skeleton';
import { bindRelightScopeDefaults } from './relight/relight-placeholder';
import { installOrthoNearCull } from './splat/ortho-cull';
import { installFastSogDecompress } from './loader/shared/fast-sog-decompress';
import { installFastTransformPack } from './loader/shared/fast-transform-pack';
import { installOverlaySplatHook } from './splat/overlay-style';
import { Splat } from './splat/splat';

/** Backend handles PC keeps off its public device type; only these fields are read. */
type DeviceInternals = {
  gl?: WebGL2RenderingContext;
  maxRenderBufferSize?: number;
  wgpu?: {
    adapter?: { features?: Set<string>; limits?: Record<string, number | undefined> };
  };
};

/**
 * Options for {@link Scene.create}. All fields are optional.
 *
 * @group Scene
 */
export interface CreateSceneOptions {
  /** Clear color as normalized floats (0–1). Default `{r: 0.08, g: 0.08, b: 0.12, a: 1}`. */
  bgColor?: { r: number; g: number; b: number; a: number };
  /**
   * Keep the WebGL/WebGPU drawing buffer contents after compositing so the
   * canvas can be read back (`canvas.toBlob`/`toDataURL`, `gl.readPixels`)
   * outside the render call. Default `false`.
   *
   * Normally the drawing buffer is cleared/recycled right after the browser
   * composites a frame, so a `toBlob` issued from an unrelated task reads an
   * empty buffer. Turn this on for offline capture pipelines (sprite-sheet
   * bakers, thumbnail renderers). It also implies an alpha-capable backbuffer
   * so a `bgColor` with `a: 0` produces genuinely transparent pixels.
   *
   * Has a small perf cost (the buffer can't be discarded between frames), so
   * leave it off for normal interactive scenes.
   */
  preserveDrawingBuffer?: boolean;
  /** Load the bundled skeleton library at scene creation. Default `true`. Disable only if you do not load characters. */
  loadSkeleton?: boolean;
  /** Enable WebGL/WebGPU MSAA. Default `false`. */
  antialias?: boolean;
  /** Preferred graphics backend. Omit to auto-detect (prefers WebGPU, falls back to WebGL2). */
  backend?: RenderBackend;
  /** Initial camera world position. Default `{x: 0, y: 1, z: 5}`. */
  cameraPosition?: { x: number; y: number; z: number };
  /** Initial camera look-at target. Default `{x: 0, y: 0.5, z: 0}`. */
  cameraTarget?: { x: number; y: number; z: number };
  /** Camera field of view in degrees. Default `60`. */
  fov?: number;
  /**
   * Camera near clip plane. Default `0.1`.
   *
   * Worth lowering for a panorama reconstruction: its nearest surface can sit
   * roughly 0.2 units from the capture point, so the default already slices
   * into the scene when the camera stands where the capture was taken.
   */
  near?: number;
  /** Camera far clip plane. Default `100`. */
  far?: number;
  /** Ambient light intensity (0–1). Default `0.55`. */
  ambientLight?: number;
  /** Tone mapping exposure. Default `1`. */
  exposure?: number;
  /**
   * Log device capabilities to the console at scene creation. Default `false`.
   * Useful when triaging backend-specific rendering issues.
   */
  logDeviceCaps?: boolean;
  /**
   * Register PlayCanvas's Ammo-backed physics component systems
   * (`RigidBodyComponentSystem` + `CollisionComponentSystem`) so consumers can
   * use `entity.rigidbody`, `entity.collision`, and `app.systems.rigidbody.raycastFirst(...)`.
   *
   * The engine does **not** ship Ammo itself. Pass either:
   *
   *  - `true`: assumes `globalThis.Ammo` is already set (e.g. via a script tag
   *    or a previous `await` of Ammo's factory). Throws if it isn't.
   *  - `{ loadAmmo }`: an async loader the engine awaits before registering
   *    the physics systems. Use this to keep ordering correct without exposing
   *    your bundler / CDN choices to the engine.
   *
   * Where Ammo comes from, since nothing in this package can tell you: take
   * `ammo.wasm.js` and `ammo.wasm.wasm` from the `playcanvas/engine` repository
   * at `examples/src/lib/ammo/`, from the tag matching your PlayCanvas version,
   * and serve them as static assets. Ammo's npm packaging is fragmented and its
   * wasm sidecar is bundler-specific, which is why the engine takes a loader
   * from you rather than pinning a build on your behalf.
   *
   * Default `false` - splat-only scenes pay nothing.
   */
  physics?: boolean | { loadAmmo: () => Promise<void> };
  /**
   * Additional PlayCanvas component system classes to register on the app, in
   * the same shape `AppOptions.componentSystems` accepts. Use for component
   * systems beyond what the engine wires by default
   * (camera / render / light / gsplat, plus optional rigidbody+collision via
   * {@link physics}).
   */
  extraComponentSystems?: unknown[];
  /**
   * Additional PlayCanvas resource handler classes to register on the app,
   * in the same shape `AppOptions.resourceHandlers` accepts. Use to opt into
   * loading file formats beyond what the engine wires by default
   * (render / texture / gsplat).
   */
  extraResourceHandlers?: unknown[];
  /**
   * Request a depth buffer on the graphics device. Default `false` - gsplat
   * sorts itself, so a depth buffer is wasted bandwidth for splat-only scenes.
   *
   * Turn this on when mixing PC standard render meshes / lines / immediate
   * mode primitives into the scene: without a depth buffer, opaque meshes
   * paint in submission order and farther geometry covers closer geometry.
   * Physics demos with rigidbody meshes almost always want `depth: true`.
   */
  depth?: boolean;
  /**
   * Cap on frames per second: frames that arrive sooner are skipped whole,
   * update and render alike. Default: the display's own rate. Phones run
   * splats hot at 60fps; 30 halves the work.
   */
  maxFps?: number;
  /**
   * Cap on the device pixel ratio used for the render target. Default `1`.
   *
   * Gaussian splat rendering is fragment-shader-bound - every covered pixel
   * runs the full splat shader. Honoring `window.devicePixelRatio` directly
   * on a 2x display means 4x the fragment work, on 3x it's 9x. PC's own
   * optimization guidelines warn about this explicitly.
   *
   * Common values:
   *   - `1`          - best perf, slight blur on HiDPI screens (default)
   *   - `1.5`        - sharper on Retina, ~2.25x cost vs `1`
   *   - `window.devicePixelRatio` - full native sharpness, full cost
   */
  maxPixelRatio?: number;
  /**
   * URL of the `glslang.js` ES module used to transpile GLSL → SPIR-V on
   * the WebGPU backend. PlayCanvas fetches it lazily - only when the WebGPU
   * device is actually created - so consumers that never select WebGPU pay
   * nothing. Must be paired with {@link twgslUrl}. Without these URLs,
   * `ShaderMaterial`s that provide only GLSL fail to compile on WebGPU.
   *
   * Typical setup: copy `glslang.js` + `glslang.wasm` into your app's
   * `public/lib/glslang/` and pass `'/lib/glslang/glslang.js'`.
   */
  glslangUrl?: string;
  /**
   * URL of the `twgsl.js` ES module used to transpile SPIR-V → WGSL on the
   * WebGPU backend. See {@link glslangUrl} for setup notes.
   */
  twgslUrl?: string;
  /**
   * Discard splats smaller than this many screen-space pixels. Works on every
   * renderer (it lives in the corner vertex stage). `true` uses PlayCanvas's
   * default of 2px; a number sets an explicit pixel size. Default `false` /
   * omitted = `0` = no sub-pixel culling (every splat is drawn).
   */
  subPixelCull?: boolean | number;
  /**
   * Discard splats whose screen contribution (opacity × projected area) falls
   * below this value. WebGPU (GPU sort) only. `true` uses
   * PlayCanvas's default of 3; a number sets an explicit threshold. Default
   * `false` / omitted = `0` = no contribution culling.
   */
  contributionCull?: boolean | number;
}

/**
 * Graphics backend preference for {@link CreateSceneOptions.backend}.
 *
 * @group Scene
 */
export type RenderBackend = 'webgl' | 'webgpu';

interface MinimalAppInit {
  graphicsDevice: GraphicsDevice;
  physics: boolean;
  extraComponentSystems: unknown[];
  extraResourceHandlers: unknown[];
}

class MinimalApp extends AppBase {
  constructor(canvas: HTMLCanvasElement, init: MinimalAppInit) {
    super(canvas);
    const opts = new AppOptions();
    opts.graphicsDevice = init.graphicsDevice;
    opts.componentSystems = [
      // @ts-ignore
      CameraComponentSystem,
      // @ts-ignore
      RenderComponentSystem,
      // @ts-ignore
      LightComponentSystem,
      GSplatComponentSystem,
      // @ts-ignore
      ParticleSystemComponentSystem,
      ...(init.physics ? [
        // @ts-ignore
        RigidBodyComponentSystem,
        // @ts-ignore
        CollisionComponentSystem,
      ] : []),
      ...(init.extraComponentSystems as typeof opts.componentSystems),
    ];
    opts.resourceHandlers = [
      // @ts-ignore
      RenderHandler,
      // @ts-ignore
      TextureHandler,
      GSplatHandler,
      // ContainerHandler loads GLB/GLTF. Registered by default so consumers
      // can `app.assets.loadFromUrl(url, 'container', ...)` for game props,
      // stage geometry, weapons, etc. without an extra opt-in.
      // @ts-ignore
      ContainerHandler,
      ...(init.extraResourceHandlers as typeof opts.resourceHandlers),
    ];
    this.init(opts);
  }
}

/** Wraps PlayCanvas's rAF tick so frames inside the interval only re-arm it.
 *  The next real tick's dt spans the skipped frames, so motion keeps its speed. */
function capFrameRate(app: AppBase, maxFps: number) {
  const internals = app as unknown as { tick: (timestamp?: number, frame?: unknown) => void; frameRequestId: number | null };
  const tick = internals.tick;
  // A frame up to 2ms early still counts, or 60Hz vsync jitter would drop to 20fps.
  const interval = 1000 / maxFps - 2;
  let last = -Infinity;
  internals.tick = (timestamp, frame) => {
    const now = timestamp ?? performance.now();
    if (now - last < interval) {
      // app.destroy() nulls the tick; a frame already queued must not re-arm.
      if (internals.tick) internals.frameRequestId = requestAnimationFrame(internals.tick);
      return;
    }
    last = now;
    tick(timestamp, frame);
  };
}

function backendToDeviceTypes(backend?: RenderBackend): string[] {
  if (backend === 'webgpu') return ['webgpu'];
  if (backend === 'webgl') return ['webgl2'];
  return ['webgpu', 'webgl2'];
}

/**
 * Top-level rendering context. Owns the PlayCanvas `AppBase`, the content root
 * entity, a camera, and the shared skeleton + animation registries that
 * {@link Character} and {@link Animation} register themselves into.
 *
 * Construct with the async factory {@link Scene.create}; the constructor itself
 * is only used internally.
 *
 * @example
 * ```ts
 * const scene = await Scene.create(canvas, { fov: 45 });
 * scene.start();
 * ```
 *
 * @group Scene
 */
/**
 * Thrown when an asset finishes loading onto a scene that has already been
 * destroyed.
 *
 * This is a CANCELLATION, not a failure: the bytes were fine and the scene is
 * simply gone. It exists as its own type so a caller can tell the two apart -
 * a UI that shows an error state for a load the user themselves cancelled (by
 * navigating away, or by changing a prop that remounts the canvas) is reporting
 * a bug that did not happen.
 */
export class SceneDestroyedError extends Error {
  constructor(what: string) {
    super(`${what}: the scene was destroyed while the asset was loading`);
    this.name = 'SceneDestroyedError';
  }
}

export class Scene {
  /** Underlying PlayCanvas application. */
  app: AppBase;
  /** Parent entity for all user-added content (characters, environments, etc.). */
  contentRoot: Entity;
  /** Camera entity driven by the scene and any attached controller. */
  cameraEntity: Entity;
  /** The selected WebGL/WebGPU device. */
  graphicsDevice: GraphicsDevice;
  /** Bundled skeleton definitions used by {@link Character.load}. */
  skeletonLibrary: SkeletonLibrary;
  /** Name → {@link Animation} registry written to by {@link Animation.register}. */
  skeletalAnimationLibrary: Map<string, Animation>;
  /**
   * Post-process pipeline for this scene. Pass effects (pixelart, future
   * bloom-by-shader-chunk, etc.) attach here. Always present; empty until
   * the first `scene.postfx.add(...)` call. See {@link PostFX}.
   */
  postfx: PostFX;
  private _destroyed = false;
  /**
   * Whether {@link Scene.destroy} has run and the graphics device is gone.
   *
   * Loading an asset is asynchronous and tearing down a scene is not, so a load
   * started before a teardown can finish after it. Anything that would touch
   * the GPU after the fact must ask this first: the device's `gl` is null by
   * then, and the failure surfaces far from its cause as
   * `Cannot read properties of null (reading 'activeTexture')` deep inside a
   * texture upload - or, if the canvas has already been remounted, as
   * `bindTexture: object does not belong to this context`, because the resource
   * belongs to the previous device while the new one is bound.
   */
  get destroyed(): boolean {
    return this._destroyed;
  }
  /**
   * Shared PC `CameraFrame` for the main camera. Lazily created the first
   * time a post-fx pass (or `getOrCreateCameraFrame`) needs it - splat-only
   * scenes that don't use any post-fx never pay for it.
   */
  cameraFrame: CameraFrame | null = null;

  /**
   * Scene-wide default for distance-based animation LOD. `null` = no
   * preset (armatures that opt in via `setAnimationLod()` with no args
   * then fall back to the engine's built-in default). Set this once when
   * configuring the scene; individual armatures still opt in per-instance
   * via {@link Armature.setAnimationLod} (LOD is off until they do).
   */
  animLodPreset: AnimLodPreset | null = null;

  /**
   * `app.frame` of the most recent frame on which ANY armature actually
   * re-evaluated and pushed a new character pose. Armatures stamp this from
   * {@link Armature.update} only on frames that pass all the anim-LOD
   * throttles (skipped / frame-dropped frames leave it untouched). Consumers
   * that mirror character pose into a secondary pass - notably
   * {@link PixelartEffect}'s mask camera - compare it against the current
   * `app.frame` to decide whether anything moved this frame, so they can
   * skip an expensive rebuild when every tagged character was LOD-throttled.
   *
   * -1 = no pose pushed yet. Read-only for consumers; written by Armature.
   */
  characterPoseUpdatedFrame = -1;

  /**
   * Layer ID for environment (background) Gaussian splats. Assigned by
   * {@link Scene.create} and used by {@link Environment.load} to put env
   * entities on a dedicated layer so they get their own {@link GSplatManager}
   * and sort worker, separate from the character/World layer.
   *
   * Separation means the env sort worker only processes env splats (fewer
   * entries → less `setOrderData` upload cost), and the character sort worker
   * is not burdened by static background splats. The env layer renders before
   * the World layer so backgrounds stay visually behind characters.
   */
  readonly envLayerId: number;

  /**
   * Layer ID for overlay splats: clouds that must paint over everything
   * else, whatever their depth. Sits after World in the composition. Walk
   * mode puts the character's see-through copy here (see
   * {@link Character.addOverlaySplat} + `applyOverlaySplatStyle`).
   */
  readonly overlayLayerId: number;

  private _resizeObserver: ResizeObserver;
  private _resize: { beforePaint: boolean };

  /**
   * Resize the drawing buffer and draw in the ResizeObserver tick, so the
   * browser paints the new size rather than the old frame stretched into it.
   * Costs a second draw in frames where the size changes.
   */
  get resizeBeforePaint(): boolean { return this._resize.beforePaint; }
  set resizeBeforePaint(v: boolean) { this._resize.beforePaint = v; }

  constructor(
    app: AppBase,
    contentRoot: Entity,
    cameraEntity: Entity,
    skeletonLibrary: SkeletonLibrary,
    resizeObserver: ResizeObserver,
    resize: { beforePaint: boolean },
    envLayerId: number,
    overlayLayerId: number,
  ) {
    this.app = app;
    this.contentRoot = contentRoot;
    this.cameraEntity = cameraEntity;
    this.graphicsDevice = app.graphicsDevice;
    this.skeletonLibrary = skeletonLibrary;
    this.skeletalAnimationLibrary = new Map();
    this._resizeObserver = resizeObserver;
    this._resize = resize;
    this.postfx = new PostFX(this);
    this.envLayerId = envLayerId;
    this.overlayLayerId = overlayLayerId;
  }

  /**
   * Lazily construct (and return) PC's `CameraFrame` for the main camera.
   * Subsequent calls return the same instance. Default settings: scene
   * depth map ON (so PC standard meshes depth-compose with the gsplat
   * compute rasterizer, which is the main reason we install CameraFrame
   * in the first place); everything else at PC's defaults.
   *
   * Effects calling this from {@link PostFXPass.configureFrame} are
   * expected to first stamp the camera (e.g. `cam.renderTarget = …`) so
   * CameraFrame's compose captures the desired RT.
   */
  getOrCreateCameraFrame(): CameraFrame {
    if (this.cameraFrame) return this.cameraFrame;
    const cam = this.cameraEntity.camera;
    if (!cam) {
      throw new Error('[Scene] getOrCreateCameraFrame: cameraEntity has no camera component');
    }
    const frame = new CameraFrame(this.app, cam);
    frame.rendering.sceneDepthMap = true;
    frame.update();
    this.cameraFrame = frame;
    return frame;
  }

  /** Tear down the CameraFrame so the camera has no `framePasses` when
   *  callers swap its renderTarget. Required because PC's renderTarget
   *  setter both warns when framePasses is non-empty AND framePasses
   *  cache RT references that go stale after the swap.
   *
   *  Pair with `getOrCreateCameraFrame()` after the RT swap to rebuild.
   *  Safe to call when no CameraFrame exists. */
  destroyCameraFrame(): void {
    if (!this.cameraFrame) return;
    try { this.cameraFrame.destroy(); } catch { /* keep going */ }
    this.cameraFrame = null;
  }

  /** Start the render loop. Call once after scene setup. */
  start() {
    this.app.start();
  }

  /** Pause rendering (updates keep ticking); resuming draws one frame. */
  setSuspended(suspended: boolean) {
    if (this._destroyed) return;
    this.app.autoRender = !suspended;
    if (!suspended) this.app.renderNextFrame = true;
  }

  /**
   * Tear down the render loop, release the graphics context, and disconnect
   * the resize observer. Call when removing the canvas from the DOM.
   */
  destroy() {
    // Set FIRST, before any teardown that could throw, so anything still in
    // flight sees a dead scene even if the rest of this method does not finish.
    this._destroyed = true;
    this._resizeObserver.disconnect();
    this.app.autoRender = false;

    // Save lose-context extension before app.destroy() nullifies the gl ref -
    // we call loseContext() at the very end so Safari frees GPU resources
    // immediately instead of waiting for GC. Prevents the ~8-context limit
    // crash when rapidly creating + destroying scenes (SPA navigation,
    // round restarts).
    const canvas = this.graphicsDevice.canvas;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const loseCtx = gl?.getExtension('WEBGL_lose_context');

    // Free the camera's render target (PC doesn't destroy these on app
    // teardown because the graphicsDevice is shared across scenes; without
    // this the textures leak across SPA navigation / round restarts).
    try {
      const camComp = this.cameraEntity.camera;
      const rt = camComp?.renderTarget;
      if (rt) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (rt as any).destroyTextureBuffers?.();
        rt.destroy();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (camComp as any).renderTarget = null;
      }
    } catch { /* ignore cleanup errors */ }

    // Release the animation library map so the keyframe + spline data inside
    // each Animation can be GC'd promptly. Without this the per-anim
    // CubicSpline.poses arrays survive until the next manual clear.
    this.skeletalAnimationLibrary.clear();

    // Splat keeps process-global registries (live instances, the shared
    // per-device bone-texture cache) that a page-lifetime module holds, not
    // the scene. Release ours before the app goes away, while the entities
    // and the graphics device are still intact enough to unwind cleanly.
    try { Splat.releaseScene(this); } catch { /* keep tearing down */ }

    try { this.postfx.destroyAll(); } catch { /* keep tearing down */ }
    try { this.cameraFrame?.destroy(); } catch { /* keep tearing down */ }
    this.cameraFrame = null;
    try { this.app.destroy?.(); } catch { /* ignore cleanup errors */ }

    // Force-release the WebGL context so Safari frees GPU resources
    // immediately instead of waiting for GC.
    loseCtx?.loseContext();
  }

  /**
   * Initialize the engine on the given canvas and return a ready scene.
   *
   * Picks a graphics device, wires up a content root and camera, loads the
   * skeleton library (unless `loadSkeleton` is false), and installs a
   * ResizeObserver that keeps the drawing buffer in sync with the canvas.
   *
   * @param canvas - Target canvas element.
   * @param opts - See {@link CreateSceneOptions}.
   * @returns A started-but-not-rendering {@link Scene}. Call {@link Scene.start} to begin rendering.
   */
  static async create(
    canvas: HTMLCanvasElement,
    opts?: CreateSceneOptions,
  ): Promise<Scene> {
    const bgClr = opts?.bgColor ?? { r: 0.08, g: 0.08, b: 0.12, a: 1 };
    const deviceTypes = backendToDeviceTypes(opts?.backend);

    const graphicsDevice = await createGraphicsDevice(canvas, {
      deviceTypes,
      antialias: opts?.antialias ?? false,
      depth: opts?.depth ?? false,
      stencil: false,
      xrCompatible: false,
      // Offline-capture pipelines need a readable backbuffer. Enabling
      // preserveDrawingBuffer also requires an alpha-capable backbuffer for
      // transparent-background reads (bgColor.a === 0), so request both
      // together.
      ...(opts?.preserveDrawingBuffer
        ? { preserveDrawingBuffer: true, alpha: true }
        : {}),
      powerPreference: 'high-performance',
      // WebGPU-only - PlayCanvas fetches these lazily inside the device
      // factory, so consumers that never land on WebGPU (no URL provided,
      // or browser unsupported, or `backend: 'webgl'`) pay zero bytes.
      ...(opts?.glslangUrl && opts?.twgslUrl
        ? { glslangUrl: opts.glslangUrl, twgslUrl: opts.twgslUrl }
        : {}),
    });

    if (opts?.logDeviceCaps) {
      // eslint-disable-next-line no-console
      console.log('[SplatEngine] device caps', Scene.getDeviceCapabilities(graphicsDevice));
    }

    // Resolve physics opt-in. If a loader is supplied, await it before
    // registering the rigidbody/collision systems - PC's RigidBodyComponent
    // initializer reads globalThis.Ammo on first use, but the safer contract
    // is "Ammo present before the system registers."
    const physicsOpt = opts?.physics ?? false;
    if (physicsOpt && typeof physicsOpt === 'object' && 'loadAmmo' in physicsOpt) {
      await physicsOpt.loadAmmo();
    }
    if (physicsOpt && !(globalThis as { Ammo?: unknown }).Ammo) {
      throw new Error(
        '[SplatEngine] physics requires globalThis.Ammo to be set. ' +
        'Either load Ammo before Scene.create, or pass physics={ loadAmmo: () => Promise<void> }. ' +
        'Ammo is not shipped with this package: take ammo.wasm.js and ammo.wasm.wasm from ' +
        'playcanvas/engine at examples/src/lib/ammo/, from the tag matching your PlayCanvas ' +
        'version, and serve them as static assets.',
      );
    }

    const app = new MinimalApp(canvas, {
      graphicsDevice,
      physics: !!physicsOpt,
      extraComponentSystems: opts?.extraComponentSystems ?? [],
      extraResourceHandlers: opts?.extraResourceHandlers ?? [],
    });
    // After init: the gsplat system registers the chunk this patches.
    installOrthoNearCull(graphicsDevice);
    installFastTransformPack();
    installFastSogDecompress();
    // Before any splat material compiles, so placing a character later doesn't recompile them all.
    installOverlaySplatHook(app);
    app.autoRender = true;
    if (opts?.maxFps) capFrameRate(app, opts.maxFps);
    // @ts-ignore
    app._allowResize = false;
    // PC 2.17.2 mandates clustered lighting on WebGPU (setting false just
    // warns and has no effect). We don't use PC's built-in LightComponent
    // system - all our lighting is custom via the gsplat work-buffer
    // shader reading scope uniforms - so the flag's value is irrelevant
    // either way. Leaving it at the default (enabled) silences the warning.
    const maxPixelRatio = opts?.maxPixelRatio ?? 1;
    app.graphicsDevice.maxPixelRatio = maxPixelRatio;
    // The canvas's box now, not its 300x150 default: the observer's first size
    // only lands on the second frame, so the first one would be painted
    // stretched. The observer below refines it to exact device pixels.
    {
      const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
      const w = Math.ceil(canvas.clientWidth * ratio);
      const h = Math.ceil(canvas.clientHeight * ratio);
      if (w > 0 && h > 0) app.graphicsDevice.setResolution(w, h);
    }

    // @ts-ignore - disable lightmapper first bake
    app.off('prerender', app._firstBake, app);

    const amb = opts?.ambientLight ?? 0.55;
    app.scene.ambientLight.set(amb, amb, amb);
    app.scene.exposure = opts?.exposure ?? 1.0;

    // Gsplat render-time culls are OPT-IN (default off): the engine draws the
    // full splat set unless a consumer asks for an optimization. Each maps to a
    // PC `app.scene.gsplat` (GSplatParams) property.
    //  - sub-pixel cull    → `minPixelSize` (off ⇒ 0; PC default 2px)
    //  - contribution cull → `minContribution` (off ⇒ 0; PC default 3)
    app.scene.gsplat.minPixelSize =
      opts?.subPixelCull == null || opts.subPixelCull === false ? 0
        : opts.subPixelCull === true ? 2 : opts.subPixelCull;
    app.scene.gsplat.minContribution =
      opts?.contributionCull == null || opts.contributionCull === false ? 0
        : opts.contributionCull === true ? 3 : opts.contributionCull;
    // No splat budget: LOD distances alone pick each node's level (budget 0
    // in TARGET mode would mean the finest level everywhere).
    app.scene.gsplat.splatBudget = 0;
    app.scene.gsplat.splatBudgetMode = GSPLAT_BUDGET_LIMIT;

    const contentRoot = new Entity('contentRoot');
    app.root.addChild(contentRoot);

    const clearColor = new Color(bgClr.r, bgClr.g, bgClr.b, bgClr.a);
    const cameraEntity = new Entity('camera');
    cameraEntity.addComponent('camera', {
      fov: opts?.fov ?? 60,
      farClip: opts?.far ?? 100,
      nearClip: opts?.near ?? 0.1,
      clearColor,
    });
    const camPos = opts?.cameraPosition ?? { x: 0, y: 1, z: 5 };
    cameraEntity.setPosition(camPos.x, camPos.y, camPos.z);
    const camTarget = opts?.cameraTarget ?? { x: 0, y: 0.5, z: 0 };
    cameraEntity.lookAt(new Vec3(camTarget.x, camTarget.y, camTarget.z));
    app.root.addChild(cameraEntity);

    // NOTE: PC's `CameraFrame` (the host for the depth-prepass that the
    // compute gsplat rasterizer reads via `uSceneDepthMap` /
    // `cam.shaderParams.sceneDepthMapLinear`) is no longer constructed
    // here. It moved behind `scene.getOrCreateCameraFrame()` so the first
    // post-fx pass that needs it can stamp `cam.renderTarget` *before*
    // CameraFrame's compose captures it - which was the root of the
    // "Setting a render target on the camera after the frame passes is
    // not supported" warning. See the additional note where
    // `scene = new Scene(...)` is created below for the contract callers
    // must honor.

    let pendingSize: { w: number; h: number } | null = null;
    const resize = { beforePaint: false };
    const observer = new ResizeObserver((entries: ResizeObserverEntry[]) => {
      if (entries.length > 0) {
        const entry = entries[0];
        if (entry) {
          // ResizeObserver fires asynchronously; by the time it ticks the
          // app may have been torn down (route change, HMR, scene.destroy),
          // leaving graphicsDevice null. Bail rather than throw.
          const device = app.graphicsDevice;
          if (!device) return;
          // Read the cap from the device so runtime changes to
          // maxPixelRatio take effect on the next resize.
          const cap = device.maxPixelRatio;
          const pixelRatio = Math.min(window.devicePixelRatio, cap);
          let w: number, h: number;
          if (entry.devicePixelContentBoxSize) {
            // devicePixelContentBoxSize is in physical device pixels and
            // ignores maxPixelRatio. Scale back to CSS pixels then apply
            // the capped ratio so the backing store matches what PC
            // actually renders to.
            const scale = pixelRatio / window.devicePixelRatio;
            w = Math.ceil(entry.devicePixelContentBoxSize[0].inlineSize * scale);
            h = Math.ceil(entry.devicePixelContentBoxSize[0].blockSize * scale);
          } else if (entry.contentBoxSize.length > 0) {
            w = Math.ceil(entry.contentBoxSize[0].inlineSize * pixelRatio);
            h = Math.ceil(entry.contentBoxSize[0].blockSize * pixelRatio);
          } else {
            return;
          }
          if (w > 0 && h > 0) {
            // Rendering here is what makes the painted frame the new one.
            if (resize.beforePaint && app.autoRender) {
              pendingSize = null;
              if (canvas.width !== w || canvas.height !== h) {
                device.setResolution(w, h);
                app.render();
              }
            } else {
              pendingSize = { w, h };
            }
          }
        }
      }
    });
    observer.observe(canvas);

    // Resizing clears the canvas, and ResizeObserver runs after the frame is
    // drawn but before paint - resizing there paints a blank frame. Apply the
    // recorded size just before the next draw instead.
    app.on('framerender', () => {
      const device = app.graphicsDevice;
      if (!pendingSize || !device) return;
      const { w, h } = pendingSize;
      pendingSize = null;
      if (canvas.width === w && canvas.height === h) return;
      // Go through the device so the `resizecanvas` event fires -
      // PixelartEffect (and any other downstream RT owner) only learns
      // about resizes via that event. Writing canvas.width/height
      // directly resizes the backbuffer but leaves attached RTs
      // (e.g. PixelartEffect's lowResRT/maskRT) at their old size,
      // which stretches the rendered image to fit the new canvas.
      device.setResolution(w, h);
      app.renderNextFrame = true;
    });

    const skeletonLibrary = (opts?.loadSkeleton !== false)
      ? loadSkeletonLibrary()
      : { boneNames: [] };

    // Create a dedicated layer for environment (background) splats so they
    // get their own GSplatManager + sort worker, independent of the character
    // World layer. Insert it before World in the composition so it renders
    // first (env always behind characters). Also add it to the camera's layer
    // list so the camera actually renders it.
    const composition = app.scene.layers;
    const envLayer = new Layer({ name: 'EnvironmentSplats' });
    const worldLayer = composition.getLayerByName('World');
    if (worldLayer) {
      // insert() adds both the opaque AND transparent sublayers of envLayer
      // at this slot. GSplat rendering uses the transparent sublayer -
      // insertOpaque alone would leave no transparent slot and the director
      // would never create a manager, making env invisible.
      //
      // Insertion point is World's TRANSPARENT slot, not its opaque slot:
      // any prerender hook on World.opaque (notably SkyDome, which paints a
      // fullscreen quad in the pre-World-opaque phase) would otherwise draw
      // OVER env splats inserted earlier in the composition, hiding the env
      // entirely. Sitting at World's transparent slot puts env after
      // World.opaque (and its SkyDome paint) but before World.transparent
      // (where character splats render - env stays visually behind chars).
      composition.insert(envLayer, composition.getTransparentIndex(worldLayer));
    } else {
      composition.push(envLayer);
    }
    // Overlay layer: the mirror of env. Inserted right AFTER World's
    // transparent slot so its splats composite over both env and World.
    const overlayLayer = new Layer({ name: 'OverlaySplats' });
    if (worldLayer) {
      composition.insert(overlayLayer, composition.getTransparentIndex(worldLayer) + 1);
    } else {
      composition.push(overlayLayer);
    }
    const cam = cameraEntity.camera!;
    const camLayersCopy = cam.layers ? [...cam.layers] : [];
    const worldIdxInCam = worldLayer ? camLayersCopy.indexOf(worldLayer.id) : -1;
    if (worldIdxInCam >= 0) {
      camLayersCopy.splice(worldIdxInCam, 0, envLayer.id);
      camLayersCopy.splice(worldIdxInCam + 2, 0, overlayLayer.id);
    } else {
      camLayersCopy.unshift(envLayer.id);
      camLayersCopy.push(overlayLayer.id);
    }
    cam.layers = camLayersCopy;

    const scene = new Scene(app, contentRoot, cameraEntity, skeletonLibrary, observer, resize, envLayer.id, overlayLayer.id);
    bindRelightScopeDefaults(scene.graphicsDevice);

    // NOTE: `opts.depth` is intentionally not realizing CameraFrame here.
    // PostFX must own the realization timing - any pass that captures the
    // scene (e.g. PixelartEffect's lowResRT) needs to stamp
    // `cam.renderTarget` *before* CameraFrame's compose pass is built,
    // and eagerly realizing here would force a destroy+rebuild dance
    // that PC doesn't recover cleanly from. Callers wanting depth-compose
    // for PC standard meshes against splats should either add a post-fx
    // pass (PixelartEffect requests `sceneDepthMap` for you), or call
    // `scene.getOrCreateCameraFrame()` explicitly after Scene.create
    // returns - at which point any later post-fx add becomes a hard
    // failure for capturing passes, which is the correct behavior.

    return scene;
  }

  /**
   * Collect commonly-useful capability fields from a PlayCanvas graphics
   * device. Intended for debug overlays and backend-diagnostic logging.
   * {@link Scene.create} logs the result of a call to this at scene creation
   * when {@link CreateSceneOptions.logDeviceCaps} is set.
   *
   * @param device - A PlayCanvas graphics device (usually `scene.graphicsDevice`).
   * @returns Plain object of capability name → value.
   */
  static getDeviceCapabilities(device: GraphicsDevice): Record<string, unknown> {
    const { gl, wgpu, maxRenderBufferSize } = device as unknown as DeviceInternals;
    const caps: Record<string, unknown> = {
      deviceType: device.deviceType,
      isWebGL2: !!device.isWebGL2,
      maxTextureSize: device.maxTextureSize,
      maxRenderBufferSize,
      precision: device.precision,
      textureFloatRenderable: device.textureFloatRenderable,
      textureHalfFloatRenderable: device.textureHalfFloatRenderable,
      textureFloatFilterable: device.textureFloatFilterable,
      supportsMultiDraw: device.supportsMultiDraw,
      supportsCompute: device.supportsCompute,
    };

    if (gl) {
      caps.gl_VERSION = gl.getParameter(gl.VERSION);
      caps.gl_RENDERER = gl.getParameter(gl.RENDERER);
      caps.gl_VENDOR = gl.getParameter(gl.VENDOR);
      caps.gl_MAX_TEXTURE_SIZE = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      caps.gl_MAX_VERTEX_TEXTURE_IMAGE_UNITS = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
      const exts = gl.getSupportedExtensions() ?? [];
      caps.has_EXT_color_buffer_float = exts.includes('EXT_color_buffer_float');
      caps.has_EXT_color_buffer_half_float = exts.includes('EXT_color_buffer_half_float');
      caps.has_OES_texture_float_linear = exts.includes('OES_texture_float_linear');
    }

    const adapter = wgpu?.adapter;
    if (adapter) {
      const features: string[] = [];
      try {
        if (adapter.features) {
          features.push(...Array.from(adapter.features as Set<string>));
        }
      } catch {
        // ignore adapter features access errors
      }
      const limits = adapter.limits;
      const webgpuLimits: Record<string, number | undefined> = {
        maxTextureDimension2D: limits?.maxTextureDimension2D,
        maxTextureArrayLayers: limits?.maxTextureArrayLayers,
        maxBindGroups: limits?.maxBindGroups,
        maxComputeWorkgroupStorageSize: limits?.maxComputeWorkgroupStorageSize,
        maxComputeInvocationsPerWorkgroup: limits?.maxComputeInvocationsPerWorkgroup,
        maxComputeWorkgroupSizeX: limits?.maxComputeWorkgroupSizeX,
        maxComputeWorkgroupSizeY: limits?.maxComputeWorkgroupSizeY,
        maxComputeWorkgroupSizeZ: limits?.maxComputeWorkgroupSizeZ,
      };
      caps.webgpu_features = features;
      caps.webgpu_limits = webgpuLimits;
    }

    return caps;
  }
}
