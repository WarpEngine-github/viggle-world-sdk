import { Mat4, math, PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE, Quat, Vec3 } from 'playcanvas';
import type { Entity } from 'playcanvas';

import type { CameraHost, CameraPreset, TargetSupplier, Vec3Like } from './camera-preset';

/**
 * Configuration for {@link OrbitControls}.
 *
 * @group Presets
 * @category Camera
 */
export interface OrbitControlsOptions {
  /** Initial horizontal angle in degrees. Default `0`. */
  yaw?: number;
  /** Initial vertical angle in degrees. Clamped to (-89, 89). Default `15`. */
  pitch?: number;
  /** Initial distance from the orbit target. Default `5`. */
  distance?: number;
  /**
   * Orbit target. Either a fixed point or a callable read each frame (so
   * the camera can follow a moving character). Default `{x:0, y:0.5, z:0}`.
   */
  target?: Vec3Like | TargetSupplier;
  /** Min/max distance for scroll and pinch zoom. Default `[0.5, 50]`. */
  distanceRange?: [number, number];
  /** Min/max pitch a drag may reach, degrees. Default `[-89, 89]`. */
  pitchRange?: [number, number];
  /** Orbit sensitivity in degrees per pixel dragged. Default `0.3`. */
  orbitSensitivity?: number;
  /** Pan sensitivity multiplier. Default `0.002`. */
  panSensitivity?: number;
  /** Zoom sensitivity multiplier. Default `0.001`. */
  zoomSensitivity?: number;
  /** Initial projection mode. Default `'perspective'`. */
  projection?: 'perspective' | 'orthographic';
}

/**
 * Pointer-driven orbit camera.
 *
 * - **Left drag / one-finger drag** → orbit around target
 * - **Right / middle drag / two-finger drag** → pan target in the camera's screen plane
 * - **Scroll wheel / two-finger pinch** → dolly in/out
 *
 * Two-phase usage:
 * ```ts
 * const orbit = new OrbitControls({ distance: 4, target: { x: 0, y: 1, z: 0 } });
 * orbit.attach({ canvas, cameraEntity: scene.cameraEntity });
 * // ... per frame:
 * orbit.update();
 * // ... teardown:
 * orbit.detach();
 * ```
 *
 * @group Presets
 * @category Camera
 */
export class OrbitControls implements CameraPreset {
  private _yaw: number;
  private _pitch: number;
  private _distance: number;
  private _target: Vec3;
  private _targetSupplier: TargetSupplier | null;
  private _distanceRange: [number, number];
  private _pitchRange: [number, number];
  private _orbitSensitivity: number;
  private _panSensitivity: number;
  private _zoomSensitivity: number;
  private _projection: 'perspective' | 'orthographic';
  private _orthoHeight = 1;     // recomputed at attach() once camera FOV is known

  private _host: CameraHost | null = null;
  private _dragging: 'orbit' | 'pan' | 'pinch' | null = null;
  private _lastX = 0;
  private _lastY = 0;
  /** Pointers the current gesture owns, by id, at their last position. A
   *  mouse holds one; touch holds up to two (a third finger is ignored). */
  private _pointers = new Map<number, { x: number; y: number }>();
  /** Finger spread at the last pinch move, in CSS px. */
  private _pinchSpan = 0;

  /**
   * Keeps the eye within `length` of `pivot`, sliding it in along the line
   * between them - a camera boom held short by a wall. Applied on every
   * {@link update}, whoever calls it; null for none. Yaw, pitch and distance
   * are left as they are.
   */
  eyeLimit: { pivot: { x: number; y: number; z: number }; length: number } | null = null;

  private _lookMat = new Mat4();
  private _up = new Vec3(0, 1, 0);
  private _pos = new Vec3();
  private _rot = new Quat();

  constructor(config?: OrbitControlsOptions) {
    this._yaw = config?.yaw ?? 0;
    this._pitch = config?.pitch ?? 15;
    this._distance = config?.distance ?? 5;
    this._distanceRange = config?.distanceRange ?? [0.5, 50];
    this._pitchRange = config?.pitchRange ?? [-89, 89];
    this._orbitSensitivity = config?.orbitSensitivity ?? 0.3;
    this._panSensitivity = config?.panSensitivity ?? 0.002;
    this._zoomSensitivity = config?.zoomSensitivity ?? 0.001;
    this._projection = config?.projection ?? 'perspective';

    const t = config?.target;
    if (typeof t === 'function') {
      this._targetSupplier = t;
      const p = t();
      this._target = new Vec3(p.x, p.y, p.z);
    } else {
      this._targetSupplier = null;
      this._target = new Vec3(t?.x ?? 0, t?.y ?? 0.5, t?.z ?? 0);
    }
  }

  attach(host: CameraHost): void {
    if (this._host) throw new Error('[OrbitControls] already attached');
    this._host = host;
    const camFov = (host.cameraEntity.camera?.fov ?? 60) * math.DEG_TO_RAD;
    this._orthoHeight = 2 * this._distance * Math.tan(camFov / 2);
    host.canvas.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    // drag-ok: multi-touch pinch and any-button mouse drags, in a package that
    // can't import the app's trackPointerDrag; moves and blur end it too.
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('blur', this._onBlur);
    host.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    host.canvas.addEventListener('contextmenu', this._onContextMenu);
    this._applyProjection();
    this.update();
  }

  detach(): void {
    if (!this._host) return;
    const { canvas } = this._host;
    canvas.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('blur', this._onBlur);
    canvas.removeEventListener('wheel', this._onWheel);
    canvas.removeEventListener('contextmenu', this._onContextMenu);
    this._host = null;
    this._dragging = null;
    this._pointers.clear();
  }

  /** Recompute camera position + rotation from current yaw/pitch/distance/target. */
  update(): void {
    if (!this._host) return;
    if (this._targetSupplier) {
      const p = this._targetSupplier();
      this._target.set(p.x, p.y, p.z);
    }
    const pitchRad = this._pitch * math.DEG_TO_RAD;
    const yawRad = this._yaw * math.DEG_TO_RAD;
    const cosPitch = Math.cos(pitchRad);

    this._pos.set(
      this._target.x + this._distance * cosPitch * Math.sin(yawRad),
      this._target.y + this._distance * Math.sin(pitchRad),
      this._target.z + this._distance * cosPitch * Math.cos(yawRad),
    );

    this._lookMat.setLookAt(this._pos, this._target, this._up);
    this._rot.setFromMat4(this._lookMat);

    // Slid in toward the pivot after the look is set: the view keeps its angle.
    const limit = this.eyeLimit;
    if (limit) {
      const { pivot, length } = limit;
      const dx = this._pos.x - pivot.x, dy = this._pos.y - pivot.y, dz = this._pos.z - pivot.z;
      const l = Math.hypot(dx, dy, dz);
      if (l > length && l > 0) {
        const k = Math.max(0, length) / l;
        this._pos.set(pivot.x + dx * k, pivot.y + dy * k, pivot.z + dz * k);
      }
    }

    this._host.cameraEntity.setPosition(this._pos);
    this._host.cameraEntity.setRotation(this._rot);
  }

  get yaw(): number { return this._yaw; }
  set yaw(v: number) { this._yaw = v; }
  get pitch(): number { return this._pitch; }
  set pitch(v: number) { this._pitch = math.clamp(v, this._pitchRange[0], this._pitchRange[1]); }
  get distance(): number { return this._distance; }
  set distance(v: number) { this._distance = math.clamp(v, this._distanceRange[0], this._distanceRange[1]); }

  /**
   * The band scroll and pinch may move {@link distance} within.
   *
   * Writable, so a caller can PIN the orbit to one radius by setting both ends
   * to it - which is the only way to express "this distance is a measurement,
   * not a preference" without the caller racing the input handlers every frame.
   * Setting it re-clamps the current distance, so a pin takes effect at once
   * rather than on the next scroll.
   */
  get distanceRange(): [number, number] { return [this._distanceRange[0], this._distanceRange[1]]; }
  set distanceRange(v: [number, number]) {
    this._distanceRange = [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
    this._distance = math.clamp(this._distance, this._distanceRange[0], this._distanceRange[1]);
  }

  /**
   * The band a drag may move {@link pitch} within, in degrees. Defaults to the
   * full `[-89, 89]` the setter already clamps to.
   *
   * Its reason for existing is the same as {@link distanceRange}'s: a camera
   * pinned to a measured ring was scored at ONE elevation, and a drag that
   * leaves that plane is exactly the unmeasured view the pin exists to avoid.
   */
  get pitchRange(): [number, number] { return [this._pitchRange[0], this._pitchRange[1]]; }
  set pitchRange(v: [number, number]) {
    this._pitchRange = [Math.max(-89, Math.min(v[0], v[1])), Math.min(89, Math.max(v[0], v[1]))];
    this._pitch = math.clamp(this._pitch, this._pitchRange[0], this._pitchRange[1]);
  }

  /**
   * Orthographic half-height in world units. Only meaningful while
   * {@link projection} is `'orthographic'`, where this - not {@link distance} -
   * is what sets the apparent zoom.
   *
   * The setter reprojects immediately rather than waiting for the next input
   * event, so callers restoring a saved framing (capture/thumbnail seeds) land
   * on the exact recorded zoom.
   */
  get orthoHeight(): number { return this._orthoHeight; }
  set orthoHeight(v: number) {
    this._orthoHeight = Math.max(0.1, v);
    if (this._host && this._projection === 'orthographic') {
      this._applyProjection();
    }
  }

  /** Direct access to the orbit target Vec3 (mutate to move the focal point). */
  get target(): Vec3 { return this._target; }

  /** Current projection mode. Setting this switches the camera between perspective and orthographic. */
  get projection(): 'perspective' | 'orthographic' { return this._projection; }
  set projection(v: 'perspective' | 'orthographic') {
    if (this._projection === v) return;
    if (v === 'orthographic' && this._host) {
      const camFov = (this._host.cameraEntity.camera?.fov ?? 60) * math.DEG_TO_RAD;
      this._orthoHeight = 2 * this._distance * Math.tan(camFov / 2);
    }
    this._projection = v;
    if (this._host) this._applyProjection();
  }

  private _applyProjection(): void {
    if (!this._host) return;
    const cam = this._host.cameraEntity.camera;
    if (!cam) return;
    if (this._projection === 'orthographic') {
      cam.projection = PROJECTION_ORTHOGRAPHIC;
      cam.orthoHeight = this._orthoHeight;
      // Negative near clip lets the ortho frustum extend behind the camera
      // origin, which prevents the grid ray-plane solver from discarding
      // fragments when the camera is angled and the frustum's near face dips
      // below the grid plane (t < 0 in the shader).
      cam.nearClip = -cam.farClip;
    } else {
      cam.projection = PROJECTION_PERSPECTIVE;
      cam.nearClip = 0.1;
    }
  }

  private _onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') {
      if (e.button === 0) this._dragging = 'orbit';
      else if (e.button === 1 || e.button === 2) this._dragging = 'pan';
      else return;
      this._pointers.clear();
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    } else {
      // The first finger of a gesture starts it afresh, so a finger whose
      // pointerup never arrived cannot leave the controls stuck mid-pinch.
      if (e.isPrimary) this._pointers.clear();
      if (this._pointers.size >= 2) return;
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pointers.size === 1) {
        this._dragging = 'orbit';
        this._lastX = e.clientX;
        this._lastY = e.clientY;
      } else {
        this._dragging = 'pinch';
        const [a, b] = this._pointers.values();
        this._pinchSpan = Math.hypot(b.x - a.x, b.y - a.y);
        this._lastX = (a.x + b.x) / 2;
        this._lastY = (a.y + b.y) / 2;
      }
    }
    e.preventDefault();
    e.stopPropagation();
  };

  private _onPointerMove = (e: PointerEvent) => {
    const p = this._pointers.get(e.pointerId);
    if (!p || !this._dragging || !this._host) return;
    // The mouse button came up where we never heard it (a swallowed up).
    if (e.pointerType === 'mouse' && e.buttons === 0) return this._onBlur();
    p.x = e.clientX;
    p.y = e.clientY;

    if (this._dragging === 'pinch') {
      // Spread the fingers and the scene follows them in: the distance
      // scales by how much the span changed, and the midpoint pans.
      const [a, b] = this._pointers.values();
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      if (span > 0 && this._pinchSpan > 0) this._dolly(this._pinchSpan / span);
      this._pinchSpan = span;
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      this._pan(midX - this._lastX, midY - this._lastY);
      this._lastX = midX;
      this._lastY = midY;
      return;
    }

    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    this._lastX = e.clientX;
    this._lastY = e.clientY;

    if (this._dragging === 'orbit') {
      this._yaw -= dx * this._orbitSensitivity;
      this._pitch = math.clamp(this._pitch + dy * this._orbitSensitivity, -89, 89);
    } else {
      this._pan(dx, dy);
    }
  };

  private _onPointerUp = (e: PointerEvent) => {
    if (!this._pointers.delete(e.pointerId)) return;
    const rest = this._pointers.values().next().value;
    if (!rest) {
      this._dragging = null;
    } else if (this._dragging === 'pinch') {
      // One finger lifted: the other carries on orbiting from where it is,
      // not from where the pinch's midpoint was.
      this._dragging = 'orbit';
      this._lastX = rest.x;
      this._lastY = rest.y;
    }
  };

  private _onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this._dolly(1 + e.deltaY * this._zoomSensitivity);
  };

  /** Move the target in the camera's screen plane by a pointer delta in px. */
  private _pan(dx: number, dy: number): void {
    if (!this._host || (dx === 0 && dy === 0)) return;
    const right = new Vec3();
    const up = new Vec3();
    const cam: Entity = this._host.cameraEntity;
    const panScale = this._projection === 'orthographic'
      ? this._orthoHeight * this._panSensitivity
      : this._distance * this._panSensitivity;
    right.copy(cam.right).mulScalar(-dx * panScale);
    up.copy(cam.up).mulScalar(dy * panScale);
    this._target.add(right).add(up);
    // Panning overrides any target supplier - caller is taking manual control.
    this._targetSupplier = null;
  }

  /** Scale the zoom by `factor` (> 1 is out), within the same limits for
   *  every input: the wheel and the pinch both come through here. */
  private _dolly(factor: number): void {
    if (this._projection === 'orthographic' && this._host) {
      this._orthoHeight = Math.max(0.1, this._orthoHeight * factor);
      this._host.cameraEntity.camera!.orthoHeight = this._orthoHeight;
    } else {
      this._distance = math.clamp(
        this._distance * factor,
        this._distanceRange[0],
        this._distanceRange[1],
      );
    }
  }

  private _onContextMenu = (e: Event) => e.preventDefault();

  /** The page lost the pointer mid-drag (alt-tab, an alert): drop the drag. */
  private _onBlur = () => {
    this._dragging = null;
    this._pointers.clear();
  };
}
