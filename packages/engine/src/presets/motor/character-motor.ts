import { Vec3 } from 'playcanvas';

import type { Character } from '../../character';

/**
 * Configuration for {@link CharacterMotor}.
 *
 * @group Presets
 * @category Motor
 */
export interface CharacterMotorOptions {
  /** Vertical impulse applied on `jump()` when grounded. Default `5`. */
  jumpSpeed?: number;
  /** Constant Y acceleration applied every tick. Default `-9.8`. */
  gravity?: number;
}

/**
 * Platformer-flavored character physics - gravity, jump, and a `y <= 0` ground
 * clamp on a {@link Character}'s transform.
 *
 * Knows nothing about input. Callers (a controller, AI brain, agent script,
 * replay buffer, …) compute world-space horizontal velocity and call
 * {@link CharacterMotor.setMoveVelocity} + optionally {@link CharacterMotor.jump}
 * each tick, then {@link CharacterMotor.update} to integrate.
 *
 * The motor is a *preset* - it bakes in conventions appropriate for a
 * platformer-style character. Games with different physics (top-down with
 * no gravity, vehicle dynamics, side-scroller) write their own motion
 * preset against the primitive APIs.
 *
 * @group Presets
 * @category Motor
 */
export class CharacterMotor {
  jumpSpeed: number;
  gravity: number;

  private _character: Character;
  private _velocity = new Vec3();
  private _grounded = false;
  private _moveVx = 0;
  private _moveVz = 0;
  private _jumpRequested = false;

  get grounded(): boolean { return this._grounded; }
  /** Last-integrated velocity. Useful for camera lead-ahead etc. */
  get velocity(): Vec3 { return this._velocity; }

  constructor(character: Character, config?: CharacterMotorOptions) {
    this._character = character;
    this.jumpSpeed = config?.jumpSpeed ?? 5;
    this.gravity = config?.gravity ?? -9.8;
  }

  /**
   * Set horizontal velocity (world space) for the *next* {@link update} call.
   * Y is managed internally (gravity + jump + ground clamp).
   */
  setMoveVelocity(vx: number, vz: number): void {
    this._moveVx = vx;
    this._moveVz = vz;
  }

  /**
   * Request a jump. Latched until the next `update`; consumed only if the
   * motor is currently grounded. Calling repeatedly while in the air does
   * nothing - gate from the caller side if rising-edge semantics matter.
   */
  jump(): void {
    this._jumpRequested = true;
  }

  /**
   * Integrate one frame. Applies the last-set move velocity + gravity,
   * resolves jump-while-grounded, and clamps to the ground plane.
   *
   * Position is written via `character.setPosition`, which routes through
   * `armature.move()` and stays consistent with the armature's baseline.
   */
  update(dt: number): { grounded: boolean; jumped: boolean } {
    this._velocity.x = this._moveVx;
    this._velocity.z = this._moveVz;
    this._velocity.y += this.gravity * dt;

    let jumped = false;
    if (this._jumpRequested && this._grounded) {
      this._velocity.y = this.jumpSpeed;
      jumped = true;
    }
    this._jumpRequested = false;

    // Read through `getPosition`, not off the entity: it is the exact inverse
    // of the `setPosition` below, so this integrate-and-write-back cannot
    // double-apply the ground shim (see `Character.groundToEntityY`). Reading
    // the raw entity here would sink a `.vsplat` character by its bake shift
    // every single frame.
    const pos = this._character.getPosition();
    let newX = pos.x + this._velocity.x * dt;
    let newY = pos.y + this._velocity.y * dt;
    let newZ = pos.z + this._velocity.z * dt;
    if (newY <= 0) {
      newY = 0;
      this._velocity.y = 0;
      this._grounded = true;
    } else {
      this._grounded = false;
    }
    this._character.setPosition(newX, newY, newZ);

    return { grounded: this._grounded, jumped };
  }
}
