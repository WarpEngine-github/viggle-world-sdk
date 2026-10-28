/**
 * Ragdoll: physics-driven {@link PoseProvider} for a character.
 *
 * ## Mode is strictly binary
 *
 * When the ragdoll is enabled, animation evaluation is fully replaced
 * by physics. No per-bone blend, no transition window. This is a
 * deliberate design choice - it keeps the pose write-back path simple
 * and makes it unambiguous which subsystem owns the pose at any
 * moment. If you need "the right arm goes ragdoll while the rest
 * keeps animating," this module isn't it; you'd build a partial-mask
 * pose provider on the same {@link PoseProvider} hook instead.
 *
 * ## Rig conventions
 *
 * Bodies are placed assuming each bone's bind-pose **direction** is
 * captured by `endBoneName` in the config (e.g. pelvis's direction is
 * the vector to spine_03). For terminal bones without a useful end
 * bone (head, hand, foot), the body axis defaults to the bone's
 * bind-pose **local +Y** in model space - true for UE-style rigs that
 * follow the standard humanoid bone naming (`pelvis`, `spine_NN`,
 * `upperarm_l/r`, etc.). Other rig conventions can be supported by
 * authoring a {@link RagdollConfig} that specifies `endBoneName`
 * everywhere instead of relying on the fallback.
 *
 * @module
 * @group Ragdoll
 */

import { Color, Entity, Mat4, Quat, Vec3 } from 'playcanvas';

import { computeBindPoseTransforms } from '../anim/bind-pose';
import type { Armature, PoseProvider } from '../armature';
import { createGeneric6DofJoint } from '../physics/joints';
import type { JointHandle } from '../physics/joints';
import type { Scene } from '../scene';

import type { Pose } from './pose';
import { DEFAULT_HUMANOID_RAGDOLL } from './ragdoll-config';
import type {
  RagdollBoneDesc,
  RagdollConfig,
  RagdollJointDesc,
} from './ragdoll-config';
import type { Skeleton } from './skeleton';

/**
 * Information passed to {@link Ragdoll.onLimbDetached} listeners.
 *
 * @group Ragdoll
 */
export interface LimbDetachedInfo {
  /** Bone name (as authored in the config) whose joint just severed. */
  boneName: string;
  /** World-space position of the joint anchor at the moment of
   *  severance. A natural spawn point for blood/spark VFX. */
  worldPos: Vec3;
}

/**
 * Physics-driven ragdoll for a character. Owns one capsule rigid body
 * per configured bone plus the joints between them. Implements
 * {@link PoseProvider}; the Armature itself has no ragdoll knowledge.
 *
 * Lifecycle:
 *   - Construct: cheap, no bodies yet, just resolves bone names.
 *   - `enable()`: build bodies + joints at the armature's current
 *     pose, install as the armature's `poseProvider`.
 *   - `applyImpulse(boneName, impulse)`: kick a specific body.
 *   - `disable()`: tear down, animation resumes.
 *
 * Bodies parent to `scene.contentRoot` (not the armature entity);
 * once active they have their own world transforms driven by Ammo.
 * The armature entity stays put - the pose write-back absorbs the
 * world position into bone-local TRS, so the splat deforms to the
 * physics-driven world either way. Trade-off: distance-LOD / frustum
 * culling bands are computed against the spawn origin, not the
 * ragdoll's drift. Fine for short-distance ragdolls.
 *
 * Requires the scene to have physics enabled
 * ({@link CreateSceneOptions.physics}).
 *
 * @group Ragdoll
 */
export class Ragdoll implements PoseProvider {
  private readonly _armature: Armature;
  private readonly _scene: Scene;
  private readonly _armatureEntity: Entity;
  private readonly _skeleton: Skeleton;
  private readonly _bindWorld: Mat4[];
  /** Live reference to the armature's per-bone world matrices. */
  private readonly _worldTransforms: readonly Mat4[];

  /** Ragdoll bone records, ordered to match the config. */
  private readonly _bones: RagdollBone[] = [];
  /** boneIdx → ragdoll-bone record (lookup for parent-chain walks). */
  private readonly _byBoneIdx = new Map<number, RagdollBone>();

  private _active = false;
  private _container: Entity | null = null;
  private _joints: JointHandle[] = [];

  // Workspace mat4s reused per-frame in writePose.
  private readonly _tmpMat = new Mat4();
  private readonly _tmpMat2 = new Mat4();

  // Per-bone world-transform cache for writePose, allocated lazily on
  // first use and reused across frames. `_writePoseHas[i]` is the
  // "populated this frame" flag - cheaper to reset than to refill the
  // matrix array with nulls.
  private _writePoseBoneWorld: Mat4[] = [];
  private _writePoseHas: boolean[] = [];

  /**
   * Build a Ragdoll bound to `armature`. The scene attached to that
   * armature must have physics enabled - throws otherwise.
   *
   * @param args.armature - Target armature. Must already be attached to a scene.
   * @param args.config - Bone/joint descriptor. Defaults to
   *   {@link DEFAULT_HUMANOID_RAGDOLL} (works for any rig that follows
   *   the standard UE-style bone naming).
   */
  constructor(args: {
    armature: Armature;
    config?: RagdollConfig;
  }) {
    const scene = args.armature.scene;
    if (!scene) {
      throw new Error('[Ragdoll] armature is not attached to a scene yet.');
    }

    this._armature = args.armature;
    this._scene = scene;
    this._armatureEntity = args.armature.entity;
    this._skeleton = args.armature.skeleton;
    this._worldTransforms = args.armature.boneWorldMatrices;

    this._bindWorld = computeBindPoseTransforms(
      this._skeleton.numBones,
      this._skeleton.bindT,
      this._skeleton.bindR,
      this._skeleton.parents,
    );

    // Build a name→idx lookup, then resolve every config entry. Skip any
    // entry whose bone (or end bone, or parent) is missing - config is
    // designed for the standard humanoid rig but should degrade
    // gracefully on smaller rigs (e.g. props with only a torso).
    const boneNames = args.armature.boneNames;
    const nameToIdx = new Map<string, number>();
    for (let i = 0; i < boneNames.length; i++) {
      const n = boneNames[i];
      if (n) nameToIdx.set(n, i);
    }

    const config = args.config ?? DEFAULT_HUMANOID_RAGDOLL;

    // First pass: build bone records. Skip if the bone itself is missing.
    for (const desc of config.bones) {
      const idx = nameToIdx.get(desc.boneName);
      if (idx === undefined) continue;
      const record = buildBoneRecord(desc, idx, nameToIdx, this._bindWorld);
      if (!record) continue;
      this._bones.push(record);
      this._byBoneIdx.set(idx, record);
    }

    // Second pass: resolve parents.
    for (const b of this._bones) {
      if (!b.parentName) continue;
      const parentIdx = nameToIdx.get(b.parentName);
      if (parentIdx === undefined) continue;
      const parent = this._byBoneIdx.get(parentIdx);
      if (!parent) continue;
      b.parent = parent;
    }

    // Third pass: precompute the skeleton subtree for each ragdoll
    // bone. When the bone detaches, splats weighted to anything in
    // its subtree go with it. The subtree is over the actual skeleton
    // hierarchy (`Skeleton.parents`), NOT the ragdoll graph - a single
    // ragdoll-bone like upperarm_l owns its full skeletal descent
    // (upperarm_l, lowerarm_l, hand_l, plus any intermediate twist
    // bones the rig has but ragdoll doesn't represent).
    this._computeSubtrees();
  }

  /** Build each `RagdollBone.subtreeBones` set by walking
   *  `Skeleton.parents`. O(numBones × numRagdollBones) - runs once. */
  private _computeSubtrees(): void {
    const parents = this._skeleton.parents;
    const n = this._skeleton.numBones;
    for (const b of this._bones) {
      const set = b.subtreeBones;
      set.clear();
      set.add(b.boneIdx);
      // Walk every bone; if its parent-chain passes through b.boneIdx,
      // include it. Cheap enough at humanoid scale (~86 bones).
      for (let i = 0; i < n; i++) {
        let cur = parents[i];
        while (cur >= 0 && cur < n) {
          if (cur === b.boneIdx) { set.add(i); break; }
          cur = parents[cur];
        }
      }
    }
  }

  /** Whether the ragdoll is currently active (bodies are in the physics world). */
  get isActive(): boolean {
    return this._active;
  }

  /**
   * Live PC `Entity` carrying the rigid body for `boneName`, or `null`
   * if the ragdoll isn't active or no body is configured for that bone.
   * Use to apply continued forces (`entity.rigidbody.applyForce(...)`),
   * read velocities, attach extra constraints, or wire bone-tracked
   * effects to a specific limb. Reference is invalidated by
   * {@link disable}.
   */
  getBodyEntity(boneName: string): Entity | null {
    if (!this._active) return null;
    const b = this._bones.find((x) => x.descBoneName === boneName);
    return b?.bodyEntity ?? null;
  }

  // ── Limb detachment ────────────────────────────────────────────

  private _detachListeners: Array<(info: LimbDetachedInfo) => void> = [];

  /**
   * Names of bones whose joint-to-parent has been severed during this
   * enable() session (manually via {@link detach} or by Bullet's
   * break threshold). Cleared on `disable()`.
   */
  get detachedBones(): readonly string[] {
    const out: string[] = [];
    for (const b of this._bones) if (b.detached) out.push(b.descBoneName);
    return out;
  }

  /**
   * Sever the joint connecting `boneName`'s body to its parent body.
   * The body and the skeletal subtree it represents continue to exist
   * as free physics bodies - they just stop being constrained to the
   * rest of the ragdoll. Fires {@link onLimbDetached}.
   *
   * No-op if the ragdoll is not active, the bone has no parent joint
   * (root bone), or the bone has already been detached.
   */
  detach(boneName: string): void {
    if (!this._active) return;
    const b = this._bones.find((x) => x.descBoneName === boneName);
    if (!b || !b.parentJoint || b.detached) return;
    this._severJoint(b);
  }

  /**
   * Subscribe to limb-detach events. Listener fires once per
   * detachment (manual or break-threshold) while the ragdoll is
   * active. Returns an unsubscribe function. All listeners are
   * automatically cleared on {@link disable}.
   *
   * The reported `worldPos` is the joint anchor's world position at
   * the moment of severance - a sensible spawn point for blood/spark
   * VFX.
   */
  onLimbDetached(cb: (info: LimbDetachedInfo) => void): () => void {
    this._detachListeners.push(cb);
    return () => {
      const i = this._detachListeners.indexOf(cb);
      if (i >= 0) this._detachListeners.splice(i, 1);
    };
  }

  /** Tear down a single bone's parent joint and fire listeners.
   *  Internal - used by manual {@link detach} and by the per-frame
   *  break-threshold poll in {@link writePose}. */
  private _severJoint(b: RagdollBone): void {
    const joint = b.parentJoint;
    if (!joint) return;
    // Capture the joint anchor world before we tear anything down.
    const worldPos = new Vec3();
    if (b.bodyEntity) {
      // Anchor in body local is (0, -length/2, 0) per the authoring
      // convention; transform to world via the current body pose.
      const local = _detachLocal.set(0, -b.length * 0.5, 0);
      b.bodyEntity.getWorldTransform().transformPoint(local, worldPos);
    }
    joint.remove();
    const idx = this._joints.indexOf(joint);
    if (idx >= 0) this._joints.splice(idx, 1);
    b.parentJoint = null;
    b.detached = true;

    // Snap every splat's bone weights to one side of the broken
    // joint so gaussians weighted across the cut don't stretch
    // between the now-separated bodies. Privatizes the splat's bone
    // textures on first detach.
    this._rewriteSplatWeightsForSubtree(b.subtreeBones);

    const info: LimbDetachedInfo = { boneName: b.descBoneName, worldPos };
    // Copy listener list before dispatch so a listener that
    // unsubscribes itself doesn't perturb iteration.
    const listeners = this._detachListeners.slice();
    for (const fn of listeners) {
      try { fn(info); } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[Ragdoll] onLimbDetached listener threw:', err);
      }
    }
  }

  /** Per-frame poll: any joint with a break threshold whose
   *  `isBroken()` flipped this step gets severed via the normal
   *  detach path. Called from {@link writePose}. */
  private _pollBrokenJoints(): void {
    for (const b of this._bones) {
      if (b.detached || !b.parentJoint) continue;
      if (b.parentJoint.isBroken()) this._severJoint(b);
    }
  }

  /**
   * Snap every linked splat's bone weights so each gaussian sits
   * entirely on one side of the cut - either fully weighted to bones
   * in `subtreeBones` (= goes with the detached limb) or fully
   * weighted to bones outside (= stays with the rest of the body).
   *
   * Implementation: per splat, sum its weights on each side. The
   * heavier side keeps its weights (zero out the other side's
   * influences), then renormalize the remaining weights to sum to
   * 1. Privatizes the splat's bone-weight buffers on first call so
   * other character instances of the same asset are unaffected.
   */
  private _rewriteSplatWeightsForSubtree(subtreeBones: Set<number>): void {
    for (const splat of this._armature.linkedSplats) {
      if (!splat.splatWeights) continue;
      splat.privatizeBoneWeights();

      const { indices, weights } = splat.splatWeights;
      const numSplats = splat.numSplats;
      const K = indices.length / numSplats; // top-K influences, typically 4
      for (let i = 0; i < numSplats; i++) {
        const base = i * K;
        let wIn = 0;
        let wOut = 0;
        for (let k = 0; k < K; k++) {
          const w = weights[base + k];
          if (w === 0) continue;
          if (subtreeBones.has(indices[base + k])) wIn += w;
          else wOut += w;
        }
        if (wIn === 0 || wOut === 0) continue; // splat is already pure
        const keepInside = wIn >= wOut;
        let kept = 0;
        for (let k = 0; k < K; k++) {
          const inside = subtreeBones.has(indices[base + k]);
          if (inside !== keepInside) {
            weights[base + k] = 0;
          } else {
            kept += weights[base + k];
          }
        }
        if (kept > 0 && kept !== 1) {
          // Renormalise the kept side so total weight stays 1.
          const inv = 1 / kept;
          for (let k = 0; k < K; k++) {
            if (weights[base + k] !== 0) weights[base + k] *= inv;
          }
        }
      }
      splat.reuploadBoneWeights();
    }
  }

  /**
   * Take over from animation: build physics bodies at the current
   * (animated) pose's world positions, wire up joints, and install
   * this Ragdoll as the armature's pose provider. Apply impulses
   * (e.g. for a death-kick) AFTER enable returns via
   * {@link applyImpulse}.
   *
   * Caller's contract: the armature must have run update() at least
   * once before enable(), so the bone world matrices used to place
   * the bodies reflect the current animated pose.
   *
   * No-op if the ragdoll is already active.
   */
  enable(opts?: {
    /** Whether bodies collide with each other across joints. Default `false`. */
    selfCollide?: boolean;
  }): void {
    if (this._active) return;
    this._buildContainer();
    this._buildBodies(opts?.selfCollide ?? false);
    this._buildJoints();
    this._active = true;
    // Install ourselves as the armature's pose provider. The setter
    // detaches any previous provider for us (firing its onDetach).
    this._armature.poseProvider = this;
  }

  /**
   * Apply a world-space impulse (N·s) to the body for `boneName`. Pass
   * `'*'` to apply the same impulse to every body - useful for an
   * explosion-style push. Silently no-ops if the ragdoll isn't active
   * or if the bone has no body.
   *
   * Typical use: kick the ragdoll on activation.
   * ```ts
   * ragdoll.enable();
   * ragdoll.applyImpulse('pelvis', new Vec3(0, 8, -10));
   * ```
   */
  applyImpulse(boneName: string, impulse: Vec3): void {
    if (!this._active) return;
    if (boneName === '*') {
      for (const b of this._bones) {
        b.bodyEntity?.rigidbody?.applyImpulse(impulse);
      }
      return;
    }
    const entry = this._bones.find((b) => b.descBoneName === boneName);
    entry?.bodyEntity?.rigidbody?.applyImpulse(impulse);
  }

  // ── enable() helpers ───────────────────────────────────────────

  private _buildContainer(): void {
    const container = new Entity('ragdoll');
    this._scene.contentRoot.addChild(container);
    this._container = container;
  }

  /** Create one capsule body per ragdoll bone at its current animated
   *  world transform. Parent under the ragdoll container. */
  private _buildBodies(selfCollide: boolean): void {
    const container = this._container!;
    const tmpPos = new Vec3();
    const tmpRot = new Quat();

    for (const b of this._bones) {
      const boneWorld = this._currentBoneWorld(b.boneIdx, this._tmpMat);
      const bodyWorld = this._tmpMat2.mul2(boneWorld, b.boneToBody);
      bodyWorld.getTranslation(tmpPos);
      tmpRot.setFromMat4(bodyWorld);

      const e = new Entity(`ragdoll-${b.descBoneName}`);
      e.setPosition(tmpPos);
      e.setRotation(tmpRot);
      e.addComponent('collision', {
        type: 'capsule',
        radius: b.radius,
        // `height` is total length including both hemispherical caps
        // (PC convention). We deliberately extend `radius` past each
        // bone endpoint so the capsule wraps the joint regions, not
        // just the bone segment - feet, hands, and head read as solid
        // rather than as a thin shaft with a cap floating off.
        height: b.length + b.radius * 2,
        // PC's capsule axis: 0=X, 1=Y, 2=Z. Default Y - matches our
        // bone-direction-along-local-Y authoring convention.
        axis: 1,
      });
      e.addComponent('rigidbody', {
        type: 'dynamic',
        mass: b.mass,
        friction: 0.6,
        restitution: 0.1,
        // Damping keeps the ragdoll from looking jittery and helps it
        // settle after a few seconds.
        linearDamping: 0.05,
        angularDamping: 0.1,
        // PC collision groups (bit-flags): 1 = DYNAMIC, 2 = STATIC,
        // 4 = KINEMATIC, 8+ user. Default mode puts ragdoll bodies on
        // user bit 8 and excludes only that bit from the mask so
        // bodies don't collide with each other but still hit the
        // static world (group 2) and other dynamics (group 1). Group
        // 2 is the tempting "non-default" pick but conflicts with
        // PC's static-body group - ragdoll then falls through the
        // floor.
        group: selfCollide ? 1 : 8,
        mask: selfCollide ? 0xffff : 0xfff7,
      });
      container.addChild(e);
      b.bodyEntity = e;
    }
  }

  /** Wire up the joints linking each body to its parent body. Skips
   *  bones with no parent (root) or no joint descriptor. */
  private _buildJoints(): void {
    for (const b of this._bones) {
      b.parentJoint = null;
      b.detached = false;
      if (!b.parent || !b.jointDesc || !b.bodyEntity || !b.parent.bodyEntity) continue;
      const joint = makeJoint(this._scene, b, b.parent, b.jointDesc);
      if (!joint) continue;
      this._joints.push(joint);
      b.parentJoint = joint;
    }
  }

  /**
   * Tear down the physics bodies and joints, and detach from the
   * armature's pose-provider slot so animation resumes next frame.
   * No-op if already disabled. Safe to call repeatedly.
   */
  disable(): void {
    if (!this._active) return;
    this._teardownBodies();
    // Setter is the user-facing teardown signal. When the setter calls
    // back into onDetach below, _teardownBodies short-circuits (already
    // inactive), so no recursion problem.
    if (this._armature.poseProvider === this) {
      this._armature.poseProvider = null;
    }
  }

  /**
   * {@link PoseProvider.onDetach} - called by the Armature when it's
   * destroyed or when another provider replaces us. Tears down bodies
   * but does NOT touch `armature.poseProvider` (the setter is mid-
   * transition; mutating it from here would either overwrite the new
   * provider or recurse).
   */
  onDetach(): void {
    this._teardownBodies();
  }

  /** Release physics bodies, joints, and the container entity. Sets
   *  `_active = false`. Idempotent. */
  private _teardownBodies(): void {
    if (!this._active) return;
    this._active = false;
    for (const j of this._joints) j.remove();
    this._joints.length = 0;
    for (const b of this._bones) {
      b.bodyEntity = null;
      b.parentJoint = null;
      b.detached = false;
    }
    this._container?.destroy();
    this._container = null;
    this._detachListeners.length = 0;
  }

  /**
   * Full cleanup: tear down bodies (if active) plus any debug
   * visualization. Call when discarding a Ragdoll instance (e.g. on
   * character respawn) - `disable()` alone leaves the debug viz
   * running.
   */
  destroy(): void {
    this.disable();
    this.setDebugVisible(false);
  }

  // ── Debug visualization ─────────────────────────────────────────

  private _debugUpdateHandler: ((dt: number) => void) | null = null;
  /** Cached per-body corner Vec3 buffer (8 corners × bodyCount) so we
   *  don't allocate per-frame. */
  private _debugCorners: Vec3[][] = [];
  /** Flat positions buffer for `app.drawLines` - 24 Vec3s per body
   *  (12 edges × 2 endpoints), reused each frame. Allocated when debug
   *  viz is first turned on. */
  private _debugLineBuffer: Vec3[] = [];

  /** Whether the debug box visualization is currently visible. */
  get debugVisible(): boolean { return this._debugUpdateHandler !== null; }

  /**
   * Show or hide debug wireframe boxes mirroring each configured
   * ragdoll body. Drawn via PC's immediate-mode `app.drawLine` (no
   * depth test) so they always render on top of splats / standard
   * meshes / each other. Boxes follow bones via the same `boneToBody`
   * offset the physics bodies use, so they sit in the right place both
   * during animation (no physics) and during ragdoll (physics-driven).
   * Use for tuning capsule radii / lengths in the config.
   */
  setDebugVisible(visible: boolean): void {
    if (visible === this.debugVisible) return;
    if (visible) {
      if (this._debugCorners.length !== this._bones.length) {
        this._debugCorners = this._bones.map(() =>
          Array.from({ length: 8 }, () => new Vec3()),
        );
        // 24 positions per body: 12 edges × 2 endpoints, all stored
        // by REFERENCE into _debugCorners so we only write once per
        // corner per frame and reuse for both endpoints of adjacent
        // edges.
        const buf: Vec3[] = [];
        for (const corners of this._debugCorners) {
          // Edge index pairs into the 8-corner array. Matches the
          // order in _drawDebug.
          const e = _BOX_EDGES;
          for (let i = 0; i < e.length; i++) buf.push(corners[e[i]]);
        }
        this._debugLineBuffer = buf;
      }
      const handler = () => this._drawDebug();
      this._scene.app.on('update', handler);
      this._debugUpdateHandler = handler;
    } else if (this._debugUpdateHandler) {
      this._scene.app.off('update', this._debugUpdateHandler);
      this._debugUpdateHandler = null;
    }
  }

  /** Per-frame: refresh corners for each body, then submit all edges
   *  in one batched `app.drawLines` call. Lines are queued onto the
   *  app's immediate layer (depthTest=false) and drained at end-of-
   *  frame. */
  private _drawDebug(): void {
    for (let i = 0; i < this._bones.length; i++) {
      const b = this._bones[i];
      const boneWorld = this._worldTransforms[b.boneIdx];
      if (!boneWorld) continue;
      const bodyWorld = _dbgMat.mul2(boneWorld, b.boneToBody);

      // 8 box corners in body-local space (Y = bone direction). Set
      // once, then transform each to world into the cached per-body
      // corner buffer. The _debugLineBuffer holds references to those
      // corners, so updating them here updates the line buffer too.
      const r = b.radius;
      const h = b.length * 0.5;
      _dbgLocal[0].set(-r, -h, -r); _dbgLocal[1].set( r, -h, -r);
      _dbgLocal[2].set( r, -h,  r); _dbgLocal[3].set(-r, -h,  r);
      _dbgLocal[4].set(-r,  h, -r); _dbgLocal[5].set( r,  h, -r);
      _dbgLocal[6].set( r,  h,  r); _dbgLocal[7].set(-r,  h,  r);
      const corners = this._debugCorners[i];
      for (let c = 0; c < 8; c++) {
        bodyWorld.transformPoint(_dbgLocal[c], corners[c]);
      }
    }
    // One batched submission: 12 edges × bodyCount × 2 endpoints.
    this._scene.app.drawLines(this._debugLineBuffer, _dbgColor, false);
  }

  /**
   * {@link PoseProvider} implementation. Replaces the entire pose with
   * values derived from the bodies' world transforms.
   *
   * Strategy: reset every bone to bind first, then overwrite the
   * ragdoll-driven bones. Intermediate skeleton bones (e.g. spine_01
   * sitting between pelvis and spine_03) stay at bind - they don't
   * articulate. This is the simplification the "pure physics" mode
   * buys us.
   *
   * The armature entity is NOT moved to follow the pelvis. The
   * bone-local TRS we write absorbs the world position; the splat
   * deforms to the physics-driven world either way. (An earlier
   * version that moved the entity caused the character to vanish -
   * a gsplat AABB interaction with simultaneous bone-matrix changes.)
   */
  writePose(pose: Pose, _armature: Armature, _dt: number): void {
    if (!this._active) return;

    // Check for joints that broke during the most recent physics
    // step before reading bodies. Listeners fire here; detaching a
    // limb doesn't change the per-bone body-read loop below - the
    // body is still in the world, just no longer joint-constrained.
    this._pollBrokenJoints();

    // Reset every bone to bind. Cheap; avoids stale animation values
    // bleeding into intermediate non-ragdoll bones.
    pose.setToBind(this._skeleton.bindT, this._skeleton.bindR);

    // For each ragdoll-driven bone, derive its desired world from the
    // body, then convert to local TRS relative to its skeleton-parent
    // bone's world transform (which uses bind values for intermediate
    // non-ragdoll bones, by construction).
    const parents = this._skeleton.parents;
    const numBones = this._skeleton.numBones;
    const entityWorld = this._armatureEntity.getWorldTransform();

    // Anchor the rig's root bone (parent of pelvis in the skeleton) to
    // the pelvis body's current world transform. Without this, root
    // stays at its bind position relative to the entity, and any
    // splat weighted to "root" renders at the entity spawn point
    // instead of following the ragdoll - visible as gaussians floating
    // in mid-air at (0,0,0) when a limb detaches. The pelvis bone
    // itself then resolves to identity in the main loop below
    // (parentInv * desired = desired^-1 * desired = identity), which
    // is correct.
    const pelvisBone = this._bones[0];
    if (pelvisBone?.bodyEntity) {
      const skelRootIdx = parents[pelvisBone.boneIdx];
      if (skelRootIdx >= 0 && skelRootIdx < numBones) {
        const bodyW = pelvisBone.bodyEntity.getWorldTransform();
        const desiredPelvisW = this._tmpMat.mul2(bodyW, pelvisBone.bodyToBone);
        const entInv = this._tmpMat2.copy(entityWorld); entInv.invert();
        const rootLocal = _localMat.mul2(entInv, desiredPelvisW);
        rootLocal.getTranslation(pose.positions[skelRootIdx]);
        rootLocal.getScale(pose.scales[skelRootIdx]);
        pose.rotations[skelRootIdx].setFromMat4(rootLocal);
      }
    }

    // Per-bone world-transform cache. Grow the Mat4 array once (covers
    // all future frames since rigs don't change size at runtime) and
    // clear only the populated-flag array each frame.
    const boneWorld = this._writePoseBoneWorld;
    const has = this._writePoseHas;
    while (boneWorld.length < numBones) boneWorld.push(new Mat4());
    if (has.length < numBones) has.length = numBones;
    for (let i = 0; i < numBones; i++) has[i] = false;

    const getBoneWorld = (i: number): Mat4 => {
      if (has[i]) return boneWorld[i];
      const out = boneWorld[i];
      const pi = parents[i];
      const local = _localMat;
      local.setTRS(pose.positions[i], pose.rotations[i], pose.scales[i]);
      if (pi < 0 || pi >= numBones) {
        out.mul2(entityWorld, local);
      } else {
        const parentW = getBoneWorld(pi);
        out.mul2(parentW, local);
      }
      has[i] = true;
      return out;
    };

    // Compute desired world for each ragdoll bone, then back out its
    // local TRS using its parent's world.
    for (const b of this._bones) {
      if (!b.bodyEntity) continue;
      // desired bone world = body world * boneToBody^-1 = body world * bodyToBone
      const bodyW = b.bodyEntity.getWorldTransform();
      const desired = this._tmpMat;
      desired.mul2(bodyW, b.bodyToBone);

      const parentIdx = parents[b.boneIdx];
      let parentW: Mat4;
      if (parentIdx < 0 || parentIdx >= numBones) {
        parentW = entityWorld;
      } else {
        parentW = getBoneWorld(parentIdx);
      }

      // localTRS = parentW^-1 * desired
      const parentInv = this._tmpMat2;
      parentInv.copy(parentW);
      parentInv.invert();
      const local = _localMat;
      local.mul2(parentInv, desired);

      // Decompose into TRS. PC's Mat4 exposes getTranslation/getScale/getRotation
      // (the rotation getter pulls a Quat from the upper-left 3×3).
      local.getTranslation(pose.positions[b.boneIdx]);
      local.getScale(pose.scales[b.boneIdx]);
      // Mat4 → Quat: use setFromMat4 on the Quat. Don't trust scale ≠ 1
      // here - we authored bodies as unit-scale and the math doesn't
      // introduce scale, so getRotation-via-quat-setFromMat4 is safe.
      pose.rotations[b.boneIdx].setFromMat4(local);

      // Cache so descendant ragdoll bones can read this world directly
      // instead of walking the chain. boneWorld[i] is always present
      // (pre-allocated above); we just stamp the value and flag it.
      boneWorld[b.boneIdx].copy(desired);
      has[b.boneIdx] = true;
    }
  }

  /** Read the bone's current world matrix from the armature's array.
   *  Falls back to entityWorld * bindWorld if the array hasn't been
   *  populated yet (e.g. enable() called before the first update()). */
  private _currentBoneWorld(boneIdx: number, out: Mat4): Mat4 {
    const m = this._worldTransforms[boneIdx];
    if (m) {
      out.copy(m);
      return out;
    }
    out.mul2(this._armatureEntity.getWorldTransform(), this._bindWorld[boneIdx]);
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Internal: per-bone record built once at construction.
// ─────────────────────────────────────────────────────────────────────────

interface RagdollBone {
  /** As authored in the config (for debug + impulse target lookup). */
  descBoneName: string;
  /** Skeleton bone index. */
  boneIdx: number;
  /** Parent body's bone name, or null if root. */
  parentName: string | null;
  /** Resolved parent record, set in the constructor's second pass. */
  parent: RagdollBone | null;
  /** Joint to the parent body. Null if root. */
  jointDesc: RagdollJointDesc | null;
  /** Capsule length (m). */
  length: number;
  /** Capsule radius (m). */
  radius: number;
  /** Body mass (kg). */
  mass: number;
  /** Constant offset from bone frame to body frame (in bone-local space). */
  boneToBody: Mat4;
  /** Inverse of `boneToBody`. */
  bodyToBone: Mat4;
  /**
   * Set of skeleton bone indices for the descendant subtree rooted at
   * `boneIdx` (inclusive). Used when this bone is detached to decide
   * which splats belong to the severed limb. Precomputed at Ragdoll
   * construction from {@link Skeleton.parents}.
   */
  subtreeBones: Set<number>;
  /** Live body entity while ragdoll is active; null otherwise. */
  bodyEntity: Entity | null;
  /** Joint connecting this body to its parent body. Null for the root
   *  bone or for bones whose joint has been severed via {@link detach}
   *  or by Bullet's break threshold. */
  parentJoint: JointHandle | null;
  /** True once this bone's parent joint has been severed. Stays true
   *  until the Ragdoll is disabled. */
  detached: boolean;
}

function buildBoneRecord(
  desc: RagdollBoneDesc,
  boneIdx: number,
  nameToIdx: Map<string, number>,
  bindWorld: Mat4[],
): RagdollBone | null {
  // Resolve capsule length + direction. Prefer endBoneName when present.
  const bonePos = _vec1;
  bindWorld[boneIdx].getTranslation(bonePos);

  const dir = _vec2;
  let length = desc.length ?? 0;
  if (desc.endBoneName) {
    const endIdx = nameToIdx.get(desc.endBoneName);
    if (endIdx !== undefined) {
      const endPos = _vec3;
      bindWorld[endIdx].getTranslation(endPos);
      dir.sub2(endPos, bonePos);
      length = dir.length();
      if (length > 1e-5) dir.mulScalar(1 / length);
    }
  }
  if (length < 1e-4) {
    // No usable end bone and no explicit length → can't build. Skip.
    return null;
  }
  if (!desc.endBoneName) {
    // length-only fallback: capsule points along bone's local +Y in
    // world. Compute that direction.
    const localY = _vec3.set(0, 1, 0);
    bindWorld[boneIdx].transformVector(localY, dir);
    if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
    dir.normalize();
  }

  // body bind world transform: position = bone + dir * length/2,
  //                            rotation = rotates local Y to dir
  const bodyWorldPos = new Vec3().add2(bonePos, _vec4.copy(dir).mulScalar(length * 0.5));
  const bodyWorldRot = new Quat();
  quatFromYTo(dir, bodyWorldRot);

  const bodyWorld = new Mat4().setTRS(bodyWorldPos, bodyWorldRot, _UNIT_SCALE);

  // boneToBody = bindWorld(bone)^-1 * bodyWorld
  const boneInv = new Mat4();
  boneInv.copy(bindWorld[boneIdx]);
  boneInv.invert();
  const boneToBody = new Mat4().mul2(boneInv, bodyWorld);

  const bodyToBone = new Mat4();
  bodyToBone.copy(boneToBody);
  bodyToBone.invert();

  return {
    descBoneName: desc.boneName,
    boneIdx,
    parentName: desc.parent,
    parent: null,
    jointDesc: desc.joint ?? null,
    length,
    radius: desc.radius,
    mass: desc.mass,
    boneToBody,
    bodyToBone,
    subtreeBones: new Set([boneIdx]), // filled in by Ragdoll ctor
    bodyEntity: null,
    parentJoint: null,
    detached: false,
  };
}

function makeJoint(
  scene: Scene,
  child: RagdollBone,
  parent: RagdollBone,
  desc: RagdollJointDesc,
): JointHandle | null {
  if (!child.bodyEntity || !parent.bodyEntity) return null;

  // Use the bodies' CURRENT world transforms (we just placed them at
  // the current animated pose during enable()).
  const childBodyWorld = _jmChildBody.copy(child.bodyEntity.getWorldTransform());
  const parentBodyWorld = _jmParentBody.copy(parent.bodyEntity.getWorldTransform());

  // Anchor at the proximal end of the child capsule, which by our
  // authoring convention is at (0, −length/2, 0) in the child body's
  // local frame. Compute its world position from there.
  const pivotInChild = new Vec3(0, -child.length * 0.5, 0);
  const anchorWorld = _vec1;
  childBodyWorld.transformPoint(pivotInChild, anchorWorld);

  // Express the same anchor in parent body local.
  const parentBodyInv = _jmParentBodyInv.copy(parentBodyWorld); parentBodyInv.invert();
  const pivotInParent = new Vec3();
  parentBodyInv.transformPoint(anchorWorld, pivotInParent);

  if (desc.type === 'hinge') {
    // Validate: btGeneric6DofConstraint treats `low > high` as
    // "axis is free" - almost certainly not what the author meant if
    // they typed inverted values. Catch early.
    if (desc.low > desc.high) {
      throw new Error(
        `[Ragdoll] hinge ${parent.descBoneName}->${child.descBoneName}: ` +
        `low (${desc.low}) > high (${desc.high}); did you mean to swap them?`,
      );
    }
    // Hinge as 6DOF: anchor a joint frame whose X axis IS the hinge
    // axis (in child body local), lock translation + Y/Z rotation,
    // allow X rotation within [low, high].
    let axisAlignRot: Quat;
    if (desc.axis === 'x') {
      // Frame X = child body X. No rotation.
      axisAlignRot = new Quat();
    } else if (desc.axis === 'y') {
      // Frame X = child body Y → rotate frame's X to Y axis: Rz(90°).
      axisAlignRot = new Quat().setFromAxisAngle(_vec3.set(0, 0, 1), 90);
    } else {
      // Frame X = child body Z → rotate frame's X to Z axis: Ry(-90°).
      axisAlignRot = new Quat().setFromAxisAngle(_vec3.set(0, 1, 0), -90);
    }
    const axisAlignMat = _jmAlign.setTRS(_zeroVec, axisAlignRot, _UNIT_SCALE);

    const jointWorldMat = _jmJointWorld.mul2(childBodyWorld, axisAlignMat);
    const frameInChildRot = axisAlignRot.clone();
    const frameInParentMat = _jmFrameInParent.mul2(parentBodyInv, jointWorldMat);
    const frameInParentRot = new Quat().setFromMat4(frameInParentMat);

    return createGeneric6DofJoint({
      app: scene.app,
      bodyA: parent.bodyEntity,
      bodyB: child.bodyEntity,
      frameInA: { position: pivotInParent, rotation: frameInParentRot },
      frameInB: { position: pivotInChild, rotation: frameInChildRot },
      angularLowerLimit: new Vec3(desc.low, 0, 0),
      angularUpperLimit: new Vec3(desc.high, 0, 0),
      breakImpulse: desc.breakImpulse,
    });
  }

  // Cone-twist: the joint frame's X axis is the cone axis. We anchor
  // it along the CHILD's bone direction (= child body's local +Y).
  // Crucially, both bodies' joint frames must COINCIDE in world space
  // at the moment of construction - same origin, same orientation -
  // or Bullet sees an initial constraint violation that the solver
  // either explodes from (NaN) or fights forever (frozen bodies).
  //
  //   jointWorld_rot = childBodyWorld_rot · Rz(90°)
  //     → joint frame's X axis in world = child body's local Y in world = bone dir
  //   frameInChild_rot = childBodyWorld_rot⁻¹ · jointWorld_rot = Rz(90°)
  //   frameInParent_rot = parentBodyWorld_rot⁻¹ · jointWorld_rot
  //                     = parentBodyWorld_rot⁻¹ · childBodyWorld_rot · Rz(90°)
  const zRot90 = new Quat().setFromAxisAngle(_vec3.set(0, 0, 1), 90);
  const zRot90Mat = _jmAlign.setTRS(_zeroVec, zRot90, _UNIT_SCALE);

  // jointWorldMat = childBodyWorld · Rz(90°)
  const jointWorldMat = _jmJointWorld.mul2(childBodyWorld, zRot90Mat);

  // frameInChild_rot - extract from Rz(90°) directly; setFromAxisAngle.
  const frameInChildRot = zRot90.clone();

  // frameInParent_rot = parentBodyWorld⁻¹ · jointWorldMat
  const frameInParentMat = _jmFrameInParent.mul2(parentBodyInv, jointWorldMat);
  const frameInParentRot = new Quat().setFromMat4(frameInParentMat);

  // Build the cone-twist with a btGeneric6DofConstraint - the same
  // frame setup as btConeTwistConstraint but a more robust solver.
  // Frame convention: X = twist axis, Y/Z = swing axes. Locked
  // translation makes the joint a pure ball-and-socket; angular
  // limits express the cone.
  const swingY = desc.swingY ?? Math.PI / 4;
  const swingZ = desc.swingZ ?? Math.PI / 4;
  const twist = desc.twist ?? Math.PI / 6;
  return createGeneric6DofJoint({
    app: scene.app,
    bodyA: parent.bodyEntity,
    bodyB: child.bodyEntity,
    frameInA: { position: pivotInParent, rotation: frameInParentRot },
    frameInB: { position: pivotInChild, rotation: frameInChildRot },
    angularLowerLimit: new Vec3(-twist, -swingY, -swingZ),
    angularUpperLimit: new Vec3(twist, swingY, swingZ),
    breakImpulse: desc.breakImpulse,
  });
}

// ── Math helpers ────────────────────────────────────────────────────────
// Quat that rotates local +Y to `dir`. Falls back to identity / 180° about
// X for the degenerate aligned / antiparallel cases.
function quatFromYTo(dir: Vec3, out: Quat): Quat {
  const dx = dir.x;
  const dy = dir.y;
  const dz = dir.z;
  const lsq = dx * dx + dy * dy + dz * dz;
  if (lsq < 1e-10) { out.set(0, 0, 0, 1); return out; }
  const inv = 1 / Math.sqrt(lsq);
  const nx = dx * inv, ny = dy * inv, nz = dz * inv;
  const dot = ny; // (0,1,0) · n = ny
  if (dot > 0.9999) { out.set(0, 0, 0, 1); return out; }
  if (dot < -0.9999) { out.set(1, 0, 0, 0); return out; } // 180° about X
  // axis = (0,1,0) × n = (nz, 0, -nx)
  const ax = nz, ay = 0, az = -nx;
  const aLen = Math.sqrt(ax * ax + az * az);
  const axn = ax / aLen, ayn = ay, azn = az / aLen;
  const ang = Math.acos(dot);
  // PC's Quat.setFromAxisAngle takes degrees.
  out.setFromAxisAngle(_vec4.set(axn, ayn, azn), ang * 180 / Math.PI);
  return out;
}

// Scratch - module-scoped so we don't allocate per-call. These are NOT
// safe to hold across yields; each function uses them within a single
// synchronous call.
const _vec1 = new Vec3();
const _vec2 = new Vec3();
const _vec3 = new Vec3();
const _vec4 = new Vec3();
// Detach math scratch (joint-anchor local point).
const _detachLocal = new Vec3();
const _UNIT_SCALE = new Vec3(1, 1, 1);
// Used only by the recursive `getBoneWorld` closure inside writePose
// (single synchronous call).
const _localMat = new Mat4();
// Debug viz scratch. Safe to share - only touched inside _drawDebug,
// which runs synchronously per frame. drawLines reads coordinates
// immediately, so reusing the same buffers across bones is fine.
const _dbgMat = new Mat4();
const _dbgColor = new Color(1, 0.55, 0.1, 1);
const _dbgLocal: Vec3[] = Array.from({ length: 8 }, () => new Vec3());
/** Indices into an 8-corner box giving the 12 edges (24 endpoint
 *  indices). Same order in {@link Ragdoll.setDebugVisible}'s line
 *  buffer construction. Bottom rect, top rect, then 4 vertical struts. */
const _BOX_EDGES: readonly number[] = [
  0, 1,  1, 2,  2, 3,  3, 0, // bottom
  4, 5,  5, 6,  6, 7,  7, 4, // top
  0, 4,  1, 5,  2, 6,  3, 7, // verticals
];

// Joint-frame computation scratch - `_jm*` prefix marks "used inside
// makeJoint, distinct from the instance scratch on the Ragdoll class".
const _zeroVec = new Vec3();
const _jmChildBody = new Mat4();
const _jmParentBody = new Mat4();
const _jmParentBodyInv = new Mat4();
const _jmAlign = new Mat4();
const _jmJointWorld = new Mat4();
const _jmFrameInParent = new Mat4();
