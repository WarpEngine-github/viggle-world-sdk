/**
 * Where a scene has gaps, and where to stand to fill them: the geometry half
 * of `SceneRenderer.findGaps`, pure so it runs (and is tested) without an
 * engine.
 *
 * WHY THERE ARE GAPS. A panorama reconstruction knows only what one viewpoint
 * saw. Step off it and whatever was in something's shadow - the floor behind
 * a sofa, the wall behind a pillar - has no splats and renders as nothing.
 * Those are the views worth generating: a fill made from there adds what the
 * capture point could not see.
 *
 * THE SEARCH. Candidate cameras stand on rings round the capture point, at
 * eye height, each looking back towards it (where the reconstruction is dense
 * and the occluded backs of things are in view). The engine's offscreen probe
 * then measures each one - the share of the frame no splat covers - and
 * `pickGaps` keeps the emptiest few that are not the same gap twice.
 *
 * INSIDE THE ROOM. A camera outside the shell looks at the void round it and
 * would score as one enormous gap. So each ring is pulled in to a share of
 * the distance to the nearest wall in its direction, measured from the
 * splats themselves (`wallDistances`).
 *
 * WORLD FRAME. Everything here is the viewer's world: Y up, the capture point
 * at the origin, the floor `height` below it. Yaw and pitch are a PlayCanvas
 * camera's Euler (pitch, yaw, 0): yaw 0 looks down -Z, pitch up is positive.
 */

export type Vec3 = [number, number, number];

export interface GapSearchOptions {
  /** Directions round the capture point. Default 12 (every 30 degrees). */
  directions?: number;
  /** Ring radii, in capture heights (the capture point's height over the floor). Default `[0.75, 1.5]`. */
  radii?: number[];
  /** How far each camera looks down, degrees. Default 10. */
  pitchDeg?: number;
  /** A camera stands at most this share of the way to the nearest wall in its direction. Default 0.5. */
  wallMargin?: number;
  /** A view with less empty than this is not a gap. Default 0.01 (1% of the frame). */
  minHoleFraction?: number;
  /** At most this many gaps, emptiest first. Default 5. */
  maxGaps?: number;
  /** Two cameras closer than this in direction, seen from the capture point, look at the same gap: the emptier is kept. Default 45. */
  minSeparationDeg?: number;
}

/** One camera to measure, in the world frame. */
export interface GapCandidate {
  position: Vec3;
  /** Unit vector the camera looks along. */
  forward: Vec3;
  yawDeg: number;
  pitchDeg: number;
}

export const GAP_DEFAULTS = {
  directions: 12,
  radii: [0.75, 1.5],
  pitchDeg: 10,
  wallMargin: 0.5,
  minHoleFraction: 0.01,
  maxGaps: 5,
  minSeparationDeg: 45,
} as const;

/** Buckets round the capture point that `wallDistances` measures. */
export const WALL_BUCKETS = 36;

/** Closer to the capture point than this (in capture heights) is not a candidate: it sees what the capture point saw. */
const MIN_RADIUS = 0.25;

/**
 * How far the nearest wall is in each of `buckets` directions round the
 * capture point, from a sample of splat centres (`[x, y, z] * n`, world).
 *
 * Only splats from chest height to well over head height count, so the floor,
 * the ceiling and what a camera can see over (a railing, a table) are not
 * walls. A bucket's wall is the MEDIAN distance of its splats: the shell
 * round the capture point, not the nearest thing in front of it - a person or
 * a pillar standing near the capture point would otherwise hold every camera
 * back on top of it, where there is nothing to fill. A bucket with no splats
 * in it is open (Infinity).
 *
 * Bucket `i` covers the directions whose yaw (as `yawOfDirection`) is in
 * `[i, i + 1) * 360 / buckets` degrees.
 */
export function wallDistances(points: Float32Array, height: number, buckets = WALL_BUCKETS): number[] {
  const lo = -0.3 * height;
  const hi = 1.0 * height;
  const near = 0.15 * height;
  const rings: number[][] = Array.from({ length: buckets }, () => []);
  for (let k = 0; k + 2 < points.length; k += 3) {
    const x = points[k]!, y = points[k + 1]!, z = points[k + 2]!;
    if (y < lo || y > hi) continue;
    const r = Math.hypot(x, z);
    if (r < near) continue;
    rings[bucketOf(yawOfDirection(x, z), buckets)]!.push(r);
  }
  return rings.map((rs) => {
    if (rs.length === 0) return Infinity;
    rs.sort((a, b) => a - b);
    return rs[Math.floor(rs.length * 0.5)]!;
  });
}

/**
 * The cameras to measure: `directions` round the capture point times each
 * ring radius, pulled in from the walls, looking back towards the middle.
 * `walls` is `wallDistances`' answer (any bucket count); omitted, nothing is
 * pulled in.
 */
export function gapCandidates(height: number, walls: number[] | null, opts: GapSearchOptions = {}): GapCandidate[] {
  const directions = opts.directions ?? GAP_DEFAULTS.directions;
  const radii = opts.radii ?? GAP_DEFAULTS.radii;
  const pitchDeg = opts.pitchDeg ?? GAP_DEFAULTS.pitchDeg;
  const margin = opts.wallMargin ?? GAP_DEFAULTS.wallMargin;
  const out: GapCandidate[] = [];
  for (let i = 0; i < directions; i++) {
    const yaw = (i / directions) * 360;
    const wall = walls ? nearestWall(walls, yaw, 360 / directions / 2) : Infinity;
    const seen = new Set<string>();
    for (const radius of radii) {
      const r = Math.min(radius * height, margin * wall);
      if (!(r >= MIN_RADIUS * height)) continue;
      const key = r.toFixed(6);
      if (seen.has(key)) continue;
      seen.add(key);
      // Standing out along `yaw`, looking back the other way.
      const [dx, dz] = directionOfYaw(yaw);
      const position: Vec3 = [dx * r, 0, dz * r];
      const p = (pitchDeg * Math.PI) / 180;
      const forward: Vec3 = [-dx * Math.cos(p), -Math.sin(p), -dz * Math.cos(p)];
      out.push({ position, forward, yawDeg: normaliseYaw(yaw + 180), pitchDeg: -pitchDeg });
    }
  }
  return out;
}

/**
 * The gaps worth filling, emptiest first: measured candidates over
 * `minHoleFraction`, no two within `minSeparationDeg` of each other (seen
 * from the capture point), at most `maxGaps`.
 */
export function pickGaps<T extends { candidate: GapCandidate; holeFraction: number }>(
  measured: T[], opts: GapSearchOptions = {},
): T[] {
  const min = opts.minHoleFraction ?? GAP_DEFAULTS.minHoleFraction;
  const max = opts.maxGaps ?? GAP_DEFAULTS.maxGaps;
  const sep = opts.minSeparationDeg ?? GAP_DEFAULTS.minSeparationDeg;
  const ranked = measured.filter((m) => m.holeFraction >= min).sort((a, b) => b.holeFraction - a.holeFraction);
  const out: T[] = [];
  for (const m of ranked) {
    if (out.length >= max) break;
    const yaw = yawOfDirection(m.candidate.position[0], m.candidate.position[2]);
    if (out.some((o) => angleBetween(yaw, yawOfDirection(o.candidate.position[0], o.candidate.position[2])) < sep)) continue;
    out.push(m);
  }
  return out;
}

/**
 * A vertical field of view as the horizontal one at `aspect` (width / height),
 * degrees: the probe measures horizontally, the viewer and the API speak vertically.
 */
export function horizontalFov(verticalDeg: number, aspect: number): number {
  const v = (verticalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(v / 2) * aspect) * 180) / Math.PI;
}

/** Yaw of the horizontal direction (x, z), degrees in [0, 360): 0 is -Z, 90 is -X, as a camera's yaw. */
function yawOfDirection(x: number, z: number): number {
  return normaliseYaw((Math.atan2(-x, -z) * 180) / Math.PI);
}

/** The unit horizontal direction (x, z) a camera of this yaw looks along. */
function directionOfYaw(yawDeg: number): [number, number] {
  const a = (yawDeg * Math.PI) / 180;
  return [-Math.sin(a), -Math.cos(a)];
}

function normaliseYaw(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

function bucketOf(yawDeg: number, buckets: number): number {
  return Math.min(buckets - 1, Math.floor((normaliseYaw(yawDeg) / 360) * buckets));
}

/** The nearest wall within `halfWidthDeg` either side of `yawDeg`: a camera between two buckets stops at the closer. */
function nearestWall(walls: number[], yawDeg: number, halfWidthDeg: number): number {
  const n = walls.length;
  const from = Math.floor(((yawDeg - halfWidthDeg) / 360) * n);
  const to = Math.floor(((yawDeg + halfWidthDeg) / 360) * n);
  let best = Infinity;
  for (let b = from; b <= to; b++) best = Math.min(best, walls[((b % n) + n) % n]!);
  return best;
}

function angleBetween(a: number, b: number): number {
  const d = Math.abs(normaliseYaw(a) - normaliseYaw(b));
  return Math.min(d, 360 - d);
}
