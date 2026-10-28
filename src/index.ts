/**
 * `@viggle/scene-sdk`: the Viggle Scene API client.
 *
 * No React, no DOM, no dependencies - runs in browsers, Node 18+, Deno, Bun
 * and edge runtimes. The other entry points:
 *
 * - `@viggle/scene-sdk/react`  - Provider, hooks, `<SceneViewer>`, `<SceneStudio>`
 * - `@viggle/scene-sdk/viewer` - `SceneRenderer`, the WebGL viewer without React
 */
export * from './core/index.js';

/** This package's version. */
export const VERSION = '0.4.0';
