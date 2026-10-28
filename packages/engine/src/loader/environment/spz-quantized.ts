/**
 * SPZ v4 attributes kept in their file encoding, laid out as PlayCanvas's own
 * SPZ parser uploads them (`playcanvas/scripts/esm/parsers/spz-parser.mjs`):
 * the shader dequantizes, so the decode worker mostly reorders bytes into
 * Morton order. Positions and opacity, which every viewer load reads, come
 * back as floats too; the other float properties are decoded on first use by
 * {@link quantizedProperty}. Both with the general path's arithmetic
 * (`decodeCloud`), so they are bit-identical to it.
 */

import { mortonOrder } from '../shared/morton-order';

export interface QuantizedSpz {
  count: number;
  fractionalBits: number;
  /** SH coefficients per channel in the file (0, 3, 8 or 15). */
  shDim: number;
  /** Per splat: xyz = 24-bit fixed-point position | 8-bit log scale << 24, w = smallest-three rotation. */
  packed: Uint32Array;
  /** Per splat: r, g, b, alpha codes. */
  color: Uint8Array;
  /** SH codes, 16 per splat per array (4 words), padded with 128 (zero). */
  sh: Uint32Array[];
  centers: Float32Array;
  /** Centre xyz then half extents xyz; null when there are no splats. */
  aabb: number[] | null;
  /** The float properties decoded so far, by name: positions and opacity in the worker, the rest on first read. */
  floats: Map<string, Float32Array>;
}

/** Whether a decode came back quantized, not as the general path's floats. */
export const isQuantized = (decoded: object): decoded is QuantizedSpz => 'fractionalBits' in decoded;

/** The splats so far, and the Morton order the stages after positions read. */
interface Quantizing extends QuantizedSpz {
  order: Uint32Array;
}

export function quantizing(count: number, shDim: number, fractionalBits: number): Quantizing {
  return {
    count, shDim, fractionalBits,
    order: new Uint32Array(0),
    packed: new Uint32Array(count * 4),
    color: new Uint8Array(count * 4),
    sh: [],
    centers: new Float32Array(0),
    aabb: null,
    floats: new Map(),
  };
}

function quantizePositions(s: Quantizing, pos: Uint8Array): void {
  const { count: n, packed } = s;
  const fixedScale = 1.0 / (1 << s.fractionalBits);
  const ux = new Float32Array(n), uy = new Float32Array(n), uz = new Float32Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 9) {
    let v = pos[k] | (pos[k + 1] << 8) | (pos[k + 2] << 16);
    ux[i] = (v | (v & 0x800000 ? 0xff000000 : 0)) * fixedScale;
    v = pos[k + 3] | (pos[k + 4] << 8) | (pos[k + 5] << 16);
    uy[i] = (v | (v & 0x800000 ? 0xff000000 : 0)) * fixedScale;
    v = pos[k + 6] | (pos[k + 7] << 8) | (pos[k + 8] << 16);
    uz[i] = (v | (v & 0x800000 ? 0xff000000 : 0)) * fixedScale;
  }
  const order = s.order = mortonOrder(ux, uy, uz);
  const centers = s.centers = new Float32Array(n * 3);
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = order[i], k = j * 9, o = i * 4;
    packed[o] = pos[k] | (pos[k + 1] << 8) | (pos[k + 2] << 16);
    packed[o + 1] = pos[k + 3] | (pos[k + 4] << 8) | (pos[k + 5] << 16);
    packed[o + 2] = pos[k + 6] | (pos[k + 7] << 8) | (pos[k + 8] << 16);
    const px = ux[j], py = uy[j], pz = uz[j];
    x[i] = px; y[i] = py; z[i] = pz;
    centers[i * 3] = px; centers[i * 3 + 1] = py; centers[i * 3 + 2] = pz;
  }
  s.floats.set('x', x).set('y', y).set('z', z);
}

function quantizeAlphas(s: Quantizing, alpha: Uint8Array): void {
  const { count: n, order, color } = s;
  const opacity = new Float32Array(n);
  const opacityF = table((c) => Math.log(c / 255.0 / (1.0 - c / 255.0)));
  for (let i = 0; i < n; i++) {
    const a = alpha[order[i]];
    color[i * 4 + 3] = a;
    opacity[i] = opacityF[a];
  }
  s.floats.set('opacity', opacity);
}

function quantizeColors(s: Quantizing, rgb: Uint8Array): void {
  const { count: n, order, color } = s;
  for (let i = 0; i < n; i++) {
    const j3 = order[i] * 3, o = i * 4;
    color[o] = rgb[j3]; color[o + 1] = rgb[j3 + 1]; color[o + 2] = rgb[j3 + 2];
  }
}

function quantizeScales(s: Quantizing, scale: Uint8Array): void {
  const { count: n, order, packed, centers } = s;
  // As `packSplat`'s bounds; codes are monotonic, so the largest code is the largest scale.
  const scaleExtent = new Float64Array(256);
  for (let c = 0; c < 256; c++) scaleExtent[c] = 2.0 * Math.exp(c / 16.0 - 10.0);
  let mx = Infinity, my = Infinity, mz = Infinity, Mx = -Infinity, My = -Infinity, Mz = -Infinity;
  for (let i = 0; i < n; i++) {
    const j3 = order[i] * 3, o = i * 4;
    const s0 = scale[j3], s1 = scale[j3 + 1], s2 = scale[j3 + 2];
    packed[o] |= s0 << 24; packed[o + 1] |= s1 << 24; packed[o + 2] |= s2 << 24;
    const e = scaleExtent[Math.max(s0, s1, s2)];
    const px = centers[i * 3], py = centers[i * 3 + 1], pz = centers[i * 3 + 2];
    mx = Math.min(mx, px - e); my = Math.min(my, py - e); mz = Math.min(mz, pz - e);
    Mx = Math.max(Mx, px + e); My = Math.max(My, py + e); Mz = Math.max(Mz, pz + e);
  }
  if (n > 0) s.aabb = [(mx + Mx) * 0.5, (my + My) * 0.5, (mz + Mz) * 0.5, (Mx - mx) * 0.5, (My - my) * 0.5, (Mz - mz) * 0.5];
}

function quantizeRotations(s: Quantizing, rot: Uint8Array): void {
  const { count: n, order, packed } = s;
  for (let i = 0; i < n; i++) {
    const k = order[i] * 4;
    packed[i * 4 + 3] = rot[k] | (rot[k + 1] << 8) | (rot[k + 2] << 16) | (rot[k + 3] << 24);
  }
}

/** PlayCanvas's SH packing: 16 codes to an array, 4 to a word. */
function quantizeHarmonics(s: Quantizing, sh: Uint8Array): void {
  const { count: n, order, shDim } = s;
  const stride = shDim * 3;
  for (let t = 0; t * 16 < stride; t++) {
    const words = new Uint32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const src = order[i] * stride + t * 16;
      for (let w = 0; w < 4; w++) {
        let word = 0;
        for (let k = 0; k < 4; k++) {
          const b = t * 16 + w * 4 + k;
          word |= (b < stride ? sh[src + w * 4 + k] : 128) << (k * 8);
        }
        words[i * 4 + w] = word;
      }
    }
    s.sh.push(words);
  }
}

/** The result, without the order. */
export function finishQuantizing({ order: _order, ...q }: Quantizing): QuantizedSpz {
  return q;
}

/** One per attribute stream, in file order; positions first, as they fix the order.
 *  Plain functions on purpose: V8 optimizes them better than closures. */
export const QUANTIZE_STAGES = [quantizePositions, quantizeAlphas, quantizeColors, quantizeScales, quantizeRotations, quantizeHarmonics];

function table(f: (code: number) => number): Float32Array {
  const out = new Float32Array(256);
  for (let c = 0; c < 256; c++) out[c] = f(c);
  return out;
}

/**
 * One of the float properties `decodeCloud` builds that {@link QuantizedSpz.floats}
 * doesn't hold yet, from the quantized splats, with the same arithmetic. The
 * rotations decode together, so all four go into `floats`.
 */
export function quantizedProperty(q: QuantizedSpz, name: string): Float32Array {
  const n = q.count;
  const out = new Float32Array(n);
  const dc = ['f_dc_0', 'f_dc_1', 'f_dc_2'].indexOf(name);
  if (dc >= 0) {
    const f = table((c) => (c / 255.0 - 0.5) / 0.15);
    for (let i = 0; i < n; i++) out[i] = f[q.color[i * 4 + dc]];
    return out;
  }
  const sc = ['scale_0', 'scale_1', 'scale_2'].indexOf(name);
  if (sc >= 0) {
    const f = table((c) => c / 16.0 - 10.0);
    for (let i = 0; i < n; i++) out[i] = f[q.packed[i * 4 + sc] >>> 24];
    return out;
  }
  if (name.startsWith('rot_')) {
    decodeRotations(q).forEach((v, k) => q.floats.set(k, v));
    return q.floats.get(name)!;
  }
  const rest = /^f_rest_(\d+)$/.exec(name);
  if (rest && Number(rest[1]) < q.shDim * 3) {
    // f_rest_k is channel-major (k = c * shDim + j); the file is coefficient-major.
    const k = Number(rest[1]), c = Math.floor(k / q.shDim), j = k % q.shDim;
    const b = j * 3 + c;
    const words = q.sh[b >> 4], w = (b >> 2) & 3, shift = (b & 3) * 8;
    const f = table((code) => (code - 128.0) / 128.0);
    for (let i = 0; i < n; i++) out[i] = f[(words[i * 4 + w] >>> shift) & 0xff];
    return out;
  }
  throw new Error(`[spz] no splat property ${name}`);
}

/**
 * Smallest-three, as `spz-format.ts` unpacks it: a 2-bit index of the dropped
 * component, then the others in index order, each a sign bit and 9 bits over
 * sqrt(1/2). The dropped one is the positive root of the other three, in
 * doubles; all four are stored as float32.
 */
function decodeRotations(q: QuantizedSpz): Map<string, Float32Array> {
  const n = q.count;
  const rot0 = new Float32Array(n), rot1 = new Float32Array(n), rot2 = new Float32Array(n), rot3 = new Float32Array(n);
  const rotMag = new Float64Array(512);
  for (let m = 0; m < 512; m++) rotMag[m] = m / 511 * Math.SQRT1_2;
  const v = new Float64Array(4);
  for (let i = 0; i < n; i++) {
    const bits = q.packed[i * 4 + 3];
    const largest = (bits >>> 30) & 0x3;
    let sum = 0;
    let shift = 20;
    for (let c = 0; c < 4; c++) {
      if (c === largest) continue;
      const field = (bits >>> shift) & 0x3ff;
      const m = field & 0x200 ? -rotMag[field & 0x1ff] : rotMag[field & 0x1ff];
      v[c] = m;
      sum += m * m;
      shift -= 10;
    }
    v[largest] = Math.sqrt(Math.max(0, 1 - sum));
    rot1[i] = v[0]; rot2[i] = v[1]; rot3[i] = v[2]; rot0[i] = v[3];
  }
  return new Map([['rot_0', rot0], ['rot_1', rot1], ['rot_2', rot2], ['rot_3', rot3]]);
}
