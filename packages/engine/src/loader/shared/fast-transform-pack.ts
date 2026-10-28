import { GSplatData, GSplatResource } from 'playcanvas';
import type { Texture } from 'playcanvas';

import type { PackedSplat } from '../environment/spz-decode';
import { float2Half, packQuat } from './float-half';

/*
 * PlayCanvas packs a GSplatResource's transform textures through GSplatData's
 * iterator: a Vec3 and a Quat written, normalized and flipped per splat, most
 * of a resource build's main-thread time. This is the same arithmetic as a
 * plain loop - SplatIterator.read, Quat.normalize/mulScalar, float2Half - so
 * the textures are bit-identical (fast-transform-pack.test.ts compares it with
 * PlayCanvas's own on raw and activated splats).
 *
 * Splat data that arrives already packed by a worker (a decompressed SOG,
 * `fast-sog-decompress.ts`) is copied in instead, once; a later rebuild (a
 * WebGL context restore) packs from the properties.
 */

// eslint-disable-next-line typescript/unbound-method -- only ever invoked with .call(this)
const original = GSplatResource.prototype.updateTransformData;
// eslint-disable-next-line typescript/unbound-method -- only ever invoked with .call(this)
const originalColor = GSplatResource.prototype.updateColorData;
// eslint-disable-next-line typescript/unbound-method -- compared, never called
const stockIter = GSplatData.prototype.createIter;
const PROPS = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'scale_0', 'scale_1', 'scale_2'] as const;

const packedOf = (gsplatData: GSplatData) => (gsplatData as { packed?: Partial<PackedSplat> }).packed;

export function copyInto(texture: Texture | undefined, data: ArrayLike<number>) {
  if (!texture) return;
  (texture.lock() as Uint8Array | Uint16Array | Uint32Array).set(data);
  texture.unlock();
}

function fastUpdateColorData(this: GSplatResource, gsplatData: GSplatData): void {
  const packed = packedOf(gsplatData);
  if (!packed?.color) return originalColor.call(this, gsplatData);
  copyInto(this.streams.getTexture('splatColor'), packed.color);
  packed.color = undefined;
}

function fastUpdateTransformData(this: GSplatResource, gsplatData: GSplatData): void {
  const transformA = this.streams.getTexture('transformA');
  if (!transformA) return;
  const packed = packedOf(gsplatData);
  if (packed?.transformA && packed.transformB) {
    copyInto(transformA, packed.transformA);
    copyInto(this.streams.getTexture('transformB'), packed.transformB);
    packed.transformA = packed.transformB = undefined;
    return;
  }
  // Anything that reads splats its own way keeps PlayCanvas's path.
  if (gsplatData.createIter !== stockIter) return original.call(this, gsplatData);
  const [x, y, z, rw, rx, ry, rz, sx, sy, sz] = PROPS.map((name) => gsplatData.getProp(name) as Float32Array);
  const activated = gsplatData.activated;
  const transformB = this.streams.getTexture('transformB')!;
  const dataA = transformA.lock() as Uint32Array;
  const dataAFloat32 = new Float32Array(dataA.buffer);
  const dataB = transformB.lock() as Uint16Array;
  for (let i = 0, n = this.numSplats; i < n; i++) {
    const o = i * 4;
    dataAFloat32[o] = x[i];
    dataAFloat32[o + 1] = y[i];
    dataAFloat32[o + 2] = z[i];
    packQuat(rx[i], ry[i], rz[i], rw[i], dataA, dataB, o);
    dataB[o] = float2Half(activated ? sx[i] : Math.exp(sx[i]));
    dataB[o + 1] = float2Half(activated ? sy[i] : Math.exp(sy[i]));
    dataB[o + 2] = float2Half(activated ? sz[i] : Math.exp(sz[i]));
  }
  transformA.unlock();
  transformB.unlock();
}

/** Swap in the plain-loop transform packing and the packed copies. Idempotent;
 *  returns the originals. */
export function installFastTransformPack(): { updateTransformData: typeof original; updateColorData: typeof originalColor } {
  GSplatResource.prototype.updateTransformData = fastUpdateTransformData;
  GSplatResource.prototype.updateColorData = fastUpdateColorData;
  return { updateTransformData: original, updateColorData: originalColor };
}
