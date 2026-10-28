/**
 * AN SPZ READER OF OUR OWN, for the versions this fleet actually meets.
 *
 * ── Why not spz-js ───────────────────────────────────────────────────────
 *
 * spz-js 1.2.5 reads exactly one shape: a gzipped version 2 file. It
 * decompresses before it looks, so a file that is not gzipped fails as a
 * decompression error, and it rejects any version but 2. That was fine while
 * every SPZ in this system was one we had written ourselves.
 *
 * The provider now emits VERSION 4: a 32-byte plaintext header, a table of
 * contents, and one ZSTD stream per attribute. Nothing in this fleet could
 * open it - not this worker, not env_render, not the viewer's own decoder -
 * and the failure read as "corrupt bytes" rather than "a format nobody agreed
 * on", which is three hours of the wrong investigation.
 *
 * ── Why writing one is reasonable rather than reckless ──────────────────
 *
 * The format is published and small, and this implementation was checked
 * against a real 17,164,402-byte file the provider produced before a line of
 * it was trusted: the header's own numbers predict the file's length to the
 * byte (112 + the five compressed sizes), and `numStreams` is 5 rather than
 * the usual 6 exactly because that scene has no spherical harmonics. A format
 * that predicts its own file size is one you can implement.
 *
 * ── The one thing injected ──────────────────────────────────────────────
 *
 * Decompression. Node has zstd in `zlib` from 22.15; a browser has none and
 * needs a library. Keeping both out of this file is what lets the same decoder
 * run in the worker and in the viewer - the format logic has no platform in
 * it, and this file has no imports at all.
 *
 * ── THIS FILE IS VENDORED, AND IS MEANT TO STAY BYTE-IDENTICAL ──────────
 *
 * The other copy is PINOC's `engine/src/loader/environment/spz-format.ts`,
 * from where it reaches `env_render` and `char_render` through their existing
 * `sync-from-pinoc.sh`. Having no imports is what makes that a `diff` rather
 * than a port, so KEEP IT THAT WAY: a platform detail belongs in the caller
 * (`spz/node.ts` here, `spz-read.ts` there), never in here.
 *
 * The tests are `scene_build/src/spz/decode.test.ts`, which the engine copy
 * has no equivalent of - one test of one decoder is the point of one decoder.
 */

/** A decoded cloud, in the shape spz-js produced - so this is a drop-in. */
export interface SpzCloud {
  numPoints: number;
  shDegree: number;
  antialiased: boolean;
  /** xyz per point, in the file's own units. */
  positions: Float32Array;
  /** Natural log per axis, as the file stores it. exp() for world units. */
  scales: Float32Array;
  /** xyzw per point, normalised. */
  rotations: Float32Array;
  /** The RAW LOGIT, as spz-js returns it. sigmoid() to threshold. */
  alphas: Float32Array;
  /** The DC spherical-harmonic term, in the PLY's own units. */
  colors: Float32Array;
  /** Higher SH bands, `shDim * 3` per point; empty at degree 0. */
  sh: Float32Array;
}

/** Inflates one stream. `size` is what the file says it should come to. */
export type Inflate = (bytes: Uint8Array, size: number) => Promise<Uint8Array>;

export interface SpzInflate {
  /** Version 4's per-stream compression. */
  zstd: Inflate;
  /** Versions 1-3 wrap the whole file in one of these. */
  gzip: Inflate;
}

export class NotAnSpz extends Error {
  override readonly name = 'NotAnSpz';
}

/** "NGSP", little-endian, at byte 0 of an uncompressed file. */
const MAGIC = 0x5053474e;
const V4_HEADER_BYTES = 32;
const V2_HEADER_BYTES = 16;

/** Coefficients per channel for each SH degree. */
const SH_DIM = [0, 3, 8, 15, 24];

/** The DC colour scale both versions pack with. */
const COLOR_SCALE = 0.15;

const FLAG_ANTIALIASED = 0x1;

/**
 * THE STREAM ORDER, WHICH IS THE WRITER'S AND NOT THE DOCUMENT'S.
 *
 * The reference packs them positions, alphas, colors, scales, rotations, sh
 * and SKIPS EMPTY ONES, so `numStreams` counts what is present rather than
 * naming which. Sizes almost resolve it on their own - 9, 1, 3, 3, 4 bytes a
 * point are nearly distinct - but colors and scales are both 3, so a reader
 * that guessed would silently swap a scene's colour for its size. This order
 * is why it does not.
 */
const STREAMS = ['positions', 'alphas', 'colors', 'scales', 'rotations', 'sh'] as const;
type StreamName = (typeof STREAMS)[number];

export interface SpzHeader {
  version: number;
  numPoints: number;
  shDegree: number;
  fractionalBits: number;
  antialiased: boolean;
  /** v4 only. */
  numStreams: number;
  tocByteOffset: number;
}

/**
 * The header of an UNCOMPRESSED file, or null when these are not its bytes.
 *
 * Null rather than throwing: a caller holding a gzipped file asks this first
 * and gets a plain "not that", which is how `decodeSpz` tells the two framings
 * apart without parsing anything twice.
 */
export function readSpzHeader(file: Uint8Array): SpzHeader | null {
  if (file.byteLength < V2_HEADER_BYTES) return null;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return null;
  const version = view.getUint32(4, true);
  const numPoints = view.getUint32(8, true);
  const shDegree = file[12]!;
  const fractionalBits = file[13]!;
  const flags = file[14]!;
  const head: SpzHeader = {
    version,
    numPoints,
    shDegree,
    fractionalBits,
    antialiased: (flags & FLAG_ANTIALIASED) !== 0,
    numStreams: file[15]!,
    tocByteOffset: version >= 4 && file.byteLength >= V4_HEADER_BYTES
      ? view.getUint32(16, true)
      : 0,
  };
  return head;
}

/**
 * IEEE half to float, by hand.
 *
 * `DataView.getFloat16` exists in ES2025 and in neither of the runtimes this
 * file has to support today, and a `Float16Array` view would need the bytes
 * aligned, which a stream at byte 16 of a file is not.
 */
function half(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa !== 0 ? NaN : sign * Infinity;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

function check(head: SpzHeader): void {
  if (head.shDegree > 4) {
    throw new NotAnSpz(`spherical-harmonic degree ${head.shDegree} is not a degree`);
  }
  // spz-js's own ceiling, kept: a count past it is a corrupt header rather
  // than a scene, and allocating from it is how that becomes a crash.
  if (!(head.numPoints > 0) || head.numPoints > 10_000_000) {
    throw new NotAnSpz(`${head.numPoints} points is not a plausible cloud`);
  }
}

/** Bytes per point of each attribute, which is also how a stream is checked. */
function strides(head: SpzHeader): Record<StreamName, number> {
  return {
    // VERSION 1 STORES A HALF FLOAT PER AXIS, and 2 onwards 24-bit fixed
    // point. Six bytes against nine, which is why a v1 file read as a v2 ends
    // inside its own colours rather than producing nonsense.
    positions: head.version >= 2 ? 9 : 6,
    alphas: 1,
    colors: 3,
    scales: 3,
    // SMALLEST-THREE FROM VERSION 3. Two bits of index and three 10-bit
    // components in 4 bytes, against v2's three signed bytes with w derived.
    rotations: head.version >= 3 ? 4 : 3,
    sh: SH_DIM[head.shDegree]! * 3,
  };
}

/**
 * Decode a version 4 file: header, table of contents, one ZSTD stream each.
 *
 * THE TOC IS TRUSTED ONLY AS FAR AS IT CHECKS OUT. Every entry carries both
 * sizes, so the uncompressed length is compared against what the header's
 * point count demands - a stream that disagrees is a file we have
 * misunderstood, and misunderstanding a stream silently swaps one attribute
 * for another rather than failing.
 */
async function decodeV4(
  file: Uint8Array,
  head: SpzHeader,
  inflate: SpzInflate,
): Promise<Record<StreamName, Uint8Array>> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const want = strides(head);
  // Which streams this file holds, in the writer's order, minus the empty
  // ones it skipped.
  const present = STREAMS.filter((s) => want[s] > 0);
  if (present.length !== head.numStreams) {
    throw new NotAnSpz(
      `the header says ${head.numStreams} streams; a cloud of ${head.numPoints} points `
      + `with SH degree ${head.shDegree} has ${present.length}`,
    );
  }

  const toc = head.tocByteOffset;
  if (toc < V4_HEADER_BYTES || toc + present.length * 16 > file.byteLength) {
    throw new NotAnSpz(`the table of contents is not inside the file (at ${toc})`);
  }

  const out = {} as Record<StreamName, Uint8Array>;
  let at = toc + present.length * 16;
  for (const [i, name] of present.entries()) {
    const compressed = Number(view.getBigUint64(toc + i * 16, true));
    const size = Number(view.getBigUint64(toc + i * 16 + 8, true));
    const expect = want[name] * head.numPoints;
    if (size !== expect) {
      throw new NotAnSpz(
        `the ${name} stream says ${size} bytes, which is not the ${expect} `
        + `that ${head.numPoints} points need`,
      );
    }
    if (at + compressed > file.byteLength) {
      throw new NotAnSpz(`the ${name} stream runs past the end of the file`);
    }
    // THE DECOMPRESSOR'S OWN COMPLAINT IS NOT A USEFUL ONE on its own: both
    // implementations behind this say something like "invalid buffer size"
    // with no idea which file or which attribute they were handed. Naming the
    // stream is the difference between a line in a log and an afternoon.
    try {
      out[name] = await inflate.zstd(file.subarray(at, at + compressed), size);
    } catch (err) {
      throw new NotAnSpz(
        `the ${name} stream does not decompress: ${(err as Error).message}`,
      );
    }
    if (out[name].byteLength !== size) {
      throw new NotAnSpz(
        `the ${name} stream inflated to ${out[name].byteLength} bytes, not ${size}`,
      );
    }
    at += compressed;
  }
  // Absent streams are empty rather than missing, so the unpack below needs no
  // branch per attribute.
  for (const name of STREAMS) out[name] ??= new Uint8Array(0);
  return out;
}

/** Versions 1-3: one gzip stream, header first, then the attributes in order. */
function splitLegacy(raw: Uint8Array, head: SpzHeader): Record<StreamName, Uint8Array> {
  const want = strides(head);
  const out = {} as Record<StreamName, Uint8Array>;
  let at = V2_HEADER_BYTES;
  for (const name of STREAMS) {
    const size = want[name] * head.numPoints;
    if (at + size > raw.byteLength) {
      throw new NotAnSpz(
        `this file ends inside its ${name}: ${raw.byteLength} bytes for a cloud `
        + `of ${head.numPoints}`,
      );
    }
    out[name] = raw.subarray(at, at + size);
    at += size;
  }
  return out;
}

/**
 * Smallest-three, as the reference packs it: the 2-bit index of the component
 * that was dropped, then the other three in index order, each a sign bit and
 * nine bits of magnitude over sqrt(1/2).
 *
 * THE DROPPED ONE IS ALWAYS POSITIVE - that is what makes it droppable - so it
 * comes back as the positive root of whatever the other three leave.
 */
function unpackRotations(src: Uint8Array, head: SpzHeader): Float32Array {
  const n = head.numPoints;
  const out = new Float32Array(n * 4);
  if (head.version >= 3) {
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const SQRT_HALF = Math.SQRT1_2;
    for (let i = 0; i < n; i++) {
      const bits = view.getUint32(i * 4, true);
      const largest = (bits >>> 30) & 0x3;
      let sum = 0;
      let shift = 20;
      for (let c = 0; c < 4; c++) {
        if (c === largest) continue;
        const field = (bits >>> shift) & 0x3ff;
        const mag = (field & 0x1ff) / 511 * SQRT_HALF;
        const v = (field & 0x200) !== 0 ? -mag : mag;
        out[i * 4 + c] = v;
        sum += v * v;
        shift -= 10;
      }
      out[i * 4 + largest] = Math.sqrt(Math.max(0, 1 - sum));
    }
    return out;
  }
  // Version 2: three signed bytes, w the positive root of the rest.
  for (let i = 0; i < n; i++) {
    const x = src[i * 3]! / 127.5 - 1;
    const y = src[i * 3 + 1]! / 127.5 - 1;
    const z = src[i * 3 + 2]! / 127.5 - 1;
    out[i * 4] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - (x * x + y * y + z * z)));
  }
  return out;
}

/** The per-attribute decode, which every version since 2 shares. */
function unpack(s: Record<StreamName, Uint8Array>, head: SpzHeader): SpzCloud {
  const n = head.numPoints;
  const positions = new Float32Array(n * 3);
  const p = s.positions;
  if (head.version >= 2) {
    const scale = 1 / (1 << head.fractionalBits);
    for (let i = 0; i < n * 3; i++) {
      // 24-bit little-endian, sign-extended.
      let fixed = p[i * 3]! | (p[i * 3 + 1]! << 8) | (p[i * 3 + 2]! << 16);
      if (fixed & 0x800000) fixed |= ~0xffffff;
      positions[i] = fixed * scale;
    }
  } else {
    for (let i = 0; i < n * 3; i++) positions[i] = half(p[i * 2]! | (p[i * 2 + 1]! << 8));
  }

  const scales = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) scales[i] = s.scales[i]! / 16 - 10;

  const alphas = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // THE RAW LOGIT, because that is what every reader of this cloud expects
    // to sigmoid for itself.
    //
    // THE ENDS ARE LEFT INFINITE, which was a deliberate reversal. Clamping
    // byte 0 to a logit of -13.8 rather than -Infinity looks like the careful
    // choice, and it is wrong here: PINOC's engine decodes a version 2 file by
    // a separate fast path whose own table is `log(c / 255 / (1 - c / 255))`,
    // and spz-js, which this replaced, does the same. A clamp makes two
    // decoders of ONE format disagree about one file - 1e-6 of opacity on an
    // invisible splat, which is exactly the kind of difference that is
    // impossible to see and impossible to explain later.
    //
    // Nothing downstream divides by this or sums it: every reader applies
    // sigmoid, and sigmoid of -Infinity is 0.
    const a = s.alphas[i]! / 255;
    alphas[i] = Math.log(a / (1 - a));
  }

  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) colors[i] = (s.colors[i]! / 255 - 0.5) / COLOR_SCALE;

  const shDim = SH_DIM[head.shDegree]!;
  const sh = new Float32Array(n * shDim * 3);
  for (let i = 0; i < sh.length; i++) sh[i] = (s.sh[i]! - 128) / 128;

  return {
    numPoints: n,
    shDegree: head.shDegree,
    antialiased: head.antialiased,
    positions,
    scales,
    rotations: unpackRotations(s.rotations, head),
    alphas,
    colors,
    sh,
  };
}

/**
 * Decode an SPZ of any version this fleet meets, gzipped or not.
 *
 * THE FRAMING IS READ OFF THE BYTES rather than off a name or a version we
 * were told: an uncompressed file starts with the magic, anything else is
 * handed to gzip and expected to start with it after. That is what makes this
 * survive the provider changing container without changing its mind.
 */
export async function decodeSpz(file: Uint8Array, inflate: SpzInflate): Promise<SpzCloud> {
  let head = readSpzHeader(file);
  // A VERSION PAST THE LAST ONE READ HERE IS REFUSED BY NUMBER, not attempted.
  // Every version so far has moved a field or a container, so a reader that
  // hoped a newer one was close enough would produce a plausible cloud of the
  // wrong thing - which is the one failure this file is written to avoid.
  if (head && head.version > 4) {
    throw new NotAnSpz(
      `this is an SPZ version ${head.version}; this decoder reads 1 to 4`,
    );
  }
  if (head && head.version === 4) {
    check(head);
    return unpack(await decodeV4(file, head, inflate), head);
  }
  let raw = file;
  if (!head) {
    // GZIP'S OWN MAGIC FIRST, so that bytes which are neither framing are
    // refused HERE and in these words. Handing them to the decompressor
    // instead gets you zlib's `incorrect header check`, which names neither
    // the file nor the format and is how an HTML error page stored as a scene
    // becomes an afternoon of reading the wrong code.
    if (file.byteLength < 2 || file[0] !== 0x1f || file[1] !== 0x8b) {
      throw new NotAnSpz(
        `these ${file.byteLength} bytes are not an SPZ: no "NGSP" header and no gzip wrapper`,
      );
    }
    try {
      raw = await inflate.gzip(file, 0);
    } catch (err) {
      throw new NotAnSpz(
        `this file is gzipped but does not decompress: ${(err as Error).message}`,
      );
    }
    head = readSpzHeader(raw);
    if (!head) throw new NotAnSpz('these bytes gunzip to something that is not an SPZ');
    if (head.version >= 4) {
      throw new NotAnSpz('a version 4 file should not be gzipped; its streams carry their own');
    }
  }
  check(head);
  if (head.version < 1) {
    throw new NotAnSpz(`version ${head.version} predates the format this reads`);
  }
  return unpack(splitLegacy(raw, head), head);
}
