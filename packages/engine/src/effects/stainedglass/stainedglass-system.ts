import { Color, type GraphicsDevice, type ScopeSpace } from 'playcanvas';

import { BaseCapturingPass } from '../postfx/base-capturing-pass';
import type { PostFXInstallContext } from '../postfx';
import {
  stainedGlassFragmentGLSL,
  stainedGlassFragmentWGSL,
} from './stainedglass-shaders';

/**
 * Construction-time options for {@link StainedGlassEffect}.
 *
 * @group StainedGlass
 */
export interface StainedGlassEffectOptions {
  /**
   * Average cell size in backbuffer pixels. Larger = chunkier shards.
   * Default 16.
   */
  cellSize?: number;
  /**
   * Seed jitter in [0, 1]. 0 = perfectly regular square grid (degenerate
   * stained-glass - looks like a chunky pixel render). 1 = seeds free to
   * roam to the cell edge - maximum irregularity. 0.7-0.9 produces the
   * iconic glass-shard look without seeds clumping. Default 0.85.
   */
  jitter?: number;
  /**
   * Dark "lead caming" drawn between cells. Pass `null` or omit to
   * disable. Set the `.a` channel of `color` for blend strength.
   */
  lead?: {
    /** Lead colour. Default near-black (0.02, 0.02, 0.04, 1). */
    color?: Color;
    /** Width of the dark gap in BB pixels. Default 1. */
    thicknessPx?: number;
    /** Smoothstep softness on the gap edge. 0 = hard step. Default 0.5
     *  (one pixel of antialiasing in cell-space, looks crisp without being
     *  jagged at most cell sizes). */
    softness?: number;
  } | null;
  /**
   * Optional whole-frame colour grade applied as the last step of the
   * compose. `gain ∘ c + lift`, clamped. Defaults to identity.
   */
  colorGrade?: { lift?: Color; gain?: Color } | null;
  /**
   * Integer downscale factor for the captured scene RT. Default 1 (full
   * res). Higher values make each cell's source-sample point read from a
   * blurrier source, which softens fine detail inside shards - useful
   * when the underlying scene has high-frequency noise that fights with
   * the cellular look.
   */
  captureScale?: number;
  /**
   * Request PC's scene-depth prepass. Match {@link PixelartEffect} -
   * enable when the scene has GLB cosmetic meshes that must depth-
   * compose with splats. Default `false` (no prepass cost).
   */
  requireSceneDepth?: boolean;
}

/**
 * Stained-glass post-process for SplatEngine.
 *
 * Sibling of {@link PixelartEffect}. Where pixel-art snaps to a regular
 * square grid, this snaps each output pixel to its nearest seed on a
 * **jittered** grid, producing irregular polygonal cells (Voronoi
 * regions). Each cell takes a single flat colour - sampled from the
 * captured scene at the cell's seed position - and an optional dark
 * "lead caming" outline is drawn where neighbouring cells meet.
 *
 * The result reads as church-window stained glass or low-poly painterly
 * tiles, depending on `cellSize` and `jitter`:
 *
 *   - small cells + low jitter → chunky pixel-art-adjacent
 *   - medium cells + 0.85 jitter + lead caming → classic stained-glass
 *   - large cells + 1.0 jitter → low-poly / cubist
 *
 * Architecture: uses {@link BaseCapturingPass}, so the whole effect is a
 * single capturing post-pass with no per-character mask machinery. Add
 * to a scene the same way you'd add `PixelartEffect`:
 *
 * ```ts
 * import { StainedGlassEffect } from '@viggle/splat-engine';
 *
 * const glass = StainedGlassEffect.create(scene, {
 *   cellSize: 18,
 *   jitter: 0.85,
 *   lead: { color: new Color(0.02, 0.02, 0.04, 1), thicknessPx: 1 },
 * });
 * // ...
 * glass.destroy();
 * ```
 *
 * @group StainedGlass
 */
export class StainedGlassEffect extends BaseCapturingPass {
  private _cellSize: number;
  private _jitter: number;
  private _leadColor: Color;
  private _leadThicknessPx: number; // 0 disables
  private _leadSoftness: number;
  private _gradeLift: Color;
  private _gradeGain: Color;
  private _captureScale: number;

  /**
   * Back-compat factory. Equivalent to:
   *
   * ```ts
   * scene.postfx.add(new StainedGlassEffect(opts));
   * ```
   *
   * Prefer the explicit `scene.postfx.add(...)` form when composing
   * multiple effects.
   */
  static create(
    scene: import('../../scene').Scene,
    opts: StainedGlassEffectOptions = {},
  ): StainedGlassEffect {
    return scene.postfx.add(new StainedGlassEffect(opts));
  }

  constructor(opts: StainedGlassEffectOptions = {}) {
    super({
      shaderName: 'stainedglass-compose-v1',
      fragmentGLSL: stainedGlassFragmentGLSL,
      fragmentWGSL: stainedGlassFragmentWGSL,
      needsSceneDepth: opts.requireSceneDepth ?? false,
    });
    this._cellSize = Math.max(2, Math.floor(opts.cellSize ?? 16));
    this._jitter = Math.max(0, Math.min(1, opts.jitter ?? 0.85));
    this._leadColor = opts.lead?.color ?? new Color(0.02, 0.02, 0.04, 1);
    this._leadThicknessPx = opts.lead
      ? Math.max(0, opts.lead.thicknessPx ?? 1)
      : 0;
    this._leadSoftness = Math.max(0, opts.lead?.softness ?? 0.5);
    this._gradeLift = opts.colorGrade?.lift ?? new Color(0, 0, 0, 1);
    this._gradeGain = opts.colorGrade?.gain ?? new Color(1, 1, 1, 1);
    this._captureScale = Math.max(1, Math.floor(opts.captureScale ?? 1));
  }

  // ── Capture sizing ────────────────────────────────────────────────────
  protected getSceneCaptureRTSize(device: GraphicsDevice): { w: number; h: number } {
    return {
      w: Math.max(1, Math.floor(device.width / this._captureScale)),
      h: Math.max(1, Math.floor(device.height / this._captureScale)),
    };
  }

  // ── Per-frame uniform binding ─────────────────────────────────────────
  protected bindUniforms(
    scope: ScopeSpace,
    device: GraphicsDevice,
    ctx: PostFXInstallContext,
  ): void {
    const outW = (ctx.outputTarget?.width as number | undefined) ?? device.width;
    const outH = (ctx.outputTarget?.height as number | undefined) ?? device.height;
    const srcW = Math.max(1, Math.floor(device.width / this._captureScale));
    const srcH = Math.max(1, Math.floor(device.height / this._captureScale));

    scope.resolve('uOutputSize').setValue([outW, outH]);
    scope.resolve('uSourceSize').setValue([srcW, srcH]);
    scope.resolve('uCellSize').setValue(this._cellSize);
    scope.resolve('uJitter').setValue(this._jitter);

    const lc = this._leadColor;
    scope.resolve('uLeadColor').setValue([lc.r, lc.g, lc.b, lc.a]);
    // Lead width is expressed in cell-space units (BB-px / cellSize) so
    // the dark gap stays the same apparent thickness regardless of cell
    // size. Half-width because (F2 - F1) measures distance to the
    // closest cell boundary on EITHER side.
    const halfWidthBB = this._leadThicknessPx * 0.5;
    scope.resolve('uLeadHalfWidth').setValue(halfWidthBB / Math.max(this._cellSize, 1));
    scope.resolve('uLeadSoftness').setValue(this._leadSoftness / Math.max(this._cellSize, 1));

    const gl = this._gradeLift;
    const gg = this._gradeGain;
    scope.resolve('uGradeLift').setValue([gl.r, gl.g, gl.b]);
    scope.resolve('uGradeGain').setValue([gg.r, gg.g, gg.b]);
  }

  // ── Live-tunable properties ──────────────────────────────────────────

  /** Average cell size in BB px. */
  get cellSize(): number { return this._cellSize; }
  set cellSize(v: number) { this._cellSize = Math.max(2, Math.floor(v)); }

  /** Seed jitter in [0, 1]. */
  get jitter(): number { return this._jitter; }
  set jitter(v: number) { this._jitter = Math.max(0, Math.min(1, v)); }

  /** Lead colour. */
  getLeadColor(): Color { return this._leadColor; }
  setLeadColor(c: Color): void { this._leadColor = c; }

  /** Lead thickness in BB pixels. 0 disables. */
  get leadThickness(): number { return this._leadThicknessPx; }
  set leadThickness(v: number) { this._leadThicknessPx = Math.max(0, v); }

  /** Lead-edge smoothstep softness. */
  get leadSoftness(): number { return this._leadSoftness; }
  set leadSoftness(v: number) { this._leadSoftness = Math.max(0, v); }

  /** Colour-grade lift (added to every pixel). */
  getColorGradeLift(): Color { return this._gradeLift; }
  setColorGradeLift(c: Color): void { this._gradeLift = c; }

  /** Colour-grade gain (multiplied with every pixel). */
  getColorGradeGain(): Color { return this._gradeGain; }
  setColorGradeGain(c: Color): void { this._gradeGain = c; }
}
