/**
 * Planar character-splat decoder - the payload half of `VFCHARB2`.
 *
 * A planar container stores one contiguous, component-major byte plane per
 * attribute (all x, then all y, then all z) instead of the per-splat records
 * `VFCHARB1` uses. Two precision modes share the one layout:
 *
 *   `fp16` - the same half-float values the shipping v2 `VFCHARB1` bundle
 *            carries, only re-laid-out. It decodes bit-identically to the v2
 *            path, which is what makes it the control when judging q23.
 *   `q23`  - ~23 B/gaussian: u16 position against per-file bounds, u8 rotation
 *            (w derived), u8 log-scale, u8 logit-opacity, u8 weights (the last
 *            one derived), bone indices through a per-file palette.
 *
 * This module is deliberately free of Worker glue so it can be driven directly
 * (from `binary-gsplat-worker.ts`, and from a plain Node process when the
 * decode is being compared against the Python reference implementation).
 */

const SH_C0 = 0.28209479177387814;

// Mirrors the decoder clamp in the interleaved path in binary-gsplat-worker.ts.
// q23 opacity is already quantized inside this band by the encoder, so the
// clamp costs nothing there.
const OPACITY_CLAMP_LO = 0.0001;
const OPACITY_CLAMP_HI = 0.9999;
const MIN_SCALE = 1e-8;

/**
 * Magic -> the `format` string a file under that magic must declare.
 *
 * The MAGIC is the container generation and the one field this decoder refuses
 * to guess at: a planar payload published under `VFCHARB1` would sail past
 * every version check in the interleaved reader and decode to silent garbage.
 * `format` is then checked as well - dispatching on `version` alone is exactly
 * how a file can be misparsed without anything throwing.
 *
 * `VSPLAT01` is the pre-release prototype of the same layout. It is kept
 * readable so the `.vsplat` LOD/quantisation A/B rig keeps working, and because
 * routing it through this same decoder means the prototype exercises the
 * production code path rather than a copy of it.
 */
const PLANAR_CONTAINERS: Record<string, string> = {
  VFCHARB2: 'vfa3d-charb2',
  VSPLAT01: 'vsplat-planar',
};

/** First planar `version`. `1` = fp32 interleaved, `2` = fp16 interleaved. */
const FIRST_PLANAR_VERSION = 3;

type PlaneDtype = 'f32' | 'f16' | 'u16' | 'u8';

/**
 * Per-plane compression codec, as written in the header.
 *
 * WHY DEFLATE AND NOT BROTLI OR ZSTD, which both compress ~10% better: these
 * three are the only formats `DecompressionStream` accepts, and the equivalents
 * (`GZipStream` / `DeflateStream`) are in the .NET base library, so a file with
 * compressed planes decodes on both targets with ZERO shipped decoder. Browsers
 * expose brotli and zstd only to the HTTP layer, never to script, so choosing
 * either would put a WASM decoder on the critical path of every character load.
 *
 * In-file compression is for platforms with no HTTP layer (Unity
 * StreamingAssets, AssetBundles, local files). On the web the file is served
 * flat with `Content-Encoding: br` instead, which is free and compresses
 * better. This decoder honours whichever the file declares.
 */
type PlaneCodec = 'gzip' | 'deflate' | 'deflate-raw';

const PLANE_CODECS: ReadonlySet<string> = new Set(['gzip', 'deflate', 'deflate-raw']);

interface PlaneInfo {
  offset: number;
  /** Bytes IN THE FILE - the compressed size when `compression` is set. */
  length: number;
  dtype: PlaneDtype;
  /** Values per splat. Stored COMPONENT-major: all c0, then all c1, ... */
  components: number;
  count: number;
  compression?: PlaneCodec;
  /** Bytes after inflation. Normative when `compression` is set. */
  uncompressedLength?: number;
}

/** A plane's bytes, wherever they ended up: in the file, or in an inflated copy. */
interface ResolvedPlane extends PlaneInfo {
  buf: ArrayBuffer;
  /** Byte offset of component 0 within `buf`. */
  base: number;
}

interface PlanarHeader {
  format: string;
  version: number;
  precision: 'fp16' | 'q23';
  numSplats: number;
  numBones: number;
  topK: number;
  bounds: { min: number[]; max: number[] };
  /** q23 only - normative, positions cannot be reconstructed without them. */
  logScale?: { min: number[]; max: number[] };
  logitOpacity?: { min: number; max: number };
  bonePalette?: number[];
  joints?: { count: number };
  /** Free-form; informational. The plane table is what the decoder obeys. */
  encoding?: { planeCompression?: PlaneCodec | null };
  planes: Record<string, PlaneInfo>;
}

const BYTES_PER_ELEMENT: Record<PlaneDtype, number> = { f32: 4, f16: 2, u16: 2, u8: 1 };

// Float16Array landed in browsers only recently (Chrome 135+/Safari 26+), so
// the manual expansion below stays as the fallback. Where it exists it is the
// whole point of the planar layout: a component plane converts into its
// Float32Array destination in one `set()` instead of a per-splat DataView walk.
const NativeFloat16Array = (globalThis as unknown as {
  Float16Array?: new (buffer: ArrayBuffer, byteOffset?: number, length?: number) => ArrayLike<number>;
}).Float16Array;

// IEEE 754 half-float -> single-float. Identical to the one in
// binary-gsplat-worker.ts; the two decoders stay independent files so the
// interleaved path has no import edge into the planar one.
const _f16Buf = new ArrayBuffer(4);
const _f16U32 = new Uint32Array(_f16Buf);
const _f16F32 = new Float32Array(_f16Buf);
function f16ToF32(h: number): number {
  const sign = (h & 0x8000) << 16;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  let bits: number;
  if (exp === 0) {
    if (frac === 0) {
      bits = sign;
    } else {
      let e = -14;
      let m = frac;
      while ((m & 0x400) === 0) {
        m <<= 1;
        e--;
      }
      m &= 0x3ff;
      bits = sign | ((e + 127) << 23) | (m << 13);
    }
  } else if (exp === 31) {
    bits = sign | 0x7f800000 | (frac << 13);
  } else {
    bits = sign | ((exp - 15 + 127) << 23) | (frac << 13);
  }
  _f16U32[0] = bits;
  return _f16F32[0];
}

/** The 8-byte ASCII magic, or `''` when the buffer is too short to have one. */
function readMagic(buffer: ArrayBuffer): string {
  if (buffer.byteLength < 12) return '';
  return new TextDecoder().decode(new Uint8Array(buffer, 0, 8));
}

/** True when `magic` names a planar container this module can decode. */
function isPlanarMagic(magic: string): boolean {
  return Object.prototype.hasOwnProperty.call(PLANAR_CONTAINERS, magic);
}

/** Inflate one plane into its own exactly-sized ArrayBuffer. */
async function inflate(src: Uint8Array, codec: PlaneCodec): Promise<ArrayBuffer> {
  const stream = new Blob([src as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream(codec));
  return await new Response(stream).arrayBuffer();
}

/**
 * Resolve every plane to a buffer + offset, inflating the compressed ones.
 *
 * This is the whole cost of supporting compressed planes: a decompressed plane
 * lands at offset 0 of a fresh buffer (so every typed-array view below stays
 * aligned), an uncompressed one is still a view straight into the file with no
 * copy at all. Everything downstream reads `p.buf` / `p.base` and no longer
 * cares which mode the file was written in.
 */
async function resolvePlanes(
  buffer: ArrayBuffer,
  header: PlanarHeader,
  planeStart: number,
): Promise<Record<string, ResolvedPlane>> {
  const out: Record<string, ResolvedPlane> = {};
  for (const [name, p] of Object.entries(header.planes)) {
    const start = planeStart + p.offset;
    if (start + p.length > buffer.byteLength) {
      throw new Error(`Planar plane out of bounds: ${name}`);
    }
    const expected = p.components * p.count * BYTES_PER_ELEMENT[p.dtype];
    if (p.compression) {
      if (!PLANE_CODECS.has(p.compression)) {
        throw new Error(`Planar plane ${name}: unsupported compression ${p.compression}`);
      }
      const buf = await inflate(new Uint8Array(buffer, start, p.length), p.compression);
      // The header's uncompressedLength is what a native decoder would have
      // used to size its destination, so a disagreement means the file lies
      // about itself - fail rather than render half a character.
      if (buf.byteLength !== (p.uncompressedLength ?? expected)) {
        throw new Error(
          `Planar plane ${name}: inflated to ${buf.byteLength} B, header says ` +
            `${p.uncompressedLength ?? expected} B`,
        );
      }
      if (buf.byteLength !== expected) {
        throw new Error(`Planar plane ${name}: ${buf.byteLength} B, expected ${expected} B`);
      }
      out[name] = { ...p, buf, base: 0 };
    } else {
      if (p.length !== expected) {
        throw new Error(`Planar plane ${name}: ${p.length} B, expected ${expected} B`);
      }
      out[name] = { ...p, buf: buffer, base: start };
    }
  }
  return out;
}

/**
 * Decode a planar character bundle into the Float32 arrays the GPU pipeline
 * expects, plus the skinning and joint data.
 *
 * Returns the same shape `parseBinaryGsplat` returns for the interleaved
 * container (minus the animation chunk, which planar files do not carry - clips
 * are registered separately), so both feed one `loadBinaryGsplat`.
 */
async function parsePlanarSplats(buffer: ArrayBuffer) {
  const magic = readMagic(buffer);
  const expectedFormat = PLANAR_CONTAINERS[magic];
  if (!expectedFormat) {
    throw new Error(`Invalid planar character bundle magic: ${magic}`);
  }

  const view = new DataView(buffer);
  const headerLength = view.getUint32(8, true);
  const headerStart = 12;
  const planeStart = headerStart + headerLength;
  if (planeStart > buffer.byteLength) throw new Error('Planar header length out of range');

  const header: PlanarHeader = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, headerStart, headerLength)),
  );
  if (header.format !== expectedFormat) {
    throw new Error(
      `Planar bundle ${magic} declares format '${header.format}', expected '${expectedFormat}'`,
    );
  }
  // The magic is the container generation, so a version below the planar line
  // under a planar magic means the file mislabels itself - the one thing this
  // reader must never shrug off. A LATER version is accepted: the format's own
  // rule is that a breaking layout change bumps the magic, not the version.
  if (!(header.version >= FIRST_PLANAR_VERSION)) {
    throw new Error(
      `Planar bundle ${magic} declares version ${header.version}, expected >= ${FIRST_PLANAR_VERSION}`,
    );
  }
  if (header.precision !== 'fp16' && header.precision !== 'q23') {
    throw new Error(`Unsupported planar precision: ${String(header.precision)}`);
  }
  if (!header.planes) throw new Error('Planar bundle has no plane table');
  // The encoder pads the header so the plane block is 4-byte aligned; without
  // that every typed-array view below would be a coin flip. (Inflated planes
  // start at offset 0 of their own buffer and are aligned for free.)
  if (planeStart % 4 !== 0) throw new Error('Planar plane block is not 4-byte aligned');

  const numSplats = header.numSplats;
  const topK = header.topK ?? 4;
  const isQ23 = header.precision === 'q23';

  const resolved = await resolvePlanes(buffer, header, planeStart);

  const plane = (name: string): ResolvedPlane => {
    const p = resolved[name];
    if (!p) throw new Error(`Planar bundle missing plane: ${name}`);
    return p;
  };

  const componentOffset = (p: ResolvedPlane, c: number): number =>
    p.base + c * p.count * BYTES_PER_ELEMENT[p.dtype];

  /** Expand one f16 component plane into `out`, natively where possible. */
  const readF16 = (p: ResolvedPlane, c: number, out: Float32Array): Float32Array => {
    const off = componentOffset(p, c);
    if (NativeFloat16Array) {
      out.set(new NativeFloat16Array(p.buf, off, p.count) as unknown as ArrayLike<number>);
      return out;
    }
    const dv = new DataView(p.buf, off, p.count * 2);
    for (let i = 0; i < p.count; i++) out[i] = f16ToF32(dv.getUint16(i * 2, true));
    return out;
  };

  const readU8 = (p: ResolvedPlane, c: number) => new Uint8Array(p.buf, componentOffset(p, c), p.count);
  const readU16 = (p: ResolvedPlane, c: number) => new Uint16Array(p.buf, componentOffset(p, c), p.count);
  const readUint = (p: ResolvedPlane, c: number): Uint8Array | Uint16Array =>
    p.dtype === 'u8' ? readU8(p, c) : readU16(p, c);

  const storage_x = new Float32Array(numSplats);
  const storage_y = new Float32Array(numSplats);
  const storage_z = new Float32Array(numSplats);
  const storage_scale_0 = new Float32Array(numSplats);
  const storage_scale_1 = new Float32Array(numSplats);
  const storage_scale_2 = new Float32Array(numSplats);
  const storage_rot_0 = new Float32Array(numSplats);
  const storage_rot_1 = new Float32Array(numSplats);
  const storage_rot_2 = new Float32Array(numSplats);
  const storage_rot_3 = new Float32Array(numSplats);
  const storage_f_dc_0 = new Float32Array(numSplats);
  const storage_f_dc_1 = new Float32Array(numSplats);
  const storage_f_dc_2 = new Float32Array(numSplats);
  const storage_opacity = new Float32Array(numSplats);

  const posPlane = plane('position');
  const scalePlane = plane('scale');
  const rotPlane = plane('rotation');
  const colorPlane = plane('color');
  const opacityPlane = plane('opacity');

  // ── position ────────────────────────────────────────────────────────
  const posOut = [storage_x, storage_y, storage_z];
  if (isQ23) {
    const bmin = header.bounds.min;
    const bmax = header.bounds.max;
    for (let c = 0; c < 3; c++) {
      const q = readU16(posPlane, c);
      const lo = bmin[c];
      const step = (bmax[c] - lo) / 65535;
      const out = posOut[c];
      for (let i = 0; i < numSplats; i++) out[i] = lo + q[i] * step;
    }
  } else {
    for (let c = 0; c < 3; c++) readF16(posPlane, c, posOut[c]);
  }

  // ── scale ───────────────────────────────────────────────────────────
  // The engine consumes LOG scale. q23 already stores log scale, so its decode
  // is a multiply-add; fp16 stores the linear value the v2 .bin stores and pays
  // the same log() the v2 path pays.
  const scaleOut = [storage_scale_0, storage_scale_1, storage_scale_2];
  if (isQ23) {
    const lsMin = header.logScale!.min;
    const lsMax = header.logScale!.max;
    for (let c = 0; c < 3; c++) {
      const q = readU8(scalePlane, c);
      const lo = lsMin[c];
      const step = (lsMax[c] - lo) / 255;
      const out = scaleOut[c];
      for (let i = 0; i < numSplats; i++) out[i] = lo + q[i] * step;
    }
  } else {
    for (let c = 0; c < 3; c++) {
      const out = readF16(scalePlane, c, scaleOut[c]);
      for (let i = 0; i < numSplats; i++) out[i] = Math.log(Math.max(out[i], MIN_SCALE));
    }
  }

  // ── rotation ────────────────────────────────────────────────────────
  // Stored xyzw; the engine wants wxyz (rot_0 = w).
  if (isQ23) {
    const qx = readU8(rotPlane, 0);
    const qy = readU8(rotPlane, 1);
    const qz = readU8(rotPlane, 2);
    for (let i = 0; i < numSplats; i++) {
      const x = (qx[i] / 255) * 2 - 1;
      const y = (qy[i] / 255) * 2 - 1;
      const z = (qz[i] / 255) * 2 - 1;
      // The encoder forced w >= 0, which is what makes this branch valid.
      storage_rot_0[i] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
      storage_rot_1[i] = x;
      storage_rot_2[i] = y;
      storage_rot_3[i] = z;
    }
  } else {
    readF16(rotPlane, 0, storage_rot_1);
    readF16(rotPlane, 1, storage_rot_2);
    readF16(rotPlane, 2, storage_rot_3);
    readF16(rotPlane, 3, storage_rot_0);
  }

  // ── colour ──────────────────────────────────────────────────────────
  const dcOut = [storage_f_dc_0, storage_f_dc_1, storage_f_dc_2];
  for (let c = 0; c < 3; c++) {
    const src = readU8(colorPlane, c);
    const out = dcOut[c];
    for (let i = 0; i < numSplats; i++) out[i] = (src[i] / 255 - 0.5) / SH_C0;
  }

  // ── opacity ─────────────────────────────────────────────────────────
  // The engine consumes the LOGIT. Same trade as scale: q23 stores it already
  // in logit space, fp16 stores the post-sigmoid value the v2 .bin stores.
  if (isQ23) {
    const lo = header.logitOpacity!.min;
    const step = (header.logitOpacity!.max - lo) / 255;
    const q = readU8(opacityPlane, 0);
    for (let i = 0; i < numSplats; i++) storage_opacity[i] = lo + q[i] * step;
  } else {
    readF16(opacityPlane, 0, storage_opacity);
    for (let i = 0; i < numSplats; i++) {
      const a = Math.max(OPACITY_CLAMP_LO, Math.min(OPACITY_CLAMP_HI, storage_opacity[i]));
      storage_opacity[i] = -Math.log(1 / a - 1);
    }
  }

  // ── skinning ────────────────────────────────────────────────────────
  let boneIndices: Uint16Array | undefined;
  let boneWeights: Float32Array | undefined;
  if (header.planes.boneIndex && header.planes.boneWeight) {
    const idxPlane = plane('boneIndex');
    const wPlane = plane('boneWeight');
    boneIndices = new Uint16Array(numSplats * topK);
    boneWeights = new Float32Array(numSplats * topK);

    // q23 indexes a per-file palette so the plane can be a byte wide; the
    // encoder widens it to u16 when a character touches more than 256 bones,
    // which the plane dtype records.
    const palette = header.bonePalette;
    for (let j = 0; j < topK; j++) {
      const src = readUint(idxPlane, j);
      if (palette) {
        for (let i = 0; i < numSplats; i++) boneIndices[i * topK + j] = palette[src[i]];
      } else {
        for (let i = 0; i < numSplats; i++) boneIndices[i * topK + j] = src[i];
      }
    }

    if (isQ23) {
      // Slots 0..2 are stored; the last one is whatever is left, which is what
      // makes the decoded quartet sum to exactly 1.
      const scratch = new Float32Array(numSplats);
      for (let j = 0; j < wPlane.components; j++) {
        const src = readU8(wPlane, j);
        for (let i = 0; i < numSplats; i++) {
          const w = src[i] / 255;
          boneWeights[i * topK + j] = w;
          scratch[i] += w;
        }
      }
      for (let i = 0; i < numSplats; i++) {
        boneWeights[i * topK + (topK - 1)] = Math.max(0, 1 - scratch[i]);
      }
    } else {
      const col = new Float32Array(numSplats);
      for (let j = 0; j < topK; j++) {
        readF16(wPlane, j, col);
        for (let i = 0; i < numSplats; i++) boneWeights[i * topK + j] = col[i];
      }
    }
  }

  // ── joints ──────────────────────────────────────────────────────────
  // Component-major like every other plane, unlike the interleaved container's
  // joints chunk, which is float3 records.
  let jointsArray: Float32Array | undefined;
  if (header.planes.joints) {
    const jp = plane('joints');
    jointsArray = new Float32Array(jp.count * 3);
    for (let c = 0; c < 3; c++) {
      const src = new Float32Array(jp.buf, componentOffset(jp, c), jp.count);
      for (let i = 0; i < jp.count; i++) jointsArray[i * 3 + c] = src[i];
    }
  }

  const transferables: ArrayBuffer[] = [
    storage_x.buffer as ArrayBuffer, storage_y.buffer as ArrayBuffer, storage_z.buffer as ArrayBuffer,
    storage_scale_0.buffer as ArrayBuffer, storage_scale_1.buffer as ArrayBuffer, storage_scale_2.buffer as ArrayBuffer,
    storage_rot_0.buffer as ArrayBuffer, storage_rot_1.buffer as ArrayBuffer, storage_rot_2.buffer as ArrayBuffer, storage_rot_3.buffer as ArrayBuffer,
    storage_f_dc_0.buffer as ArrayBuffer, storage_f_dc_1.buffer as ArrayBuffer, storage_f_dc_2.buffer as ArrayBuffer,
    storage_opacity.buffer as ArrayBuffer,
  ];
  if (boneIndices) transferables.push(boneIndices.buffer as ArrayBuffer);
  if (boneWeights) transferables.push(boneWeights.buffer as ArrayBuffer);
  if (jointsArray) transferables.push(jointsArray.buffer as ArrayBuffer);

  const result = {
    header,
    numSplats,
    splats: {
      x: storage_x, y: storage_y, z: storage_z,
      scale_0: storage_scale_0, scale_1: storage_scale_1, scale_2: storage_scale_2,
      rot_0: storage_rot_0, rot_1: storage_rot_1, rot_2: storage_rot_2, rot_3: storage_rot_3,
      f_dc_0: storage_f_dc_0, f_dc_1: storage_f_dc_1, f_dc_2: storage_f_dc_2,
      opacity: storage_opacity,
    },
    boneIndices: boneIndices ?? null,
    boneWeights: boneWeights ?? null,
    // Planar files carry no animation chunk; the fields exist so both
    // containers hand `loadBinaryGsplat` the same shape.
    animationArray: null as Float32Array | null,
    animNumFrames: 0,
    animNumBones: 0,
    jointsArray: jointsArray ?? null,
    nativeFloat16: !!NativeFloat16Array,
    planeCompression: header.encoding?.planeCompression ?? null,
  };

  return { result, transferables };
}

export { parsePlanarSplats, readMagic, isPlanarMagic, PLANAR_CONTAINERS, FIRST_PLANAR_VERSION };
export type { PlanarHeader, PlaneInfo, PlaneCodec, PlaneDtype };
