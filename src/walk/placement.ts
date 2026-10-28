/**
 * Where a walkable scene goes in the world, so that its walk start lands on
 * the origin and its floor on y = 0, in metres.
 *
 * The explorer stands the walker on the origin facing -Z, so the scene is
 * moved rather than the walker. A generated file is +Y down, which a half
 * turn about X rights: file (x, y, z) is world (x, -y, -z), times the scale.
 * An upright file (+Y up) can also be turned about Y so the walker faces
 * `face` at the start.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** A splat file's mount: rotation in Euler degrees, then uniform scale, then position. */
export interface SceneTransform {
  position: Vec3Like;
  rotation: Vec3Like;
  scale: number;
}

export interface WalkPlacement {
  /** True when the file is stored +Y up. Default false: a generated file, +Y down. */
  upright?: boolean;
  /** Metres per file unit. Pick it so a door or a chair reads at human scale. */
  scale: number;
  /** The floor's height under the start, in file units along the file's own Y. */
  floor: number;
  /** Where the walker starts, file (x, z). */
  start: readonly [number, number];
  /** Upright files only: the way the walker faces at the start, degrees in the file (0 = +Z, 90 = +X). Default 180 (-Z). */
  face?: number;
}

/**
 * Measure the placement when the scene loads, instead of giving it: for a
 * scene with no known scale - one just generated, or a file someone dropped
 * in. The floor is found straight below the capture point (the origin), and
 * the scale is the one that puts the capture point `captureHeight` metres
 * above it. The walker starts at the capture point.
 */
export interface AutoPlacement {
  auto: true;
  /**
   * True when the file is +Y up. Default: by format - an `.spz` is +Y up (as
   * the API's scenes are, once loaded), a `.ply` from the API +Y down.
   */
  upright?: boolean;
  /** How high the panorama was shot, metres. Default 1.5. */
  captureHeight?: number;
}

/** A panorama's assumed height above its floor, metres. */
export const DEFAULT_CAPTURE_HEIGHT = 1.5;
/** Metres per unit when no floor is found: where generated scenes usually land. */
export const FALLBACK_SCENE_SCALE = 10;

/**
 * The placement a measured floor gives: `depth` is how far below the capture
 * point the floor is, in file units (null when nothing was found).
 */
export function placementFromGround(depth: number | null, opts: Omit<AutoPlacement, 'auto'> = {}): WalkPlacement {
  const height = opts.captureHeight ?? DEFAULT_CAPTURE_HEIGHT;
  const d = depth !== null && depth > 0 && Number.isFinite(depth) ? depth : height / FALLBACK_SCENE_SCALE;
  return { upright: opts.upright || void 0, scale: height / d, floor: opts.upright ? -d : d, start: [0, 0] };
}

/** Which way up a splat file of this name is stored, when nothing says: an `.spz` is +Y up, anything else is taken as the API's +Y-down camera frame. */
export function isUprightFile(filename: string): boolean {
  return /\.spz$/i.test(filename.split(/[?#]/)[0] ?? '');
}

export function isAutoPlacement(p: WalkPlacement | AutoPlacement): p is AutoPlacement {
  return (p as AutoPlacement).auto === true;
}

const FLIP = { x: 180, y: 0, z: 0 };

/** The mount that puts `p.start` on the origin and its floor on y = 0. */
export function placeWalkScene(p: WalkPlacement): SceneTransform {
  const s = p.scale;
  const [x, z] = p.start;
  if (p.face !== undefined && !p.upright) throw new Error('placeWalkScene: `face` needs an upright scene');
  if (!p.upright) return { rotation: FLIP, scale: s, position: { x: -s * x, y: s * p.floor, z: s * z } };
  // To face `face` instead of -Z, turn the scene about Y by 180 - face, and
  // move it so the start still lands on the origin.
  const turn = 180 - (p.face ?? 180);
  const c = Math.cos((turn * Math.PI) / 180);
  const n = Math.sin((turn * Math.PI) / 180);
  return {
    rotation: { x: 0, y: turn, z: 0 },
    scale: s,
    position: { x: -s * (x * c + z * n), y: -s * p.floor, z: -s * (-x * n + z * c) },
  };
}

/** A point in the file's frame, in the world `t` mounts the file into. */
export function fileToWorldPoint(t: SceneTransform, [x, y, z]: readonly [number, number, number]): Vec3Like {
  const s = t.scale;
  let px = x * s, py = y * s, pz = z * s;
  if (t.rotation.x === 180) { py = -py; pz = -pz; }
  const turn = (t.rotation.y * Math.PI) / 180;
  if (turn !== 0) {
    const c = Math.cos(turn), n = Math.sin(turn);
    [px, pz] = [px * c + pz * n, -px * n + pz * c];
  }
  return { x: px + t.position.x, y: py + t.position.y, z: pz + t.position.z };
}

/**
 * A compass direction given in the file's frame (0 = +Z, 90 = +X), in the
 * world. A flipped file runs its Z the other way, so it is mirrored first.
 */
export function fileToWorldAzimuth(t: SceneTransform, azimuth: number): number {
  return (t.rotation.x === 180 ? 180 - azimuth : azimuth) + t.rotation.y;
}
