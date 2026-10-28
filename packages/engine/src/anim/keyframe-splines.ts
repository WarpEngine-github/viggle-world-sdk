import { Quat, Vec3 } from 'playcanvas';

import type { SkeletalKeyframeEntry } from '../animation';

import { toRestRelative } from './rest-relative';
import type { BonePose, RestPose } from './rest-relative';
import { CubicSpline } from './spline';

/**
 * Per-bone curve as {@link buildArmatureKeyframes} emits it. Flat, not per-key
 * objects: at 441 bones x 495 keys that allocation dominates the build.
 */
export interface ArmatureKeyframeEntry {
  /** Frame time per key, ascending. `length` is the key count. */
  frames: Float32Array;
  /** `[x,y,z]` per key. */
  positions: Float32Array;
  /** `[x,y,z,w]` per key, in the hemisphere the clip authored. */
  rotations: Float32Array;
  /** `[x,y,z]` per key. */
  scales: Float32Array;
  /** Null below two keys, or when the bone is dense enough not to need one. */
  spline: CubicSpline | null;
}

/**
 * True when no two consecutive keys are more than a frame apart. The epsilon
 * covers non-integral frame stamps; judging a dense bone sparse only costs a
 * spline, which is the safe direction to be wrong in.
 */
function isDenselyKeyed(frames: Float32Array): boolean {
  for (let k = 1; k < frames.length; k++) {
    if (frames[k] - frames[k - 1] > 1.0001) return false;
  }
  return true;
}

/**
 * Build the per-bone keyframe array an armature samples from at playback time.
 *
 * For each bone in `libraryKeyframes` whose index is below `numBones`:
 *  1. convert every pose into the bone's rest-relative space (so playback can
 *     blend a delta on top of the rest pose), and
 *  2. build the cubic spline that interpolates them, unless the bone is keyed
 *     densely enough not to need one.
 *
 * Result is a sparse array of length `numBones`; bones not referenced by the
 * source map stay `null` and fall back to rest pose at evaluation time.
 *
 * If `restPose.positions` is empty (rig has no rest data), keys are emitted
 * unchanged - the rest-relative conversion no-ops.
 */
export function buildArmatureKeyframes(
  libraryKeyframes: Map<number, SkeletalKeyframeEntry>,
  numFrames: number,
  numBones: number,
  restPose: RestPose,
  looping: boolean,
  translationMask?: Uint8Array,
  bones?: ArrayLike<number> | null,
): Array<ArmatureKeyframeEntry | null> {
  const out: Array<ArmatureKeyframeEntry | null> = Array.from({ length: numBones }, () => null);
  let only: Uint8Array | null = null;
  if (bones) {
    only = new Uint8Array(numBones);
    for (let k = 0; k < bones.length; k++) only[bones[k]] = 1;
  }
  // Reused for every key, so the build allocates no per-key object.
  const key: BonePose = { position: new Vec3(), rotation: new Quat(), scale: new Vec3() };
  const scratch: BonePose = { position: new Vec3(), rotation: new Quat(), scale: new Vec3() };

  libraryKeyframes.forEach((entry, boneIdx) => {
    if (boneIdx >= numBones || (only && !only[boneIdx])) return;
    // A `0` in the mask means the clip carries no MOTION for this bone, only a
    // declaration of the source rig's rest: hold the position delta at zero so
    // `fromRestRelative` reproduces the armature's own rest translation, i.e.
    // THIS character's bone length, rather than the source rig's. Absent mask =
    // every bone animates, which is what a pre-mask clip means.
    //
    // Only when there IS a rest to inherit: with no rest data `toRestRelative`
    // passes the pose through, so a zeroed position would not decode back to a
    // rest translation, it would collapse the bone onto its parent.
    const inheritsRestPosition = translationMask !== undefined
      && translationMask[boneIdx] === 0
      && boneIdx < restPose.positions.length;

    // Shared with the store: already ascending, and read-only.
    const { frames } = entry;
    const n = frames.length;
    // Safe to skip when dense: the spline feeds position and scale only
    // (rotation is slerped regardless) and playback clamps it to the
    // neighbouring keys, so over one frame it cannot deviate perceptibly.
    const wantsSpline = n > 1 && !isDenselyKeyed(frames);
    const positions = new Float32Array(n * 3);
    const rotations = new Float32Array(n * 4);
    const scales = new Float32Array(n * 3);
    // eslint-disable-next-line unicorn/no-new-array
    const times: number[] = wantsSpline ? new Array(n) : [];
    // eslint-disable-next-line unicorn/no-new-array
    const points: number[] = wantsSpline ? new Array(n * 10) : [];
    let prevX = 0;
    let prevY = 0;
    let prevZ = 0;
    let prevW = 0;

    for (let k = 0; k < n; k++) {
      const i3 = k * 3;
      const i4 = k * 4;
      key.position.set(entry.positions[i3], entry.positions[i3 + 1], entry.positions[i3 + 2]);
      key.rotation.set(entry.rotations[i4], entry.rotations[i4 + 1], entry.rotations[i4 + 2], entry.rotations[i4 + 3]);
      key.scale.set(entry.scales[i3], entry.scales[i3 + 1], entry.scales[i3 + 2]);
      toRestRelative(boneIdx, key, restPose, scratch);
      if (inheritsRestPosition) scratch.position.set(0, 0, 0);

      const { position: sp, rotation: sr, scale: ss } = scratch;
      positions[i3] = sp.x; positions[i3 + 1] = sp.y; positions[i3 + 2] = sp.z;
      rotations[i4] = sr.x; rotations[i4 + 1] = sr.y;
      rotations[i4 + 2] = sr.z; rotations[i4 + 3] = sr.w;
      scales[i3] = ss.x; scales[i3 + 1] = ss.y; scales[i3 + 2] = ss.z;

      if (wantsSpline) {
        times[k] = frames[k];
        // Short arc: unflipped, the spline takes the long way round wherever a
        // sample changed hemisphere. Compared as authored, not as flipped.
        const flip = k > 0 && prevX * sr.x + prevY * sr.y + prevZ * sr.z + prevW * sr.w < 0;
        const o = k * 10;
        points[o] = sp.x; points[o + 1] = sp.y; points[o + 2] = sp.z;
        points[o + 3] = flip ? -sr.x : sr.x;
        points[o + 4] = flip ? -sr.y : sr.y;
        points[o + 5] = flip ? -sr.z : sr.z;
        points[o + 6] = flip ? -sr.w : sr.w;
        points[o + 7] = ss.x; points[o + 8] = ss.y; points[o + 9] = ss.z;
        prevX = sr.x; prevY = sr.y; prevZ = sr.z; prevW = sr.w;
      }
    }

    let spline: CubicSpline | null = null;
    if (wantsSpline) {
      spline = looping
        ? CubicSpline.fromPointsLooping(numFrames, times, points, 1)
        : CubicSpline.fromPoints(times, points, 1);
    }
    out[boneIdx] = { frames, positions, rotations, scales, spline };
  });

  return out;
}
