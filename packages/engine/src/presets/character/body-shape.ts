import type { Character } from '../../character';
import type { BoneScaleInput } from '../../skeletal/bone-stretch';
import {
  ALL_BODY_PARTS,
  BodyPart,
  NUM_BODY_PARTS,
  buildBoneToGroup,
} from '../../skeletal/body-parts';

// ── ProportionSpec: the compact body-proportion vocabulary ────────────────────
// Ported from the proportion-preset tables our earlier character products
// shipped, so the numbers here are the ones already tuned against this rig. A
// spec is what a body-shape preset stores; buildStretch() expands it into the
// per-bone factors Armature.setBoneStretch consumes.

const SPINE_BONES = ['spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05'] as const;
const NECK_BONES = ['neck_01', 'neck_02'] as const;
const ARM_BONES = ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r'] as const;
const LEG_BONES = ['thigh_l', 'thigh_r', 'calf_l', 'calf_r'] as const;
const HAND_BONES = ['hand_l', 'hand_r'] as const;
const FOOT_BONES = ['foot_l', 'foot_r', 'ball_l', 'ball_r'] as const;

/**
 * A body-proportion preset, parameterized over the rig's humanoid bones.
 * `along` lengthens a segment; girth (width + thickness) fattens it.
 * Spine girth tapers linearly from `torsoGirthBase` (hips, spine_01) to
 * `torsoGirthTop` (chest, spine_05) so the silhouette can be pyramid-shaped.
 * Every value is a multiplier (1 = unchanged).
 *
 * @group Characters & Animation
 */
export interface ProportionSpec {
  /** Uniform scale for the head bone + every FACIAL_* bone. */
  head: number;
  /** Lengthen the spine segments. */
  torsoAlong: number;
  /** Spine cross-section at the hips (spine_01). Default 1. */
  torsoGirthBase?: number;
  /** Spine cross-section at the chest (spine_05). Default = torsoGirthBase. */
  torsoGirthTop?: number;
  /** Lengthen the neck. Default = torsoAlong. */
  neckAlong?: number;
  /** Base length for arms + legs. */
  limbAlong: number;
  /** Base cross-section for arms + legs. Default 1. */
  limbGirth?: number;
  /** Override arm length / cross-section. Default = limb*. */
  armAlong?: number;
  armGirth?: number;
  /** Override leg length / cross-section. Default = limb*. */
  legAlong?: number;
  legGirth?: number;
  /** Uniform scale on hand_l/r. Default 1 (unchanged). */
  hands?: number;
  /** Uniform scale on foot_l/r + ball_l/r. Default 1 (unchanged). */
  feet?: number;
  /**
   * Degrees to swing the upper arms out from the torso each frame. Fattening
   * the belly doesn't move the shoulders, so heavy builds need this to keep
   * the arms from sinking into the gut. NOT applied by buildStretch (it's an
   * animation-layer concern, not a bone scale); stored on the spec so presets
   * round-trip it. Default 0.
   */
  armOutDeg?: number;
}

/**
 * Expand a {@link ProportionSpec} into the `{ boneName: scale }` map
 * {@link Armature.setBoneStretch} consumes. Encodes the spine-girth taper and
 * all the per-limb defaults, so the compact spec is meaningless without it.
 * `boneNames` = the loaded rig's actual bones (use `armature.rigBoneNames` so
 * the 441-bone facial rig resolves correctly); optional extremities
 * (hands/feet/FACIAL_*) are only written when present.
 *
 * @group Characters & Animation
 */
export function buildStretch(
  boneNames: readonly string[],
  spec: ProportionSpec,
): Record<string, BoneScaleInput> {
  const girthBase = spec.torsoGirthBase ?? 1;
  const girthTop = spec.torsoGirthTop ?? girthBase;
  const armAlong = spec.armAlong ?? spec.limbAlong;
  const armGirth = spec.armGirth ?? spec.limbGirth ?? 1;
  const legAlong = spec.legAlong ?? spec.limbAlong;
  const legGirth = spec.legGirth ?? spec.limbGirth ?? 1;

  const has = new Set(boneNames);
  const factors: Record<string, BoneScaleInput> = { head: spec.head };

  // Spine girth lerps from hips (spine_01) to chest (spine_05).
  SPINE_BONES.forEach((name, i) => {
    const t = i / (SPINE_BONES.length - 1); // 0 at hips → 1 at chest
    const g = girthBase + (girthTop - girthBase) * t;
    factors[name] = { along: spec.torsoAlong, width: g, thickness: g };
  });
  for (const name of NECK_BONES) factors[name] = { along: spec.neckAlong ?? spec.torsoAlong };
  for (const name of ARM_BONES) factors[name] = { along: armAlong, width: armGirth, thickness: armGirth };
  for (const name of LEG_BONES) factors[name] = { along: legAlong, width: legGirth, thickness: legGirth };
  // Extremities are guarded - not every rig has hand/foot/ball bones.
  if (spec.hands !== undefined) for (const name of HAND_BONES) if (has.has(name)) factors[name] = spec.hands;
  if (spec.feet !== undefined) for (const name of FOOT_BONES) if (has.has(name)) factors[name] = spec.feet;
  // Face scales with the head.
  for (const name of boneNames) if (name.startsWith('FACIAL_')) factors[name] = spec.head;

  return factors;
}

// ── Legacy uniform per-body-part vocabulary (kept for wire compat) ────────────

/**
 * Stable string keys for {@link BodyPart} - the wire vocabulary of the legacy
 * flat `{part → multiplier}` shape. Prefer {@link ProportionSpec} presets.
 */
export const BODY_PART_SLUGS: readonly (readonly [string, BodyPart])[] = [
  ['torso', BodyPart.Torso],
  ['head', BodyPart.Head],
  ['left_upper_arm', BodyPart.LeftUpperArm],
  ['left_lower_arm', BodyPart.LeftLowerArm],
  ['left_hand', BodyPart.LeftHand],
  ['right_upper_arm', BodyPart.RightUpperArm],
  ['right_lower_arm', BodyPart.RightLowerArm],
  ['right_hand', BodyPart.RightHand],
  ['left_upper_leg', BodyPart.LeftUpperLeg],
  ['left_lower_leg', BodyPart.LeftLowerLeg],
  ['left_foot', BodyPart.LeftFoot],
  ['right_upper_leg', BodyPart.RightUpperLeg],
  ['right_lower_leg', BodyPart.RightLowerLeg],
  ['right_foot', BodyPart.RightFoot],
];

const SLUG_TO_PART: ReadonlyMap<string, BodyPart> = new Map(BODY_PART_SLUGS);

/**
 * Body-shape preview driver for one {@link Character}: expands a
 * {@link ProportionSpec} (or a legacy flat per-part map) and applies it via
 * {@link Armature.setBoneStretch}. Cheap enough for live slider dragging.
 *
 * @example
 * ```ts
 * const shape = BodyShapeVariant.create(character);
 * shape.setSpec({ head: 1.6, torsoAlong: 0.7, limbAlong: 0.5, torsoGirthBase: 1.35 });
 * shape.reset();
 * shape.destroy();
 * ```
 *
 * @group Characters & Animation
 */
export class BodyShapeVariant {
  private readonly _character: Character;
  private readonly _boneNames: readonly string[];
  /** Bone names per body part (legacy flat-map path), `[BodyPart] → names`. */
  private readonly _partBoneNames: string[][];

  private constructor(character: Character, boneNames: readonly string[]) {
    this._character = character;
    this._boneNames = boneNames;
    const boneToGroup = buildBoneToGroup(boneNames);
    this._partBoneNames = Array.from({ length: NUM_BODY_PARTS }, () => []);
    const n = Math.min(character.armature.numBones, boneToGroup.length);
    for (let i = 0; i < n; i++) this._partBoneNames[boneToGroup[i]].push(boneNames[i]);
  }

  /**
   * Bind to the host character's rig. Synchronous - the armature must already
   * be attached to a scene with a loaded skeleton library (441-bone facial
   * rigs resolve through `armature.rigBoneNames`).
   */
  static create(character: Character): BodyShapeVariant {
    const names = character.armature.rigBoneNames;
    if (names.length === 0) {
      throw new Error(
        'BodyShapeVariant.create: no bone names for this rig - ensure scene.skeletonLibrary is loaded',
      );
    }
    return new BodyShapeVariant(character, names);
  }

  /**
   * Apply a {@link ProportionSpec}. Takes effect on the next armature update.
   * `armOutDeg` is carried on the spec but not previewed (animation-layer
   * concern).
   */
  setSpec(spec: ProportionSpec): void {
    this._character.armature.setBoneStretch(buildStretch(this._boneNames, spec));
    this._character.requestSort();
  }

  /**
   * Legacy flat shape: uniform multiplier per body part, keyed by
   * {@link BODY_PART_SLUGS} (`'torso'`, `'left_upper_arm'`, …). Unknown keys
   * and non-finite values are ignored. Prefer {@link setSpec}.
   */
  setScalesByName(scales: Record<string, number>): void {
    const factors: Record<string, BoneScaleInput> = {};
    for (const [slug, v] of Object.entries(scales)) {
      const part = SLUG_TO_PART.get(slug);
      if (part === undefined || !Number.isFinite(v) || v === 1) continue;
      for (const name of this._partBoneNames[part]) factors[name] = v;
    }
    this._character.armature.setBoneStretch(Object.keys(factors).length ? factors : null);
    this._character.requestSort();
  }

  /** Return the character to its unstretched proportions. */
  reset(): void {
    this._character.armature.setBoneStretch(null);
    this._character.requestSort();
  }

  /** Alias of {@link reset} - detach the stretch entirely. */
  destroy(): void {
    this.reset();
  }
}

// Re-export so preset consumers can iterate parts without a deep import.
export { ALL_BODY_PARTS };
