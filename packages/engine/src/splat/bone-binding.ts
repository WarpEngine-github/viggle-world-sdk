import { getStripped1185Names } from '../loader/skeleton';
import type { SkeletonLibrary } from '../types';

import type { Splat } from './splat';

/**
 * Build the source→target bone remap when the splat's `.bin` bundle was
 * authored against a wider skeleton than the armature uses (e.g. a 1185-bone
 * source on the 86-bone std-male rig, or a 441-bone full body+facial source
 * on the 86-bone body rig).
 *
 * Returns `null` when no remap is needed (source and target bone counts
 * match) or when the skeleton library doesn't carry enough naming metadata to
 * resolve the mapping. Unmapped bones in the result are `-1`, except facial
 * bones (`FACIAL_*`), which fall back to the `head` bone so the splats track
 * head motion rather than snapping to root.
 */
export function buildSourceBoneRemap(
  splat: Splat,
  numBones: number,
  skeletonLibrary: SkeletonLibrary | undefined,
): Int32Array | null {
  const sourceCount = splat.sourceBoneCount;
  if (!sourceCount || sourceCount === numBones) return null;
  if (!skeletonLibrary) return null;

  let targetNames: string[] | undefined;
  if (skeletonLibrary.boneNames?.length === numBones) targetNames = skeletonLibrary.boneNames;
  else if (skeletonLibrary.boneNames441?.length === numBones) targetNames = skeletonLibrary.boneNames441;
  if (!targetNames) return null;

  let sourceNames: string[] | undefined;
  const fullNames = skeletonLibrary.skeleton1185Names;
  if (fullNames && sourceCount === fullNames.length) {
    sourceNames = fullNames;
  } else if (fullNames && sourceCount === fullNames.length - 1 && fullNames[0] === 'joints_grp') {
    sourceNames = fullNames.slice(1);
  } else if (sourceCount === skeletonLibrary.boneNames441?.length) {
    sourceNames = skeletonLibrary.boneNames441;
  } else if (sourceCount === skeletonLibrary.boneNames?.length) {
    sourceNames = skeletonLibrary.boneNames;
  } else {
    const stripped = getStripped1185Names(skeletonLibrary);
    if (stripped && stripped.length === sourceCount) sourceNames = stripped;
  }
  if (!sourceNames) return null;

  const targetByName = new Map<string, number>();
  targetNames.forEach((n, i) => targetByName.set(n, i));

  // Fallback target for facial bones when target armature has no facial
  // bones (e.g. 86-bone std male rig loaded with a 441-bone full bin) -
  // facial splats track head motion rather than snapping to root.
  const facialFallback = targetByName.get('head') ?? -1;

  const remap = new Int32Array(sourceCount);
  for (let i = 0; i < sourceCount; i++) {
    const name = sourceNames[i];
    const t = targetByName.get(name);
    if (t !== undefined) {
      remap[i] = t;
    } else if (name.startsWith('FACIAL_')) {
      remap[i] = facialFallback;
    } else {
      remap[i] = -1;
    }
  }
  return remap;
}

/**
 * Allocate the splat's slice of the shared transform palette and rewrite its
 * bone-index texture so each splat's K influences point at the palette slots
 * the armature will write into.
 *
 * Splats with no resolvable target bone (typically facial influences on a
 * body-only rig that can't fall back to `head`) get weight 0 - they stay at
 * rest instead of snapping to bone 0.
 *
 * Returns the first palette index allocated for this splat's bone block.
 * Palette slot for bone `i` is always `firstIdx + i`.
 */
export function initializeSplatBoneMapping(
  splat: Splat,
  numBones: number,
  skeletonLibrary: SkeletonLibrary | undefined,
): number {
  const weights = splat.splatWeights;
  if (!weights) throw new Error('No weights data');

  const boneIndices = weights.indices;
  const boneWeights = weights.weights;
  const numSplats = boneIndices.length / 4;
  const palette = splat.transformPalette;
  const firstIdx = palette.alloc(numBones);

  if (!splat.boneIndicesTexture || !splat.boneWeightsTexture) {
    throw new Error('Bone textures not initialized');
  }

  const srcToTarget = buildSourceBoneRemap(splat, numBones, skeletonLibrary);

  const indicesData = splat.boneIndicesTexture.lock() as Float32Array;
  const weightsData = splat.boneWeightsTexture.lock() as Float32Array;

  for (let s = 0; s < numSplats; s++) {
    for (let j = 0; j < 4; j++) {
      const rawIdx = boneIndices[s * 4 + j];
      const targetIdx = srcToTarget ? srcToTarget[rawIdx] ?? -1 : rawIdx;
      if (targetIdx < 0 || targetIdx >= numBones) {
        indicesData[s * 4 + j] = firstIdx;
        weightsData[s * 4 + j] = 0;
      } else {
        indicesData[s * 4 + j] = firstIdx + targetIdx;
        weightsData[s * 4 + j] = boneWeights[s * 4 + j];
      }
    }
  }

  splat.boneIndicesTexture.unlock();
  splat.boneWeightsTexture.unlock();

  return firstIdx;
}

/**
 * Walk the splat's per-influence bone-index buffer and return the sorted list
 * of distinct bone indices it actually references. Used to skip palette writes
 * for bones no splat influences (e.g. a 441-bone rig where ~half the bones are
 * facial and the splat has no facial weights).
 *
 * Returns an empty `Int32Array` when the splat has no weights data - callers
 * treat that as "fall back to walking every bone."
 */
export function buildSplatBoneIndexList(splat: Splat, numBones: number): Int32Array {
  const weights = splat.splatWeights;
  if (!weights) return new Int32Array(0);
  const used = new Uint8Array(numBones);
  for (let i = 0; i < weights.indices.length; i++) {
    const idx = weights.indices[i] | 0;
    if (idx >= 0 && idx < numBones) used[idx] = 1;
  }
  let count = 0;
  for (let i = 0; i < numBones; i++) if (used[i]) count++;
  const list = new Int32Array(count);
  let j = 0;
  for (let i = 0; i < numBones; i++) if (used[i]) list[j++] = i;
  return list;
}
