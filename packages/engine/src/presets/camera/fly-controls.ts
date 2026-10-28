import { math, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, Quat, Vec3 } from 'playcanvas';

import type { CameraHost, CameraPreset } from './camera-preset';
import { defaultShouldIgnoreKeystroke } from './keystroke';

export { defaultShouldIgnoreKeystroke };

const _scratchEuler = new Vec3();

/**
 * Configuration for {@link FlyControls}.
 *
 * @group Presets
 * @category Camera
 */
export interface FlyControlsOptions {
  /** Initial yaw (degrees). Default `0`. */
  yaw?: number;
  /** Initial pitch (degrees, clamped ±89). Default `0`. */
  pitch?: number;
  /** Fly speed in world-units per second. Default `8`. */
  flySpeed?: number;
  /** Multiplier applied to fly speed while Shift is held. Default `3`. */
  shiftSpeedMultiplier?: number;
  /**
   * When `true`, fly speed scales with distance from the world origin: slow
   * near a splat's centre (where the detail lives, so you linger) easing up
   * to the full {@link flySpeed} cap at the lower-quality edges. Default
   * `false` (constant `flySpeed`).
   */
  distanceScaledSpeed?: boolean;
  /** Floor speed at the origin when {@link distanceScaledSpeed} is on. Default `flySpeed / 4`. */
  minFlySpeed?: number;
  /** Degrees per pixel of left-drag. Default `0.25`. */
  lookSensitivity?: number;
  /** Flip the pitch axis: dragging down looks up. Default `false`. */
  invertLook?: boolean;
  /**
   * Right-drag pan speed multiplier. Scaled by the camera's world-space
   * distance from origin so panning feels equally fast at any zoom level.
   * Default `0.005`.
   */
  panSensitivity?: number;
  /** Scroll-wheel zoom multiplier (world-units per wheel delta unit). Default `0.02`. */
  zoomSensitivity?: number;
  /**
   * Predicate consulted on every keydown to decide whether the fly cam
   * should ignore the keystroke. Defaults to a heuristic that ignores
   * events whose composed-path contains a text-y `<input>`,
   * `<textarea>`, `<select>`, or any element with `contenteditable` -
   * see {@link defaultShouldIgnoreKeystroke}.
   *
   * Override for stricter semantics. Example: only fly when the canvas
   * itself is the focused element ("Three.js FirstPersonControls" mode):
   * ```ts
   * new FlyControls({
   *   shouldIgnoreKeystroke: () => document.activeElement !== canvas,
   * });
   * ```
   */
  shouldIgnoreKeystroke?: (e: KeyboardEvent) => boolean;
}

/**
 * Maya / Unity-style free-fly camera.
 *
 * - **Left drag** → orbit (yaw + pitch)
 * - **Right drag** → pan in the camera's screen plane
 * - **Scroll wheel** → dolly forward / backward
 * - **W/A/S/D** → fly forward / left / back / right
 * - **E / Space** → fly up · **Q** → fly down
 * - **Shift** → speed multiplier while fly keys are held
 * - **One-finger drag** → look · **pinch** → dolly (ortho: zoom) ·
 *   **two-finger drag** → pan
 *
 * Translation can also come from somewhere that is not a keyboard - a touch
 * joystick, a gamepad - through {@link FlyControls.setMoveInput}, which is
 * summed with the keys rather than replacing them.
 *
 * Unlike {@link OrbitControls} there is no orbit target - the camera moves
 * freely in world space. Drop in as the default editor / dev-cam preset:
 *
 * ```ts
 * const fly = new FlyControls({ flySpeed: 12 });
 * fly.attach({ canvas, cameraEntity: scene.cameraEntity });
 * scene.app.on('update', (dt) => fly.update(dt));
 * ```
 *
 * Set {@link FlyControls.enabled `enabled = false`} to suppress all input
 * (handy while a transform gizmo is dragging or a modal owns the pointer).
 * Held mouse buttons + fly keys are released on the falling edge so the
 * camera doesn't carry stale input when input resumes.
 *
 * @group Presets
 * @category Camera
 */
export class FlyControls implements CameraPreset {
  /** Fly speed in world-units per second. Mutable at runtime. */
  flySpeed: number;
  /** Multiplier applied to fly speed while Shift is held. Mutable at runtime. */
  shiftSpeedMultiplier: number;
  /** When `true`, fly speed eases from {@link minFlySpeed} up to {@link flySpeed} with distance from origin. Mutable at runtime. */
  distanceScaledSpeed: boolean;
  /** Floor speed at the origin when {@link distanceScaledSpeed} is on. Mutable at runtime. */
  minFlySpeed: number;
  /** Degrees per pixel of left-drag. Mutable at runtime. */
  lookSensitivity: number;
  /** Flip the pitch axis. Mutable at runtime. */
  invertLook: boolean;
  /** Right-drag pan multiplier (scaled internally by distance-from-origin). Mutable at runtime. */
  panSensitivity: number;
  /** Scroll-wheel zoom multiplier (world-units per wheel delta). Mutable at runtime. */
  zoomSensitivity: number;
  /** Predicate that returns true when a keystroke should be ignored. Mutable at runtime. */
  shouldIgnoreKeystroke: (e: KeyboardEvent) => boolean;

  private _yaw: number;
  private _pitch: number;

  private _host: CameraHost | null = null;
  private _enabled = true;
  private _leftDown = false;
  private _rightDown = false;
  // The pointer driving the drag. Move/up listen on window, so without this a
  // second finger (e.g. on a touch stick) feeds its deltas into the look.
  private _pointerId: number | null = null;
  // Fingers down on the canvas (at most two); two make a pinch.
  private _touches = new Map<number, { x: number; y: number }>();
  private _pinchSpan = 0;
  private _lastX = 0;
  private _lastY = 0;
  private _keys = new Set<string>();
  // Translation from a non-keyboard source, in the same axes the keys write
  // into below. Three numbers rather than a Vec3 so there is nothing for a
  // caller to hold a reference to and mutate behind this class's back.
  private _moveX = 0;
  private _moveY = 0;
  private _moveZ = 0;

  // Reusable scratch - avoid per-frame allocation in update() / pointer move.
  private _rotQuat = new Quat();
  private _scratchRight = new Vec3();
  private _scratchUp = new Vec3();
  private _scratchFwd = new Vec3();
  private _scratchPos = new Vec3();

  // Fly keys we care about - anything else falls through to the host app
  // so editors / inspectors keep their shortcuts.
  private static readonly _FLY_KEYS = new Set([
    'w', 'a', 's', 'd', 'q', 'e', ' ', 'shift',
  ]);

  constructor(config?: FlyControlsOptions) {
    this._yaw = config?.yaw ?? 0;
    this._pitch = config?.pitch ?? 0;
    this.flySpeed = config?.flySpeed ?? 8;
    this.shiftSpeedMultiplier = config?.shiftSpeedMultiplier ?? 3;
    this.distanceScaledSpeed = config?.distanceScaledSpeed ?? false;
    this.minFlySpeed = config?.minFlySpeed ?? this.flySpeed / 4;
    this.lookSensitivity = config?.lookSensitivity ?? 0.25;
    this.invertLook = config?.invertLook ?? false;
    this.panSensitivity = config?.panSensitivity ?? 0.005;
    this.zoomSensitivity = config?.zoomSensitivity ?? 0.02;
    this.shouldIgnoreKeystroke = config?.shouldIgnoreKeystroke ?? defaultShouldIgnoreKeystroke;
  }

  attach(host: CameraHost): void {
    if (this._host) throw new Error('[FlyControls] already attached');
    this._host = host;
    host.canvas.addEventListener('pointerdown', this._onPointerDown);
    // drag-ok: multi-touch pinch and two-button mouse drags, in a package that
    // can't import the app's trackPointerDrag; moves and blur end it too.
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('blur', this._onBlur);
    host.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    host.canvas.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this._applyRotation();
  }

  detach(): void {
    if (!this._host) return;
    const { canvas } = this._host;
    canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('blur', this._onBlur);
    canvas.removeEventListener('wheel', this._onWheel);
    canvas.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this._host = null;
    this._leftDown = false;
    this._rightDown = false;
    this._pointerId = null;
    this._touches.clear();
    this._keys.clear();
    this.setMoveInput(0, 0, 0);
  }

  /** Per-frame fly tick. Pass seconds since last call so fly speed is dt-independent. */
  update(dt: number): void {
    if (!this._host || !this._enabled) return;
    const keys = this._keys;

    let mx = this._moveX; let my = this._moveY; let mz = this._moveZ;
    if (keys.has('w')) mz -= 1;
    if (keys.has('s')) mz += 1;
    if (keys.has('a')) mx -= 1;
    if (keys.has('d')) mx += 1;
    if (keys.has('e') || keys.has(' ')) my += 1;
    if (keys.has('q')) my -= 1;
    if (mx === 0 && my === 0 && mz === 0) return;

    const cam = this._host.cameraEntity;
    // Distance-scaled speed eases (smoothstep, so it starts/ends gently) from
    // minFlySpeed at the origin up to the flySpeed cap, reaching it 3×flySpeed
    // world-units out. Off → constant flySpeed. Shift multiplies either way.
    const base = this.distanceScaledSpeed
      ? math.lerp(this.minFlySpeed, this.flySpeed,
          math.smoothstep(0, this.flySpeed * 3, cam.getPosition().length()))
      : this.flySpeed;
    const speed = base * dt * (keys.has('shift') ? this.shiftSpeedMultiplier : 1);
    const rot = cam.getRotation();
    this._scratchRight.set(1, 0, 0);
    this._scratchFwd.set(0, 0, -1);
    rot.transformVector(this._scratchRight, this._scratchRight);
    rot.transformVector(this._scratchFwd, this._scratchFwd);
    this._scratchPos.copy(cam.getPosition());
    this._scratchPos.add(this._scratchRight.mulScalar(mx * speed));
    this._scratchPos.add(this._scratchFwd.mulScalar(-mz * speed));
    this._scratchPos.y += my * speed;
    cam.setPosition(this._scratchPos);
  }

  // ── public state ─────────────────────────────────────────────────────

  get yaw(): number { return this._yaw; }
  set yaw(v: number) { this._yaw = v; this._applyRotation(); }
  get pitch(): number { return this._pitch; }
  set pitch(v: number) {
    this._pitch = math.clamp(v, -89, 89);
    this._applyRotation();
  }

  /**
   * Set yaw + pitch in one call without two camera writes. Useful when an
   * external system (e.g. the editor seeding from a saved camera) is
   * snapping orientation in lockstep.
   */
  setOrientation(yaw: number, pitch: number): void {
    this._yaw = yaw;
    this._pitch = math.clamp(pitch, -89, 89);
    this._applyRotation();
  }

  /**
   * Translation from a source that is not the keyboard - a touch joystick, a
   * gamepad, a scripted move - SUMMED with whatever keys are held rather than
   * replacing them, so a stick and a keyboard can drive the same camera.
   *
   * The axes are the fly keys' own, and so is the sign: `x` is +right (D),
   * `y` is +up (E / Space), and `z` is +BACK (S), i.e. -1 is forward (W),
   * matching the -Z forward convention the camera itself uses. Magnitudes
   * are not clamped: 1 is the full {@link flySpeed}, less is proportionally
   * slower, which is what gives an analogue stick its dead zone and its
   * ramp.
   *
   * It is STICKY - the camera keeps moving until it is set back to zero - so
   * whoever sets it owns clearing it. {@link detach} and
   * `enabled = false` clear it along with the held keys, on the same
   * reasoning: input that went away must not keep driving the camera.
   */
  setMoveInput(x: number, y: number, z: number): void {
    this._moveX = x;
    this._moveY = y;
    this._moveZ = z;
  }

  /**
   * Whether {@link setMoveInput} is currently asking for movement. For a host
   * that treats "the camera is being driven" as a state of its own - stopping
   * an idle auto-rotate, cancelling a scripted move - the way a keydown would.
   */
  get hasMoveInput(): boolean {
    return this._moveX !== 0 || this._moveY !== 0 || this._moveZ !== 0;
  }

  /**
   * Switch the host camera between perspective and orthographic. A fly cam
   * has no orbit distance to derive an ortho frame from, so the caller passes
   * `orthoHeight` (world units the view spans vertically); it is ignored for
   * perspective. No-op before {@link attach}.
   */
  setProjection(projection: 'perspective' | 'orthographic', orthoHeight = 1): void {
    const cam = this._host?.cameraEntity.camera;
    if (!cam) return;
    if (projection === 'orthographic') {
      cam.projection = PROJECTION_ORTHOGRAPHIC;
      cam.orthoHeight = orthoHeight / 2;
      // Negative near clip lets the ortho frustum extend behind the camera
      // origin (as OrbitControls does): with the camera angled, the frustum's
      // near face dips under the floor plane and the grid's ray-plane solver
      // would discard the whole lower half of the frame (t < 0).
      cam.nearClip = -cam.farClip;
    } else {
      cam.projection = PROJECTION_PERSPECTIVE;
      cam.nearClip = 0.1;
    }
  }

  /**
   * Read the camera entity's current rotation back into local yaw/pitch.
   * Call this whenever something OTHER than this preset moved the camera
   * (e.g. a turntable auto-rotation, a gizmo edit, a saved-view recall),
   * otherwise the next mouse-orbit will snap the camera back to the
   * preset's stale orientation.
   *
   * The quat→euler conversion is unstable at pitch ±90 (gimbal lock), so
   * if your external writer goes near vertical, prefer driving the preset
   * via {@link setOrientation} from yaw/pitch you already know.
   */
  syncFromCamera(): void {
    if (!this._host) return;
    _scratchEuler.copy(this._host.cameraEntity.getEulerAngles());
    this._pitch = math.clamp(_scratchEuler.x, -89, 89);
    this._yaw = _scratchEuler.y;
  }

  /**
   * Global enable / disable. When `false`, all listeners ignore input and
   * `update()` is a no-op. Toggling off also releases any held mouse
   * buttons, fly keys and move input so the camera doesn't drift when input
   * resumes - a stick whose finger vanished while this was off would
   * otherwise still be pushing.
   */
  get enabled(): boolean { return this._enabled; }
  set enabled(v: boolean) {
    if (this._enabled === v) return;
    this._enabled = v;
    if (!v) {
      this._leftDown = false;
      this._rightDown = false;
      this._pointerId = null;
      this._touches.clear();
      this._keys.clear();
      this.setMoveInput(0, 0, 0);
    }
  }

  // ── handlers ─────────────────────────────────────────────────────────

  private _applyRotation(): void {
    if (!this._host) return;
    this._rotQuat.setFromEulerAngles(this._pitch, this._yaw, 0);
    this._host.cameraEntity.setRotation(this._rotQuat);
  }

  private _onPointerDown = (e: PointerEvent) => {
    if (!this._enabled || !this._host) return;
    if (e.pointerType === 'touch') {
      // A primary touch starts a fresh gesture, dropping fingers whose up never came.
      if (e.isPrimary) this._touches.clear();
      if (this._touches.size >= 2) return;
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._touches.size === 1) {
        this._leftDown = true;
        this._pointerId = e.pointerId;
        this._lastX = e.clientX;
        this._lastY = e.clientY;
      } else {
        const [a, b] = this._touches.values();
        this._pinchSpan = Math.hypot(b.x - a.x, b.y - a.y);
        this._lastX = (a.x + b.x) / 2;
        this._lastY = (a.y + b.y) / 2;
      }
      e.preventDefault();
      return;
    }
    // Mouse / pen: another pointer already owns the drag. A primary pointer
    // means nothing else is down, so any owner it would displace is stale.
    if (this._pointerId !== null && this._pointerId !== e.pointerId && !e.isPrimary) return;
    if (e.button === 0) {
      this._leftDown = true;
    } else if (e.button === 2) {
      this._rightDown = true;
    } else {
      return;
    }
    this._pointerId = e.pointerId;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    e.preventDefault();
  };

  // Also pointercancel: a touch the OS takes (notification, edge swipe) never
  // sends pointerup, and a drag left down would turn any later finger into look.
  private _onPointerUp = (e: PointerEvent) => {
    if (this._touches.delete(e.pointerId)) {
      // A pinch losing a finger goes back to looking with the one left.
      const rest = this._touches.entries().next().value;
      if (rest) {
        this._pointerId = rest[0];
        this._lastX = rest[1].x;
        this._lastY = rest[1].y;
        return;
      }
    }
    if (e.pointerId !== this._pointerId) return;
    this._leftDown = false;
    this._rightDown = false;
    this._pointerId = null;
  };

  /** The page lost the pointer mid-drag (alt-tab, an alert): drop the drag. */
  private _onBlur = () => {
    this._leftDown = false;
    this._rightDown = false;
    this._pointerId = null;
    this._touches.clear();
  };

  private _onPointerMove = (e: PointerEvent) => {
    if (!this._enabled || !this._host) return;
    const touch = this._touches.get(e.pointerId);
    if (touch) {
      touch.x = e.clientX;
      touch.y = e.clientY;
      if (this._touches.size === 2) { this._pinchMove(); return; }
    }
    if (e.pointerId !== this._pointerId) return;
    if (!this._leftDown && !this._rightDown) return;
    // The mouse button came up where we never heard it (a swallowed up).
    if (e.pointerType === 'mouse' && e.buttons === 0) return this._onBlur();
    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    this._lastX = e.clientX;
    this._lastY = e.clientY;

    if (this._leftDown) {
      // Update yaw/pitch directly then rebuild the quaternion. Don't
      // round-trip through entity.getEulerAngles() - quat→euler is
      // unstable near pitch ±90 and causes the camera to teleport.
      this._yaw -= dx * this.lookSensitivity;
      const pitchDelta = dy * this.lookSensitivity * (this.invertLook ? 1 : -1);
      this._pitch = math.clamp(this._pitch + pitchDelta, -89, 89);
      this._applyRotation();
    } else {
      this._pan(dx, dy);
    }
  };

  // Spread to fly in (ortho: zoom in), move both fingers to pan.
  private _pinchMove(): void {
    const cam = this._host!.cameraEntity;
    const [a, b] = this._touches.values();
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const camComp = cam.camera;
    if (camComp && camComp.projection === PROJECTION_ORTHOGRAPHIC) {
      if (span > 0 && this._pinchSpan > 0) {
        camComp.orthoHeight = Math.max(0.01, camComp.orthoHeight * (this._pinchSpan / span));
      }
    } else {
      // Same world-per-pixel scale as the pan, so a pinch and a drag of one
      // length move the camera equally far.
      this._scratchFwd.set(0, 0, -1);
      cam.getRotation().transformVector(this._scratchFwd, this._scratchFwd);
      this._scratchPos.copy(cam.getPosition());
      this._scratchPos.add(this._scratchFwd.mulScalar((span - this._pinchSpan) * this._panScale()));
      cam.setPosition(this._scratchPos);
    }
    this._pinchSpan = span;
    this._pan(midX - this._lastX, midY - this._lastY);
    this._lastX = midX;
    this._lastY = midY;
  }

  // Pan in the screen plane, scaled by world-space distance from origin so
  // panning feels equally fast at any zoom. There's no orbit target for a fly
  // cam, so distance-from-origin proxies for "zoom level".
  private _pan(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const cam = this._host!.cameraEntity;
    const rot = cam.getRotation();
    this._scratchRight.set(1, 0, 0);
    this._scratchUp.set(0, 1, 0);
    rot.transformVector(this._scratchRight, this._scratchRight);
    rot.transformVector(this._scratchUp, this._scratchUp);
    const panScale = this._panScale();
    this._scratchPos.copy(cam.getPosition());
    this._scratchPos.add(this._scratchRight.mulScalar(-dx * panScale));
    this._scratchPos.add(this._scratchUp.mulScalar(dy * panScale));
    cam.setPosition(this._scratchPos);
  }

  private _panScale(): number {
    return (this._host!.cameraEntity.getPosition().length() || 1) * this.panSensitivity;
  }

  private _onWheel = (e: WheelEvent) => {
    if (!this._enabled || !this._host) return;
    e.preventDefault();
    const cam = this._host.cameraEntity;
    const camComp = cam.camera;
    // Orthographic: dolly does nothing visible, so zoom by scaling the ortho
    // frustum height (exponential so each notch feels the same at any zoom).
    if (camComp && camComp.projection === PROJECTION_ORTHOGRAPHIC) {
      // ~1.1× per typical wheel notch (deltaY ≈ 100); exponential so zoom feels
      // uniform at any scale. Scroll up (deltaY < 0) zooms in.
      const next = camComp.orthoHeight * Math.exp(e.deltaY * 0.001);
      camComp.orthoHeight = Math.max(0.01, next);
      return;
    }
    this._scratchFwd.set(0, 0, -1);
    cam.getRotation().transformVector(this._scratchFwd, this._scratchFwd);
    this._scratchPos.copy(cam.getPosition());
    this._scratchPos.add(this._scratchFwd.mulScalar(-e.deltaY * this.zoomSensitivity));
    cam.setPosition(this._scratchPos);
  };

  private _onContextMenu = (e: Event) => e.preventDefault();

  private _onKeyDown = (e: KeyboardEvent) => {
    if (!this._enabled) return;
    if (this.shouldIgnoreKeystroke(e)) return;
    const k = e.key.toLowerCase();
    if (FlyControls._FLY_KEYS.has(k)) this._keys.add(k);
  };

  private _onKeyUp = (e: KeyboardEvent) => {
    this._keys.delete(e.key.toLowerCase());
  };
}
