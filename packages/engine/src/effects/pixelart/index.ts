/**
 * Pixel-art post-process for SplatEngine.
 *
 * ```ts
 * import { PixelartEffect } from '@viggle/splat-engine';
 *
 * const pixelart = PixelartEffect.create(scene, {
 *   scale: 4,
 *   quantize: { levels: 6 },        // optional
 *   dither: { strength: 1 },        // optional - needs `quantize` to do anything
 * });
 * // ...
 * pixelart.destroy();
 * ```
 *
 * See `pixelart-system.ts` for pipeline details. The effect mirrors
 * the outline effect's architecture - custom RT + dedicated compose
 * camera + EVENT_PRERENDER_LAYER quad - but uses it to do the inverse:
 * downscale the entire scene render to a small RT, then upscale to the
 * backbuffer with nearest-neighbour sampling.
 *
 * @group Pixelart
 */

export { PixelartEffect } from './pixelart-system';
export type { PixelartEffectOptions } from './pixelart-system';
