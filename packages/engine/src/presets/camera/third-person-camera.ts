import { Mat4, Quat, Vec3 } from 'playcanvas';

import type { CameraHost, CameraPreset, TargetSupplier } from './camera-preset';

/**
 * Built-in third-person follow camera.
 *
 * Manifest-addressed as `{ type: 'thirdPerson', target, distance, height, pitch }`.
 *
 * Orbits behind a target position at `distance` with adjustable `yaw`/`pitch`,
 * looks at `target + (0, height, 0)`. Mouse handling via pointer-lock (click
 * canvas to capture, Escape to release). No smoothing.
 *
 * @group Presets
 * @category Camera
 */
export interface ThirdPersonCameraOptions {
  /** Position the camera orbits around, read each frame. */
  target: TargetSupplier;
  /** Default 4. */
  distance?: number;
  /** LookAt vertical offset above target. Default 1.2. */
  height?: number;
  /** Initial pitch (degrees, downward positive). Default 15. */
  pitch?: number;
  /** Mouse-look sensitivity in degrees per pixel. Default 0.2. */
  mouseSensitivity?: number;
}

/**
 * @group Presets
 * @category Camera
 */
export class ThirdPersonCamera implements CameraPreset {
  yaw = 0;
  pitch: number;
  distance: number;
  height: number;
  mouseSensitivity: number;
  /** When false, mouse-look stops mutating yaw/pitch and the canvas no
   *  longer grabs pointer lock. The follow `update()` still runs, so a
   *  scripted camera move (e.g. a death cutscene) can drive yaw/pitch/
   *  distance/height itself without the player fighting it. Setting this
   *  false also releases an active pointer lock. */
  get inputEnabled(): boolean { return this._inputEnabled; }
  set inputEnabled(v: boolean) {
    this._inputEnabled = v;
    if (!v && this._host && document.pointerLockElement === this._host.canvas) {
      document.exitPointerLock();
    }
  }

  private _target: TargetSupplier;
  private _host: CameraHost | null = null;
  private _pointerLocked = false;
  private _inputEnabled = true;

  private _scratchPos = new Vec3();
  private _scratchLook = new Vec3();
  private _scratchUp = new Vec3(0, 1, 0);
  private _scratchMat = new Mat4();
  private _scratchQuat = new Quat();

  constructor(config: ThirdPersonCameraOptions) {
    this._target = config.target;
    this.distance = config.distance ?? 4;
    this.height = config.height ?? 1.2;
    this.pitch = config.pitch ?? 15;
    this.mouseSensitivity = config.mouseSensitivity ?? 0.2;
  }

  attach(host: CameraHost): void {
    if (this._host) throw new Error('[ThirdPersonCamera] already attached');
    this._host = host;
    host.canvas.addEventListener('click', this._onClickToLock);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('mousemove', this._onMouseMove);
  }

  detach(): void {
    if (!this._host) return;
    const { canvas } = this._host;
    canvas.removeEventListener('click', this._onClickToLock);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    this._host = null;
  }

  update(_dt: number): void {
    if (!this._host) return;
    const t = this._target();
    const yawRad = this.yaw * Math.PI / 180;
    const pitchRad = this.pitch * Math.PI / 180;
    const horiz = this.distance * Math.cos(pitchRad);
    const vert = this.distance * Math.sin(pitchRad);
    this._scratchPos.set(
      t.x + Math.sin(yawRad) * horiz,
      t.y + this.height + vert,
      t.z + Math.cos(yawRad) * horiz,
    );
    this._scratchLook.set(t.x, t.y + this.height, t.z);
    this._scratchMat.setLookAt(this._scratchPos, this._scratchLook, this._scratchUp);
    this._scratchQuat.setFromMat4(this._scratchMat);
    this._host.cameraEntity.setPosition(this._scratchPos);
    this._host.cameraEntity.setRotation(this._scratchQuat);
  }

  private _onClickToLock = () => {
    if (!this._inputEnabled || this._pointerLocked || !this._host) return;
    // requestPointerLock returns a Promise in modern browsers (Chrome 111+,
    // Safari 17+). The browser enforces a ~1.25 s cooldown after the user
    // presses Esc to release the lock - re-acquiring inside that window
    // rejects with `SecurityError`. Swallow the rejection: the next click
    // outside the cooldown will succeed normally. Old browsers return
    // `undefined`, so guard the `.catch`.
    const p = this._host.canvas.requestPointerLock() as Promise<void> | undefined;
    p?.catch(() => { /* post-Esc cooldown - ignore, next click will re-lock */ });
  };
  private _onLockChange = () => {
    this._pointerLocked = !!this._host && document.pointerLockElement === this._host.canvas;
  };
  private _onMouseMove = (e: MouseEvent) => {
    if (!this._inputEnabled || !this._pointerLocked) return;
    this.yaw -= e.movementX * this.mouseSensitivity;
    this.pitch = Math.max(-30, Math.min(70, this.pitch + e.movementY * this.mouseSensitivity));
  };
}
