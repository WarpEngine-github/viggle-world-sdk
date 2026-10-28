/**
 * `@viggle/scene-sdk/viewer`: a scene on a canvas, without React.
 *
 * This entry carries the splat engine and PlayCanvas (~590 KB gzip) and its
 * decoder workers. Browser only.
 */
export { SceneRenderer } from './renderer.js';
export type { LoadProgress, SceneRendererOptions } from './renderer.js';
