import type { GraphicsDevice, ScopeSpace } from 'playcanvas';

import { BaseCapturingPass } from '../postfx/base-capturing-pass';
import type { PostFXInstallContext } from '../postfx';
import { CRT_FRAGMENT_GLSL, CRT_FRAGMENT_WGSL } from './crt-shaders';

/**
 * Construction options for {@link CRTEffect}.
 *
 * @group CRT
 */
export interface CRTEffectOptions {
  /** Barrel-distortion strength. 0 = no curvature; 0.18 is a moderate CRT
   *  bezel curve; values above ~0.3 cut off too much of the image. */
  barrel?: number;
  /** Scanline darkening intensity in [0, 1]. 0 disables, 1 multiplies
   *  every alternate row by 0 (very dark). Typical 0.3–0.5. */
  scanline?: number;
  /** Chromatic-aberration split, expressed as a fraction of width.
   *  0.0025 ≈ a 2-pixel horizontal offset between R/B channels at 800px. */
  aberration?: number;
}

/**
 * CRT post-process - barrel distortion, scanlines, mild RGB chromatic
 * aberration. A {@link BaseCapturingPass} reference implementation:
 * everything except the shader + uniform binding is inherited.
 *
 * Usage:
 * ```ts
 * scene.postfx.add(new CRTEffect({ barrel: 0.18, scanline: 0.35 }));
 * ```
 *
 * Works standalone (CRT allocates its own scene-capture RT) or chained
 * after another capturing pass (CRT reads `ctx.inputTarget`).
 *
 * @group CRT
 */
export class CRTEffect extends BaseCapturingPass {
  private readonly _barrel: number;
  private readonly _scanline: number;
  private readonly _aberration: number;

  constructor(opts: CRTEffectOptions = {}) {
    super({
      shaderName: 'crt-effect-v1',
      fragmentGLSL: CRT_FRAGMENT_GLSL,
      fragmentWGSL: CRT_FRAGMENT_WGSL,
      // CRT doesn't read scene depth - `requireFrame` is enough to keep
      // CameraFrame realized so the scene actually composes into our
      // input RT.
      needsSceneDepth: false,
    });
    this._barrel = opts.barrel ?? 0.18;
    this._scanline = opts.scanline ?? 0.35;
    this._aberration = opts.aberration ?? 0.0025;
  }

  protected override bindUniforms(
    scope: ScopeSpace,
    device: GraphicsDevice,
    _ctx: PostFXInstallContext,
  ): void {
    scope.resolve('uResolution').setValue([device.width, device.height]);
    scope.resolve('uBarrel').setValue(this._barrel);
    scope.resolve('uScanline').setValue(this._scanline);
    scope.resolve('uAberration').setValue(this._aberration);
  }
}
