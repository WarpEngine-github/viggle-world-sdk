// Its own module so the SOG worker chunk doesn't pull in the SPZ decoder.

const floatView = new Float32Array(1);
const int32View = new Int32Array(floatView.buffer);

/** PlayCanvas 2.23's `FloatPacking.float2Half`, copied to keep the worker PlayCanvas-free. */
export function float2Half(value: number): number {
  floatView[0] = value;
  const x = int32View[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) {
    if (e === 102 && x & 0x007fffff) bits |= 1;
    return bits;
  }
  if (e > 142) {
    // Overflow is Infinity; only a NaN keeps a mantissa bit.
    bits |= 0x7c00;
    if (e === 255 && x & 0x007fffff) bits |= 0x0200;
    return bits;
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

/**
 * `GSplatResource`'s rotation packing for splat `o / 4`: normalized (a zero
 * quaternion is the identity) with w made non-negative, x and y into
 * `transformA`'s fourth word and z into `transformB`'s fourth half.
 */
export function packQuat(x: number, y: number, z: number, w: number, transformA: Uint32Array, transformB: Uint16Array, o: number): void {
  let len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len === 0) {
    x = y = z = 0;
    w = 1;
  } else {
    len = 1 / len;
    x *= len; y *= len; z *= len; w *= len;
  }
  if (w < 0) {
    x *= -1; y *= -1; z *= -1;
  }
  transformA[o + 3] = float2Half(x) | (float2Half(y) << 16);
  transformB[o + 3] = float2Half(z);
}
