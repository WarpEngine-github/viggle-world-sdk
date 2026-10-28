import { Quat, Vec3 } from 'playcanvas';

/**
 * Per-bone local TRS for a whole rig. The seam between
 * {@link AnimationPlayer} (which writes pose values) and
 * {@link Skeleton} (which composes them into world transforms).
 *
 * Three parallel arrays of length `numBones`. Values live in armature-local
 * bone space - absolute, not rest-relative. Allocation happens once;
 * AnimationPlayer mutates entries in place each frame.
 *
 * @group Characters & Animation
 */
export class Pose {
  readonly positions: Vec3[];
  readonly rotations: Quat[];
  readonly scales: Vec3[];

  constructor(numBones: number) {
    this.positions = Array.from({ length: numBones }, () => new Vec3());
    this.rotations = Array.from({ length: numBones }, () => new Quat());
    this.scales = Array.from({ length: numBones }, () => new Vec3(1, 1, 1));
  }

  get numBones(): number {
    return this.positions.length;
  }

  /** Copy every bone from `other` into this pose. */
  copyFrom(other: Pose): void {
    const n = this.positions.length;
    for (let i = 0; i < n; i++) {
      this.positions[i].copy(other.positions[i]);
      this.rotations[i].copy(other.rotations[i]);
      this.scales[i].copy(other.scales[i]);
    }
  }

  /**
   * Reset every bone to the bind-pose values held in `bindT` (flat
   * `[x,y,z]*numBones`) and `bindR` (flat `[x,y,z,w]*numBones`). Scales reset
   * to unit.
   */
  setToBind(bindT: Float32Array, bindR: Float32Array): void {
    const n = this.positions.length;
    for (let i = 0; i < n; i++) {
      this.positions[i].set(bindT[i * 3], bindT[i * 3 + 1], bindT[i * 3 + 2]);
      this.rotations[i].set(bindR[i * 4], bindR[i * 4 + 1], bindR[i * 4 + 2], bindR[i * 4 + 3]);
      this.scales[i].set(1, 1, 1);
    }
  }
}
