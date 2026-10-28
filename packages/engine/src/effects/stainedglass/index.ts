/**
 * Stained-glass post-process for SplatEngine.
 *
 * ```ts
 * import { StainedGlassEffect, Color } from '@viggle/splat-engine';
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
 * See `stainedglass-system.ts` for pipeline details. The effect is a
 * sibling of {@link PixelartEffect} - same capturing-pass architecture,
 * Voronoi cellular sampling instead of square-grid snapping.
 *
 * @group StainedGlass
 */

export { StainedGlassEffect } from './stainedglass-system';
export type { StainedGlassEffectOptions } from './stainedglass-system';
