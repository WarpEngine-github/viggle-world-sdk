import {
  ADDRESS_CLAMP_TO_EDGE,
  Color,
  Entity,
  EVENT_PRERENDER_LAYER,
  FILTER_LINEAR,
  Layer,
  PIXELFORMAT_RGBA8,
  QuadRender,
  RenderTarget,
  SEMANTIC_POSITION,
  ShaderUtils,
  Texture,
  type CameraFrame,
  type GraphicsDevice,
  type ScopeSpace,
} from 'playcanvas';
import type { CameraComponent } from 'playcanvas';

import type { Scene } from '../../scene';
import type { PostFXFrameConfig, PostFXInstallContext, PostFXPass } from './postfx';

/**
 * Construction-time options for a {@link BaseCapturingPass}.
 *
 * @group PostFX
 */
export interface BaseCapturingPassOptions {
  /** Unique name for shader-cache deduplication. Keep stable for a given
   *  pass class - e.g. `'crt-compose-v1'`. */
  readonly shaderName: string;
  /** GLSL fragment source. Must use `gl_FragCoord` (NOT `vUv0`) when
   *  sampling source RTs; see rule 7 in `postfx.ts`. */
  readonly fragmentGLSL: string;
  /** WGSL fragment source. Must use `input.position.xy` (NOT
   *  `input.vUv0`) when sampling source RTs; see rule 7 in `postfx.ts`. */
  readonly fragmentWGSL: string;
  /** When true, also request the scene-depth prepass via
   *  `PostFXFrameConfig.sceneDepthMap`. Default false (uses `requireFrame`
   *  to ensure CameraFrame realizes without paying for the prepass). */
  readonly needsSceneDepth?: boolean;
  /** Compose-camera priority offset relative to the main camera. Default
   *  `+3` - leaves room for pixelart's mask camera (`+1`) and compose
   *  camera (`+2`) when chained downstream of it. Set higher if you
   *  expect more passes to chain after you. */
  readonly composePriorityOffset?: number;
}

/**
 * Abstract base class for *capturing* {@link PostFXPass} implementations
 * that follow the standard "capture the scene into an RT, run a
 * fullscreen quad shader, write to chain output" pattern.
 *
 * ## What this base class encodes for you (rules 1-6 in `postfx.ts`)
 *
 * - Caches `this._scene` in `configureFrame` (**rule 1**).
 * - Allocates `_ownSceneRT` eagerly in `getSceneCaptureRT()` (**rule 2**),
 *   reusing existing RTs when size matches and reallocating on resize.
 * - `install` reallocates RTs after a prior `uninstall` freed them
 *   (**rule 3**).
 * - `uninstall` keeps `this._scene` set so the next `getSceneCaptureRT`
 *   in a chain rebuild can still find the graphics device (**rule 4**).
 * - `install` and `uninstall` are a reversible pair - no `_destroyed`
 *   flag (**rule 5**).
 * - Re-entry guard in `uninstall` uses a resource handle, not the
 *   scene ref (**rule 6**).
 *
 * Rules 7 and 8 (use `gl_FragCoord` not `vUv0`, avoid `textureSample`
 * in non-uniform control flow) are your shader's responsibility - see
 * `postfx.ts` for the full text.
 *
 * ## What you provide
 *
 * 1. **Constructor options** - a unique `shaderName`, the GLSL + WGSL
 *    fragment sources. The fragment must declare a `uniform sampler2D
 *    uSourceTex` (GLSL) or `texture_2d<f32> uSourceTex` (WGSL); the base
 *    class binds it for you each frame.
 *
 * 2. **`bindUniforms(scope, device, ctx)` override** - bind any custom
 *    uniforms your shader uses. The base class has already bound
 *    `uSourceTex` by the time this runs. Optional - omit if your shader
 *    only needs `uSourceTex`.
 *
 * 3. **(Optional) `getSceneCaptureRTSize(device)` override** - return
 *    `{ w, h }` for the scene-capture RT. Defaults to backbuffer size.
 *    Override to capture at a different resolution (e.g. low-res for a
 *    pixelart-style effect).
 *
 * ## Example
 *
 * ```ts
 * class TintPass extends BaseCapturingPass {
 *   constructor(private tint: Color = new Color(1, 0.5, 0.5, 1)) {
 *     super({
 *       shaderName: 'tint-compose-v1',
 *       fragmentGLSL: `
 *         uniform sampler2D uSourceTex;
 *         uniform vec3 uTint;
 *         uniform vec2 uResolution;
 *         void main() {
 *           ivec2 px = ivec2(gl_FragCoord.xy);
 *           vec3 c = texelFetch(uSourceTex, px, 0).rgb;
 *           gl_FragColor = vec4(c * uTint, 1.0);
 *         }
 *       `,
 *       fragmentWGSL: `…`,
 *     });
 *   }
 *
 *   protected bindUniforms(scope: ScopeSpace, device: GraphicsDevice): void {
 *     scope.resolve('uTint').setValue([this.tint.r, this.tint.g, this.tint.b]);
 *     scope.resolve('uResolution').setValue([device.width, device.height]);
 *   }
 * }
 *
 * scene.postfx.add(new TintPass());
 * ```
 *
 * @group PostFX
 */
export abstract class BaseCapturingPass implements PostFXPass {
  readonly capturesScene = true;

  /** Options passed at construction. Available to subclasses if they
   *  need to read `shaderName` etc. */
  protected readonly options: BaseCapturingPassOptions;

  /** Captured in `configureFrame`. Stays set across uninstall/install
   *  cycles per rule 4. */
  protected _scene: Scene | null = null;

  // ── Owned scene-capture RT (used when we're the first capturing pass) ──
  private _ownSceneRT: RenderTarget | null = null;
  private _ownSceneTex: Texture | null = null;
  private _ownSceneW = 0;
  private _ownSceneH = 0;

  // ── Per-install ephemeral state ──
  private _input: RenderTarget | null = null;
  private _output: RenderTarget | null = null;
  private _frame: CameraFrame | null = null;
  private _composeLayer: Layer | null = null;
  private _composeLayerId = -1;
  private _composeCameraEntity: Entity | null = null;
  private _quad: QuadRender | null = null;
  private _handler: ((cam: CameraComponent, layer: Layer, transparent: boolean) => void) | null = null;

  constructor(options: BaseCapturingPassOptions) {
    this.options = options;
  }

  // ── Subclass extension points ─────────────────────────────────────────

  /**
   * Bind any custom uniforms your shader uses. `uSourceTex` has already
   * been bound to the input RT's color texture by the time this runs.
   * Default is a no-op - override if your shader needs more uniforms.
   */
  protected bindUniforms(
    _scope: ScopeSpace,
    _device: GraphicsDevice,
    _ctx: PostFXInstallContext,
  ): void {
    // default no-op
  }

  /**
   * Return the scene-capture RT size in pixels. Default is backbuffer.
   * Override to capture at a different resolution.
   */
  protected getSceneCaptureRTSize(device: GraphicsDevice): { w: number; h: number } {
    return { w: device.width, h: device.height };
  }

  // ── PostFXPass lifecycle ───────────────────────────────────────────────

  configureFrame(scene: Scene, rendering: PostFXFrameConfig): void {
    this._scene = scene;
    if (this.options.needsSceneDepth) {
      rendering.sceneDepthMap = true;
    } else {
      rendering.requireFrame = true;
    }
  }

  getSceneCaptureRT(): RenderTarget | null {
    this._ensureOwnSceneRT();
    return this._ownSceneRT;
  }

  install(scene: Scene, ctx: PostFXInstallContext): void {
    // `_scene` may already be set by configureFrame, but re-set defensively
    // in case a subclass overrode that hook without forwarding to super.
    this._scene = scene;
    this._output = ctx.outputTarget;
    this._frame = ctx.frame;

    // Pick our input: upstream capturing pass's output if chained,
    // otherwise our own scene-capture RT (we're the first capture pass).
    if (ctx.inputTarget) {
      this._input = ctx.inputTarget;
    } else {
      this._ensureOwnSceneRT();
      this._input = this._ownSceneRT;
    }
    if (!this._input) {
      throw new Error(`[${this.options.shaderName}] install: no input RT could be resolved`);
    }

    const device = scene.graphicsDevice;
    const mainCam = scene.cameraEntity.camera;
    if (!mainCam) {
      throw new Error(`[${this.options.shaderName}] install: scene.cameraEntity has no camera`);
    }

    // Compose layer (anchor for our EVENT_PRERENDER_LAYER quad - no meshes).
    this._composeLayer = new Layer({
      name: `${this.options.shaderName}-layer`,
      clearColorBuffer: false,
      clearDepthBuffer: false,
      passThrough: false,
    });
    scene.app.scene.layers.push(this._composeLayer);
    this._composeLayerId = this._composeLayer.id;

    // Compose camera. `renderTarget = ctx.outputTarget` (null → backbuffer
    // for the last capturing pass; PostFX's intermediate RT when chained).
    const priorityOffset = this.options.composePriorityOffset ?? 3;
    this._composeCameraEntity = new Entity(`${this.options.shaderName}-camera`);
    scene.app.root.addChild(this._composeCameraEntity);
    this._composeCameraEntity.addComponent('camera', {
      clearColor: new Color(0, 0, 0, 1),
      clearColorBuffer: true,
      clearDepthBuffer: false,
      clearStencilBuffer: false,
      renderTarget: this._output as unknown as RenderTarget,
      layers: [this._composeLayerId],
      priority: (mainCam.priority ?? 0) + priorityOffset,
    });
    // PC 2.18 escape hatch: addComponent special-cases null; cast through.
    this._composeCameraEntity.camera!.renderTarget = this._output as unknown as RenderTarget;

    // Shader + quad.
    const shader = ShaderUtils.createShader(device, {
      uniqueName: this.options.shaderName,
      attributes: { vertex_position: SEMANTIC_POSITION },
      vertexChunk: 'fullscreenQuadVS',
      fragmentGLSL: this.options.fragmentGLSL,
      fragmentWGSL: this.options.fragmentWGSL,
    });
    this._quad = new QuadRender(shader);

    // Per-frame uniform binding. We resolve uSourceTex automatically;
    // subclass `bindUniforms` runs after for everything else.
    const ctxSnapshot: PostFXInstallContext = {
      frame: this._frame,
      inputTarget: this._input,
      outputTarget: this._output,
    };
    this._handler = (_cam, layer, transparent) => {
      if (layer?.id !== this._composeLayerId || transparent) return;
      if (!this._input || !this._quad) return;
      const sourceTex = this._input.colorBuffer;
      if (!sourceTex) return;
      device.scope.resolve('uSourceTex').setValue(sourceTex);
      this.bindUniforms(device.scope, device, ctxSnapshot);
      this._quad.render();
    };
    scene.app.scene.on(EVENT_PRERENDER_LAYER, this._handler);
  }

  uninstall(_scene: Scene): void {
    // Resource-handle re-entry guard (rule 6). We do NOT null `this._scene`
    // - `getSceneCaptureRT` in the next rebuild needs it (rule 4).
    if (!this._composeCameraEntity && !this._composeLayer) return;

    if (this._scene && this._handler) {
      try { this._scene.app.scene.off(EVENT_PRERENDER_LAYER, this._handler); } catch { /* ignore */ }
    }
    this._handler = null;

    if (this._composeCameraEntity) {
      this._composeCameraEntity.parent?.removeChild(this._composeCameraEntity);
      try { this._composeCameraEntity.destroy(); } catch { /* already freed */ }
      this._composeCameraEntity = null;
    }
    if (this._composeLayer && this._scene) {
      this._scene.app.scene.layers.remove(this._composeLayer);
    }
    this._composeLayer = null;
    this._composeLayerId = -1;
    this._quad = null;
    this._input = null;
    this._output = null;
    this._frame = null;

    // Tear down our own scene-capture RT. `install` will reallocate it
    // via `_ensureOwnSceneRT` on the next cycle if we're still the first
    // capturing pass (rule 3).
    if (this._ownSceneRT) {
      try { this._ownSceneRT.destroy(); } catch { /* ignore */ }
      this._ownSceneRT = null;
    }
    if (this._ownSceneTex) {
      try { this._ownSceneTex.destroy(); } catch { /* ignore */ }
      this._ownSceneTex = null;
    }
    this._ownSceneW = 0;
    this._ownSceneH = 0;
  }

  // ── internals ────────────────────────────────────────────────────────

  /** Idempotent: allocates our own scene-capture RT at the requested size,
   *  reuses if size unchanged. */
  private _ensureOwnSceneRT(): void {
    if (!this._scene) return;
    const device = this._scene.graphicsDevice;
    const { w, h } = this.getSceneCaptureRTSize(device);
    const wi = Math.max(1, Math.floor(w));
    const hi = Math.max(1, Math.floor(h));
    if (this._ownSceneRT && this._ownSceneW === wi && this._ownSceneH === hi) return;

    if (this._ownSceneRT) { try { this._ownSceneRT.destroy(); } catch { /* ignore */ } }
    if (this._ownSceneTex) { try { this._ownSceneTex.destroy(); } catch { /* ignore */ } }

    this._ownSceneTex = new Texture(device, {
      name: `${this.options.shaderName}-scene-color`,
      width: wi,
      height: hi,
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    this._ownSceneRT = new RenderTarget({
      name: `${this.options.shaderName}-scene-rt`,
      colorBuffer: this._ownSceneTex,
      depth: false,
      stencil: false,
      samples: 1,
    });
    this._ownSceneW = wi;
    this._ownSceneH = hi;
  }
}
