/**
 * `@viggle/scene-sdk/walk`: the walk's logic, with no engine and no DOM.
 *
 * A third-person walk over a splat scene is a few pure steps a frame: the
 * keys to a move, the move to a body over the floor and out of the walls
 * (stepWalker), the body's motion to a clip (stepLocomotion), and the camera
 * after it (followYaw, boomLimit). `@viggle/scene-sdk/explorer` runs them on
 * the engine; this entry is for running them on your own.
 */
export { EMPTY_INPUT, moveAxes, stepWalker, turnToward, walkInputFromKeys } from './controller.js';
export type { FloorProbe, PushOut, WalkerState, WalkInput, WalkParams, WallProbe, WallResolver } from './controller.js';
export { createLocoMachine, JUMP_CLIP_AIR_S, JUMP_CLIP_LAND_S, JUMP_PHASE, JUMP_RATE, LOCO_BLEND, stepLocomotion } from './locomotion.js';
export type { GroundState, JumpPhase, LocoInput, LocoMachine, LocoState, LocoStep } from './locomotion.js';
export { buildFloorIndex, walkerAperture } from './floorIndex.js';
export type { FloorIndex, FloorSample } from './floorIndex.js';
export { armReach, boomFor, boomLimit, eyeAt, fadeFor, insideReach, pivotFor, stepBoom, stepFade } from './cameraArm.js';
export type { Boom, BoomCollider, BoomView } from './cameraArm.js';
export { FOLLOW, followYaw, wrapDeg, yawBehind } from './cameraFollow.js';
export {
  DEFAULT_CAPTURE_HEIGHT, FALLBACK_SCENE_SCALE, fileToWorldAzimuth, fileToWorldPoint, isAutoPlacement, isUprightFile, placeWalkScene, placementFromGround,
} from './placement.js';
export type { AutoPlacement, SceneTransform, Vec3Like, WalkPlacement } from './placement.js';
export { walkParamsFor, WALK_TUNING } from './tuning.js';
export { ring, walkableOutline } from './outline.js';
export type { Outline, OutlineOptions, StandProbe } from './outline.js';
