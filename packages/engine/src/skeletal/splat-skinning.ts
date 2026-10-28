import { Mat4 } from 'playcanvas';
import type { Frustum } from 'playcanvas';

import {
  buildSplatBoneIndexList,
  initializeSplatBoneMapping,
} from '../splat/bone-binding';
import type { Splat } from '../splat/splat';
import type { SkeletonLibrary } from '../types';

import type { Skeleton } from './skeleton';

/**
 * Per-character splat skinning coordinator. Owns the set of {@link Splat}s
 * driven by an armature, their palette-slot maps, and the GPU push that
 * uploads bone matrices each frame.
 *
 * Also owns the frustum-visibility gate: the armature can skip the expensive
 * pose-eval + skinning path when no linked splat is on-screen.
 *
 * @group Characters & Animation
 */
export class SplatSkinning {
  /** Splats currently driven by this skinning unit. */
  readonly linkedSplats = new Set<Splat>();

  /**
   * Optional per-bone local stretch matrices (the covariance half of
   * bone-length scaling - see {@link computeBoneStretch}). When set, each
   * bone's palette entry gets this stretch folded in, the per-bone scale is
   * NOT normalized out of the palette, and linked splats render with the
   * `USE_NONRIGID_COV` shader path so Gaussian covariances follow the stretch.
   * `null` = rigid skinning (the normal path). Set via {@link setCovStretch}.
   */
  covStretch: Mat4[] | null = null;

  private readonly _skeleton: Skeleton;
  private readonly _skeletonLibrary: SkeletonLibrary | undefined;

  // firstPaletteIdx[splat] - palette slot for bone i is firstIdx + i (linear, no Map lookup needed)
  private readonly _bonePaletteFirstIdx = new Map<Splat, number>();
  private readonly _boneIndexLists = new Map<Splat, Int32Array>();

  private readonly _finalBoneTransforms: Mat4[];
  private readonly _armatureWorldToLocal = new Mat4();

  constructor(skeleton: Skeleton, skeletonLibrary: SkeletonLibrary | undefined) {
    this._skeleton = skeleton;
    this._skeletonLibrary = skeletonLibrary;
    const n = skeleton.numBones;
    this._finalBoneTransforms = Array.from({ length: n }, () => new Mat4());
  }

  link(splat: Splat): void {
    this.linkedSplats.add(splat);
  }

  unlink(splat: Splat): void {
    this.linkedSplats.delete(splat);
    this._bonePaletteFirstIdx.delete(splat);
    this._boneIndexLists.delete(splat);
  }

  /**
   * Set (or clear with `null`) the per-bone covariance-stretch matrices for
   * bone-length scaling. Also flips the `USE_NONRIGID_COV` shader path on every
   * linked splat so covariances follow the stretch. Pass `null` to return to
   * rigid skinning.
   */
  setCovStretch(mats: Mat4[] | null): void {
    this.covStretch = mats;
    for (const splat of this.linkedSplats) splat.setNonRigidCovariance(!!mats);
  }

  /**
   * Returns `true` when at least one linked splat's bounding sphere intersects
   * the camera frustum. Used by the armature to short-circuit the per-frame
   * skinning math for off-screen characters.
   *
   * When `frustum` is missing (e.g. scene not yet started) returns `true` -
   * the conservative choice is to do the extra work rather than freeze a
   * character's pose.
   */
  anyVisible(frustum: Frustum | undefined): boolean {
    if (this.linkedSplats.size === 0) return false;
    if (!frustum) return true;
    for (const splat of this.linkedSplats) {
      // PlayCanvas `Frustum.containsSphere` accepts a `BoundingSphere` while
      // `Splat.isInFrustum` is typed against a narrower duck shape for
      // testability - both have `containsSphere(sphere): number`. The cast
      // bridges the API-level type variance.
      if (splat.isInFrustum(frustum as unknown as Parameters<typeof splat.isInFrustum>[0])) return true;
    }
    return false;
  }

  /**
   * Compose `worldTransforms` (one per bone) with the entity's inverse world
   * transform and the inverse-bind pose, then upload the resulting palette to
   * every linked splat. `worldTransforms[i]` is the i-th bone's matrix in
   * world space, as produced by {@link Skeleton.applyLocal}.
   *
   * Strips scale from the per-bone linear part before composing with the
   * inverse bind. Without this, any net scale (from `splat.entity` world scale
   * or animated bone scale) inflates Gaussian sigmas on the GPU via the
   * palette's column lengths - visible as radial streaks on hands/fists, and
   * desyncs CPU-computed centers from GPU-rendered positions.
   */
  pushTransforms(worldTransforms: Mat4[], entityWorldTransform: Mat4, skipPositions = false): void {
    if (this.linkedSplats.size === 0) return;

    const inverseBindPose = this._skeleton.inverseBindPose;
    if (inverseBindPose.length === 0) return;

    const armatureWorldToLocal = this._armatureWorldToLocal;
    // Fast inverse for TRS matrices (no shear). Transpose the 3×3 rotation
    // block after normalizing out scale, then compute the rotated-negated
    // translation. ~2× fewer ops than the general Mat4 cofactor expansion.
    {
      const ed = entityWorldTransform.data;
      const ad = armatureWorldToLocal.data;
      const sx2 = 1 / Math.max(ed[0]*ed[0] + ed[1]*ed[1] + ed[2]*ed[2], 1e-16);
      const sy2 = 1 / Math.max(ed[4]*ed[4] + ed[5]*ed[5] + ed[6]*ed[6], 1e-16);
      const sz2 = 1 / Math.max(ed[8]*ed[8] + ed[9]*ed[9] + ed[10]*ed[10], 1e-16);
      ad[0]  = ed[0]*sx2; ad[1]  = ed[4]*sy2; ad[2]  = ed[8]*sz2;  ad[3]  = 0;
      ad[4]  = ed[1]*sx2; ad[5]  = ed[5]*sy2; ad[6]  = ed[9]*sz2;  ad[7]  = 0;
      ad[8]  = ed[2]*sx2; ad[9]  = ed[6]*sy2; ad[10] = ed[10]*sz2; ad[11] = 0;
      const tx = ed[12], ty = ed[13], tz = ed[14];
      ad[12] = -(ad[0]*tx + ad[4]*ty + ad[8]*tz);
      ad[13] = -(ad[1]*tx + ad[5]*ty + ad[9]*tz);
      ad[14] = -(ad[2]*tx + ad[6]*ty + ad[10]*tz);
      ad[15] = 1;
    }

    const numBones = this._skeleton.numBones;
    const finalBoneTransforms = this._finalBoneTransforms;
    for (let boneIdx = 0; boneIdx < numBones; boneIdx++) {
      const ft = finalBoneTransforms[boneIdx];
      ft.mul2(armatureWorldToLocal, worldTransforms[boneIdx]);

      const ld = ft.data;
      // Bone-length scaling: when covStretch is set we WANT the scale
      // preserved (the deformation IS a stretch), so skip the normalization.
      if (!this.covStretch) {
        // Inline sqrt - Math.hypot is variadic and ~3-4× slower than the
        // inline Math.sqrt(x*x+y*y+z*z) form. Called numBones × 3 per
        // character per frame; the spread shows up in CPU profiles.
        const l0 = ld[0] * ld[0] + ld[1] * ld[1] + ld[2] * ld[2];
        const l1 = ld[4] * ld[4] + ld[5] * ld[5] + ld[6] * ld[6];
        const l2 = ld[8] * ld[8] + ld[9] * ld[9] + ld[10] * ld[10];
        const il0 = 1 / Math.max(Math.sqrt(l0), 1e-8);
        const il1 = 1 / Math.max(Math.sqrt(l1), 1e-8);
        const il2 = 1 / Math.max(Math.sqrt(l2), 1e-8);
        ld[0] *= il0; ld[1] *= il0; ld[2] *= il0;
        ld[4] *= il1; ld[5] *= il1; ld[6] *= il1;
        ld[8] *= il2; ld[9] *= il2; ld[10] *= il2;
      }

      // Bone-length scaling: fold in this bone's local along-axis stretch
      // (between the world transform and the inverse bind, so it acts in the
      // bone's own frame and affects only this bone's Gaussians).
      if (this.covStretch) ft.mul(this.covStretch[boneIdx]);

      // In-place: ft = ft * inverseBindPose[boneIdx]
      ft.mul(inverseBindPose[boneIdx]);
    }

    for (const splat of this.linkedSplats) {
      if (!splat.splatWeights) continue;
      // Skip inactive LODs entirely - for a multi-level character only one
      // linked splat is enabled at a time. Saves the dominant CPU cost
      // (palette upload + updatePositions) on hidden levels.
      if (splat.entity && !splat.entity.enabled) continue;

      let firstPaletteIdx = this._bonePaletteFirstIdx.get(splat);
      if (firstPaletteIdx === undefined) {
        firstPaletteIdx = initializeSplatBoneMapping(splat, numBones, this._skeletonLibrary);
        this._bonePaletteFirstIdx.set(splat, firstPaletteIdx);
      }
      let boneIndexList = this._boneIndexLists.get(splat);
      if (!boneIndexList) {
        boneIndexList = buildSplatBoneIndexList(splat, numBones);
        this._boneIndexLists.set(splat, boneIndexList);
      }

      const palette = splat.transformPalette;
      if (boneIndexList.length > 0) {
        for (let j = 0; j < boneIndexList.length; j++) {
          const boneIdx = boneIndexList[j];
          palette.setTransform(firstPaletteIdx + boneIdx, finalBoneTransforms[boneIdx]);
        }
      } else {
        for (let boneIdx = 0; boneIdx < numBones; boneIdx++) {
          palette.setTransform(firstPaletteIdx + boneIdx, finalBoneTransforms[boneIdx]);
        }
      }

      const uploaded = palette.upload();
      if (uploaded) {
        splat.updateUnifiedWorkBufferParams();
        // skipPositions: GPU palette is still uploaded (so items + hitboxes
        // tracking bones move correctly), but the CPU center re-upload -
        // which copies the full ~720 KB centers buffer to the sort worker -
        // is skipped. The depth-sort order lags one frame; visible pose
        // doesn't (driven by the palette we just uploaded).
        if (!skipPositions) {
          splat.updatePositions(this._finalBoneTransforms);
        }
      }
    }
  }

  /** Request a re-sort on every linked splat (e.g. after a transform change). */
  requestSortAll(): void {
    for (const splat of this.linkedSplats) splat.requestSort();
  }
}
