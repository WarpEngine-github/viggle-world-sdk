import { Vec3 } from 'playcanvas';
import type { AppBase, Entity, Quat } from 'playcanvas';

/**
 * Thin wrapper around the Ammo constraint API that PlayCanvas's
 * `RigidBodyComponentSystem` doesn't expose. Construct via the helpers
 * below; both return a {@link JointHandle} whose `remove()` detaches the
 * constraint from the dynamics world and frees the native object.
 *
 * Why this exists: PC ships `rigidbody` + `collision` components but no
 * `joint` component. Ragdoll, hinged door, swinging-rope, and rigid
 * "chain of bodies" demos all need raw Ammo constraints. This module is
 * the contained leak - the only place in the engine that touches
 * `globalThis.Ammo` directly.
 *
 * Requires `Scene.create({ physics: ... })` so the rigidbody system is
 * registered and `globalThis.Ammo` is populated. Throws otherwise.
 *
 * @group Physics
 */

// ── Minimal ambient typing for the Ammo bits we actually call. ──────────
// The full Emscripten typings (kripken/ammo.js) don't ship with PC and
// add a large dependency just to type a handful of methods. Type only
// the surface the wrapper touches; everything else stays `unknown`.

interface AmmoBody { /* opaque btRigidBody */ }

interface AmmoVec3 {
  x(): number; y(): number; z(): number;
  setValue(x: number, y: number, z: number): void;
}

interface AmmoQuat { /* opaque btQuaternion */ }

interface AmmoXform {
  setIdentity(): void;
  setOrigin(v: AmmoVec3): void;
  setRotation(q: AmmoQuat): void;
}

interface AmmoConstraint {
  setBreakingImpulseThreshold(v: number): void;
  enableFeedback(v: boolean): void;
  /** Most-recent applied impulse from the constraint solver (a single
   *  scalar magnitude). We poll this each frame for break detection
   *  instead of `isEnabled()`, which isn't exposed by every Ammo.js
   *  build (notably the one PlayCanvas ships). */
  getAppliedImpulse(): number;
}

interface AmmoConeTwist extends AmmoConstraint {
  /** Swing about local Y, swing about local Z, twist about local X. Radians. */
  setLimit(swingY: number, swingZ: number, twist: number): void;
}

interface AmmoHinge extends AmmoConstraint {
  setLimit(low: number, high: number, softness?: number, bias?: number, relax?: number): void;
}

interface AmmoGeneric6Dof extends AmmoConstraint {
  setLinearLowerLimit(v: AmmoVec3): void;
  setLinearUpperLimit(v: AmmoVec3): void;
  setAngularLowerLimit(v: AmmoVec3): void;
  setAngularUpperLimit(v: AmmoVec3): void;
}

interface AmmoDynamicsWorld {
  addConstraint(c: AmmoConstraint, disableCollisionBetweenLinkedBodies?: boolean): void;
  removeConstraint(c: AmmoConstraint): void;
}

interface AmmoNS {
  btVector3: new (x: number, y: number, z: number) => AmmoVec3;
  btQuaternion: new (x: number, y: number, z: number, w: number) => AmmoQuat;
  btTransform: new () => AmmoXform;
  btConeTwistConstraint: new (
    rbA: AmmoBody, rbB: AmmoBody, frameA: AmmoXform, frameB: AmmoXform,
  ) => AmmoConeTwist;
  btHingeConstraint: new (
    rbA: AmmoBody, rbB: AmmoBody,
    pivotA: AmmoVec3, pivotB: AmmoVec3,
    axisA: AmmoVec3, axisB: AmmoVec3,
  ) => AmmoHinge;
  btGeneric6DofConstraint: new (
    rbA: AmmoBody, rbB: AmmoBody,
    frameA: AmmoXform, frameB: AmmoXform,
    useLinearReferenceFrameA: boolean,
  ) => AmmoGeneric6Dof;
  destroy(obj: unknown): void;
}

function ammo(): AmmoNS {
  const a = (globalThis as { Ammo?: AmmoNS }).Ammo;
  if (!a) {
    throw new Error(
      '[joints] globalThis.Ammo is not set. Pass physics={ loadAmmo } to Scene.create first.',
    );
  }
  return a;
}

function bodyOf(entity: Entity): AmmoBody {
  // PC's RigidBodyComponent stores the btRigidBody at `.body`. Typed
  // loosely there too - same loose cast here keeps us at the boundary.
  const rb = (entity as unknown as { rigidbody?: { body?: AmmoBody } }).rigidbody;
  const b = rb?.body;
  if (!b) {
    throw new Error(
      `[joints] entity '${entity.name}' has no active rigidbody.body. ` +
      'Add a rigidbody component and attach the entity before creating joints.',
    );
  }
  return b;
}

function worldOf(app: AppBase): AmmoDynamicsWorld {
  const sys = (app.systems as unknown as {
    rigidbody?: { dynamicsWorld?: AmmoDynamicsWorld };
  }).rigidbody;
  const dw = sys?.dynamicsWorld;
  if (!dw) {
    throw new Error(
      '[joints] rigidbody system not registered. Pass physics to Scene.create.',
    );
  }
  return dw;
}

/** Build an Ammo btTransform from a PC pose. Caller owns destroy(). */
function makeXform(pos: Vec3, rot: Quat): AmmoXform {
  const A = ammo();
  const t = new A.btTransform();
  t.setIdentity();
  // Bullet copies setOrigin / setRotation inputs by value, so we can free
  // the temporaries immediately.
  const p = new A.btVector3(pos.x, pos.y, pos.z);
  t.setOrigin(p);
  A.destroy(p);
  const q = new A.btQuaternion(rot.x, rot.y, rot.z, rot.w);
  t.setRotation(q);
  A.destroy(q);
  return t;
}

/**
 * Reference to a live joint. `remove()` detaches the constraint and frees
 * the underlying Ammo object. Idempotent.
 *
 * @group Physics
 */
export interface JointHandle {
  /** Detach from the dynamics world and free the underlying Ammo
   *  object. Idempotent. */
  remove(): void;
  /** True if the constraint has been broken by Bullet's solver (its
   *  applied impulse exceeded the configured `breakImpulse`). Always
   *  `true` after `remove()`. */
  isBroken(): boolean;
}

class Joint implements JointHandle {
  private _c: AmmoConstraint | null;
  private readonly _world: AmmoDynamicsWorld;
  /** Breaking threshold (N·s) stored on the wrapper for our own poll;
   *  `0` means "unbreakable". */
  private readonly _breakThreshold: number;
  private _broken = false;

  constructor(world: AmmoDynamicsWorld, c: AmmoConstraint, breakThreshold: number) {
    this._world = world;
    this._c = c;
    this._breakThreshold = breakThreshold;
  }

  remove(): void {
    if (!this._c) return;
    this._world.removeConstraint(this._c);
    ammo().destroy(this._c);
    this._c = null;
  }

  isBroken(): boolean {
    if (!this._c) return true;
    if (this._broken) return true;
    if (this._breakThreshold > 0) {
      // Bullet's solver updates `m_appliedImpulse` after each step;
      // when it exceeds the breaking threshold the constraint is
      // internally disabled. We replicate the check on our side so
      // we don't depend on `isEnabled()` (not exposed in PC's Ammo
      // build) and so manual `breakImpulse: 0` callers still poll
      // cheaply.
      if (Math.abs(this._c.getAppliedImpulse()) > this._breakThreshold) {
        this._broken = true;
        return true;
      }
    }
    return false;
  }
}

/**
 * Options for {@link createConeTwistJoint}.
 *
 * @group Physics
 */
export interface ConeTwistJointOptions {
  app: AppBase;
  bodyA: Entity;
  bodyB: Entity;
  /** Joint anchor in `bodyA`'s local space. */
  frameInA: { position: Vec3; rotation: Quat };
  /** Joint anchor in `bodyB`'s local space. */
  frameInB: { position: Vec3; rotation: Quat };
  /** Cone half-angle about the joint's local Y axis (radians). Default π/4. */
  swingY?: number;
  /** Cone half-angle about the joint's local Z axis (radians). Default π/4. */
  swingZ?: number;
  /** Twist half-angle about the joint's local X axis (radians). Default π/6. */
  twist?: number;
  /**
   * When true, the two bodies stop colliding with each other - required
   * for limb pairs whose colliders overlap at the joint. Default `true`.
   */
  disableCollisionBetweenLinkedBodies?: boolean;
}

/**
 * Create a cone-twist constraint between two bodies. Models ball-and-
 * socket joints (shoulder, hip, neck) - bodyB can swing within an
 * elliptical cone of bodyA and twist around the cone's axis.
 *
 * @group Physics
 */
export function createConeTwistJoint(opts: ConeTwistJointOptions): JointHandle {
  const A = ammo();
  const world = worldOf(opts.app);
  const bA = bodyOf(opts.bodyA);
  const bB = bodyOf(opts.bodyB);
  const fA = makeXform(opts.frameInA.position, opts.frameInA.rotation);
  const fB = makeXform(opts.frameInB.position, opts.frameInB.rotation);
  const c = new A.btConeTwistConstraint(bA, bB, fA, fB);
  c.setLimit(
    opts.swingY ?? Math.PI / 4,
    opts.swingZ ?? Math.PI / 4,
    opts.twist ?? Math.PI / 6,
  );
  world.addConstraint(c, opts.disableCollisionBetweenLinkedBodies ?? true);
  A.destroy(fA);
  A.destroy(fB);
  return new Joint(world, c, 0);
}

/**
 * Options for {@link createHingeJoint}.
 *
 * @group Physics
 */
export interface HingeJointOptions {
  app: AppBase;
  bodyA: Entity;
  bodyB: Entity;
  /** Hinge pivot in `bodyA`'s local space. */
  pivotInA: Vec3;
  /** Hinge pivot in `bodyB`'s local space. */
  pivotInB: Vec3;
  /** Hinge axis in `bodyA`'s local space. Need not be unit-length. */
  axisInA: Vec3;
  /** Hinge axis in `bodyB`'s local space. */
  axisInB: Vec3;
  /** Lower hinge angle (radians). Default −π (no lower stop). */
  lowLimit?: number;
  /** Upper hinge angle (radians). Default π (no upper stop). */
  highLimit?: number;
  /** See {@link ConeTwistJointOptions.disableCollisionBetweenLinkedBodies}. */
  disableCollisionBetweenLinkedBodies?: boolean;
}

/**
 * Options for {@link createGeneric6DofJoint}.
 *
 * @group Physics
 */
export interface Generic6DofJointOptions {
  app: AppBase;
  bodyA: Entity;
  bodyB: Entity;
  /** Joint frame in `bodyA`'s local space. */
  frameInA: { position: Vec3; rotation: Quat };
  /** Joint frame in `bodyB`'s local space. */
  frameInB: { position: Vec3; rotation: Quat };
  /** Translation limits per axis (in the joint frame). Default `(0,0,0)` /
   *  `(0,0,0)` - fully locked, the typical ball-and-socket case. */
  linearLowerLimit?: Vec3;
  linearUpperLimit?: Vec3;
  /** Rotation limits per axis (radians). Conventions in `btGeneric6DofConstraint`:
   *   - `lower < upper`: axis is limited to that range
   *   - `lower == upper`: axis is fully locked
   *   - `lower > upper`: axis is free (no limit)
   *
   *  For a cone-twist-style joint where frame X is the twist/cone axis:
   *  `lower = (-twist, -swingY, -swingZ)`, `upper = (twist, swingY, swingZ)`. */
  angularLowerLimit: Vec3;
  angularUpperLimit: Vec3;
  /**
   * Breaking impulse threshold (N·s). When the constraint's applied
   * impulse exceeds this value in a single physics step, Bullet
   * auto-disables the constraint (`isEnabled() → false`) and the two
   * bodies become free of each other. Poll {@link JointHandle.isBroken}
   * each frame to react. Omit for an unbreakable joint.
   */
  breakImpulse?: number;
  /** See {@link ConeTwistJointOptions.disableCollisionBetweenLinkedBodies}. */
  disableCollisionBetweenLinkedBodies?: boolean;
}

/**
 * Create a generic 6-DOF constraint between two bodies. The workhorse
 * for ragdoll joints - independently constrain translation and rotation
 * on each axis of a joint frame. More numerically robust than
 * {@link createConeTwistJoint} for the asymmetric body orientations
 * typical of ragdoll shoulders / hips.
 *
 * @group Physics
 */
export function createGeneric6DofJoint(opts: Generic6DofJointOptions): JointHandle {
  const A = ammo();
  const world = worldOf(opts.app);
  const bA = bodyOf(opts.bodyA);
  const bB = bodyOf(opts.bodyB);
  const fA = makeXform(opts.frameInA.position, opts.frameInA.rotation);
  const fB = makeXform(opts.frameInB.position, opts.frameInB.rotation);
  // useLinearReferenceFrameA = true: linear constraints measured in
  // body A's frame (the common choice for joints).
  const c = new A.btGeneric6DofConstraint(bA, bB, fA, fB, true);

  const linLow = opts.linearLowerLimit ?? _zero3;
  const linHigh = opts.linearUpperLimit ?? _zero3;
  const vLL = new A.btVector3(linLow.x, linLow.y, linLow.z);
  c.setLinearLowerLimit(vLL); A.destroy(vLL);
  const vLU = new A.btVector3(linHigh.x, linHigh.y, linHigh.z);
  c.setLinearUpperLimit(vLU); A.destroy(vLU);

  const aLow = opts.angularLowerLimit;
  const aHigh = opts.angularUpperLimit;
  const vAL = new A.btVector3(aLow.x, aLow.y, aLow.z);
  c.setAngularLowerLimit(vAL); A.destroy(vAL);
  const vAU = new A.btVector3(aHigh.x, aHigh.y, aHigh.z);
  c.setAngularUpperLimit(vAU); A.destroy(vAU);

  if (opts.breakImpulse !== undefined) {
    // Bullet's own break-on-threshold path. Even though our wrapper
    // does its own poll (see Joint.isBroken), setting this also lets
    // Bullet internally disable the constraint mid-solve, which is
    // cheap insurance for very large impulses that might destabilise
    // the next step.
    c.setBreakingImpulseThreshold(opts.breakImpulse);
  }

  world.addConstraint(c, opts.disableCollisionBetweenLinkedBodies ?? true);
  A.destroy(fA);
  A.destroy(fB);
  return new Joint(world, c, opts.breakImpulse ?? 0);
}

const _zero3 = new Vec3(0, 0, 0);

/**
 * Create a hinge constraint between two bodies. Models single-axis joints
 * like elbows, knees, and doors. Set `lowLimit`/`highLimit` to author
 * realistic limb ranges (e.g. an elbow swings 0 → +2.4 rad, not the full
 * ±π default).
 *
 * @group Physics
 */
export function createHingeJoint(opts: HingeJointOptions): JointHandle {
  const A = ammo();
  const world = worldOf(opts.app);
  const bA = bodyOf(opts.bodyA);
  const bB = bodyOf(opts.bodyB);
  const pA = new A.btVector3(opts.pivotInA.x, opts.pivotInA.y, opts.pivotInA.z);
  const pB = new A.btVector3(opts.pivotInB.x, opts.pivotInB.y, opts.pivotInB.z);
  const aA = new A.btVector3(opts.axisInA.x, opts.axisInA.y, opts.axisInA.z);
  const aB = new A.btVector3(opts.axisInB.x, opts.axisInB.y, opts.axisInB.z);
  const c = new A.btHingeConstraint(bA, bB, pA, pB, aA, aB);
  c.setLimit(opts.lowLimit ?? -Math.PI, opts.highLimit ?? Math.PI);
  world.addConstraint(c, opts.disableCollisionBetweenLinkedBodies ?? true);
  A.destroy(pA);
  A.destroy(pB);
  A.destroy(aA);
  A.destroy(aB);
  return new Joint(world, c, 0);
}
