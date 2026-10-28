/**
 * Coarse body-part segmentation used by the damage / variant system.
 *
 * Each bone in the skeleton is classified into one of {@link BodyPart}.
 * A {@link Splat} stores the dominant-bone group per gaussian; at runtime
 * the variant-mask uniform decides per-group whether to render the splat
 * from the "normal" cloud or the "damaged" cloud. The `DamageVariant`
 * preset (`presets/character/damage-variant.ts`) is the system built on
 * this: `DamageVariant.create` / `setBodyPartDamaged`.
 *
 * The enum values are stable group IDs used directly as texture coords on
 * the variant-mask texture - do not renumber without updating shaders.
 *
 * @group Characters & Animation
 */
// A const object rather than a TS `enum`: this source is consumed directly
// (not prebuilt) by apps compiling with `erasableSyntaxOnly`, which rejects
// `enum` because it emits runtime code. The const-object + union-type pair
// keeps both the `BodyPart.Head` value form and the `BodyPart` type form
// working at call sites, and preserves the numeric group IDs exactly.
export const BodyPart = {
  Torso: 0,
  Head: 1,
  LeftUpperArm: 2,
  LeftLowerArm: 3,
  LeftHand: 4,
  RightUpperArm: 5,
  RightLowerArm: 6,
  RightHand: 7,
  LeftUpperLeg: 8,
  LeftLowerLeg: 9,
  LeftFoot: 10,
  RightUpperLeg: 11,
  RightLowerLeg: 12,
  RightFoot: 13,
} as const;

/** One of the {@link BodyPart} group IDs. */
export type BodyPart = (typeof BodyPart)[keyof typeof BodyPart];

/** Width of the per-character variant-mask texture (= max group ID + 1). */
export const NUM_BODY_PARTS = 14;

const SUFFIX_LEFT = /(_l|_left|\.l|\.left)$/i;
const SUFFIX_RIGHT = /(_r|_right|\.r|\.right)$/i;

function sideOf(name: string): 'l' | 'r' | null {
  if (SUFFIX_LEFT.test(name)) return 'l';
  if (SUFFIX_RIGHT.test(name)) return 'r';
  return null;
}

/**
 * Classify a single bone name into a {@link BodyPart}. Pattern-based so it
 * tolerates both the 86-bone std-male rig (clavicle_l, upperarm_l, ...) and
 * the 441-bone rig (FACIAL_* in addition).
 *
 * Returns {@link BodyPart.Torso} for anything we can't confidently bucket
 * (root, unknown auxiliary bones) - Torso is the safest fallback because the
 * spine controls the largest contiguous splat region.
 */
export function classifyBone(boneName: string): BodyPart {
  const n = boneName.toLowerCase();
  const side = sideOf(n);

  // Head & neck. Facial bones in the 441-rig start with FACIAL_ → all head.
  if (n.startsWith('facial_') || n === 'head' || n.startsWith('neck')) {
    return BodyPart.Head;
  }

  // Torso (pelvis included so hip splats move with the body, not the legs).
  if (n.startsWith('spine') || n === 'pelvis' || n === 'root') {
    return BodyPart.Torso;
  }

  // ── Arms ──────────────────────────────────────────────────────────────
  if (side) {
    // Hands & fingers - any hand_*, *_metacarpal_*, finger names.
    if (
      n.startsWith('hand') ||
      n.includes('metacarpal') ||
      n.startsWith('thumb') ||
      n.startsWith('index_0') ||
      n.startsWith('middle_0') ||
      n.startsWith('ring_0') ||
      n.startsWith('pinky_0')
    ) {
      return side === 'l' ? BodyPart.LeftHand : BodyPart.RightHand;
    }
    if (n.startsWith('lowerarm') || n.includes('forearm')) {
      return side === 'l' ? BodyPart.LeftLowerArm : BodyPart.RightLowerArm;
    }
    if (n.startsWith('upperarm') || n.startsWith('clavicle') || n.startsWith('shoulder')) {
      return side === 'l' ? BodyPart.LeftUpperArm : BodyPart.RightUpperArm;
    }

    // ── Legs ────────────────────────────────────────────────────────────
    if (
      n.startsWith('foot') ||
      n.startsWith('ball') ||
      n.includes('toe')
    ) {
      return side === 'l' ? BodyPart.LeftFoot : BodyPart.RightFoot;
    }
    if (n.startsWith('calf') || n.startsWith('shin') || n.startsWith('lowerleg')) {
      return side === 'l' ? BodyPart.LeftLowerLeg : BodyPart.RightLowerLeg;
    }
    if (n.startsWith('thigh') || n.startsWith('upperleg')) {
      return side === 'l' ? BodyPart.LeftUpperLeg : BodyPart.RightUpperLeg;
    }
  }

  return BodyPart.Torso;
}

/**
 * Build a Uint8Array of length `boneNames.length` where entry `i` is the
 * group ID for bone `i`. Cheap (single pass, regex-based) - call once per
 * armature/splat-asset combination.
 */
export function buildBoneToGroup(boneNames: readonly string[]): Uint8Array {
  const out = new Uint8Array(boneNames.length);
  for (let i = 0; i < boneNames.length; i++) {
    out[i] = classifyBone(boneNames[i] ?? '');
  }
  return out;
}

/** Human-readable label for a body part (debug overlays, UI). */
export function bodyPartLabel(p: BodyPart): string {
  switch (p) {
    case BodyPart.Torso: return 'Torso';
    case BodyPart.Head: return 'Head';
    case BodyPart.LeftUpperArm: return 'L Upper Arm';
    case BodyPart.LeftLowerArm: return 'L Lower Arm';
    case BodyPart.LeftHand: return 'L Hand';
    case BodyPart.RightUpperArm: return 'R Upper Arm';
    case BodyPart.RightLowerArm: return 'R Lower Arm';
    case BodyPart.RightHand: return 'R Hand';
    case BodyPart.LeftUpperLeg: return 'L Upper Leg';
    case BodyPart.LeftLowerLeg: return 'L Lower Leg';
    case BodyPart.LeftFoot: return 'L Foot';
    case BodyPart.RightUpperLeg: return 'R Upper Leg';
    case BodyPart.RightLowerLeg: return 'R Lower Leg';
    case BodyPart.RightFoot: return 'R Foot';
  }
}

/** Iteration helper - all defined body parts in stable order. */
export const ALL_BODY_PARTS: readonly BodyPart[] = [
  BodyPart.Torso,
  BodyPart.Head,
  BodyPart.LeftUpperArm,
  BodyPart.LeftLowerArm,
  BodyPart.LeftHand,
  BodyPart.RightUpperArm,
  BodyPart.RightLowerArm,
  BodyPart.RightHand,
  BodyPart.LeftUpperLeg,
  BodyPart.LeftLowerLeg,
  BodyPart.LeftFoot,
  BodyPart.RightUpperLeg,
  BodyPart.RightLowerLeg,
  BodyPart.RightFoot,
];
