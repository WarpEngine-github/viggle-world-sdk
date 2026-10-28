import { Quat } from 'playcanvas';
import type { Vec3 } from 'playcanvas';

/**
 * Rest pose for a rig, stored as parallel arrays indexed by bone. An empty
 * `positions` array marks an uninitialized rest pose - the rest-relative
 * conversion functions pass poses through unchanged in that case.
 */
export interface RestPose {
  positions: Vec3[];
  rotations: Quat[];
  scales: Vec3[];
}

/** A bone-space transform: position, rotation (as quaternion), and scale. */
export interface BonePose {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

const _conjScratch = new Quat();

/**
 * Express `pose` relative to the bone's rest transform. Writes the result
 * into `out`. Safe to call with `out === pose` (in-place).
 *
 * If `boneIndex` is out of range or `rest` is uninitialized, `pose` is copied
 * to `out` unchanged.
 */
export function toRestRelative(
  boneIndex: number,
  pose: BonePose,
  rest: RestPose,
  out: BonePose,
): void {
  if (boneIndex < 0 || boneIndex >= rest.positions.length) {
    if (out !== pose) {
      out.position.copy(pose.position);
      out.rotation.copy(pose.rotation);
      out.scale.copy(pose.scale);
    }
    return;
  }
  const restPos = rest.positions[boneIndex];
  const restRot = rest.rotations[boneIndex];
  const restScale = rest.scales[boneIndex];

  // out.position = pose.position - restPos
  out.position.sub2(pose.position, restPos);
  // out.rotation = conj(restRot) * pose.rotation
  _conjScratch.copy(restRot).conjugate();
  out.rotation.mul2(_conjScratch, pose.rotation);
  // out.scale = pose.scale / restScale (component-wise, guarding divide-by-zero)
  out.scale.set(
    restScale.x !== 0 ? pose.scale.x / restScale.x : pose.scale.x,
    restScale.y !== 0 ? pose.scale.y / restScale.y : pose.scale.y,
    restScale.z !== 0 ? pose.scale.z / restScale.z : pose.scale.z,
  );
}

/**
 * Inverse of {@link toRestRelative}: compose a rest-relative `delta` back into
 * an absolute bone pose. Writes the result into `out`. Safe to call with
 * `out === delta` (in-place).
 */
export function fromRestRelative(
  boneIndex: number,
  delta: BonePose,
  rest: RestPose,
  out: BonePose,
): void {
  if (boneIndex < 0 || boneIndex >= rest.positions.length) {
    if (out !== delta) {
      out.position.copy(delta.position);
      out.rotation.copy(delta.rotation);
      out.scale.copy(delta.scale);
    }
    return;
  }
  const restPos = rest.positions[boneIndex];
  const restRot = rest.rotations[boneIndex];
  const restScale = rest.scales[boneIndex];

  out.position.add2(restPos, delta.position);
  out.rotation.mul2(restRot, delta.rotation);
  out.scale.set(
    restScale.x * delta.scale.x,
    restScale.y * delta.scale.y,
    restScale.z * delta.scale.z,
  );
}
