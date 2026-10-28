/**
 * Describes how a humanoid (or other) rig becomes a set of physics
 * bodies for ragdoll. Keyed by bone name.
 *
 * ## Assumed conventions
 *
 * The Ragdoll places each capsule body so that the body's local +Y
 * axis points along the bone's bind-pose direction (i.e. toward
 * `endBoneName`'s bind position). Authoring the config correctly
 * therefore requires that the rig's bone hierarchy and bind pose be
 * known - name lookup is done by string match against
 * `Armature.boneNames`, which is supplied by `Scene.skeletonLibrary`.
 *
 * For UE-style humanoids (`pelvis`, `spine_NN`, `neck_NN`, `head`,
 * `clavicle_l/r`, `upperarm_l/r`, `lowerarm_l/r`, `hand_l/r`,
 * `thigh_l/r`, `calf_l/r`, `foot_l/r`) the bundled
 * {@link DEFAULT_HUMANOID_RAGDOLL} works without modification. Other
 * rigs (Maya joint orientation, custom skeletons, props) can supply a
 * custom config; only the bone names need to differ.
 *
 * @group Ragdoll
 */
export interface RagdollConfig {
  bones: RagdollBoneDesc[];
}

/**
 * One physics body in the ragdoll graph. Each body is a capsule attached to
 * a bone; its axis points from the bone's bind-pose origin toward the
 * bind-pose position of `endBoneName` (so its length is implicit in the
 * rig). Terminal bodies (head, hand, foot) without a useful end bone in
 * the config specify `length` directly.
 *
 * @group Ragdoll
 */
export interface RagdollBoneDesc {
  /** Bone the body is attached to. */
  boneName: string;
  /**
   * Bone whose bind-pose position defines the capsule's distal end.
   * Capsule length = ‖bindPos(endBoneName) − bindPos(boneName)‖.
   * Omit and set {@link length} for terminal bodies (head, hand, foot)
   * whose child bones don't represent the body's tip.
   */
  endBoneName?: string;
  /** Capsule length override when {@link endBoneName} is absent. Meters. */
  length?: number;
  /** Capsule radius. Meters. */
  radius: number;
  /** Body mass. */
  mass: number;
  /** Parent body's `boneName`. `null` for the root body (pelvis). */
  parent: string | null;
  /**
   * Joint to the parent body. `null` for the root body. The joint anchors
   * sit at the proximal end of the child capsule (where the bone starts)
   * and at the corresponding point on the parent body.
   */
  joint?: RagdollJointDesc | null;
}

/**
 * Joint between a body and its parent. `coneTwist` is the right choice for
 * shoulders, hips, neck, and the spine; `hinge` is for elbows and knees.
 *
 * @group Ragdoll
 */
/**
 * Shared fields across joint variants.
 *
 * @group Ragdoll
 */
interface RagdollJointCommon {
  /**
   * When set, the joint detaches if its applied impulse in a single
   * physics step exceeds this value (N·s). Triggers
   * {@link Ragdoll.onLimbDetached} for the child bone and severs the
   * skeletal subtree. Omit for an unbreakable joint.
   *
   * Tuning is rig-specific - start around 8–15 N·s for shoulders /
   * hips on a humanoid; lower values detach more easily.
   */
  breakImpulse?: number;
}

export type RagdollJointDesc =
  | (RagdollJointCommon & {
      type: 'coneTwist';
      /** Cone half-angle, radians. Default π/4. */
      swingY?: number;
      /** Cone half-angle, radians. Default π/4. */
      swingZ?: number;
      /** Twist half-angle, radians. Default π/6. */
      twist?: number;
    })
  | (RagdollJointCommon & {
      type: 'hinge';
      /** Hinge axis in the child body's local space. `'x' | 'y' | 'z'`. */
      axis: 'x' | 'y' | 'z';
      /** Lower limit, radians. */
      low: number;
      /** Upper limit, radians. */
      high: number;
    });

/**
 * A sensible default humanoid ragdoll for rigs that use the standard
 * UE-style bone naming (`pelvis`, `spine_NN`, `neck_NN`, `head`,
 * `clavicle_l/r`, `upperarm_l/r`, `lowerarm_l/r`, `hand_l/r`,
 * `thigh_l/r`, `calf_l/r`, `foot_l/r`). Collapses the spine to a single
 * torso body, ignores fingers, toes, and twist bones - 14 bodies total,
 * enough for recognizable ragdoll motion without the cost of a per-bone
 * body.
 *
 * Override per-character by passing a custom {@link RagdollConfig} to
 * the {@link Ragdoll} constructor.
 *
 * @group Ragdoll
 */
export const DEFAULT_HUMANOID_RAGDOLL: RagdollConfig = {
  bones: [
    // ── Torso ───────────────────────────────────────────────────────
    // Pelvis is the root - no joint, no parent.
    {
      boneName: 'pelvis',
      endBoneName: 'spine_03',
      radius: 0.13,
      mass: 8,
      parent: null,
    },
    // Single chest body covers spine_01..spine_05. Parent is pelvis.
    {
      boneName: 'spine_03',
      endBoneName: 'neck_01',
      radius: 0.12,
      mass: 10,
      parent: 'pelvis',
      joint: { type: 'coneTwist', swingY: Math.PI / 6, swingZ: Math.PI / 6, twist: Math.PI / 8 },
    },
    // Head - terminal, length authored.
    {
      boneName: 'neck_01',
      endBoneName: 'head',
      radius: 0.08,
      mass: 4,
      parent: 'spine_03',
      joint: { type: 'coneTwist', swingY: Math.PI / 4, swingZ: Math.PI / 4, twist: Math.PI / 6 },
    },

    // ── Left arm ────────────────────────────────────────────────────
    {
      boneName: 'upperarm_l',
      endBoneName: 'lowerarm_l',
      radius: 0.05,
      mass: 2,
      parent: 'spine_03',
      // Shoulders are very free - wide cone.
      joint: { type: 'coneTwist', swingY: Math.PI / 2, swingZ: Math.PI / 2, twist: Math.PI / 3 },
    },
    {
      boneName: 'lowerarm_l',
      endBoneName: 'hand_l',
      radius: 0.045,
      mass: 1.2,
      parent: 'upperarm_l',
      // Elbow: hinge, ~0..140°.
      joint: { type: 'hinge', axis: 'x', low: 0, high: Math.PI * 0.75 },
    },

    // ── Right arm ───────────────────────────────────────────────────
    {
      boneName: 'upperarm_r',
      endBoneName: 'lowerarm_r',
      radius: 0.05,
      mass: 2,
      parent: 'spine_03',
      joint: { type: 'coneTwist', swingY: Math.PI / 2, swingZ: Math.PI / 2, twist: Math.PI / 3 },
    },
    {
      boneName: 'lowerarm_r',
      endBoneName: 'hand_r',
      radius: 0.045,
      mass: 1.2,
      parent: 'upperarm_r',
      joint: { type: 'hinge', axis: 'x', low: 0, high: Math.PI * 0.75 },
    },

    // ── Left leg ────────────────────────────────────────────────────
    {
      boneName: 'thigh_l',
      endBoneName: 'calf_l',
      radius: 0.07,
      mass: 5,
      parent: 'pelvis',
      // Hips: large cone, low twist.
      joint: { type: 'coneTwist', swingY: Math.PI / 3, swingZ: Math.PI / 3, twist: Math.PI / 8 },
    },
    {
      boneName: 'calf_l',
      endBoneName: 'foot_l',
      radius: 0.05,
      mass: 3,
      parent: 'thigh_l',
      // Knee: hinge, opposite direction from elbow.
      joint: { type: 'hinge', axis: 'x', low: -Math.PI * 0.75, high: 0 },
    },

    // ── Right leg ───────────────────────────────────────────────────
    {
      boneName: 'thigh_r',
      endBoneName: 'calf_r',
      radius: 0.07,
      mass: 5,
      parent: 'pelvis',
      joint: { type: 'coneTwist', swingY: Math.PI / 3, swingZ: Math.PI / 3, twist: Math.PI / 8 },
    },
    {
      boneName: 'calf_r',
      endBoneName: 'foot_r',
      radius: 0.05,
      mass: 3,
      parent: 'thigh_r',
      joint: { type: 'hinge', axis: 'x', low: -Math.PI * 0.75, high: 0 },
    },
  ],
};
