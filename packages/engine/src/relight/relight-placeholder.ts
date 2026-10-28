import {
  ADDRESS_CLAMP_TO_EDGE,
  FILTER_LINEAR,
  PIXELFORMAT_RGBA16F,
  Texture,
} from 'playcanvas';
import type { GraphicsDevice, GSplatComponent } from 'playcanvas';

/**
 * 1x1 stand-in for the relight textures.
 *
 * Every sampler a shader declares has to be bound on every draw - WebGPU
 * rejects the draw outright, WebGL binds whatever happens to be on unit 0 - and
 * the relight chunk is compiled into EVERY splat's work-buffer shader, including
 * scenes that never create a {@link RelightPass}. This is what those scenes
 * bind.
 *
 * Zero coverage in the alpha channel, so a consumer that somehow reaches the
 * sample despite `uRelightParams.w == 0` still falls back to its baked colour
 * rather than to black.
 *
 * Created eagerly by the caller, never lazily inside a render pass: WebGPU
 * rejects the mid-pass `queue.submit` a texture upload needs.
 */
const cache = new WeakMap<GraphicsDevice, Texture>();

export function getRelightPlaceholder(device: GraphicsDevice): Texture {
  const hit = cache.get(device);
  if (hit) return hit;
  const tex = new Texture(device, {
    name: 'relightPlaceholder',
    width: 1,
    height: 1,
    format: PIXELFORMAT_RGBA16F,
    mipmaps: false,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  const data = tex.lock() as Uint16Array;
  for (let i = 0; i < data.length; i++) data[i] = 0;
  tex.unlock();
  cache.set(device, tex);
  return tex;
}

/** Identity matrix for `uRelightVP` before any pass has published one. */
export const RELIGHT_IDENTITY_VP = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/** `xy = 1/size, z = 1/referenceLuminance, w = 0` - w = 0 means "no texture". */
export const RELIGHT_IDLE_PARAMS = new Float32Array([0, 0, 1, 0]);

export const RELIGHT_WHITE = new Float32Array([1, 1, 1]);

/**
 * Bind the neutral relight values on one gsplat component, so its very first
 * work-buffer render has valid bindings for every uniform the chunk declares.
 * A live {@link RelightPass} overwrites these every frame.
 */
export function seedRelightDefaults(
  gsplat: GSplatComponent | null | undefined,
  device: GraphicsDevice,
): void {
  if (!gsplat) return;
  const placeholder = getRelightPlaceholder(device);
  gsplat.setParameter('uRelightTex', placeholder);
  gsplat.setParameter('uRelightShadowTex', placeholder);
  gsplat.setParameter('uRelightVP', RELIGHT_IDENTITY_VP);
  gsplat.setParameter('uRelightParams', RELIGHT_IDLE_PARAMS);
  gsplat.setParameter('uRelightStrength', 0);
  gsplat.setParameter('uRelightTint', RELIGHT_WHITE);
  gsplat.setParameter('uRelightAmbient', 0);
  gsplat.setParameter('uRelightShadowStrength', 0);
  gsplat.setParameter('uRelightFlipY', 0);
  gsplat.setParameter('uRelightDebug', 0);
}

/**
 * Bind the neutral relight values in the device's global uniform scope, once
 * per scene at creation.
 *
 * The relight chunk is compiled into every splat's work-buffer shader, so its
 * samplers must be bound on the first draw whether or not a
 * {@link RelightPass} exists. `uRelightParams.w = 0` means "no lighting
 * texture published", which makes the whole chunk a no-op. A live pass
 * overwrites all of this from its prerender hook. Called outside any render
 * pass, so the placeholder's upload is legal on WebGPU.
 */
export function bindRelightScopeDefaults(device: GraphicsDevice): void {
  const scope = device.scope;
  const placeholder = getRelightPlaceholder(device);
  scope.resolve('uRelightTex').setValue(placeholder);
  scope.resolve('uRelightShadowTex').setValue(placeholder);
  scope.resolve('uRelightVP').setValue(RELIGHT_IDENTITY_VP);
  scope.resolve('uRelightParams').setValue(RELIGHT_IDLE_PARAMS);
  scope.resolve('uRelightStrength').setValue(0);
  scope.resolve('uRelightTint').setValue(RELIGHT_WHITE);
  scope.resolve('uRelightAmbient').setValue(0);
  scope.resolve('uRelightShadowStrength').setValue(0);
  scope.resolve('uRelightFlipY').setValue(0);
  scope.resolve('uRelightDebug').setValue(0);
}
