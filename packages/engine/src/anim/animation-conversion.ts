import { Mat4, Quat, Vec3 } from 'playcanvas';

import { Animation } from '../animation';
import type { SkeletalKeyframeEntry } from '../animation';
import { getStripped1185Names } from '../loader/skeleton';
import type { SkeletonLibrary } from '../types';

const _mat = new Mat4();
const _pos = new Vec3();
const _rot = new Quat();
const _scale = new Vec3();

/** Frames to key, ascending: in-range `keyframeFrames` (duplicates kept), else every frame. */
function sourceFrames(animationData: Animation): Float32Array {
  const numFrames = animationData.numFrames;
  if (!animationData.keyframeFrames?.length) {
    const frames = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) frames[f] = f;
    return frames;
  }
  return Float32Array.from(animationData.keyframeFrames.filter((f) => f >= 0 && f < numFrames)).sort();
}

/** Decompose one bone's matrices at `frames` into flat keys. */
function decomposeBone(
  data: Float32Array,
  numBones: number,
  bone: number,
  frames: Float32Array,
): SkeletalKeyframeEntry {
  const n = frames.length;
  const positions = new Float32Array(n * 3);
  const rotations = new Float32Array(n * 4);
  const scales = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const offset = (frames[k] * numBones + bone) * 16;
    for (let i = 0; i < 16; i++) _mat.data[i] = data[offset + i];
    _mat.getTranslation(_pos);
    _mat.getScale(_scale);
    _rot.setFromMat4(_mat);
    _rot.normalize();
    positions[k * 3] = _pos.x; positions[k * 3 + 1] = _pos.y; positions[k * 3 + 2] = _pos.z;
    rotations[k * 4] = _rot.x; rotations[k * 4 + 1] = _rot.y;
    rotations[k * 4 + 2] = _rot.z; rotations[k * 4 + 3] = _rot.w;
    scales[k * 3] = _scale.x; scales[k * 3 + 1] = _scale.y; scales[k * 3 + 2] = _scale.z;
  }
  return { frames, positions, rotations, scales };
}

/**
 * Walk the raw 4×4 bone matrices stored in `animationData.data` and produce
 * the per-bone keys used at playback time.
 *
 * Idempotent - subsequent calls on the same `Animation` are no-ops (guarded
 * by `Animation.skeletalConverted`). {@link Animation.register} calls this
 * for you.
 *
 * Side effect: clears `animationData.data` once converted, since the raw
 * matrices are no longer needed and would otherwise hold ~16 floats per bone
 * per frame in memory for the lifetime of the animation.
 */
export function convertSkeletalAnimation(
  animationData: Animation,
  _skeletonLibrary?: SkeletonLibrary,
): void {
  if (animationData.skeletalConverted) return;

  if (animationData.numBones === 0 || animationData.numFrames === 0 || animationData.data.length === 0) {
    animationData.skeletalConverted = true;
    animationData.data = new Float32Array(0);
    return;
  }

  const store = animationData.skeletalStore ?? {
    keyframes: new Map<number, SkeletalKeyframeEntry>(),
    manualBones: new Set<number>(),
    source: 'imported',
  };
  animationData.skeletalStore = store;
  store.keyframes.clear();

  const frames = sourceFrames(animationData);
  for (let boneIdx = 0; boneIdx < animationData.numBones; boneIdx++) {
    store.keyframes.set(boneIdx, decomposeBone(animationData.data, animationData.numBones, boneIdx, frames));
  }

  animationData.skeletalConverted = true;
  animationData.data = new Float32Array(0);
}

/**
 * Return a view of `animationData` remapped to the target armature's bone
 * count, handling rig mismatches (e.g. a 1185-bone source animation played on
 * an 86-bone body rig). Target bones with no matching source bone stay at
 * rest pose during playback.
 *
 * Result is cached on the input via `Animation.filteredForBones`, so repeated
 * calls for the same target bone count reuse the filtered copy.
 */
export function filterAnimationForArmature(
  animationData: Animation,
  targetBoneCount: number,
  skeletonLibrary: SkeletonLibrary,
): Animation {
  const cacheMap = animationData.filteredForBones;
  const cached = cacheMap?.get(targetBoneCount);
  if (cached) return cached;

  // Resolve target names from skeleton library (86-bone std male or 441-bone full rig).
  let targetNames: string[] | undefined;
  if (targetBoneCount === skeletonLibrary?.boneNames?.length) {
    targetNames = skeletonLibrary.boneNames;
  } else if (targetBoneCount === skeletonLibrary?.boneNames441?.length) {
    targetNames = skeletonLibrary.boneNames441;
  }
  if (!targetNames) return animationData;

  // Resolve source names by bone count: full 1185, stripped (1185 minus
  // facial), 441, or 86.
  let sourceNames: string[] | undefined;
  const fullNames = skeletonLibrary.skeleton1185Names;
  if (fullNames && animationData.numBones === fullNames.length) {
    sourceNames = fullNames;
  } else if (animationData.numBones === skeletonLibrary.boneNames441?.length) {
    sourceNames = skeletonLibrary.boneNames441;
  } else if (animationData.numBones === skeletonLibrary.boneNames?.length) {
    sourceNames = skeletonLibrary.boneNames;
  } else {
    const stripped = getStripped1185Names(skeletonLibrary);
    if (stripped && stripped.length === animationData.numBones) sourceNames = stripped;
  }
  if (!sourceNames) return animationData;

  // Build target → source remap (-1 when target has no matching source bone).
  const sourceByName = new Map<string, number>();
  sourceNames.forEach((n, i) => sourceByName.set(n, i));
  const mapIndices = new Int32Array(targetBoneCount);
  let identity = targetBoneCount === sourceNames.length;
  for (let i = 0; i < targetBoneCount; i++) {
    const s = sourceByName.get(targetNames[i]);
    mapIndices[i] = s === undefined ? -1 : s;
    if (identity && mapIndices[i] !== i) identity = false;
  }
  if (identity) {
    const cache = cacheMap ?? new Map<number, Animation>();
    cache.set(targetBoneCount, animationData);
    animationData.filteredForBones = cache;
    return animationData;
  }

  // Emit pre-converted output: only mapped target bones get keyframe entries.
  // Unmapped bones stay at rest pose at playback (see getAnimSample fallback).
  const numFrames = animationData.numFrames;
  const filtered = new Animation(new Float32Array(0), numFrames, targetBoneCount);
  const keyframes = new Map<number, SkeletalKeyframeEntry>();

  // Carry the translation mask across the bone remap. It is indexed by bone, so
  // it has to follow the same target->source mapping as the keyframes; losing
  // it here would silently reinstate the source rig's bone lengths. Target bones
  // with no source bone stay 0 - they have no keyframes either, so playback
  // falls back to rest regardless.
  if (animationData.translationMask) {
    const sourceMask = animationData.translationMask;
    const targetMask = new Uint8Array(targetBoneCount);
    for (let i = 0; i < targetBoneCount; i++) {
      const srcIdx = mapIndices[i];
      if (srcIdx >= 0) targetMask[i] = sourceMask[srcIdx];
    }
    filtered.translationMask = targetMask;
  }

  if (animationData.data.length === 0) {
    // Source is already converted: its entries are read-only, so share them.
    const sourceStore = animationData.skeletalStore;
    if (sourceStore?.keyframes) {
      for (let i = 0; i < targetBoneCount; i++) {
        const srcIdx = mapIndices[i];
        if (srcIdx < 0) continue;
        const entry = sourceStore.keyframes.get(srcIdx);
        if (entry?.frames.length) keyframes.set(i, entry);
      }
    }
  } else {
    // Source is raw matrices - convert the mapped target bones only.
    const frames = sourceFrames(animationData);
    for (let i = 0; i < targetBoneCount; i++) {
      const srcIdx = mapIndices[i];
      if (srcIdx < 0) continue;
      keyframes.set(i, decomposeBone(animationData.data, animationData.numBones, srcIdx, frames));
    }
  }

  filtered.skeletalConverted = true;
  filtered.skeletalStore = { keyframes, manualBones: new Set<number>(), source: 'imported' };

  const cache = cacheMap ?? new Map<number, Animation>();
  cache.set(targetBoneCount, filtered);
  animationData.filteredForBones = cache;
  return filtered;
}
