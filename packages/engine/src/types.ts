import type { GSplatData } from 'playcanvas';

import type { SkeletonLibrary } from './loader/skeleton';

/**
 * Rig description used to construct an {@link Armature}.
 *
 * The `stdMale*` fields are filled in by {@link Character.load} from the
 * scene's {@link SkeletonLibrary}, picking the 86-bone body rig or the
 * 441-bone full-body + facial rig depending on the `.bin` bone count.
 *
 * @group Characters & Animation
 */
export interface ArmatureData {
  /** Bone count. */
  numBones: number;
  /** Optional per-joint metadata from the `.bin` bundle. */
  joints?: Float32Array;
  /**
   * Whether this bundle went through the character-correction pipeline (ankle
   * pitch, then ground). True means `joints` is the character's OWN rest with
   * the corrections baked into it and into the splats; false means the bundle
   * predates corrections and its rig should come from the canonical tables.
   *
   * This is the only reliable old/new discriminator. Container magic and header
   * version are NOT: every bundle back to `VFCHARB1` carries a `joints` array,
   * and `VSPLAT01` v3 files exist both with corrections and without, because
   * corrections change VALUES and never the layout a version names.
   *
   * Drives `restSource: 'auto'` - see `Character._buildFromLoadResult`.
   */
  corrected?: boolean;
  /**
   * Whether {@link joints} is this character's own rest pose, vetted against
   * the gaussians it ships with, and therefore authoritative.
   *
   * True only for `VIGGCHAR` v1 bundles, where the corrections are baked into
   * both the gaussians and the joints block so the two agree. False for every
   * legacy container, whose joints are diagnostics and whose characters render
   * against the canonical rest tables today.
   *
   * Gated on the container rather than on {@link corrected} deliberately: some
   * legacy bundles carry a correction receipt, so keying on the receipt would
   * change how already-shipped characters render. Read by
   * `Character.bakedGroundShiftY`.
   */
  restIsPerCharacter?: boolean;
  /** Optional raw skeleton hierarchy from the `.bin` bundle. */
  skeleton?: Int32Array;
  /** Flat `[x,y,z]*numBones` rest-pose translations. */
  stdMaleRestTranslations?: Float32Array;
  /** Flat `[x,y,z,w]*numBones` rest-pose rotations (quaternions). */
  stdMaleRestRotations?: Float32Array;
  /** Parent bone index per bone. `-1` for root bones. */
  stdMaleParents?: Int32Array;
  /**
   * This rig's own bone names, index-aligned with the arrays above. Set for a
   * rig that is not one of the bundled skeletons (a mesh character's GLB
   * skeleton); name lookups then read these instead of the scene's library.
   */
  boneNames?: string[];
}

/**
 * Top-K bone weights per splat, as authored in the `.bin` character bundle.
 * `indices.length === weights.length === numSplats * K` (typically K = 4).
 *
 * @group Characters & Animation
 */
export interface SplatWeights {
  /** Bone index for the k-th influence of each splat. */
  indices: Uint16Array;
  /** Matching weight for the k-th influence of each splat. */
  weights: Float32Array;
}

export interface BinaryGsplatResult {
  gsplatData: GSplatData;
  armatureData?: ArmatureData;
  animationData?: { data: Float32Array; numFrames: number; numBones: number; keyframeFrames?: number[] };
  header: unknown;
  splatWeights?: SplatWeights;
}

export type { SkeletonLibrary };
