import type { Character } from '../../character';
import {
  ALL_BODY_PARTS,
  NUM_BODY_PARTS,
  buildBoneToGroup,
} from '../../skeletal/body-parts';
import type { BodyPart } from '../../skeletal/body-parts';
import type { Splat } from '../../splat/splat';

/**
 * Options for {@link DamageVariant.create}.
 *
 * @group Characters & Animation
 */
export interface DamageVariantOptions {
  /**
   * URL of the damaged-variant `.bin`. Must be rigged to the same skeleton
   * as the host character (same bone count and bone naming), and ideally
   * authored from the same base mesh so the two splat clouds occupy the
   * same volume in bind pose - otherwise toggling a body part will leave a
   * visible seam at the bone boundary.
   */
  damagedUrl: string;
}

/**
 * Body-part-keyed damage system layered on top of {@link Character}'s
 * variant-splat primitive. Loads a second skinned splat cloud (the
 * "damaged" version) into the same armature, classifies every gaussian in
 * both clouds by its dominant bone's body part, and exposes a per-body-
 * part toggle that swaps which cloud each part renders from.
 *
 * No mesh deformation, no per-splat painting - the visible character is
 * the union of "normal splats whose body part is undamaged" and "damaged
 * splats whose body part is damaged". The two masks always sum to one per
 * body part, so there's no double draw and no holes.
 *
 * @example
 * ```ts
 * const character = await Character.load(scene, 'Robot_normal.bin');
 * const damage = await DamageVariant.create(character, {
 *   damagedUrl: 'Robot_damaged.bin',
 * });
 * damage.setBodyPartDamaged(BodyPart.LeftLowerArm, true);
 * // ...
 * damage.destroy();
 * ```
 *
 * @group Characters & Animation
 */
export class DamageVariant {
  private _damaged: Splat | null;
  private _damageBits = new Uint8Array(NUM_BODY_PARTS);

  private _character: Character;

  // Explicit field, not a parameter property: consumers compiling this source
  // with `erasableSyntaxOnly` reject the parameter-property form.
  private constructor(character: Character, damaged: Splat) {
    this._character = character;
    this._damaged = damaged;
  }

  /**
   * Async constructor. Loads the damaged variant, classifies splats in
   * both clouds, and primes masks so the visible state matches the
   * undamaged character.
   */
  static async create(character: Character, options: DamageVariantOptions): Promise<DamageVariant> {
    const boneNames = character.armature.boneNames;
    if (boneNames.length === 0) {
      throw new Error(
        'DamageVariant.create: armature has no boneNames - ensure scene.skeletonLibrary is loaded',
      );
    }
    const boneToGroup = buildBoneToGroup(boneNames);

    // Bake group IDs on every primary (LOD) splat that's already loaded.
    // Added LODs (Character.addLodLevel) after this point won't be
    // classified - re-call refresh() in that case, or load the damage
    // system after all LODs are in place.
    for (const s of character.splats) {
      applyGroupsTo(s, boneToGroup);
    }

    // Load + classify the damaged cloud. Both clouds stay enabled - the
    // masks decide which one wins per body part.
    const damaged = await character.addVariantSplat(options.damagedUrl);
    applyGroupsTo(damaged, boneToGroup);

    const dv = new DamageVariant(character, damaged);
    dv._applyMasks();
    return dv;
  }

  /** Toggle a single body part between the normal and damaged splat cloud. */
  setBodyPartDamaged(part: BodyPart, damaged: boolean): void {
    if (part < 0 || part >= NUM_BODY_PARTS) return;
    this._damageBits[part] = damaged ? 1 : 0;
    this._applyMasks();
  }

  /**
   * Bulk-set damage state. Either an explicit list (every other part reset
   * to undamaged) or a sparse object mapping parts to booleans (unspecified
   * parts left untouched).
   */
  setMask(parts: readonly BodyPart[] | Partial<Record<BodyPart, boolean>>): void {
    if (Array.isArray(parts)) {
      this._damageBits.fill(0);
      for (const p of parts) {
        if (p >= 0 && p < NUM_BODY_PARTS) this._damageBits[p] = 1;
      }
    } else {
      const obj = parts as Partial<Record<BodyPart, boolean>>;
      for (const p of ALL_BODY_PARTS) {
        const v = obj[p];
        if (v !== undefined) this._damageBits[p] = v ? 1 : 0;
      }
    }
    this._applyMasks();
  }

  /** Reset every body part to its normal (undamaged) appearance. */
  reset(): void {
    this._damageBits.fill(0);
    this._applyMasks();
  }

  /** Returns true if the given body part is currently showing the damaged variant. */
  isBodyPartDamaged(part: BodyPart): boolean {
    return this._damageBits[part] === 1;
  }

  /**
   * Re-bake group IDs on every primary splat. Call after adding a new LOD
   * level via {@link Character.addLodLevel} so it picks up the variant
   * mask. The damaged splat is unaffected (it's owned by this system and
   * was classified at create time).
   */
  refresh(): void {
    const boneNames = this._character.armature.boneNames;
    if (boneNames.length === 0) return;
    const boneToGroup = buildBoneToGroup(boneNames);
    for (const s of this._character.splats) applyGroupsTo(s, boneToGroup);
    this._applyMasks();
  }

  /** Detach + destroy the damaged splat. The host character is untouched. */
  destroy(): void {
    if (this._damaged) {
      this._character.removeVariantSplat(this._damaged);
      this._damaged = null;
    }
  }

  /** Push the current `_damageBits` to both clouds with inverted polarity. */
  private _applyMasks(): void {
    const normalMask = new Float32Array(NUM_BODY_PARTS);
    const damagedMask = new Float32Array(NUM_BODY_PARTS);
    for (let i = 0; i < NUM_BODY_PARTS; i++) {
      const dmg = this._damageBits[i] === 1;
      normalMask[i] = dmg ? 0 : 1;
      damagedMask[i] = dmg ? 1 : 0;
    }
    for (const s of this._character.splats) s.setVariantMask(normalMask);
    this._damaged?.setVariantMask(damagedMask);
  }
}

/**
 * Classify every gaussian in `splat` by its dominant bone's group ID and
 * upload via {@link Splat.setSplatGroups}. No-op for non-skinned splats.
 *
 * "Dominant" = the bone with the largest weight among the splat's top-K
 * influences. PC stores influences in descending-weight order, so this is
 * the splat's most-important bone.
 */
function applyGroupsTo(splat: Splat, boneToGroup: Uint8Array): void {
  const weightsBundle = splat.splatWeights;
  if (!weightsBundle) return;
  const { indices, weights } = weightsBundle;
  const topK = indices.length / splat.numSplats;

  const groupIds = new Uint8Array(splat.numSplats);
  for (let i = 0; i < splat.numSplats; i++) {
    let bestW = -1;
    let bestBone = 0;
    for (let j = 0; j < topK; j++) {
      const w = weights[i * topK + j];
      if (w > bestW) {
        bestW = w;
        bestBone = indices[i * topK + j] | 0;
      }
    }
    groupIds[i] = bestBone < boneToGroup.length ? boneToGroup[bestBone] : 0;
  }
  splat.setSplatGroups(groupIds, NUM_BODY_PARTS);
}
