import type { Character } from '../../character';
import type { Keyboard } from '../../input/keyboard';
import { CharacterMotor } from './character-motor';

/**
 * Built-in player controller - keyboard input → camera-relative velocity →
 * {@link CharacterMotor}. Manifest-addressed as `{ type: 'wasd', ... }`.
 *
 * Lives in `presets/` because the WASD mapping, "face the direction you're
 * moving" facing logic, and idle/move animation crossfade are all genre
 * conventions (third-person platformer). Different game shapes (vehicle,
 * top-down, fighting game) write their own controller against the
 * primitives.
 *
 * @group Presets
 * @category Motor
 */
export interface WasdControllerOptions {
  character: Character;
  keyboard: Keyboard;
  idleAnim?: string;
  moveAnim?: string;
  moveSpeed?: number;
  jumpSpeed?: number;
  /** Max deg/sec the character's facing turns. Default 360. */
  turnSpeed?: number;
}

/**
 * @group Presets
 * @category Motor
 */
export class WasdController {
  readonly motor: CharacterMotor;
  moveSpeed: number;
  turnSpeed: number;

  private _character: Character;
  private _keyboard: Keyboard;
  private _idleAnim?: string;
  private _moveAnim?: string;
  private _currentAnim: 'idle' | 'move' = 'idle';
  private _facingYaw = 0;
  private _prevJumpPressed = false;

  constructor(config: WasdControllerOptions) {
    this._character = config.character;
    this._keyboard = config.keyboard;
    this._idleAnim = config.idleAnim;
    this._moveAnim = config.moveAnim;
    this.moveSpeed = config.moveSpeed ?? 3;
    this.turnSpeed = config.turnSpeed ?? 360;
    this.motor = new CharacterMotor(this._character, {
      jumpSpeed: config.jumpSpeed,
    });

    if (this._idleAnim) this._character.playAnimation(this._idleAnim, { loop: true });
  }

  /** Called every frame by the loader. `cameraYaw` translates WASD to world space. */
  update(dt: number, cameraYaw: number) {
    // Read WASD into a normalized input direction.
    let ix = 0, iz = 0;
    if (this._keyboard.isKeyDown('KeyW')) iz -= 1;
    if (this._keyboard.isKeyDown('KeyS')) iz += 1;
    if (this._keyboard.isKeyDown('KeyA')) ix -= 1;
    if (this._keyboard.isKeyDown('KeyD')) ix += 1;
    const len = Math.hypot(ix, iz);
    const isMoving = len > 0;
    if (isMoving) { ix /= len; iz /= len; }

    // Camera-relative input → world-space velocity vector.
    let vx = 0, vz = 0;
    if (isMoving) {
      const yawRad = cameraYaw * Math.PI / 180;
      const fwdX = Math.sin(yawRad);
      const fwdZ = Math.cos(yawRad);
      const rgtX = Math.cos(yawRad);
      const rgtZ = -Math.sin(yawRad);
      vx = (fwdX * iz + rgtX * ix) * this.moveSpeed;
      vz = (fwdZ * iz + rgtZ * ix) * this.moveSpeed;
    }
    this.motor.setMoveVelocity(vx, vz);

    // Rising-edge jump request.
    const jumpPressed = this._keyboard.isKeyDown('Space');
    if (jumpPressed && !this._prevJumpPressed) this.motor.jump();
    this._prevJumpPressed = jumpPressed;

    // Integrate physics.
    this.motor.update(dt);

    // Face the move direction (platformer convention). Same atan2 derivation
    // as the previous in-motor version - kept here so callers writing custom
    // controllers can pick whatever facing rule fits their game.
    if (isMoving) {
      const inputAngle = Math.atan2(-ix, -iz) * 180 / Math.PI;
      const targetYaw = cameraYaw + inputAngle;
      this._facingYaw = lerpAngle(this._facingYaw, targetYaw, this.turnSpeed * dt);
    }
    this._character.setRotation(0, this._facingYaw, 0);

    // Idle / move animation crossfade.
    if (this._idleAnim && this._moveAnim) {
      const want: 'idle' | 'move' = isMoving ? 'move' : 'idle';
      if (want !== this._currentAnim) {
        this._character.crossfadeTo(want === 'move' ? this._moveAnim : this._idleAnim, {
          duration: 0.15,
          loop: true,
        });
        this._currentAnim = want;
      }
    }
  }
}

function lerpAngle(current: number, target: number, maxDelta: number): number {
  let diff = wrapAngle(target - current);
  if (Math.abs(diff) <= maxDelta) return wrapAngle(target);
  return wrapAngle(current + (diff > 0 ? maxDelta : -maxDelta));
}

function wrapAngle(a: number): number {
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}
