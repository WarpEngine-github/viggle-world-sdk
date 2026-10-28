/**
 * `VIGGCHAR` version 1 - the quantised block payload.
 *
 * Written from the character-bundle format spec and from nothing else.
 * A JSON header with exactly two keys, `numSplats` and `blocks`, followed by
 * the blocks it lists. Each block holds one attribute for every gaussian,
 * stored component-major, and each block's entry carries everything needed to
 * decode THAT block - its dequantisation bounds, its palette. There is no
 * top-level decoding parameter and no file-wide precision mode.
 *
 * This handler is total over version 1 and knows that no other version exists.
 * It never re-checks the magic or the version: the dispatcher owns both.
 *
 * Vocabulary note: this format says BLOCKS. The legacy containers next door say
 * planes and chunks. The difference is deliberate - a block is self-describing
 * in a way a plane was not, and keeping the words apart keeps the two readers
 * from being read as one.
 */

import { CharacterBundleError } from '../types';
import type { DecodeResult, DecodedBundle } from '../types';

/** Spherical-harmonic DC coefficient. A constant of version 1. */
const SH_C0 = 0.28209479177387814;

/** Position quantisation levels: stored values run `0..65535`. */
const POSITION_LEVELS = 65536;

/** Scale and opacity quantisation levels: stored values run `0..255`. */
const BYTE_LEVELS = 256;

type BlockDtype = 'f32' | 'u16' | 'u8';

const BYTES_PER_ELEMENT: Record<BlockDtype, number> = { f32: 4, u16: 2, u8: 1 };

/** The five keys required on every block entry. */
const COMMON_KEYS = ['offset', 'length', 'dtype', 'components', 'count'] as const;

/**
 * Every block this version defines, with the shape its entry must declare.
 *
 * `components: null` means "whatever the entry says" - `boneIndex` carries `K`
 * and `boneWeight` carries `K - 1`, and `K` is per-file. A block name that is
 * not in here is ignored: the manifest is what the file contains, and a name
 * this version does not define contributes nothing to the decode.
 */
const BLOCK_SHAPES: Record<string, { dtypes: BlockDtype[]; components: number | null }> = {
  position: { dtypes: ['u16'], components: 3 },
  scale: { dtypes: ['u8'], components: 3 },
  rotation: { dtypes: ['u8'], components: 3 },
  color: { dtypes: ['u8'], components: 3 },
  opacity: { dtypes: ['u8'], components: 1 },
  boneIndex: { dtypes: ['u8', 'u16'], components: null },
  boneWeight: { dtypes: ['u8'], components: null },
  joints: { dtypes: ['f32'], components: 3 },
};

/** The five blocks every conforming file carries. A missing one is rejected by name. */
const UNCONDITIONAL_BLOCKS = ['position', 'scale', 'rotation', 'color', 'opacity'] as const;

/**
 * The blocks quantised against a range measured from this file's data.
 *
 * These and only these carry `min` / `max`. `rotation`, `boneWeight` and
 * `color` do not, because their range is a property of their type rather than
 * of this character, and there is nothing per-file to record.
 */
const BOUNDED_BLOCKS = ['position', 'scale', 'opacity'] as const;

interface BlockEntry {
  offset: number;
  /** Bytes in the file, and the only length a block has. */
  length: number;
  dtype: BlockDtype;
  /** Values per row, stored component-major: all c0, then all c1, ... */
  components: number;
  count: number;
  /** Per-component dequantisation bounds. Present on `BOUNDED_BLOCKS` only. */
  min?: number[];
  max?: number[];
  /** Stored index -> global rig bone index. Present on `boneIndex` only. */
  palette?: number[];
}

interface V1Header {
  numSplats: number;
  blocks: Record<string, BlockEntry>;
}

/** A block entry with its bytes located: `base` is where component 0 begins. */
interface ResolvedBlock extends BlockEntry {
  /** Absolute byte offset of component 0 in the file: `blockStart + offset`. */
  base: number;
}

// A `function` declaration rather than a `const` arrow, deliberately: TypeScript
// only narrows control flow through a never-returning call when the callee is a
// function declaration or an explicitly-annotated variable. As a `const` arrow
// this returned `never` and still left every `if (x === undefined) fail(...)`
// guard invisible to the compiler, so the code after it saw `x` as possibly
// undefined even though the guard had already thrown.
function fail(
  category: ConstructorParameters<typeof CharacterBundleError>[0],
  message: string,
): never {
  throw new CharacterBundleError(category, message);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isUint = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Check the five common keys and the arithmetic that ties them together.
 *
 * Everything here is a property of ONE block entry, which is the point: no
 * check reaches into a sibling key, so a block decodes from its own entry plus
 * the constants of this version.
 */
function validateCommonKeys(name: string, entry: unknown, blockStart: number, totalLength: number) {
  if (!isPlainObject(entry)) {
    fail('BadFieldValue', `block '${name}': entry is ${JSON.stringify(entry)}, expected an object`);
  }
  const e = entry as Record<string, unknown>;
  for (const key of COMMON_KEYS) {
    if (e[key] === undefined || e[key] === null) {
      fail('MissingField', `block '${name}': missing required key '${key}'`);
    }
  }
  for (const key of ['offset', 'length', 'components', 'count'] as const) {
    if (!isUint(e[key])) {
      fail('BadFieldValue', `block '${name}': '${key}' is ${JSON.stringify(e[key])}, expected a non-negative integer`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(BYTES_PER_ELEMENT, e.dtype as string)) {
    fail(
      'BadFieldValue',
      `block '${name}': dtype ${JSON.stringify(e.dtype)}, expected one of ${Object.keys(BYTES_PER_ELEMENT).join(', ')}`,
    );
  }

  const p = e as unknown as BlockEntry;
  // A u16 or f32 block at an odd offset otherwise fails deep inside the decode,
  // where the cause is no longer visible.
  if (p.offset % 4 !== 0) {
    fail('UnalignedPayload', `block '${name}': offset ${p.offset} is not a multiple of 4`);
  }
  const end = blockStart + p.offset + p.length;
  if (end > totalLength) {
    fail(
      'Truncated',
      `block '${name}': bytes [${blockStart + p.offset}, ${end}) run past the file's ${totalLength} B`,
    );
  }
  // The block's bytes are the decoded bytes, so its stored length is the size
  // its own shape asks for. A disagreement is the file describing itself wrong,
  // and it is caught here rather than as a short read deep inside the decode.
  const decoded = p.components * p.count * BYTES_PER_ELEMENT[p.dtype];
  if (p.length !== decoded) {
    fail(
      'BlockSizeMismatch',
      `block '${name}': length ${p.length} B, but ` +
        `${p.components} components x ${p.count} rows x ${BYTES_PER_ELEMENT[p.dtype]} B (${p.dtype}) = ${decoded} B`,
    );
  }
}

/**
 * Check the manifest as a whole: which blocks are present, and what their
 * entries must then say about each other.
 *
 * The block table is the ONE place this reader learns what the file contains.
 * Nothing below probes the payload, guesses from a size, or reads meaning into
 * a block's absence beyond the presence rules the spec states outright.
 */
function validateManifest(header: V1Header, blocks: Record<string, BlockEntry>) {
  for (const name of UNCONDITIONAL_BLOCKS) {
    if (!blocks[name]) fail('MissingField', `manifest is missing the required block '${name}'`);
  }

  for (const [name, p] of Object.entries(blocks)) {
    const shape = BLOCK_SHAPES[name];
    if (!shape) continue;
    if (!shape.dtypes.includes(p.dtype)) {
      fail(
        'InconsistentHeader',
        `block '${name}': dtype '${p.dtype}', expected ${shape.dtypes.map((d) => `'${d}'`).join(' or ')}`,
      );
    }
    if (shape.components !== null && p.components !== shape.components) {
      fail(
        'InconsistentHeader',
        `block '${name}': ${p.components} components, expected exactly ${shape.components}`,
      );
    }
    if (name !== 'joints' && p.count !== header.numSplats) {
      fail(
        'InconsistentHeader',
        `block '${name}': count ${p.count}, expected numSplats ${header.numSplats}`,
      );
    }
  }

  // Checked before anything reads the rig's size: an empty rig is not a rig,
  // and a `joints.count` of 0 would otherwise surface as every palette entry
  // being out of range.
  if (blocks.joints && blocks.joints.count === 0) {
    fail('UnexpectedField', `block 'joints': count 0, and an empty rig is not a rig`);
  }

  // Bounds live in the entry of the block they decode, and nowhere else. A
  // block that carries them where it should not is as wrong as one that omits
  // them: both mean a decoder cannot tell from an entry how to read it.
  for (const [name, p] of Object.entries(blocks)) {
    if (!BLOCK_SHAPES[name]) continue;
    const bounded = (BOUNDED_BLOCKS as readonly string[]).includes(name);
    for (const key of ['min', 'max'] as const) {
      const v = p[key];
      if (!bounded) {
        if (v !== undefined) {
          fail('UnexpectedField', `block '${name}': carries '${key}', but its range is fixed by its type`);
        }
        continue;
      }
      if (v === undefined) {
        fail('MissingField', `block '${name}': missing dequantisation bound '${key}'`);
      }
      if (!Array.isArray(v) || v.length !== p.components || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        fail(
          'BadFieldValue',
          `block '${name}': '${key}' is ${JSON.stringify(v)}, expected an array of ${p.components} finite numbers`,
        );
      }
    }
    if (bounded) {
      for (let c = 0; c < p.components; c++) {
        if (p.max![c] < p.min![c]) {
          fail(
            'BadFieldValue',
            `block '${name}': component ${c} has max ${p.max![c]} below min ${p.min![c]}, an inverted span`,
          );
        }
      }
    }
    if (name !== 'boneIndex' && p.palette !== undefined) {
      fail('UnexpectedField', `block '${name}': carries a 'palette', which only 'boneIndex' takes`);
    }
  }

  // Skinning is one fact in two blocks. A bundle with one of them has no
  // defined meaning, so neither half is guessed at from the other's absence.
  const hasIndex = !!blocks.boneIndex;
  const hasWeight = !!blocks.boneWeight;
  if (hasIndex && !hasWeight) {
    fail('MissingField', `manifest has 'boneIndex' but not 'boneWeight'; skinning needs both`);
  }
  if (hasWeight && !hasIndex) {
    fail('UnexpectedField', `manifest has 'boneWeight' but not 'boneIndex'; skinning needs both`);
  }
  if (hasIndex) {
    const idx = blocks.boneIndex;
    const w = blocks.boneWeight;
    if (w.components !== idx.components - 1) {
      fail(
        'InconsistentHeader',
        `block 'boneWeight': ${w.components} components, expected boneIndex.components - 1 = ${idx.components - 1}`,
      );
    }
    if (idx.palette === undefined) {
      fail('MissingField', `block 'boneIndex': missing 'palette'`);
    }
    if (!Array.isArray(idx.palette) || !idx.palette.every(isUint)) {
      fail(
        'BadFieldValue',
        `block 'boneIndex': 'palette' is ${JSON.stringify(idx.palette)?.slice(0, 80)}, expected an array of rig indices`,
      );
    }
    // A palette entry is a global rig index, so the rig - when the file carries
    // one - is what says which indices exist.
    const rigBones = blocks.joints?.count;
    if (rigBones !== undefined) {
      for (let i = 0; i < idx.palette.length; i++) {
        if (idx.palette[i] >= rigBones) {
          fail(
            'InconsistentHeader',
            `block 'boneIndex': palette[${i}] is ${idx.palette[i]}, outside the ${rigBones}-bone rig`,
          );
        }
      }
    }
  }

}

/**
 * Locate every block: `base` is where its component 0 begins in the file.
 *
 * A block is read in place - no copy at all. `blockStart` and every `offset`
 * are multiples of 4, so every typed-array view below is aligned by the
 * layout's own rules and nothing has to be moved to make it so.
 */
function resolveBlocks(
  blocks: Record<string, BlockEntry>,
  blockStart: number,
): Record<string, ResolvedBlock> {
  const out: Record<string, ResolvedBlock> = {};
  for (const [name, p] of Object.entries(blocks)) {
    if (!BLOCK_SHAPES[name]) continue;
    out[name] = { ...p, base: blockStart + p.offset };
  }
  return out;
}

/**
 * Decode a `VIGGCHAR` version 1 payload.
 *
 * Version 1 means CORRECTED: the ankle pitch bake and then the ground shift are
 * already in the gaussians and in the `joints` block, and the character stands
 * on `y = 0` by construction. There is no in-file signal about that and nothing
 * below looks for one - the version answered it.
 *
 * The decode is straight-line and never yields; it is declared `async` only
 * because `VersionHandler` is promise-shaped for the handlers that must be.
 */
async function decodeV1(
  file: ArrayBuffer,
  payloadOffset: number,
  payloadLength: number,
): Promise<DecodeResult> {
  const totalLength = payloadOffset + payloadLength;

  if (payloadLength < 4) {
    fail('Truncated', `payload is ${payloadLength} B, too small to carry a header length`);
  }
  const headerLength = new DataView(file).getUint32(payloadOffset, true);
  const headerStart = payloadOffset + 4;
  const blockStart = headerStart + headerLength;
  if (blockStart > totalLength) {
    fail(
      'Truncated',
      `header claims ${headerLength} B, which ends at ${blockStart}, past the file's ${totalLength} B`,
    );
  }
  // The writer pads the JSON with spaces until this holds. Block offsets are
  // relative to `blockStart`, so a misaligned base makes every typed-array view
  // in the payload invalid - and a `u16` block would fail far from the cause.
  if (headerLength % 4 !== 0) {
    fail('UnalignedPayload', `headerLength ${headerLength} is not a multiple of 4`);
  }

  let header: V1Header;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array(file, headerStart, headerLength),
    );
    header = JSON.parse(text);
  } catch (err) {
    return fail('MalformedHeader', `header is not valid UTF-8 JSON (${(err as Error)?.message ?? String(err)})`);
  }
  if (!isPlainObject(header)) {
    return fail('MalformedHeader', `header is ${JSON.stringify(header)}, expected a JSON object`);
  }

  if (header.numSplats === undefined || header.numSplats === null) {
    fail('MissingField', `header is missing 'numSplats'`);
  }
  if (!isUint(header.numSplats)) {
    fail('BadFieldValue', `header 'numSplats' is ${JSON.stringify(header.numSplats)}, expected a non-negative integer`);
  }
  if (header.blocks === undefined || header.blocks === null) {
    fail('MissingField', `header is missing 'blocks', the block table`);
  }
  if (!isPlainObject(header.blocks)) {
    fail('BadFieldValue', `header 'blocks' is ${JSON.stringify(header.blocks)}, expected an object`);
  }

  const numSplats = header.numSplats;
  // A name this version does not define contributes nothing to the decode, so
  // it is ignored whole rather than validated against rules written for other
  // blocks. Everything past this point works from `blocks`.
  const blocks: Record<string, BlockEntry> = {};
  for (const [name, entry] of Object.entries(header.blocks)) {
    if (!BLOCK_SHAPES[name]) continue;
    validateCommonKeys(name, entry, blockStart, totalLength);
    blocks[name] = entry as BlockEntry;
  }
  validateManifest(header, blocks);

  const resolved = resolveBlocks(blocks, blockStart);
  const block = (name: string): ResolvedBlock => resolved[name];

  const componentOffset = (p: ResolvedBlock, c: number): number =>
    p.base + c * p.count * BYTES_PER_ELEMENT[p.dtype];

  const readU8 = (p: ResolvedBlock, c: number) => new Uint8Array(file, componentOffset(p, c), p.count);
  const readU16 = (p: ResolvedBlock, c: number) => new Uint16Array(file, componentOffset(p, c), p.count);
  const readUint = (p: ResolvedBlock, c: number): Uint8Array | Uint16Array =>
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

  // ── position, scale, opacity ────────────────────────────────────────
  // One decode, `min[c] + q * (max[c] - min[c]) / (levels - 1)`, over the
  // component index of whichever block is being read. Nothing distinguishes
  // the single-component block from the three-component ones, which is why
  // opacity's bounds are one-element arrays like everybody else's.
  const dequantise = (p: ResolvedBlock, levels: number, out: Float32Array[]) => {
    for (let c = 0; c < out.length; c++) {
      const q = levels === POSITION_LEVELS ? readU16(p, c) : readU8(p, c);
      const lo = p.min![c];
      const step = (p.max![c] - lo) / (levels - 1);
      const dst = out[c];
      for (let i = 0; i < numSplats; i++) dst[i] = lo + q[i] * step;
    }
  };

  dequantise(block('position'), POSITION_LEVELS, [storage_x, storage_y, storage_z]);
  // Log-space per-axis standard deviations, which is the space the engine
  // consumes, so the decode is a multiply-add and nothing pays a `log` per
  // gaussian.
  dequantise(block('scale'), BYTE_LEVELS, [storage_scale_0, storage_scale_1, storage_scale_2]);
  // The LOGIT, not an alpha. Same trade as scale.
  dequantise(block('opacity'), BYTE_LEVELS, [storage_opacity]);

  // ── rotation ────────────────────────────────────────────────────────
  // Three components, not four: the writer negated any quaternion with w < 0
  // before quantising, which is what makes w recoverable from xyz. Stored
  // xyzw; the engine wants wxyz, so rot_0 is w.
  {
    const p = block('rotation');
    const qx = readU8(p, 0);
    const qy = readU8(p, 1);
    const qz = readU8(p, 2);
    for (let i = 0; i < numSplats; i++) {
      const x = (qx[i] / 255) * 2 - 1;
      const y = (qy[i] / 255) * 2 - 1;
      const z = (qz[i] / 255) * 2 - 1;
      storage_rot_0[i] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
      storage_rot_1[i] = x;
      storage_rot_2[i] = y;
      storage_rot_3[i] = z;
    }
  }

  // ── colour ──────────────────────────────────────────────────────────
  // The spherical-harmonic DC term. There is no higher band; characters are
  // lit flat.
  {
    const p = block('color');
    const dcOut = [storage_f_dc_0, storage_f_dc_1, storage_f_dc_2];
    for (let c = 0; c < 3; c++) {
      const src = readU8(p, c);
      const dst = dcOut[c];
      for (let i = 0; i < numSplats; i++) dst[i] = (src[i] / 255 - 0.5) / SH_C0;
    }
  }

  // ── skinning ────────────────────────────────────────────────────────
  let boneIndices: Uint16Array | undefined;
  let boneWeights: Float32Array | undefined;
  if (resolved.boneIndex) {
    const idxBlock = block('boneIndex');
    const wBlock = block('boneWeight');
    const palette = idxBlock.palette!;
    const K = idxBlock.components;
    boneIndices = new Uint16Array(numSplats * K);
    boneWeights = new Float32Array(numSplats * K);

    // The palette is what lets a narrow character on a 441-bone rig store its
    // indices in a byte. It is required even when it is the identity mapping,
    // so there is only ever one index space to read.
    for (let j = 0; j < K; j++) {
      const src = readUint(idxBlock, j);
      for (let i = 0; i < numSplats; i++) {
        const q = src[i];
        if (q >= palette.length) {
          fail(
            'InconsistentHeader',
            `block 'boneIndex': gaussian ${i} slot ${j} stores index ${q}, ` +
              `outside its ${palette.length}-entry palette`,
          );
        }
        boneIndices[i * K + j] = palette[q];
      }
    }

    // K - 1 slots are stored; the last is whatever is left, which is what makes
    // the decoded influences sum to exactly 1. The writer allocated the K byte
    // weights by largest remainder so they total 255, so summing the BYTES and
    // dividing once evaluates `1 - sum(q / 255)` with no rounding drift.
    const stored = new Uint32Array(numSplats);
    for (let j = 0; j < wBlock.components; j++) {
      const src = readU8(wBlock, j);
      for (let i = 0; i < numSplats; i++) {
        boneWeights[i * K + j] = src[i] / 255;
        stored[i] += src[i];
      }
    }
    for (let i = 0; i < numSplats; i++) {
      boneWeights[i * K + (K - 1)] = Math.max(0, 255 - stored[i]) / 255;
    }
  }

  // ── joints ──────────────────────────────────────────────────────────
  // Rest positions only - no rotations, no names, no hierarchy. Row i is the
  // rest position of global rig bone i, the same index space a decoded
  // `boneIndex` lands in. Component-major like every other block.
  let jointsArray: Float32Array | undefined;
  let rigBoneCount = 0;
  if (resolved.joints) {
    const p = block('joints');
    rigBoneCount = p.count;
    jointsArray = new Float32Array(p.count * 3);
    for (let c = 0; c < 3; c++) {
      const src = new Float32Array(file, componentOffset(p, c), p.count);
      for (let i = 0; i < p.count; i++) jointsArray[i * 3 + c] = src[i];
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

  const result: DecodedBundle = {
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
    // This format carries no animation. Clips are separate files, registered
    // separately; the fields exist so every version hands back one shape.
    animationArray: null,
    animNumFrames: 0,
    animNumBones: 0,
    jointsArray: jointsArray ?? null,
    rigBoneCount,
    // Version 1 means corrected. There is no field to read and no receipt to
    // find, and a reader is forbidden from looking for one.
    corrected: true,
    // Always. The corrections are baked into the gaussians AND into the joints
    // block, so this rest is the character's own and the two agree.
    bundledRestIsPerCharacter: true,
  };

  return { result, transferables };
}

export { decodeV1 };
