/**
 * Interleaved character-splat decoder - the payload half of `VFCHARB1`.
 *
 * MOVED, NOT REWRITTEN. This is `binary-gsplat-worker.ts`'s `parseBinaryGsplat`
 * verbatim, lifted out of the worker glue so the legacy readers sit behind one
 * door (`../index.ts`). It decodes files that are already in storage and will
 * stay there - there is no backfill - so any behaviour change here is a
 * regression, and it keeps its own vocabulary: this container talks about
 * CHUNKS, where the planar one talks about PLANES and `VIGGCHAR` talks about
 * BLOCKS.
 *
 * `version` here numbers one global bundle lineage across both legacy magics
 * (1 = fp32 interleaved, 2 = fp16 interleaved, 3 = planar), which is exactly the
 * accretion `VIGGCHAR` was shaped to end.
 */

/** The interleaved container: per-splat records, v1 (fp32) and v2 (fp16). */
const CHARACTER_BUNDLE_MAGIC = 'VFCHARB1';

/**
 * First `version` of the PLANAR container, which the interleaved reader below
 * must never attempt. `version` numbers one global bundle lineage across both
 * magics (1 = fp32 interleaved, 2 = fp16 interleaved, 3 = planar), so
 * `version >= 3` under the interleaved magic is a mislabelled file, not a
 * newer interleaved one - and `encoding.precision === 'fp16'` would happily
 * accept it and decode planes as records.
 */
const FIRST_PLANAR_VERSION = 3;

const SH_C0 = 0.28209479177387814;

interface BundleChunk {
  offset: number;
  length: number;
  stride?: number;
}

interface AssetHeader {
  format: string;
  version: number;
  numSplats: number;
  numBones: number;
  bounds: { min: number[]; max: number[] };
  encoding?: {
    /**
     * Bundle-wide field precision. `'fp16'` means pos/scale/rot/opacity and
     * the weights chunk's per-splat weights are stored as IEEE 754 half-floats
     * (read 2 bytes / value, expanded to Float32 on parse). `'fp32'` or
     * missing = legacy raw float32 (the v1 layout). RGB stays uint8 and bone
     * indices stay uint16 either way. Bumps the file size by ~42%; expanding
     * to Float32 here means GPU memory is unchanged.
     */
    precision?: 'fp16' | 'fp32';
    weights?: { topK: number; indexType: string; weightType: string; stride: number };
    color?: { format: string; levels: number };
  };
  chunks: {
    splats: BundleChunk;
    weights?: BundleChunk;
    joints?: BundleChunk;
    animation?: BundleChunk;
  };
  animation?: {
    format: string;
    numFrames: number;
    numBones: number;
    shape: number[];
    stride: number;
  };
  joints?: {
    count: number;
    format: string;
    stride: number;
  };
}

// IEEE 754 half-float → single-float, branch-light. Used to expand the v2
// quantized fields back into the Float32Arrays the GPU pipeline expects.
// Subnormals are handled correctly (rare in our data - opacity 0 / unused
// channels). Speed matters: this runs numSplats × ~12 times per asset load.
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
      // Subnormal - normalize the mantissa into f32 representation.
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

function parseBinaryGsplat(bundleBuffer: ArrayBuffer) {
  if (bundleBuffer.byteLength < 12) {
    throw new Error('Character bundle too small');
  }

  const bundleView = new DataView(bundleBuffer);
  const magic = new TextDecoder().decode(new Uint8Array(bundleBuffer, 0, CHARACTER_BUNDLE_MAGIC.length));
  if (magic !== CHARACTER_BUNDLE_MAGIC) {
    throw new Error(`Invalid character bundle magic: ${magic}`);
  }

  const headerLength = bundleView.getUint32(CHARACTER_BUNDLE_MAGIC.length, true);
  const headerStart = CHARACTER_BUNDLE_MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bundleBuffer.byteLength) {
    throw new Error('Character bundle header length out of range');
  }

  const headerText = new TextDecoder().decode(new Uint8Array(bundleBuffer, headerStart, headerLength));
  const header: AssetHeader = JSON.parse(headerText);
  if (header.format !== 'vfa3d-charbin') {
    throw new Error(`Unsupported character bundle format: ${header.format}`);
  }
  // Both `format` and `version` are checked, not just one: this reader used to
  // decide layout from `encoding.precision` alone, which cannot tell a planar
  // payload from an interleaved fp16 one. A file that gets this far is claiming
  // to be interleaved under two independent fields.
  if (header.version >= FIRST_PLANAR_VERSION) {
    throw new Error(
      `Character bundle declares version ${header.version} under the ${CHARACTER_BUNDLE_MAGIC} ` +
        'magic; planar payloads must be published as VFCHARB2',
    );
  }

  const payloadStart = headerEnd;
  const chunkBuffer = (chunk: BundleChunk | undefined): ArrayBuffer | null => {
    if (!chunk) return null;
    const start = payloadStart + chunk.offset;
    const end = start + chunk.length;
    if (start < payloadStart || end > bundleBuffer.byteLength || start > end) {
      throw new Error('Character bundle chunk range out of bounds');
    }
    return bundleBuffer.slice(start, end);
  };

  const numSplats = header.numSplats;

  // Parse splats
  const splatsBuffer = chunkBuffer(header.chunks.splats);
  if (!splatsBuffer) throw new Error('Missing splats chunk');
  const splatData = new DataView(splatsBuffer);

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

  const isFp16 = header.encoding?.precision === 'fp16';
  let offset = 0;
  if (isFp16) {
    // v2 layout: pos/scale/rot/opacity stored as fp16. RGB+pad still 4B, no
    // padding after opacity. Per-splat stride = 6 + 6 + 8 + 4 + 2 = 26 B.
    for (let i = 0; i < numSplats; i++) {
      storage_x[i] = f16ToF32(splatData.getUint16(offset + 0, true));
      storage_y[i] = f16ToF32(splatData.getUint16(offset + 2, true));
      storage_z[i] = f16ToF32(splatData.getUint16(offset + 4, true));
      offset += 6;

      const scaleX = f16ToF32(splatData.getUint16(offset + 0, true));
      const scaleY = f16ToF32(splatData.getUint16(offset + 2, true));
      const scaleZ = f16ToF32(splatData.getUint16(offset + 4, true));
      storage_scale_0[i] = Math.log(Math.max(scaleX, 1e-8));
      storage_scale_1[i] = Math.log(Math.max(scaleY, 1e-8));
      storage_scale_2[i] = Math.log(Math.max(scaleZ, 1e-8));
      offset += 6;

      const qx = f16ToF32(splatData.getUint16(offset + 0, true));
      const qy = f16ToF32(splatData.getUint16(offset + 2, true));
      const qz = f16ToF32(splatData.getUint16(offset + 4, true));
      const qw = f16ToF32(splatData.getUint16(offset + 6, true));
      storage_rot_0[i] = qw;
      storage_rot_1[i] = qx;
      storage_rot_2[i] = qy;
      storage_rot_3[i] = qz;
      offset += 8;

      const r = splatData.getUint8(offset + 0);
      const g = splatData.getUint8(offset + 1);
      const b = splatData.getUint8(offset + 2);
      storage_f_dc_0[i] = (r / 255 - 0.5) / SH_C0;
      storage_f_dc_1[i] = (g / 255 - 0.5) / SH_C0;
      storage_f_dc_2[i] = (b / 255 - 0.5) / SH_C0;
      offset += 4;

      const opacity = f16ToF32(splatData.getUint16(offset + 0, true));
      const clampedOpacity = Math.max(0.0001, Math.min(0.9999, opacity));
      storage_opacity[i] = -Math.log(1 / clampedOpacity - 1);
      offset += 2;
    }
  } else {
    // v1 layout: all float32. Per-splat stride 48 B.
    for (let i = 0; i < numSplats; i++) {
      storage_x[i] = splatData.getFloat32(offset + 0, true);
      storage_y[i] = splatData.getFloat32(offset + 4, true);
      storage_z[i] = splatData.getFloat32(offset + 8, true);
      offset += 12;

      const scaleX = splatData.getFloat32(offset + 0, true);
      const scaleY = splatData.getFloat32(offset + 4, true);
      const scaleZ = splatData.getFloat32(offset + 8, true);
      storage_scale_0[i] = Math.log(Math.max(scaleX, 1e-8));
      storage_scale_1[i] = Math.log(Math.max(scaleY, 1e-8));
      storage_scale_2[i] = Math.log(Math.max(scaleZ, 1e-8));
      offset += 12;

      const qx = splatData.getFloat32(offset + 0, true);
      const qy = splatData.getFloat32(offset + 4, true);
      const qz = splatData.getFloat32(offset + 8, true);
      const qw = splatData.getFloat32(offset + 12, true);
      storage_rot_0[i] = qw;
      storage_rot_1[i] = qx;
      storage_rot_2[i] = qy;
      storage_rot_3[i] = qz;
      offset += 16;

      const r = splatData.getUint8(offset + 0);
      const g = splatData.getUint8(offset + 1);
      const b = splatData.getUint8(offset + 2);
      storage_f_dc_0[i] = (r / 255 - 0.5) / SH_C0;
      storage_f_dc_1[i] = (g / 255 - 0.5) / SH_C0;
      storage_f_dc_2[i] = (b / 255 - 0.5) / SH_C0;
      offset += 4;

      const opacity = splatData.getFloat32(offset + 0, true);
      const clampedOpacity = Math.max(0.0001, Math.min(0.9999, opacity));
      storage_opacity[i] = -Math.log(1 / clampedOpacity - 1);
      offset += 4;
    }
  }

  // Parse weights
  let boneIndices: Uint16Array | undefined;
  let boneWeights: Float32Array | undefined;
  const weightsBuffer = chunkBuffer(header.chunks.weights);
  if (weightsBuffer) {
    const topK = Math.max(1, header.encoding?.weights?.topK ?? 4);
    const indexBytes = 2;
    // v1 stores per-splat weights as float32; v2 stores them as fp16. Indices
    // stay uint16 either way (capacity for the 441-bone full rig).
    const weightBytes = isFp16 ? 2 : 4;
    const weightsData = new DataView(weightsBuffer);
    boneIndices = new Uint16Array(numSplats * topK);
    boneWeights = new Float32Array(numSplats * topK);
    let wOffset = 0;
    for (let i = 0; i < numSplats; i++) {
      for (let j = 0; j < topK; j++) {
        boneIndices[i * topK + j] = weightsData.getUint16(wOffset + j * 2, true);
      }
      wOffset += topK * indexBytes;
      if (isFp16) {
        for (let j = 0; j < topK; j++) {
          boneWeights[i * topK + j] = f16ToF32(weightsData.getUint16(wOffset + j * 2, true));
        }
      } else {
        for (let j = 0; j < topK; j++) {
          boneWeights[i * topK + j] = weightsData.getFloat32(wOffset + j * 4, true);
        }
      }
      wOffset += topK * weightBytes;
    }
  }

  // Parse animation
  let animationArray: Float32Array | undefined;
  let animNumFrames = 0;
  let animNumBones = 0;
  if (header.animation && header.animation.numFrames > 0 && header.animation.numBones > 0) {
    const animationBuffer = chunkBuffer(header.chunks.animation);
    if (animationBuffer) {
      const FLOATS_PER_BONE = 16;
      animNumBones = header.animation.numBones;
      animNumFrames = header.animation.numFrames;
      const expectedSize = animNumFrames * animNumBones * FLOATS_PER_BONE * 4;
      if (animationBuffer.byteLength !== expectedSize) {
        const actualBoneCount = animationBuffer.byteLength / 4 / (animNumFrames * FLOATS_PER_BONE);
        if (Number.isInteger(actualBoneCount) && actualBoneCount > 0) {
          animNumBones = actualBoneCount;
        }
      }
      animationArray = new Float32Array(animationBuffer);
    }
  }

  // Parse joints
  let jointsArray: Float32Array | undefined;
  if (header.joints) {
    const jointsBuffer = chunkBuffer(header.chunks.joints);
    if (jointsBuffer) {
      const FLOATS_PER_JOINT = 3;
      const expectedJointsSize = header.joints.count * FLOATS_PER_JOINT * 4;
      if (jointsBuffer.byteLength === expectedJointsSize) {
        jointsArray = new Float32Array(jointsBuffer);
      }
    }
  }

  // Collect all transferable buffers
  const transferables: ArrayBuffer[] = [
    storage_x.buffer as ArrayBuffer, storage_y.buffer as ArrayBuffer, storage_z.buffer as ArrayBuffer,
    storage_scale_0.buffer as ArrayBuffer, storage_scale_1.buffer as ArrayBuffer, storage_scale_2.buffer as ArrayBuffer,
    storage_rot_0.buffer as ArrayBuffer, storage_rot_1.buffer as ArrayBuffer, storage_rot_2.buffer as ArrayBuffer, storage_rot_3.buffer as ArrayBuffer,
    storage_f_dc_0.buffer as ArrayBuffer, storage_f_dc_1.buffer as ArrayBuffer, storage_f_dc_2.buffer as ArrayBuffer,
    storage_opacity.buffer as ArrayBuffer,
  ];
  if (boneIndices) transferables.push(boneIndices.buffer as ArrayBuffer);
  if (boneWeights) transferables.push(boneWeights.buffer as ArrayBuffer);
  if (animationArray) transferables.push(animationArray.buffer as ArrayBuffer);
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
    animationArray: animationArray ?? null,
    animNumFrames,
    animNumBones,
    jointsArray: jointsArray ?? null,
  };

  return { result, transferables };
}

export { parseBinaryGsplat, CHARACTER_BUNDLE_MAGIC };
