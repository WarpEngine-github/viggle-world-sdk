/**
 * `@viggle/scene-sdk/react`: React 18+ bindings.
 *
 * Importing this entry does NOT load the 3D engine: `<SceneViewer>` fetches
 * it when it first mounts, on the client. So it is safe under SSR (Next.js,
 * Remix) and costs nothing for an app that only uses the hooks.
 */
export { ViggleSceneProvider, useViggleSceneClient } from './context.js';
export type { ViggleSceneProviderProps } from './context.js';
export { useSceneExpand, useSceneGeneration, useSceneRebuild } from './hooks.js';
export type { JobPhase, JobState } from './useJob.js';
export { SceneViewer } from './SceneViewer.js';
export type { SceneViewerHandle, SceneViewerProps } from './SceneViewer.js';
export { SceneStudio } from './SceneStudio.js';
export type { SceneStudioClassNames, SceneStudioLabels, SceneStudioProps, SceneStudioToolbarContext } from './SceneStudio.js';
export { SceneExplorerView } from './SceneExplorerView.js';
export type { SceneExplorerHandle, SceneExplorerViewProps } from './SceneExplorerView.js';
