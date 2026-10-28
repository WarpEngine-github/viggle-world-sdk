/**
 * CRT post-process - barrel distortion, scanlines, chromatic aberration.
 *
 * Reference implementation of {@link BaseCapturingPass} from the postfx
 * pipeline - read its source for the canonical pattern when writing your
 * own capturing pass.
 *
 * @group CRT
 */
export { CRTEffect } from './crt-pass';
export type { CRTEffectOptions } from './crt-pass';
export { CRT_FRAGMENT_GLSL, CRT_FRAGMENT_WGSL } from './crt-shaders';
