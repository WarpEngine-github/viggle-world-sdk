/**
 * Where the ground is under a point of a scanned scene (Walk mode).
 *
 * A splat scan has no mesh to collide with, so "the floor" has to be read out
 * of the points themselves. This does it the way the RENDERER does: march a
 * ray down from the asker, accumulate opacity through the splats it passes,
 * and call the surface at the depth where enough of it has accumulated to be
 * solid. The depth that comes back is therefore the depth the ground LOOKS
 * like it is at, which is the number a character has to agree with.
 *
 * ADAPTED FROM viggle-view-playground's `src/core/ground.ts`, which arrived at
 * this after trying the obvious things. Its header is worth reading in full;
 * the two findings that decided this file are:
 *
 *   A PLANE FIT IS THE WRONG MODEL. That repo fitted one by least squares and
 *   it "read beautifully on the scenes here, every one of which turned out to
 *   be tilted between 1 and 6.4 degrees" - and it was still wrong, because a
 *   plane can only be right where the ground IS one. Fitting a plane to a
 *   staircase returns the ramp through it, a surface nobody is standing on.
 *
 *   A MATHEMATICAL RAY IS TOO THIN. Tested against splat extents it hits 4 to
 *   16 splats, "few enough that one stray decides the answer". The ray needs
 *   an APERTURE: a cylinder about a foot across, which gathers 70 to 130 and
 *   moves less than 1% as the opacity threshold is swept.
 *
 * WHAT THIS FILE CHANGED, and why. The playground probes ONE position - the
 * capture point - once per scene, so it can walk the whole cloud. A walker
 * probes a moving position several times a frame, so the points have to be
 * findable: the counting-sort grid below is this file's whole addition, and
 * the decision it feeds is theirs. It also drops their seeded aperture, which
 * their own header calls a real dependency that is not load bearing: a
 * normalised scene is one unit per metre, so the aperture is a fraction of
 * the walker and needs no probe to size it.
 *
 * WHAT IT REPLACED. A percentile over the points in a window - first the
 * lowest of all of them, then the lowest of the topmost cluster. Both answer
 * with a splat CENTRE, and a centre sits inside the surface it belongs to, so
 * a walker standing on the answer stands inside the floor. Accumulated
 * opacity has no such bias: it commits where the scene becomes opaque, which
 * is where it is seen to be.
 *
 * Every size here is a fraction of the scene's own extent or of the walker,
 * never a metre.
 */

/** A world-space point sample with the per-splat alpha the march needs. */
export interface FloorSample {
  /** `[x,y,z] * count`, world space. */
  positions: Float32Array;
  /**
   * Per-splat alpha in [0,1], one per point. Null when the file carries no
   * opacity property, in which case every splat counts as solid - the
   * engine's own advice for a caller with a threshold, and the alternative
   * (counting none) would make the ground vanish on such a file.
   */
  alpha: Float32Array | null;
}

export interface FloorIndex {
  /**
   * The ground below (x, z), or null when the ray never committed.
   *
   * `fromY` is where the ray starts - the walker's feet plus whatever step
   * she is allowed. Only splats BELOW it are marched, so a table she is
   * under cannot be stood on.
   *
   * `aperture` is the cylinder's radius: a foot, not a scene fraction. See
   * `walkerAperture`.
   *
   * `maxDrop` bounds how far down the march looks. It is what keeps a
   * panorama's shell underside - metres below the floor, and the thing that
   * put a walker under the ground twice - out of the gather entirely.
   */
  floorAt: (x: number, z: number, aperture: number, fromY: number, maxDrop: number) => number | null;
  /** Grid cell edge in world units. The resolution this index can resolve. */
  cell: number;
  /** Points the index holds. */
  count: number;
}

/** Cells per side across the sample's longest horizontal extent. */
const CELLS_ACROSS = 64;

/**
 * THE APERTURE, as a fraction of the walker's height: about 7 cm on a 1.7 m
 * body, which is the patch a foot covers.
 *
 * It is the playground's 0.05 of a 1.5 m capture height, re-expressed against
 * the body so that no seed probe is needed to size it. Their measurements are
 * what make it this number rather than a guess: at this width the answer
 * moves less than 1% as the opacity threshold is swept, and at four times it
 * starts catching what is NEAR the character rather than under them.
 *
 * "The aperture is the one thing standing between this and a plane fit."
 */
const APERTURE_FRACTION = 0.045;

/** Below this a splat is reconstruction haze rather than surface. */
const MIN_ALPHA = 0.5;

/**
 * Some captures never get that opaque: Pink static's floor is all alpha 0.49
 * and its most solid splats 0.55, so the 0.5 cut left no floor anywhere. The
 * cut drops to this fraction of the capture's 90th-percentile alpha when that
 * is lower - a no-op on a capture whose solid splats are near 1.
 */
const MIN_ALPHA_OF_P90 = 0.75;

/** The lowest the cut goes: below it a capture that is mostly haze would
 *  count its haze as floor. */
const MIN_HAZE_CUT = 0.1;

/** The haze cut for this sample. See {@link MIN_ALPHA_OF_P90}. */
function hazeCutFor(alpha: Float32Array | null): number {
  if (!alpha || alpha.length === 0) return MIN_ALPHA;
  const bins = new Uint32Array(101);
  for (let i = 0; i < alpha.length; i++) bins[Math.min(100, Math.max(0, Math.round(alpha[i]! * 100)))]!++;
  let seen = 0;
  for (let b = 0; b <= 100; b++) {
    seen += bins[b]!;
    if (seen >= alpha.length * 0.9) return Math.max(MIN_HAZE_CUT, Math.min(MIN_ALPHA, (b / 100) * MIN_ALPHA_OF_P90));
  }
  return MIN_ALPHA;
}

/**
 * Accumulated alpha before a depth counts as the surface.
 *
 * THE STRAY REJECTION, and the whole of it. One bright splat floating under
 * the walker clears MIN_ALPHA and would win on its own if the surface were
 * simply the first hit; five says "do not believe a surface until something
 * solid is there". No statistics and no rejection pass - one number, and
 * raising or lowering it does a thing a reader can predict.
 */
const COMMIT_OPACITY = 5;

/**
 * The aperture a walker of this height should march with, on an index of this
 * resolution.
 *
 * Floored at one cell only because the grid cannot hand back points at a
 * finer resolution than its own bins; the body is what sets it otherwise. A
 * foot is the same size in a cupboard and in a stadium, which is why this
 * does NOT scale with the scene - an earlier version did, and was differently
 * wrong in every scene as a result.
 */
export function walkerAperture(height: number, cell: number): number {
  return Math.max(cell, height * APERTURE_FRACTION);
}

/**
 * Build the index from a world-space sample. Empty or degenerate input gives
 * an index whose `floorAt` always returns null.
 */
export function buildFloorIndex(sample: FloorSample, cellsAcross = CELLS_ACROSS): FloorIndex {
  const points = sample.positions;
  const alpha = sample.alpha;
  const n = Math.floor(points.length / 3);
  if (n === 0) return { floorAt: () => null, cell: 1, count: 0 };

  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3]!; const z = points[i * 3 + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const span = Math.max(maxX - minX, maxZ - minZ);
  if (!(span > 0) || !Number.isFinite(span)) return { floorAt: () => null, cell: 1, count: n };
  const cell = span / cellsAcross;
  const minAlpha = hazeCutFor(alpha);
  const cols = Math.ceil((maxX - minX) / cell) + 1;
  const rows = Math.ceil((maxZ - minZ) / cell) + 1;

  // Counting sort into cells: one pass for counts, one for placement, so the
  // index is two typed arrays rather than a million small arrays. This is the
  // only reason a per-frame probe is affordable at all.
  const cellOf = (x: number, z: number) =>
    Math.min(rows - 1, Math.max(0, Math.floor((z - minZ) / cell))) * cols
    + Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell)));
  const counts = new Uint32Array(cols * rows + 1);
  for (let i = 0; i < n; i++) counts[cellOf(points[i * 3]!, points[i * 3 + 2]!) + 1]!++;
  for (let c = 1; c < counts.length; c++) counts[c]! += counts[c - 1]!;
  const order = new Uint32Array(n);
  const fill = counts.slice(0, -1);
  for (let i = 0; i < n; i++) {
    const c = cellOf(points[i * 3]!, points[i * 3 + 2]!);
    order[fill[c]!++] = i;
  }

  // Reused across calls: a probe runs several times a frame and must not
  // allocate. Depth and alpha travel as parallel entries of one array, so a
  // sort moves both.
  let scratch: { down: number; a: number }[] = [];

  const floorAt = (
    x: number,
    z: number,
    aperture: number,
    fromY: number,
    maxDrop: number,
  ): number | null => {
    const r2 = aperture * aperture;
    const c0 = Math.max(0, Math.floor((x - aperture - minX) / cell));
    const c1 = Math.min(cols - 1, Math.floor((x + aperture - minX) / cell));
    const r0 = Math.max(0, Math.floor((z - aperture - minZ) / cell));
    const r1 = Math.min(rows - 1, Math.floor((z + aperture - minZ) / cell));
    if (c1 < c0 || r1 < r0) return null;

    scratch = [];
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const c = row * cols + col;
        for (let k = counts[c]!; k < counts[c + 1]!; k++) {
          const i = order[k]! * 3;
          const dx = points[i]! - x; const dz = points[i + 2]! - z;
          // The CYLINDER. Not a cone: a character occupies the same patch of
          // floor whether the reconstruction put it near or far.
          if (dx * dx + dz * dz > r2) continue;
          // Strictly below the asker, and not so far below that it is the
          // shell rather than the floor.
          const down = fromY - points[i + 1]!;
          if (down <= 0 || down > maxDrop) continue;
          const a = alpha ? alpha[order[k]!]! : 1;
          if (a < minAlpha) continue;
          scratch.push({ down, a });
        }
      }
    }
    if (scratch.length === 0) return null;

    // Front to back from the asker, then march: the surface is where enough
    // opacity has been passed THROUGH, never simply the first thing hit.
    scratch.sort((p, q) => p.down - q.down);
    let acc = 0;
    for (let i = 0; i < scratch.length; i++) {
      acc += scratch[i]!.a;
      if (acc >= COMMIT_OPACITY) return fromY - scratch[i]!.down;
    }
    // Everything under her put together is not solid enough to stand on. Null
    // is the honest answer and the walk controller handles it.
    return null;
  };

  return { floorAt, cell, count: n };
}
