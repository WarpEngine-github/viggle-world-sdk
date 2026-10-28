import { Mat4, Quat, Vec3 } from 'playcanvas';

import { computeBindPoseTransforms, invertBindPose } from '../anim/bind-pose';
import type { RestPose } from '../anim/rest-relative';
import type { ArmatureData } from '../types';

import type { Pose } from './pose';

/**
 * Rig data and skeletal math for one character. Owns the bone hierarchy, the
 * rest pose, and the (lazy) inverse-bind pose. Composes per-bone local
 * transforms into world-space matrices.
 *
 * Pure data + math - no PlayCanvas `Entity`, no `Scene`, no `Splat`. Safe to
 * construct in tests with a fixture rig.
 *
 * @group Characters & Animation
 */
export class Skeleton {
  readonly numBones: number;
  /** Parent bone index per bone. `-1` for root bones. */
  readonly parents: Int32Array;
  /** Flat bind-pose translations: `[x,y,z]*numBones`. */
  readonly bindT: Float32Array;
  /** Flat bind-pose rotations (quaternions): `[x,y,z,w]*numBones`. */
  readonly bindR: Float32Array;
  /** Rest pose as parallel `Vec3`/`Quat` arrays. */
  readonly restPose: RestPose;

  /**
   * Optional per-bone multiplier on the local rest translation, applied during
   * FK. A bone's local translation is its offset from its parent, so scaling
   * it lengthens that segment - this is the lengthening half of bone-length
   * scaling (see {@link computeBoneStretch}). It deliberately affects only the
   * translation, not the bone's orientation/scale, so it never inflates
   * Gaussian covariance and never compounds down a chain. `null` = unscaled
   * (the normal path). The bind/inverse-bind are intentionally NOT rescaled,
   * so the palette carries the standard→stretched delta.
   */
  lengthScale: Float32Array | null = null;

  private readonly _children: number[][];
  private readonly _rootBones: number[];
  private _inverseBindPose: Mat4[] | null = null;
  private readonly _tmpLocalMat = new Mat4();
  private readonly _tmpPos = new Vec3();
  private readonly _kfStack: number[] = [];

  constructor(armatureData: ArmatureData) {
    const { stdMaleRestTranslations: bt, stdMaleRestRotations: br, stdMaleParents: parents } = armatureData;
    if (!bt || !br || !parents) {
      throw new Error('Skeleton requires stdMaleRestTranslations/Rotations/Parents on ArmatureData');
    }

    this.numBones = armatureData.numBones;
    this.bindT = bt;
    this.bindR = br;
    this.parents = parents;

    // Hierarchy
    const children: number[][] = Array.from({ length: this.numBones }, () => []);
    const roots: number[] = [];
    for (let i = 0; i < this.numBones; i++) {
      const pi = parents[i];
      if (pi >= 0 && pi < this.numBones) {
        children[pi].push(i);
      } else {
        roots.push(i);
      }
    }
    if (roots.length === 0) roots.push(0);
    this._children = children;
    this._rootBones = roots;

    // Rest pose (decomposed bind for rest-relative animation evaluation).
    const positions: Vec3[] = [];
    const rotations: Quat[] = [];
    const scales: Vec3[] = [];
    for (let i = 0; i < this.numBones; i++) {
      positions.push(new Vec3(bt[i * 3], bt[i * 3 + 1], bt[i * 3 + 2]));
      rotations.push(new Quat(br[i * 4], br[i * 4 + 1], br[i * 4 + 2], br[i * 4 + 3]));
      scales.push(new Vec3(1, 1, 1));
    }
    this.restPose = { positions, rotations, scales };
  }

  /**
   * World-space inverse-bind pose, one matrix per bone. Lazy - bind pose is
   * only needed once splat skinning starts pushing transforms.
   */
  get inverseBindPose(): Mat4[] {
    if (!this._inverseBindPose) {
      const bindPose = computeBindPoseTransforms(this.numBones, this.bindT, this.bindR, this.parents);
      this._inverseBindPose = invertBindPose(bindPose);
    }
    return this._inverseBindPose;
  }

  /**
   * Compose local-space `pose` into world-space matrices, prefixed by
   * `entityWorldTransform`. Walks the hierarchy parent-first so child world
   * transforms read the freshly-written parent.
   *
   * `out` is reused - entries are created lazily if missing, but the caller
   * owns the buffer (no per-frame allocation). Given `bones` (from
   * {@link subsetOrder}), only those entries are written.
   */
  applyLocal(pose: Pose, entityWorldTransform: Mat4, out: Mat4[], bones?: Int32Array | null): void {
    const numBones = this.numBones;
    for (let i = out.length; i < numBones; i++) out[i] = new Mat4();
    if (bones) {
      for (let k = 0; k < bones.length; k++) this._composeBone(bones[k], pose, entityWorldTransform, out);
      return;
    }

    const stack = this._kfStack;
    for (const rootIdx of this._rootBones) {
      stack.length = 0;
      stack.push(rootIdx);
      while (stack.length > 0) {
        const bi = stack.pop()!;
        this._composeBone(bi, pose, entityWorldTransform, out);
        const kids = this._children[bi];
        for (let ci = 0; ci < kids.length; ci++) stack.push(kids[ci]);
      }
    }
  }

  /**
   * `bones` and all their ancestors, parents first: the order
   * {@link applyLocal} composes a subset in.
   */
  subsetOrder(bones: Iterable<number>): Int32Array {
    const keep = new Uint8Array(this.numBones);
    for (let b of bones) {
      while (b >= 0 && b < this.numBones && !keep[b]) {
        keep[b] = 1;
        b = this.parents[b];
      }
    }
    const order: number[] = [];
    const stack = this._kfStack;
    for (const rootIdx of this._rootBones) {
      stack.length = 0;
      stack.push(rootIdx);
      while (stack.length > 0) {
        const bi = stack.pop()!;
        if (!keep[bi]) continue;
        order.push(bi);
        const kids = this._children[bi];
        for (let ci = 0; ci < kids.length; ci++) stack.push(kids[ci]);
      }
    }
    return Int32Array.from(order);
  }

  private _composeBone(bi: number, pose: Pose, entityWorldTransform: Mat4, out: Mat4[]): void {
    const localMat = this._tmpLocalMat;
    const ls = this.lengthScale;
    if (ls && ls[bi] !== 1) {
      // Lengthen this bone's segment: scale only its local translation.
      const p = pose.positions[bi];
      const f = ls[bi];
      this._tmpPos.set(p.x * f, p.y * f, p.z * f);
      localMat.setTRS(this._tmpPos, pose.rotations[bi], pose.scales[bi]);
    } else {
      localMat.setTRS(pose.positions[bi], pose.rotations[bi], pose.scales[bi]);
    }
    const pi = this.parents[bi];
    if (pi < 0 || pi >= this.numBones) {
      out[bi].mul2(entityWorldTransform, localMat);
    } else {
      out[bi].mul2(out[pi], localMat);
    }
  }
}
