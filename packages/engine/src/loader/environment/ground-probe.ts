/**
 * WHAT A CHARACTER STANDING AT THE CAPTURE POINT WOULD HAVE UNDER THEIR FEET.
 *
 * A port of viggle-view-playground's `src/core/ground.ts`, which is also what
 * the scene pipeline's view search uses, so the viewer and the search answer
 * the same question the same way on the same file.
 *
 * ── What this is NOT ────────────────────────────────────────────────────
 *
 * It is not a floor plane and it does not fit one. The playground tried that -
 * least squares over a cone - and it read beautifully on scenes that turned
 * out to be tilted 1 to 6.4 degrees. A plane can only be right where the
 * ground IS one, and the ground under a character is as likely to be a hill,
 * a step, or the top of a staircase; fitting a plane to a staircase returns
 * the ramp through it, a surface nobody stands on.
 *
 * Nor is it a median depth, which is what this file replaced in the viewer.
 * A median over a cone answers "how far away is the floor on average", which
 * is the same number only while the floor is flat and empty.
 *
 * ── The method ──────────────────────────────────────────────────────────
 *
 * A RAY MARCH, which is the renderer's own logic: march down from the capture
 * point, gather the splats the ray passes through, sort them front to back,
 * and accumulate opacity until there is enough to call it a surface. That is
 * how a splat renderer decides what you can see, so the depth it returns is
 * the depth the ground LOOKS like it is at - the number a character has to
 * agree with.
 *
 * AN APERTURE, because a mathematical ray is too thin: it hits 4 to 16 splats,
 * few enough that one stray decides the answer. A cylinder of 5% of the depth
 * gathers 70 to 130 and the answer moves less than 1% as the opacity threshold
 * is swept. A CYLINDER and not a cone - a character occupies the same patch of
 * floor whether the reconstruction put it near or far.
 *
 * `commitOpacity` IS WHAT BEATS A STRAY. A single bright splat floating under
 * the camera clears `minAlpha` and would win on its own, so the surface is not
 * the first hit but the depth by which enough accumulated opacity has been
 * passed through.
 *
 * THE SEED. The aperture is a fraction of a depth, so a depth is needed first:
 * the cone median, which is robust and cheap. A seed wrong by a factor of two
 * moves a 5% aperture to between 2.5% and 10%, which the playground's sweep
 * shows does not move the answer - a real dependency, but not load bearing.
 *
 * ── The sign ────────────────────────────────────────────────────────────
 *
 * `downSign` is the trap this whole area keeps setting. A Y-down file (a raw
 * PLY or `.sog`) and a +Y-up one (SPZ v4) disagree about which way is down,
 * and a probe pointed the wrong way measures the SKY and reports it as a floor
 * with a straight face. The caller knows the file's frame and passes it; there
 * is no default.
 */

/** One splat the ray passed through, front to back. */
export interface GroundHit {
  /** Depth below the capture point, FILE units. */
  down: number;
  alpha: number;
  /** Alpha accumulated from the front up to and including this splat. */
  acc: number;
}

export interface GroundProbeParams {
  /** Aperture radius as a fraction of the seeded depth. */
  apertureFrac: number;
  /** Below this a splat is haze rather than surface. */
  minAlpha: number;
  /** Accumulated alpha before a depth counts as the surface. */
  commitOpacity: number;
  /** Nearer than this is at-camera residue with no meaningful direction. */
  minRadius: number;
}

/** The playground's own figures, swept rather than picked. */
export const DEFAULT_GROUND_PROBE: GroundProbeParams = {
  apertureFrac: 0.05,
  minAlpha: 0.5,
  commitOpacity: 5,
  minRadius: 0.02,
};

export interface GroundProbeResult {
  /** Depth of the first committed surface, FILE units. Null when nothing committed. */
  depth: number | null;
  /** The first hit that cleared `minAlpha` - the naive answer, for comparison. */
  firstHit: number | null;
  /** Median depth inside the aperture: a second opinion on the same sample. */
  median: number | null;
  /** The cone median that seeded the aperture. */
  seed: number | null;
  /**
   * Share of the SEED's cone sample within 2% of its median.
   *
   * Not what the depth is taken from - it is the sanity check on the scene:
   * a real floor reads about 0.86, a collapsed spherical shell 0.28, and a
   * probe pointed the wrong way up 0.21.
   */
  flatness: number;
  /** The aperture's radius in file units. */
  aperture: number;
  /** Splats inside the aperture before `minAlpha` dropped any. */
  considered: number;
  /** Splats the ray actually marched through. */
  marched: number;
}

const EMPTY: GroundProbeResult = {
  depth: null, firstHit: null, median: null, seed: null, flatness: 0,
  aperture: 0, considered: 0, marched: 0,
};

/** Half-angle of the seed's cone, degrees. */
const SEED_CONE_DEG = 30;
/** Half-thickness of the flatness slab, as a fraction of the seed depth. */
const SEED_SLAB_FRACTION = 0.02;

/**
 * Per-splat arrays, so this reads a `GSplatData` without importing one.
 *
 * `ArrayLike<number>` and not `Float32Array`, because `getProp` is typed as a
 * union over every typed array a PLY property can arrive in. Nothing here does
 * more than index them.
 */
export interface GroundCloud {
  count: number;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
  /** The RAW LOGIT, as every SPZ decoder in this engine stores it. */
  opacity: ArrayLike<number>;
}

/**
 * The cone median that seeds the aperture, and the flatness that says whether
 * the scene has a floor under it at all.
 */
function seedProbe(
  cloud: GroundCloud,
  downSign: number,
  params: GroundProbeParams,
): { depth: number | null; flatness: number } {
  const cosCone = Math.cos((SEED_CONE_DEG * Math.PI) / 180);
  const depths: number[] = [];
  for (let i = 0; i < cloud.count; i++) {
    const x = cloud.x[i]!, y = cloud.y[i]!, z = cloud.z[i]!;
    const r = Math.sqrt(x * x + y * y + z * z);
    if (!(r >= params.minRadius)) continue;
    if (1 / (1 + Math.exp(-cloud.opacity[i]!)) < params.minAlpha) continue;
    const down = downSign * y;
    if (down <= 0 || down / r < cosCone) continue;
    depths.push(down);
  }
  if (depths.length === 0) return { depth: null, flatness: 0 };
  depths.sort((a, b) => a - b);
  const depth = depths[Math.floor(depths.length * 0.5)]!;
  const half = SEED_SLAB_FRACTION * depth;
  let inSlab = 0;
  for (const d of depths) if (Math.abs(d - depth) <= half) inSlab++;
  return { depth, flatness: inSlab / depths.length };
}

/**
 * The ground under the capture point, in the file's own units.
 *
 * One pass to gather the aperture, one sort, one walk - over the WHOLE cloud,
 * which is the point of it living here. A strided sample would put one or two
 * splats in an aperture the playground fills with 70 to 130, and a committed
 * opacity of 5 would never be reached.
 */
export function probeGround(
  cloud: GroundCloud,
  downSign: 1 | -1,
  params: GroundProbeParams = DEFAULT_GROUND_PROBE,
): GroundProbeResult {
  const { depth: seed, flatness } = seedProbe(cloud, downSign, params);
  if (seed === null || seed <= 0) return EMPTY;

  const aperture = params.apertureFrac * seed;
  const hits: GroundHit[] = [];
  let considered = 0;
  for (let i = 0; i < cloud.count; i++) {
    const x = cloud.x[i]!, y = cloud.y[i]!, z = cloud.z[i]!;
    const r = Math.sqrt(x * x + y * y + z * z);
    if (!(r >= params.minRadius)) continue;
    const down = downSign * y;
    if (down <= 0) continue;
    if (Math.hypot(x, z) > aperture) continue;
    considered++;
    const alpha = 1 / (1 + Math.exp(-cloud.opacity[i]!));
    if (alpha < params.minAlpha) continue;
    hits.push({ down, alpha, acc: 0 });
  }
  if (hits.length === 0) {
    return { ...EMPTY, seed, flatness, aperture, considered };
  }

  hits.sort((a, b) => a.down - b.down);
  let acc = 0;
  let committedAt = -1;
  for (let i = 0; i < hits.length; i++) {
    acc += hits[i]!.alpha;
    hits[i]!.acc = acc;
    if (committedAt < 0 && acc >= params.commitOpacity) committedAt = i;
  }

  return {
    depth: committedAt >= 0 ? hits[committedAt]!.down : null,
    firstHit: hits[0]!.down,
    median: hits[hits.length >> 1]!.down,
    seed,
    flatness,
    aperture,
    considered,
    marched: hits.length,
  };
}
