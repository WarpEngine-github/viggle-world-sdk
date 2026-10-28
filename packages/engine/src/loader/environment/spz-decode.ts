/**
 * The CPU half of an `.spz` load, with no PlayCanvas in it so it can run in
 * `spz-worker.ts`: unpack, split into per-property arrays, Morton-order, and
 * build the GPU texture data. `spz.ts` wraps the result on the main thread.
 */

import { float2Half, packQuat } from '../shared/float-half';
import { mortonOrder } from '../shared/morton-order';
import type { QuantizedSpz } from './spz-quantized';
import { finishQuantizing, QUANTIZE_STAGES, quantizing } from './spz-quantized';
import type { SpzCloud } from './spz-format';
import { NotAnSpz, readSpzHeader } from './spz-format';
import { browserInflate, readSpz } from './spz-read';

export interface SplatProperty {
  type: 'float';
  name: string;
  storage: Float32Array;
  byteSize: 4;
}

/** What PlayCanvas's `GSplatResource` constructor derives from the
 *  properties, built here so the main thread only copies it in. */
export interface PackedSplat {
  color: Uint16Array;
  transformA: Uint32Array;
  transformB: Uint16Array;
  centers: Float32Array;
  /** Centre xyz then half extents xyz; null when no splat is finite. */
  aabb: number[] | null;
}

export interface DecodedSpz {
  count: number;
  properties: SplatProperty[];
  packed: PackedSplat;
}

/** A `GSplatData` vertex property. PlayCanvas's PLY reader builds these from
 *  the header; building them by hand means owning the table, so the names and
 *  the `float`/4-byte shape below have to match what the renderer asks
 *  `getProp` for rather than what any file happens to contain. */
function floatProp(name: string, storage: Float32Array): SplatProperty {
  return { type: 'float', name, storage, byteSize: 4 };
}

/**
 * Split an `SpzCloud`'s interleaved attributes into the per-property
 * Float32Arrays `GSplatData` indexes, with no file in between.
 *
 * Pure, and the reason this is a function of its own: the two conventions it
 * encodes are both silent when wrong. Get the quaternion order backwards and
 * every splat is rotated, with nothing to catch it but the eye; get the SH
 * layout backwards and view-dependent colour goes subtly wrong only when the
 * camera moves.
 *
 *  - `cloud.rotations` is xyzw, `rot_0` is **w** and `rot_1..3` are xyz
 *    (PlayCanvas's `SplatIterator` reads `set(rot_1, rot_2, rot_3, rot_0)`).
 *  - `cloud.sh` is coefficient-major per splat (`sh[(i * shDim + j) * 3 + c]`),
 *    while `f_rest_k` is channel-major (`k = c * shDim + j`) - the order
 *    `getSHData` then re-interleaves from.
 *
 * Both are exactly what `spz-js`'s own `serializePly` wrote, so the renderer
 * sees the same numbers the PLY round trip used to deliver.
 *
 * `scale_2` is NOT conditional here the way `loadGsplat`'s `load:data` fixup
 * is: that fixup exists for 2D-splat PLYs, which carry only `scale_0`/`_1`,
 * and every SPZ carries three scales per point (`spz-format.ts` refuses a
 * stream whose length says otherwise). The fixup stays where it is for the
 * formats that need it.
 *
 * `nx`/`ny`/`nz` are dropped. The PLY carried them because the format wants a
 * normal, `serializePly` wrote zeros, and the parser dutifully allocated three
 * more Float32Arrays of them (6.3 MB on this capture) that nothing reads.
 */
export function spzToProperties(cloud: SpzCloud): SplatProperty[] {
  const n = cloud.numPoints;
  const shDim = n > 0 ? Math.floor(cloud.sh.length / n / 3) : 0;

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const scale0 = new Float32Array(n);
  const scale1 = new Float32Array(n);
  const scale2 = new Float32Array(n);
  const dc0 = new Float32Array(n);
  const dc1 = new Float32Array(n);
  const dc2 = new Float32Array(n);
  const rot0 = new Float32Array(n);
  const rot1 = new Float32Array(n);
  const rot2 = new Float32Array(n);
  const rot3 = new Float32Array(n);

  // One pass per source array rather than one pass over everything: each of
  // these walks its source forwards and its three destinations forwards, which
  // is the access pattern that costs nothing. 13 n writes in all, against the
  // 17 n the serialize wrote plus the 17 n the parser read back.
  const { positions, scales, colors, rotations } = cloud;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    x[i] = positions[j];
    y[i] = positions[j + 1];
    z[i] = positions[j + 2];
  }
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    scale0[i] = scales[j];
    scale1[i] = scales[j + 1];
    scale2[i] = scales[j + 2];
  }
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    dc0[i] = colors[j];
    dc1[i] = colors[j + 1];
    dc2[i] = colors[j + 2];
  }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    rot0[i] = rotations[j + 3];
    rot1[i] = rotations[j];
    rot2[i] = rotations[j + 1];
    rot3[i] = rotations[j + 2];
  }

  const properties: SplatProperty[] = [
    floatProp('x', x),
    floatProp('y', y),
    floatProp('z', z),
    floatProp('f_dc_0', dc0),
    floatProp('f_dc_1', dc1),
    floatProp('f_dc_2', dc2),
  ];

  // Channel-major, because that is the order `getSHData` indexes
  // (`f_rest_{j}`, `f_rest_{j + numCoeffs}`, `f_rest_{j + 2 * numCoeffs}` are
  // one coefficient's r, g, b). `GSplatData.shBands` then reads the band count
  // back off how many `f_rest_*` exist - 9, 24 or 45 - so a cloud with no SH
  // adds none of them and compiles SH_BANDS 0, exactly as before.
  for (let c = 0; c < 3; c++) {
    for (let j = 0; j < shDim; j++) {
      const coeff = new Float32Array(n);
      for (let i = 0; i < n; i++) coeff[i] = cloud.sh[(i * shDim + j) * 3 + c];
      properties.push(floatProp(`f_rest_${c * shDim + j}`, coeff));
    }
  }

  // `alphas` is already one value per splat, so `opacity` adopts the array the
  // decode allocated instead of copying it. Nothing else holds the cloud once
  // this returns.
  properties.push(floatProp('opacity', cloud.alphas));
  properties.push(floatProp('scale_0', scale0));
  properties.push(floatProp('scale_1', scale1));
  properties.push(floatProp('scale_2', scale2));
  properties.push(floatProp('rot_0', rot0));
  properties.push(floatProp('rot_1', rot1));
  properties.push(floatProp('rot_2', rot2));
  properties.push(floatProp('rot_3', rot3));

  return properties;
}

/**
 * Decode a version 4 `.spz` into PlayCanvas's quantized SPZ layout
 * (`spz-quantized.ts`), which the shader dequantizes, in Morton order: the
 * order `PlyParser` applied (`asset.data.reorder`), which buys spatial
 * locality for the depth sort and every later pass over the cloud. Each
 * attribute is decoded as soon as its bytes arrive, so only the last one waits
 * for the end of the file. A file the stream can't read comes back from the
 * general path, as floats.
 *
 * Version 4 only: every scene is one, and the gzipped versions before it are
 * no longer produced or stored.
 */
export async function decodeSpzQuantized(file: ReadableStream<Uint8Array>): Promise<QuantizedSpz | DecodedSpz> {
  const { decoded, bytes } = await streamV4(await openV4(file));
  // The general path names what is wrong with a malformed file.
  return decoded ?? decodeCloud(await readSpz(bytes));
}

/** The file again, once its first bytes say it is a version 4 SPZ. */
async function openV4(file: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const [head, stream] = await peek(file, 8);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 8 || view.getUint32(0, true) !== SPZ_MAGIC || view.getUint32(4, true) !== 4) {
    await stream.cancel().catch(() => {});
    throw new NotAnSpz(unsupported(head));
  }
  return stream;
}

const SPZ_MAGIC = 0x5053474e;

function unsupported(head: Uint8Array): string {
  if (head[0] === 0x1f && head[1] === 0x8b) return 'this is a gzipped SPZ (version 1-3); only version 4 is read';
  if (head.length >= 8 && new DataView(head.buffer, head.byteOffset, 8).getUint32(0, true) === SPZ_MAGIC) {
    return `this is an SPZ version ${new DataView(head.buffer, head.byteOffset, 8).getUint32(4, true)}; only version 4 is read`;
  }
  return 'these bytes are not an SPZ';
}

/** The first `bytes` of a stream, and the stream again with them still in it. */
async function peek(file: ReadableStream<Uint8Array>, bytes: number): Promise<[Uint8Array, ReadableStream<Uint8Array>]> {
  const reader = file.getReader();
  const seen: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (length < bytes) {
    const r = await reader.read();
    if (r.done) { done = true; break; }
    seen.push(r.value);
    length += r.value.length;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of seen) c.enqueue(chunk);
      if (done) c.close();
    },
    async pull(c) {
      const r = await reader.read();
      if (r.done) c.close();
      else c.enqueue(r.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return [concat(seen), stream];
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((at, c) => (out.set(c, at), at + c.length), 0);
  return out;
}

/** Byte length of each attribute, in file order, with SH last if any. */
function sections(n: number, shDim: number): number[] {
  const strides = [9, 1, 3, 3, 4, shDim * 3];
  return (shDim ? strides : strides.slice(0, 5)).map((stride) => stride * n);
}

/**
 * A version 4 file, each zstd stream inflated and decoded as soon as it has
 * all arrived. `decoded` is null for anything the general path should read
 * instead, which is also the path that explains a malformed file; `bytes` is
 * the whole file either way.
 */
async function streamV4(file: ReadableStream<Uint8Array>): Promise<{ decoded: QuantizedSpz | null; bytes: Uint8Array }> {
  const reader = file.getReader();
  let chunks: Uint8Array[] = [];
  let received = 0;
  const more = async () => {
    const r = await reader.read();
    if (r.done) return false;
    chunks.push(r.value);
    received += r.value.length;
    return true;
  };
  const rest = async () => {
    while (await more());
    return { decoded: null, bytes: concat(chunks) };
  };

  // The header, then its table of contents.
  while (received < 32 && await more());
  let bytes = concat(chunks);
  const head = readSpzHeader(bytes);
  // spz-js's point limit, and SH bands PlayCanvas renders.
  if (!head || head.version !== 4 || head.numPoints > 10_000_000 || head.shDegree > 3) return rest();
  const n = head.numPoints;
  const shDim = [0, 3, 8, 15][head.shDegree];
  const sizes = sections(n, shDim);
  const toc = head.tocByteOffset;
  if (sizes.length !== head.numStreams || toc < 32) return rest();
  const tocEnd = toc + sizes.length * 16;
  while (received < tocEnd && await more());
  if (received < tocEnd) return rest();
  bytes = concat(chunks);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const spans: [number, number][] = [];
  let end = tocEnd;
  for (let i = 0; i < sizes.length; i++) {
    const compressed = Number(view.getBigUint64(toc + i * 16, true));
    if (Number(view.getBigUint64(toc + i * 16 + 8, true)) !== sizes[i]) return rest();
    // ZSTD_COMPRESSBOUND plus slack: a larger stream is a broken table, and
    // it would size the buffer below.
    if (compressed > sizes[i] + (sizes[i] >> 8) + 1024) return rest();
    spans.push([end, end += compressed]);
  }

  // The whole file, copied in once, with each stream decoded once it is all
  // there. A file longer than its table of contents says is the general
  // path's to judge.
  if (received > end) return rest();
  const all = new Uint8Array(end);
  all.set(bytes);
  const s = quantizing(n, shDim, head.fractionalBits);
  let ok = true;
  let next = 0;
  const ready = async () => {
    for (; ok && next < spans.length && spans[next][1] <= received; next++) {
      try {
        const out = await browserInflate.zstd(all.subarray(...spans[next]), sizes[next]);
        if (out.byteLength !== sizes[next]) ok = false;
        else QUANTIZE_STAGES[next](s, out);
      } catch {
        ok = false;
      }
    }
  };
  for (;;) {
    await ready();
    const r = await reader.read();
    if (r.done) break;
    if (received + r.value.length > end) {
      chunks = [all.subarray(0, received), r.value];
      received += r.value.length;
      return rest();
    }
    all.set(r.value, received);
    received += r.value.length;
  }
  return { decoded: ok && received === end ? finishQuantizing(s) : null, bytes: all.subarray(0, received) };
}

/** The general path, from an unpacked cloud. */
export function decodeCloud(cloud: SpzCloud): DecodedSpz {
  const properties = spzToProperties(cloud);
  const get = (name: string) => properties.find((p) => p.name === name)!.storage;
  const order = mortonOrder(get('x'), get('y'), get('z'));
  for (const p of properties) {
    const src = p.storage;
    const dst = new Float32Array(src.length);
    for (let i = 0; i < order.length; i++) dst[i] = src[order[i]];
    p.storage = dst;
  }
  return { count: cloud.numPoints, properties, packed: packSplat(get, cloud.numPoints) };
}

const SH_C0 = 0.28209479177387814;

/** `updateColorData`, `updateTransformData`, `getCenters` and `calcAabb` in
 *  one pass, with the same arithmetic so the textures are bit-identical. */
export function packSplat(get: (name: string) => Float32Array, n: number): PackedSplat {
  const [x, y, z] = [get('x'), get('y'), get('z')];
  const [sx, sy, sz] = [get('scale_0'), get('scale_1'), get('scale_2')];
  const [rw, rx, ry, rz] = [get('rot_0'), get('rot_1'), get('rot_2'), get('rot_3')];
  const [cr, cg, cb, ca] = [get('f_dc_0'), get('f_dc_1'), get('f_dc_2'), get('opacity')];

  const color = new Uint16Array(n * 4);
  const transformA = new Uint32Array(n * 4);
  const transformAFloat = new Float32Array(transformA.buffer);
  const transformB = new Uint16Array(n * 4);
  const centers = new Float32Array(n * 3);
  let first = true;
  let mx = 0, my = 0, mz = 0, Mx = 0, My = 0, Mz = 0;

  for (let i = 0; i < n; i++) {
    const px = x[i], py = y[i], pz = z[i];
    const o = i * 4;

    color[o] = float2Half(cr[i] * SH_C0 + 0.5);
    color[o + 1] = float2Half(cg[i] * SH_C0 + 0.5);
    color[o + 2] = float2Half(cb[i] * SH_C0 + 0.5);
    color[o + 3] = float2Half(1 / (1 + Math.exp(-ca[i])));

    transformAFloat[o] = px;
    transformAFloat[o + 1] = py;
    transformAFloat[o + 2] = pz;
    packQuat(rx[i], ry[i], rz[i], rw[i], transformA, transformB, o);
    transformB[o] = float2Half(Math.exp(sx[i]));
    transformB[o + 1] = float2Half(Math.exp(sy[i]));
    transformB[o + 2] = float2Half(Math.exp(sz[i]));

    centers[i * 3] = px;
    centers[i * 3 + 1] = py;
    centers[i * 3 + 2] = pz;

    const scale = Math.max(sx[i], sy[i], sz[i]);
    if (!isFinite(px) || !isFinite(py) || !isFinite(pz) || !isFinite(scale)) continue;
    const s = 2.0 * Math.exp(scale);
    if (first) {
      first = false;
      mx = px - s; my = py - s; mz = pz - s;
      Mx = px + s; My = py + s; Mz = pz + s;
    } else {
      mx = Math.min(mx, px - s); my = Math.min(my, py - s); mz = Math.min(mz, pz - s);
      Mx = Math.max(Mx, px + s); My = Math.max(My, py + s); Mz = Math.max(Mz, pz + s);
    }
  }

  const aabb = first ? null : [(mx + Mx) * 0.5, (my + My) * 0.5, (mz + Mz) * 0.5, (Mx - mx) * 0.5, (My - my) * 0.5, (Mz - mz) * 0.5];
  return { color, transformA, transformB, centers, aabb };
}
