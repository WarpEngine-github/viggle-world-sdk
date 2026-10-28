import { Mat4, Quat, Vec3 } from 'playcanvas';

/**
 * Walk the rig's rest pose to produce world-space bind-pose matrices, one per
 * bone. Parents are expected to come before their children in index order (the
 * skeleton library's bone arrays satisfy this).
 *
 * Returns `null` if any of the three arrays is missing - the armature's
 * `armatureData` carries them as optional fields.
 */
export function computeBindPoseTransforms(
  numBones: number,
  restTranslations: Float32Array,
  restRotations: Float32Array,
  parents: Int32Array,
): Mat4[] {
  const wt = Array.from({ length: numBones }, () => new Mat4());

  const tmpPos = new Vec3();
  const tmpRot = new Quat();
  const tmpScale = new Vec3(1, 1, 1);
  const tmpLocal = new Mat4();

  for (let i = 0; i < numBones; i++) {
    tmpPos.set(restTranslations[i * 3], restTranslations[i * 3 + 1], restTranslations[i * 3 + 2]);
    tmpRot.set(restRotations[i * 4], restRotations[i * 4 + 1], restRotations[i * 4 + 2], restRotations[i * 4 + 3]);
    tmpLocal.setTRS(tmpPos, tmpRot, tmpScale);

    const pi = parents[i];
    if (pi >= 0 && pi < numBones) {
      wt[i].mul2(wt[pi], tmpLocal);
    } else {
      wt[i].copy(tmpLocal);
    }
  }
  return wt;
}

/**
 * Compute the inverse of each matrix in `bindPose`. Returns a new array; the
 * input is left untouched.
 */
export function invertBindPose(bindPose: Mat4[]): Mat4[] {
  return bindPose.map((m) => {
    const inv = new Mat4();
    inv.copy(m);
    inv.invert();
    return inv;
  });
}
