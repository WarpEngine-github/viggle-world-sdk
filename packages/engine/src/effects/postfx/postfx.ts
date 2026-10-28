import type { CameraFrame, RenderTarget } from 'playcanvas';
import {
  ADDRESS_CLAMP_TO_EDGE,
  FILTER_LINEAR,
  PIXELFORMAT_RGBA8,
  RenderTarget as RenderTargetCtor,
  Texture,
} from 'playcanvas';

import type { Scene } from '../../scene';

/**
 * ── PostFXPass author contract ─────────────────────────────────────────────
 *
 * Writing a custom `PostFXPass` correctly requires obeying eight rules. They
 * exist because we sit on top of PC's CameraFrame, which has its own
 * lifecycle expectations, and because PostFX rebuilds the pass chain every
 * time the capturing list changes (add / remove / resize). Most of these
 * rules are subtle and have caused real bugs - read them before writing
 * a new pass. {@link BaseCapturingPass} encodes rules 1-6 so a capturing
 * pass can typically just extend it and provide a shader.
 *
 * 1.  **`configureFrame` must cache `this._scene` if you need it later.**
 *     `getSceneCaptureRT()` is called by PostFX *before* `install`, so
 *     anything that allocates against the graphics device must have a
 *     scene reference by then. `configureFrame` is the only hook that
 *     fires before `getSceneCaptureRT`.
 *
 * 2.  **Capturing passes must allocate their scene-capture RT eagerly in
 *     `getSceneCaptureRT()`.** PostFX queries it on the first capturing
 *     pass in the chain and stamps `cam.renderTarget` with the result -
 *     it can't be deferred to `install`.
 *
 * 3.  **`install` must re-allocate any RTs that `uninstall` freed.** A
 *     pass instance can be uninstalled and re-installed many times across
 *     chain rebuilds (e.g. when another pass is added or the canvas
 *     resizes). Make allocation idempotent - `_ensureXxxRT()`-style guards
 *     that no-op when size matches.
 *
 * 4.  **`uninstall` must NOT null fields that `getSceneCaptureRT` reads.**
 *     PostFX's rebuild calls `uninstall` → `getSceneCaptureRT` → `install`
 *     on the same instance. Specifically, keep `this._scene` set. Symptom
 *     of violating: black screen when adding a second pass on top.
 *
 * 5.  **`uninstall` and `install` must be a reversible pair.** Don't set
 *     permanent "destroyed" flags in `uninstall` - those belong in a
 *     separate `destroy()` method that the consumer calls when the pass
 *     is gone for good.
 *
 * 6.  **Use a resource handle (not `this._scene`) as the re-entry guard
 *     in `uninstall`.** Something like `if (!this._composeCameraEntity)
 *     return;` rather than `if (!this._scene) return;`, since rule 4
 *     means `this._scene` stays set across cycles.
 *
 * 7.  **Shaders that sample source RTs must use `gl_FragCoord` /
 *     `input.position` (pixel coords), NOT `vUv0`.** On WebGPU, `vUv0`
 *     is interpolated in the destination framebuffer's orientation,
 *     which is Y-flipped relative to how PC stores RT contents. Sampling
 *     via UVs produces an upside-down image. Use `texelFetch` /
 *     `textureLoad` indexed by `ivec2(gl_FragCoord.xy)` or by
 *     `vec2i(input.position.xy)`. See `pixelart-shaders.ts:18-23` for
 *     the long-form explanation. `vUv0` is still fine for GEOMETRIC math
 *     (UV-space curves, masks) that doesn't read a texture.
 *
 * 8.  **WGSL forbids `textureSample` in non-uniform control flow.** A
 *     bounds-check early-return is non-uniform → compile error. Either
 *     use `textureLoad` (no derivatives, no uniformity requirement) or
 *     sample unconditionally with clamped UVs and mask the result with
 *     a `step()` product. Rule 7's `textureLoad` solves this for free.
 *
 * @group PostFX
 */

/**
 * Contract a post-process effect implements to plug into {@link PostFX}.
 *
 * A pass's lifecycle has these phases:
 *
 * 1. **`configureFrame`** - runs once when the pass is added. Lets the pass
 *    request CameraFrame features (`sceneDepthMap`, `requireFrame`). Runs
 *    BEFORE CameraFrame is realized for the first time, so a pass cannot
 *    rely on `scene.cameraFrame` being non-null here.
 *
 * 2. **`getSceneCaptureRT`** *(capturing passes only)* - returns the
 *    `RenderTarget` that PC should write the composed scene into. PostFX
 *    queries this on the FIRST capturing pass in the chain and stamps
 *    `cam.renderTarget = <returned RT>` BEFORE CameraFrame is constructed,
 *    so its compose pass captures into the right target.
 *
 * 3. **`install`** - final phase. Receives a {@link PostFXInstallContext}
 *    that tells the pass:
 *      - which `CameraFrame` is live (or null if no pass requested one),
 *      - which `RenderTarget` to read its input from (chain wiring; null
 *        for the first capturing pass and for non-capturing passes), and
 *      - which `RenderTarget` to write its output to (`null` = backbuffer
 *        for the last capturing pass; PostFX-allocated intermediate for
 *        earlier capturing passes).
 *
 * Symmetric `uninstall` tears down whatever `install` set up. PostFX rebuilds
 * the whole chain (uninstall → tear down CameraFrame → re-install) any time
 * the capturing-pass list changes, so passes only need to handle one
 * `install`/`uninstall` cycle correctly - they don't have to be live-
 * mutable.
 *
 * @group PostFX
 */
export interface PostFXPass {
  /** Set true if this pass captures the scene render - i.e., it reads the
   *  full-screen output of the previous stage (or, for the first capturing
   *  pass, the scene CameraFrame just composed) and produces a new
   *  full-screen RT. Pixelart, CRT, bloom, scanline overlays, etc. are
   *  capturing. Vignette / colour grade / SSAO / etc. that ride inside
   *  CameraFrame's compose are NOT capturing. */
  readonly capturesScene?: boolean;

  /** Optional CameraFrame-feature requests, evaluated before realization. */
  configureFrame?(scene: Scene, rendering: PostFXFrameConfig): void;

  /** Capturing passes only. Return the RT PC should write the composed
   *  scene into (typically a fixed-size low-res RT for pixelart, or a
   *  backbuffer-size RT for bloom). PostFX stamps `cam.renderTarget` with
   *  this value before CameraFrame is constructed for the FIRST capturing
   *  pass in the chain; for later capturing passes the field is ignored
   *  (their input comes from the previous pass's outputTarget). Must be
   *  ready (allocated) before this method returns - typically allocated
   *  inside `configureFrame` to be safe. */
  getSceneCaptureRT?(): RenderTarget | null;

  /** Install the pass - layers, cameras, event hooks, shader bindings.
   *  See {@link PostFXInstallContext} for what's provided. */
  install(scene: Scene, ctx: PostFXInstallContext): void;

  /** Tear down everything `install` set up. After this returns, the pass
   *  must be safe to either re-install or destroy. */
  uninstall(scene: Scene): void;
}

/**
 * Context PostFX hands to a pass during {@link PostFXPass.install}.
 *
 * @group PostFX
 */
export interface PostFXInstallContext {
  /** PC's shared CameraFrame for the scene. Null only when no pass
   *  requested CameraFrame realization (via `sceneDepthMap` or
   *  `requireFrame`). Passes that depend on CameraFrame features
   *  (Vignette, Bloom, Grading, scene depth) must request realization in
   *  `configureFrame` so this is non-null at install time. */
  frame: CameraFrame | null;
  /** For chained capturing passes (NOT the first): the RT this pass reads
   *  its input from - equal to the previous capturing pass's outputTarget.
   *
   *  For the FIRST capturing pass: null. The first pass owns its own input
   *  via `getSceneCaptureRT` (PC writes the scene there directly).
   *
   *  For non-capturing passes: null. */
  inputTarget: RenderTarget | null;
  /** Where this pass writes its final output.
   *
   *  For the LAST capturing pass: null (= backbuffer).
   *
   *  For earlier capturing passes: a PostFX-allocated intermediate RT
   *  sized to backbuffer. The next capturing pass receives this same RT
   *  as its `inputTarget`.
   *
   *  For non-capturing passes: null. */
  outputTarget: RenderTarget | null;
}

/**
 * Mutable view of CameraFrame settings a pass can opt into during
 * {@link PostFXPass.configureFrame}.
 *
 * @group PostFX
 */
export interface PostFXFrameConfig {
  /** Request a linear scene-depth texture (`uSceneDepthMap`). Needed when
   *  PC standard meshes must depth-compose with gsplat content under the
   *  WebGPU compute rasterizer. Monotonic across adds. */
  sceneDepthMap?: boolean;
  /** Force CameraFrame realization even if no specific feature is requested.
   *  Use this when your pass relies on CameraFrame's built-in compose
   *  features (Vignette, Bloom, ColorEnhance, Grading, ColorLUT, Fringing)
   *  but doesn't need scene depth. Monotonic across adds. */
  requireFrame?: boolean;
}

/**
 * Manages a chain of {@link PostFXPass} attached to a {@link Scene}.
 * One instance per scene, created automatically and exposed as
 * `scene.postfx`.
 *
 * ## Chain model
 *
 *   Scene (PC) ──cam.renderTarget──> first capturing pass's sceneCaptureRT
 *                                       ↓ (pass 0 compose)
 *                                    intermediate RT 0
 *                                       ↓ (pass 1 compose)
 *                                    intermediate RT 1
 *                                       ↓ ...
 *                                       ↓ (pass N-1 compose)
 *                                    backbuffer
 *
 * Non-capturing passes don't participate in the RT chain - they modify
 * CameraFrame state (`vignette`, `grading.saturation`, …) and ride
 * inside CameraFrame's compose shader, which runs BEFORE the first
 * capturing pass captures.
 *
 * ## Rebuild semantics
 *
 * The chain is rebuilt from scratch any time the capturing-pass list
 * changes (add/remove) or the graphics device resizes. "Rebuild" means:
 *
 *   1. `uninstall` every pass (in reverse-add order - safer for state
 *      restoration of non-capturing passes that touch CameraFrame).
 *   2. Destroy the shared CameraFrame (its compose pass holds a stale RT
 *      pointer once any capturing pass's RT is freed; PC has no supported
 *      way to redirect it after construction).
 *   3. Free PostFX-owned intermediate RTs.
 *   4. Walk the pass list in add order, allocate intermediates, realize
 *      CameraFrame if any pass requested it, then call `install` on each
 *      pass with the appropriate context.
 *
 * This is expensive but correct. PC's CameraFrame internals don't support
 * partial reconfiguration, so a full rebuild is the only path that doesn't
 * leak GPU resources or crash inside WebGPU.
 *
 * @example
 * ```ts
 * const scene = await Scene.create(canvas);
 *
 * // Capturing pass - owns the scene render.
 * const pixelart = scene.postfx.add(new PixelartEffect({ scale: 3 }));
 *
 * // Non-capturing pass - rides CameraFrame's compose.
 * const vignette = scene.postfx.add(new VignettePass(0.6));
 *
 * // Second capturing pass - chains after pixelart.
 * const crt = scene.postfx.add(new CRTPass());
 * ```
 *
 * @group PostFX
 */
export class PostFX {
  private readonly _scene: Scene;
  /** Current pass set - mutated by add/remove. Drives the NEXT rebuild's
   *  install order. */
  private readonly _passes: PostFXPass[] = [];
  /** Snapshot of what the LAST rebuild actually installed. Driven by
   *  `_rebuild`, used by the next `_rebuild` to know what to uninstall.
   *
   *  Critical: this is intentionally distinct from `_passes`. `remove(p)`
   *  splices `p` out of `_passes` BEFORE calling `_rebuild`, so iterating
   *  `_passes` to tear down would skip the removed pass and leak its
   *  resources. Iterating `_installed` instead reliably uninstalls
   *  everything that was last alive. */
  private _installed: PostFXPass[] = [];
  private readonly _frameConfig: PostFXFrameConfig = {};
  private _intermediates: RenderTarget[] = [];
  private _rebuilding = false;
  private readonly _resizeHandler: () => void;

  constructor(scene: Scene) {
    this._scene = scene;
    this._resizeHandler = () => {
      // Skip during scene teardown - graphics device may be partially gone.
      if (this._scene.cameraFrame === null && this._passes.length === 0) return;
      this._rebuild();
    };
    // We hook the device's resize signal once, on first add. See _ensureResizeHook.
  }

  /** Add a pass. Returns the same instance for chaining / handle capture. */
  add<T extends PostFXPass>(pass: T): T {
    if (pass.configureFrame) {
      pass.configureFrame(this._scene, this._frameConfig);
    }
    this._passes.push(pass);
    this._ensureResizeHook();
    this._rebuild();
    return pass;
  }

  /** Remove a previously-added pass. Triggers a chain rebuild. */
  remove(pass: PostFXPass): void {
    const i = this._passes.indexOf(pass);
    if (i < 0) return;
    this._passes.splice(i, 1);
    this._rebuild();
  }

  /** Internal - called by `Scene.destroy`. */
  destroyAll(): void {
    // Detach the resize hook first so a late resize doesn't trigger a rebuild
    // mid-teardown.
    this._scene.graphicsDevice.off('resizecanvas', this._resizeHandler);
    this._uninstallAll();        // iterates _installed snapshot
    this._freeIntermediates();
    this._passes.length = 0;
  }

  // ── internals ────────────────────────────────────────────────────────

  private _hookedResize = false;
  private _ensureResizeHook(): void {
    if (this._hookedResize) return;
    this._scene.graphicsDevice.on('resizecanvas', this._resizeHandler);
    this._hookedResize = true;
  }

  private _needsFrame(): boolean {
    return this._frameConfig.sceneDepthMap === true ||
      this._frameConfig.requireFrame === true;
  }

  private _capturingPasses(): PostFXPass[] {
    return this._passes.filter((p) => p.capturesScene === true);
  }

  private _uninstallAll(): void {
    if (this._installed.length === 0) return;
    // Reverse order: non-capturing passes that wrap CameraFrame state should
    // restore their fields before CameraFrame is torn down. Iterate the
    // INSTALLED snapshot (not current `_passes`) so passes removed before
    // this rebuild still get their uninstall called.
    for (let i = this._installed.length - 1; i >= 0; i--) {
      try { this._installed[i].uninstall(this._scene); } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[PostFX] uninstall threw', err);
      }
    }
    this._installed = [];
  }

  private _freeIntermediates(): void {
    for (const rt of this._intermediates) {
      const tex = rt.colorBuffer;
      try { rt.destroy(); } catch { /* ignore */ }
      try { tex?.destroy(); } catch { /* ignore */ }
    }
    this._intermediates = [];
  }

  private _allocateIntermediate(name: string): RenderTarget {
    const device = this._scene.graphicsDevice;
    const tex = new Texture(device, {
      name: `${name}-color`,
      width: Math.max(1, device.width),
      height: Math.max(1, device.height),
      format: PIXELFORMAT_RGBA8,
      mipmaps: false,
      minFilter: FILTER_LINEAR,
      magFilter: FILTER_LINEAR,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    const rt = new RenderTargetCtor({
      name,
      colorBuffer: tex,
      depth: false,
      stencil: false,
      samples: 1,
    });
    this._intermediates.push(rt);
    return rt;
  }

  /**
   * Tear down and re-install the full chain. Idempotent - safe to call as
   * often as you like. Guarded against re-entry (a pass's uninstall that
   * triggers a resize, for example).
   */
  private _rebuild(): void {
    if (this._rebuilding) return;
    this._rebuilding = true;
    try {
      // 1. Uninstall current chain.
      this._uninstallAll();

      // 2. Tear down CameraFrame - its compose pass captured a now-stale RT
      //    pointer, and PC has no supported way to redirect it.
      const cam = this._scene.cameraEntity.camera;
      if (this._scene.cameraFrame) {
        this._scene.cameraFrame.destroy();
        this._scene.cameraFrame = null;
      }
      // Restore cam.renderTarget to backbuffer (= null). The first capturing
      // pass below will re-stamp it if needed.
      if (cam) cam.renderTarget = null as unknown as RenderTarget;

      // 3. Free PostFX-owned intermediates from the previous build.
      this._freeIntermediates();

      if (this._passes.length === 0) return;

      // 4. Walk capturing passes; stamp cam.renderTarget on the first;
      //    allocate one intermediate RT between every adjacent pair.
      const capturing = this._capturingPasses();
      const outputTargets: (RenderTarget | null)[] = capturing.map(() => null);
      if (capturing.length > 0) {
        // First capturing pass's input = its own getSceneCaptureRT(). Stamp it.
        const firstSceneRT = capturing[0].getSceneCaptureRT?.() ?? null;
        if (cam && firstSceneRT) {
          cam.renderTarget = firstSceneRT;
        }
        // Each capturing pass writes to the next pass's input (intermediate)
        // OR backbuffer if it's the last.
        for (let i = 0; i < capturing.length - 1; i++) {
          outputTargets[i] = this._allocateIntermediate(`postfx-chain-${i}`);
        }
        outputTargets[capturing.length - 1] = null; // last → backbuffer
      }

      // 5. Realize CameraFrame if requested. Must come AFTER the
      //    cam.renderTarget stamp so the compose pass captures the right RT.
      const frame = this._needsFrame() ? this._scene.getOrCreateCameraFrame() : null;

      // 6. Install every pass in add order, with the correct context.
      let captureIdx = 0;
      for (const pass of this._passes) {
        const ctx: PostFXInstallContext = pass.capturesScene
          ? {
              frame,
              // First capturing pass reads its own sceneCaptureRT internally.
              // Later passes read the PRIOR pass's output (an intermediate).
              inputTarget: captureIdx === 0 ? null : outputTargets[captureIdx - 1],
              outputTarget: outputTargets[captureIdx],
            }
          : { frame, inputTarget: null, outputTarget: null };
        try {
          pass.install(this._scene, ctx);
          this._installed.push(pass);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[PostFX] install threw', err);
        }
        if (pass.capturesScene) captureIdx++;
      }
    } finally {
      this._rebuilding = false;
    }
  }
}
