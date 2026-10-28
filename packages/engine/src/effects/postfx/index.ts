/**
 * Lightweight post-process pipeline that lets multiple effects share PC's
 * `CameraFrame` without fighting over the main camera's render target.
 *
 * See `postfx.ts` for the contract; concrete passes live in
 * `effects/pixelart`, `effects/outlines`, etc.
 *
 * @group PostFX
 */
export { PostFX } from './postfx';
export type { PostFXPass, PostFXFrameConfig, PostFXInstallContext } from './postfx';
export { BaseCapturingPass } from './base-capturing-pass';
export type { BaseCapturingPassOptions } from './base-capturing-pass';
