/**
 * `@viggle/scene-sdk/explorer`: walk a character through a splat scene.
 * Loads the 3D engine (~2.4 MB); import it lazily, as `<SceneExplorerView>` does.
 */
export { SceneExplorer, VIGGLE_LOCOMOTION_CLIPS } from './SceneExplorer.js';
export type {
  ActionOptions,
  CollisionView,
  ExplorerCameraOptions,
  ExplorerLoadOptions,
  ExplorerProgress,
  LocomotionClips,
  PlacementSource,
  SceneExplorerOptions,
  WalkerBehind,
  WalkerPose,
  WalkMove,
} from './SceneExplorer.js';
export { placeWalkScene } from '../walk/placement.js';
export type { AutoPlacement, SceneTransform, WalkPlacement } from '../walk/placement.js';
