import type { C2W, CameraAngles, CameraInput, ScenePose, SceneVersion, Vec3Tuple, ViggleScene } from './types.js';

/**
 * The scene file is Y-down (OpenCV, the provider's camera frame); the viewer's
 * world is PlayCanvas's Y-up. The renderer mounts the splat with a half turn
 * about X and nothing else, so file <-> world is that same half turn both
 * ways: it is its own inverse.
 */
export function fileToWorld([x, y, z]: Vec3Tuple): Vec3Tuple {
  return [x, -y, -z];
}

export const worldToFile = fileToWorld;

/**
 * Yaw and pitch, in degrees, of a WORLD forward vector, in the convention of
 * a PlayCanvas camera rotated by Euler (pitch, yaw, 0): yaw 0 looks down -Z.
 */
export function yawPitchOf([fx, fy, fz]: Vec3Tuple): { yaw: number; pitch: number } {
  const len = Math.hypot(fx, fy, fz) || 1;
  const pitch = Math.asin(Math.max(-1, Math.min(1, fy / len)));
  const yaw = Math.atan2(-fx, -fz);
  return { yaw: (yaw * 180) / Math.PI, pitch: (pitch * 180) / Math.PI };
}

/** The scene's up, in the file's Y-down frame. */
const UP: Vec3Tuple = [0, -1, 0];
/** cos(1 degree): closer to straight up or down than this, the view is tipped back to 1 degree off. */
const VERTICAL_GUARD = 0.9998477;

/**
 * A pose as the camera-to-world matrix the API takes: columns right, down,
 * forward, position (OpenCV). The horizon is kept level - the camera has no
 * roll - and a view straight up or down, which has no horizon, is tipped one
 * degree off the axis. The same construction the Viggle backend uses.
 */
export function poseToC2W(pose: ScenePose): C2W {
  for (const v of [...pose.position, ...pose.forward]) {
    if (!Number.isFinite(v)) throw new RangeError('A camera pose must be finite numbers.');
  }
  let fwd = unit(pose.forward);
  if (!fwd) throw new RangeError('This camera pose has no forward direction.');
  const d = dot(fwd, UP);
  if (Math.abs(d) > VERTICAL_GUARD) {
    const flat = unit(sub(fwd, scale(UP, d))) ?? [0, 0, 1];
    const keep = Math.sqrt(1 - VERTICAL_GUARD * VERTICAL_GUARD);
    fwd = add(scale(flat, keep), scale(UP, Math.sign(d) * VERTICAL_GUARD));
  }
  const right = unit(cross(fwd, UP))!;
  const down = scale(cross(right, fwd), -1);
  const [px, py, pz] = pose.position;
  return [
    [right[0], down[0], fwd[0], px],
    [right[1], down[1], fwd[1], py],
    [right[2], down[2], fwd[2], pz],
    [0, 0, 0, 1],
  ];
}

/** The pose a camera matrix stands at and looks along. */
export function c2wToPose(c2w: C2W): ScenePose {
  const fwd = unit([c2w[0]![2]!, c2w[1]![2]!, c2w[2]![2]!]) ?? [0, 0, 1];
  return { position: [c2w[0]![3]!, c2w[1]![3]!, c2w[2]![3]!], forward: fwd };
}

/** The 4x4 identity: a panorama at the scene's own origin, level. */
export const IDENTITY_C2W: C2W = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

export function isC2W(v: CameraInput): v is C2W {
  return Array.isArray(v);
}

const RAD = Math.PI / 180;

/**
 * Angles as a pose. Yaw 0 looks at the panorama's front (+Z), 90 to its right
 * (+X); pitch 90 looks straight up (-Y, the file being Y-down).
 */
export function anglesToPose({ position = [0, 0, 0], yaw, pitch = 0 }: CameraAngles): ScenePose {
  if (![yaw, pitch, ...position].every(Number.isFinite)) throw new RangeError('Camera angles must be finite numbers.');
  if (pitch < -90 || pitch > 90) throw new RangeError('pitch must be from -90 to 90 degrees.');
  const cp = Math.cos(pitch * RAD);
  return {
    position: [...position],
    forward: [Math.sin(yaw * RAD) * cp, -Math.sin(pitch * RAD), Math.cos(yaw * RAD) * cp],
  };
}

/** A pose as angles: yaw in (-180, 180], pitch in [-90, 90]. */
export function poseToAngles(pose: ScenePose): Required<CameraAngles> {
  const f = unit(pose.forward);
  if (!f) throw new RangeError('This camera pose has no forward direction.');
  const pitch = Math.asin(Math.max(-1, Math.min(1, -f[1]))) / RAD;
  // Straight up or down has no heading of its own: call it the front.
  const yaw = Math.hypot(f[0], f[2]) < 1e-9 ? 0 : Math.atan2(f[0], f[2]) / RAD;
  return { position: [...pose.position], yaw: yaw === -180 ? 180 : yaw, pitch };
}

/** Any camera input as a pose (a matrix's own position and forward). */
export function toPose(camera: CameraInput): ScenePose {
  if (isC2W(camera)) return c2wToPose(camera);
  return 'yaw' in camera ? anglesToPose(camera) : camera;
}

/** Any camera input as the matrix the API takes. */
export function toC2W(camera: CameraInput | undefined): C2W {
  if (!camera) return IDENTITY_C2W;
  return isC2W(camera) ? camera : poseToC2W(toPose(camera));
}

/** The scene's current version: the last one. */
export function currentVersion(scene: ViggleScene): SceneVersion | undefined {
  return scene.versions[scene.versions.length - 1];
}

/** Is `a` the same pose as `b`, to within a hair? */
export function samePose(a: ScenePose, b: ScenePose, eps = 1e-4): boolean {
  return a.position.every((v, i) => Math.abs(v - b.position[i]!) < eps)
    && a.forward.every((v, i) => Math.abs(v - b.forward[i]!) < eps);
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function add(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a: Vec3Tuple, s: number): Vec3Tuple { return [a[0] * s, a[1] * s, a[2] * s]; }
function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(a: Vec3Tuple): Vec3Tuple | null {
  const n = Math.hypot(...a);
  return n > 1e-12 ? scale(a, 1 / n) : null;
}
