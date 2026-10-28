/**
 * `@viggle/scene-sdk/viewer`: a scene on a canvas, without React.
 *
 * This entry carries the splat engine and PlayCanvas (~590 KB gzip) and its
 * decoder workers. Browser only.
 */
export { SceneRenderer } from './renderer.js';
export type { FindGapsOptions, FlyToOptions, LoadProgress, SceneGap, SceneRendererOptions } from './renderer.js';
export { gapCandidates, horizontalFov, pickGaps, wallDistances } from './gaps.js';
export type { GapCandidate, GapSearchOptions } from './gaps.js';
