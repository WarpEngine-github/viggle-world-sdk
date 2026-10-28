/**
 * Splat cloud -> {@link ProxyMeshInput}.
 *
 * Three conversions the voxelizer deliberately does NOT do for you, because
 * doing them would give a pure geometry module opinions about our container
 * format:
 *
 * 1. **De-interleave.** `GSplatData` keeps x, y and z as three columns; the
 *    voxelizer wants one `[x,y,z]` stream, because that is what every other
 *    mesh pipeline in the world wants.
 * 2. **Sigmoid the opacity.** `.vsplat` stores the LOGIT. Thresholding a logit
 *    against 0.2 keeps everything down to alpha 0.55 - the opposite of what
 *    the knob is for, and it fails silently by producing a mesh that is merely
 *    a bit too fat.
 * 3. **Remap the bone indices.** A bundle's weights are authored against the
 *    SOURCE rig (often 1185 or 441 bones); the armature the proxy will be
 *    skinned by is usually the 86-bone body rig. `buildSourceBoneRemap` is the
 *    same mapping `initializeSplatBoneMapping` applies to the GPU bone
 *    textures, so the proxy and the splats end up following the same bones.
 *
 * Internal. `SplatRelight` is the consumer; the dev pages import it directly.
 */

import type { Armature } from '../armature';
import type { Scene } from '../scene';
import { buildSourceBoneRemap } from '../splat/bone-binding';
import type { Splat } from '../splat/splat';

import type { ProxyMeshInput } from './voxelizer';
import { alphaFromLogits } from './voxelizer';

/** Influences the voxelizer reads per splat. */
const INFLUENCES = 4;

/**
 * Pull the rest positions, alpha and (when the splat is skinned) armature-space
 * bone influences out of a loaded splat.
 *
 * Positions come out in BIND space - the space `Skeleton.inverseBindPose`
 * undoes - so a mesh built from them can be handed straight to
 * `ArmatureSkinAdapter`.
 *
 * Allocates the whole input. Call it once per character, not once per rebuild:
 * the voxel knobs are what move while tuning and none of this depends on them.
 */
export function proxyInputFromSplat(
  splat: Splat,
  armature: Armature | null,
  scene: Scene,
): ProxyMeshInput {
  const data = splat.splatData;
  const n = splat.numSplats;

  const x = data.getProp('x') as Float32Array;
  const y = data.getProp('y') as Float32Array;
  const z = data.getProp('z') as Float32Array;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = x[i];
    positions[i * 3 + 1] = y[i];
    positions[i * 3 + 2] = z[i];
  }

  const logits = data.getProp('opacity') as Float32Array | null;
  const opacities = logits ? alphaFromLogits(logits) : undefined;

  const weights = splat.splatWeights;
  if (!weights || !armature) return { positions, opacities };

  const numBones = armature.numBones;
  const remap = buildSourceBoneRemap(splat, numBones, scene.skeletonLibrary);
  // The asset can carry more than four influences per splat; the first four
  // are the heaviest, which is the same slice the GPU bone textures take.
  const srcStride = Math.max(1, Math.floor(weights.indices.length / n));
  const take = Math.min(srcStride, INFLUENCES);

  const boneIndices = new Uint32Array(n * INFLUENCES);
  const boneWeights = new Float32Array(n * INFLUENCES);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < take; j++) {
      const raw = weights.indices[i * srcStride + j];
      const target = remap ? (remap[raw] ?? -1) : raw;
      // Out of range means the influence has no home on this rig - typically a
      // facial bone on a body-only armature. Weight 0 leaves the vertex to its
      // other influences instead of dragging it to the root.
      if (target < 0 || target >= numBones) continue;
      boneIndices[i * INFLUENCES + j] = target;
      boneWeights[i * INFLUENCES + j] = weights.weights[i * srcStride + j];
    }
  }

  return { positions, opacities, boneIndices, boneWeights };
}
