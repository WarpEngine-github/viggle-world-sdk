
/**
 * The follow camera's boom: how far from the subject the eye may sit before a
 * wall gets between them. Third-person games call it a spring arm; this one
 * follows Roblox's default camera (PlayerModule's Popper, ZoomController and
 * TransparencyController).
 *
 * The boom runs from her head to where the orbit puts the eye, and the eye only
 * ever slides along it: the view keeps its angle. The orbit's own distance and
 * pitch are never written - they stay the reader's.
 *
 * Two kinds of limit:
 * - inside a wall: the eye at full length would be in one. Applied at once.
 * - behind a wall: the eye is in the open but something hides her. Applied only
 *   when the eye just passed through it, or when she would stay hidden - over
 *   the next second of her walk and the reader's turn, and from points around
 *   her head - so a post going by never moves the view.
 * The boom comes in at once and springs back out.
 */

/** The boom's pivot, in walker heights above her feet: her head. */
const PIVOT_HEIGHTS = 0.85;
/** The spring the boom lets out on, Hz: critically damped, from rest. */
const RELEASE_HZ = 4.5;
/** Looking ahead for "would she stay hidden": this far, in steps of this. */
const AHEAD_S = 1.25;
const AHEAD_STEP_S = 1 / 16;
/** Points around her head that must all be hidden too, in walker heights
 *  along the view's right and up. */
const AROUND_HEIGHTS: readonly (readonly [number, number])[] = [[0.08, 0], [-0.08, 0], [0, -0.08], [0, 0.08], [0, 0.04]];
/** Her fade by the eye's distance from her head, in walker heights: whole
 *  past `FADE_CLEAR`, else from half down to none at `FADE_GONE`. */
const FADE_CLEAR_HEIGHTS = 0.25;
const FADE_GONE_HEIGHTS = 0.1;
/** Per second: the most her opacity changes while partly shown. */
const FADE_RATE = 2.8;

type Vec3 = { x: number; y: number; z: number };

/** What the boom asks of the scene's walls: the engine's `SceneCollider` answers it. */
export interface BoomCollider {
  /** Distance along `dir` (unit) to the first wall within `maxT`, or null. */
  raycast(origin: Vec3, dir: Vec3, maxT: number): number | null;
  /** True when a ball of `radius` at `point` touches no wall. */
  isClear(point: Vec3, radius: number): boolean;
}

/** The boom's sizes for one walker, world units. */
export interface Boom {
  /** An orbit this close to her head is left alone. A wall may still bring
   *  the eye nearer, right up to her head, where she is faded out: a view from
   *  her eyes rather than one from inside the wall. */
  min: number;
  /** The eye is a ball this big: it stops this far off a wall, and keeps off
   *  one it only skims past. Narrower than her own collision capsule (0.18
   *  heights), so a boom along a wall she walks beside is clear. */
  radius: number;
  /** The ball is only checked past this, where her head may be near a wall. */
  skip: number;
}

/** The boom for a walker `height` tall. */
export function boomFor(height: number): Boom {
  return { min: height * 0.15, radius: height * 0.1, skip: height * 0.25 };
}

/** Where the boom pivots: her head. */
export function pivotFor(feet: Vec3, height: number): Vec3 {
  return { x: feet.x, y: feet.y + height * PIVOT_HEIGHTS, z: feet.z };
}

/** The orbit's eye for `yaw`/`pitch` degrees at `length` - OrbitControls' formula. */
export function eyeAt(target: Vec3, yawDeg: number, pitchDeg: number, length: number): Vec3 {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const c = Math.cos(pitch);
  return {
    x: target.x + length * c * Math.sin(yaw),
    y: target.y + length * Math.sin(pitch),
    z: target.z + length * c * Math.cos(yaw),
  };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const along = (o: Vec3, d: Vec3, t: number): Vec3 => ({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t });

/** The boom length the walls allow from `pivot` toward `eye`: short of the
 *  first wall on the line, and of any the eye would skim. */
export function armReach(collider: BoomCollider, pivot: Vec3, eye: Vec3, boom: Boom): number {
  const full = len(sub(eye, pivot));
  if (!(full > boom.min)) return full;
  const dir = sub(eye, pivot);
  const unit = { x: dir.x / full, y: dir.y / full, z: dir.z / full };
  const hit = collider.raycast(pivot, unit, full + boom.radius);
  const reach = hit === null ? full : Math.min(full, hit - boom.radius);
  return clearReach(collider, pivot, unit, Math.max(0, reach), boom);
}

/** How far along unit `dir` the eye's ball stays clear, up to `end`. */
function clearReach(collider: BoomCollider, from: Vec3, dir: Vec3, end: number, boom: Boom): number {
  const start = Math.max(boom.skip, boom.min);
  if (!(end > start) || !(boom.radius > 0)) return end;
  const clear = (t: number) => collider.isClear(along(from, dir, t), boom.radius);
  if (!clear(start)) {
    // A wall right by her head: as far out as the ball clears it, from her head.
    let lo = 0, hi = start;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (clear(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }
  // Steps of one radius leave no gap a wall could hide in between the balls.
  let free = start;
  for (let t = start + boom.radius; ; t += boom.radius) {
    const probe = Math.min(t, end);
    if (!clear(probe)) {
      let hi = probe;
      for (let i = 0; i < 5; i++) {
        const mid = (free + hi) / 2;
        if (clear(mid)) free = mid; else hi = mid;
      }
      return free;
    }
    free = probe;
    if (probe >= end) return end;
  }
}

/** The boom an eye inside a wall is pulled back to: that wall's near side.
 *  The whole boom when the eye is in the open. */
export function insideReach(collider: BoomCollider, pivot: Vec3, eye: Vec3, boom: Boom): number {
  const full = len(sub(eye, pivot));
  if (!(full > boom.min) || collider.isClear(eye, boom.radius)) return full;
  const d = sub(eye, pivot);
  const unit = { x: d.x / full, y: d.y / full, z: d.z / full };
  const clear = (t: number) => collider.isClear(along(pivot, unit, t), boom.radius);
  let hi = full;
  for (let t = full - boom.radius; t > 0; t -= boom.radius) {
    if (clear(t)) {
      let lo = t;
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2;
        if (clear(mid)) lo = mid; else hi = mid;
      }
      return lo;
    }
    hi = t;
  }
  return 0;
}

/** One frame of the follow camera, as the boom sees it. */
export interface BoomView {
  /** Her head ({@link pivotFor}), the orbit's eye and its target, world. */
  pivot: Vec3;
  eye: Vec3;
  target: Vec3;
  /** The orbit's yaw and pitch, degrees, and its distance. */
  yaw: number;
  pitch: number;
  distance: number;
  /** World units and degrees per second: her walk, and the reader's turn. */
  velocity: Vec3;
  yawRate: number;
  /** Where the eye was drawn last frame; null on the first. */
  lastEye: Vec3 | null;
}

/** The longest boom this frame allows, from the pivot toward the orbit's eye. */
export function boomLimit(collider: BoomCollider, view: BoomView, boom: Boom, height: number): number {
  const { eye } = view;
  const hard = insideReach(collider, view.pivot, eye, boom);
  const soft = armReach(collider, view.pivot, eye, boom);
  if (!(soft < hard)) return hard;
  // From where the eye was drawn, a wall in the way is one it just passed through.
  const passed = view.lastEye !== null && blocked(collider, view.lastEye, eye);
  return passed || staysHidden(collider, view, eye, height) ? soft : hard;
}

/** Whether a wall lies on the line from `from` to `to`. */
function blocked(collider: BoomCollider, from: Vec3, to: Vec3): boolean {
  const d = sub(to, from);
  const l = len(d);
  return l > 1e-6 && collider.raycast(from, d, l) !== null;
}

/** Whether she stays hidden: at every point of the next stretch of her walk
 *  and the reader's turn, and from every point around her head. */
function staysHidden(collider: BoomCollider, view: BoomView, eye: Vec3, height: number): boolean {
  const v = view.velocity;
  const speed = len(v);
  if (speed > 1e-3) {
    // Only as far ahead as she can walk before she meets a wall.
    const hit = collider.raycast(view.pivot, v, speed * AHEAD_S);
    const until = hit === null ? AHEAD_S : hit / speed;
    for (let s = 0; s <= until; s += AHEAD_STEP_S) {
      const target = along(view.target, v, s);
      if (!blocked(collider, along(view.pivot, v, s), eyeAt(target, view.yaw + view.yawRate * s, view.pitch, view.distance))) {
        return false;
      }
    }
  }
  const yaw = (view.yaw * Math.PI) / 180;
  const pitch = (view.pitch * Math.PI) / 180;
  const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const up = { x: -Math.sin(pitch) * Math.sin(yaw), y: Math.cos(pitch), z: -Math.sin(pitch) * Math.cos(yaw) };
  for (const [r, u] of AROUND_HEIGHTS) {
    const off = { x: (right.x * r + up.x * u) * height, y: (right.y * r + up.y * u) * height, z: (right.z * r + up.z * u) * height };
    // Kept on her side of a wall right beside her head.
    const out = collider.raycast(view.pivot, off, len(off));
    const from = out === null ? along(view.pivot, off, 1) : along(view.pivot, off, (out / len(off)) * 0.9);
    if (!blocked(collider, from, eye)) return false;
  }
  return true;
}

/** One frame of the boom springing toward `goal`: critically damped, so it
 *  sets off from rest and never overshoots. Returns `[length, velocity]`. */
export function stepBoom(x: number, v: number, goal: number, dt: number): [number, number] {
  const w = RELEASE_HZ * 2 * Math.PI;
  const offset = goal - x;
  const step = w * dt;
  const decay = Math.exp(-step);
  return [goal + (v * dt - offset * (step + 1)) * decay, ((offset * w - v) * step + v) * decay];
}

/** Her opacity for an eye this far from her head ({@link pivotFor}). */
export function fadeFor(eye: Vec3, pivot: Vec3, height: number): number {
  const d = len(sub(eye, pivot));
  if (d >= height * FADE_CLEAR_HEIGHTS) return 1;
  return Math.max(0, (0.5 * (d - height * FADE_GONE_HEIGHTS)) / (height * (FADE_CLEAR_HEIGHTS - FADE_GONE_HEIGHTS)));
}

/** This frame's opacity toward `wanted`: eased while she is partly shown, at
 *  once into and out of fully gone (an eye inside her never lingers). */
export function stepFade(current: number, wanted: number, dt: number): number {
  if (wanted <= 0 || current <= 0.05) return wanted;
  const max = FADE_RATE * dt;
  return current + Math.max(-max, Math.min(max, wanted - current));
}
