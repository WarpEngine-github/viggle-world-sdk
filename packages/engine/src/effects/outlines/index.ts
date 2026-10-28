/**
 * Per-object outline effect for SplatEngine (v4 - custom post-process).
 *
 * ```ts
 * import { OutlineEffect } from '@viggle/splat-engine';
 * import { Color } from 'playcanvas';
 *
 * const outlines = new OutlineEffect(scene, {
 *   color: new Color(0.6, 0.2, 1.0, 1.0),
 *   thicknessPx: 3,
 *   mainCamera: scene.cameraEntity,
 * });
 * outlines.add(gunEntity);
 * outlines.add(questTarget);
 * outlines.remove(gunEntity);
 * outlines.destroy();
 * ```
 *
 * See `outline-system.ts` for pipeline details, limitations, and the
 * rationale for writing a custom system instead of wrapping PC 2.18's
 * built-in `OutlineRenderer` (which has a shader-option bug that
 * outputs black instead of the configured colour).
 *
 * @group Outlines
 */

export { OutlineEffect } from './outline-system';
export type {
  OutlineAddOptions,
  OutlineEffectOptions,
} from './outline-types';
