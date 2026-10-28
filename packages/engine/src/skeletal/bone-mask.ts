/**
 * Bone-mask utilities for layered animation. A {@link BoneMask} selects a
 * subset of an armature's bones by index; the {@link Armature} layer system
 * uses it to gate an overlay animation to (e.g.) just the upper body while a
 * base full-body clip drives the rest.
 *
 * Built-in regions ({@link UPPER_BODY_BONE_NAMES} / {@link LOWER_BODY_BONE_NAMES})
 * follow the canonical 86-bone rig naming. The split bone is the pelvis:
 *   - UPPER covers everything from `spine_01` up (spine 01-05, neck, head,
 *     clavicles, arms, hands, all fingers) so the overlay fully replaces
 *     the torso without leak from the base's spine rotation.
 *   - LOWER covers `pelvis` plus the leg chain (thighs, calves, calf
 *     twists, feet, ball, all toes). Including pelvis means an overlay's
 *     pelvis Y motion drives the rig and routes through `rootMotionMode`,
 *     so the lower-body overlay owns root motion when active.
 *
 * @group Characters & Animation
 */

export const UPPER_BODY_BONE_NAMES = [
  'spine_01', 'spine_02', 'spine_03', 'spine_04', 'spine_05',
  'neck_01', 'neck_02',
  'head',
  'clavicle_l', 'clavicle_r',
  'upperarm_l', 'upperarm_r',
  'lowerarm_l', 'lowerarm_r',
  'hand_l', 'hand_r',
  // Fingers - so the overlay fully owns hand pose.
  'thumb_01_l', 'thumb_02_l', 'thumb_03_l',
  'index_metacarpal_l', 'index_01_l', 'index_02_l', 'index_03_l',
  'middle_metacarpal_l', 'middle_01_l', 'middle_02_l', 'middle_03_l',
  'ring_metacarpal_l', 'ring_01_l', 'ring_02_l', 'ring_03_l',
  'pinky_metacarpal_l', 'pinky_01_l', 'pinky_02_l', 'pinky_03_l',
  'thumb_01_r', 'thumb_02_r', 'thumb_03_r',
  'index_metacarpal_r', 'index_01_r', 'index_02_r', 'index_03_r',
  'middle_metacarpal_r', 'middle_01_r', 'middle_02_r', 'middle_03_r',
  'ring_metacarpal_r', 'ring_01_r', 'ring_02_r', 'ring_03_r',
  'pinky_metacarpal_r', 'pinky_01_r', 'pinky_02_r', 'pinky_03_r',
] as const;

export const LOWER_BODY_BONE_NAMES = [
  'pelvis',
  'thigh_l', 'thigh_r',
  'calf_l', 'calf_r',
  'calf_twist_01_l', 'calf_twist_01_r',
  'foot_l', 'foot_r',
  'ball_l', 'ball_r',
  'bigtoe_01_l', 'bigtoe_02_l',
  'indextoe_01_l', 'indextoe_02_l',
  'middletoe_01_l', 'middletoe_02_l',
  'ringtoe_01_l', 'ringtoe_02_l',
  'littletoe_01_l', 'littletoe_02_l',
  'bigtoe_01_r', 'bigtoe_02_r',
  'indextoe_01_r', 'indextoe_02_r',
  'middletoe_01_r', 'middletoe_02_r',
  'ringtoe_01_r', 'ringtoe_02_r',
  'littletoe_01_r', 'littletoe_02_r',
] as const;

export interface BoneMask {
  name: string;
  boneIndices: Int32Array;
}

export function resolveBoneIndices(
  allBoneNames: readonly string[],
  maskNames: readonly string[],
): Int32Array {
  const out: number[] = [];
  for (const n of maskNames) {
    const i = allBoneNames.indexOf(n);
    if (i >= 0) out.push(i);
  }
  return Int32Array.from(out);
}

export type BodyRegion = 'upperBody' | 'lowerBody';

export function makeRegionMask(
  region: BodyRegion,
  allBoneNames: readonly string[],
): BoneMask {
  const names = region === 'upperBody' ? UPPER_BODY_BONE_NAMES : LOWER_BODY_BONE_NAMES;
  return { name: region, boneIndices: resolveBoneIndices(allBoneNames, names) };
}
