/**
 * A walkable collider for a scanned scene, built by voxelizing the splats.
 *
 * This is the pure half: sample in, a serializable occupancy grid out. It
 * touches no GPU, no scene and no PlayCanvas type, so it runs in a worker, in a
 * test and in a build script with equal safety - and `collider-worker.ts` does
 * run it in a worker, because the build is a few hundred milliseconds and no
 * frame should pay for it. `scene-collider.ts` is the query half;
 * `environment-collider.ts` is the one call an app makes.
 *
 * ## THE GRID, NOT THE MESH
 *
 * {@link buildColliderData} runs the voxelizer's occupancy stage
 * ({@link buildVoxelGrid}) and never extracts a surface. Every query is a grid
 * lookup:
 *
 *  - the topmost occupied cell in a column is the floor;
 *  - an occupied cell inside the walker's capsule is a wall.
 *
 * That is not a shortcut, it is the reason this is safe. A voxelizer's extracted
 * surface is closed but NOT manifold - two cells touching along a grid edge
 * leave that edge shared by four faces - so a physics cook or a mesh simplifier
 * would choke on it, and dilation moves the pinches rather than removing them.
 * A grid lookup needs no cook. Nothing here ever hands a mesh to a physics
 * engine, and there is no physics engine to hand one to: the capsule is tested
 * by per-slice disc lookups and penetration is resolved by pushing out along
 * the shallowest axis.
 *
 * ## The walkable band is what makes a metric voxel size affordable
 *
 * A panorama reconstruction is radially smeared. The Flow2D fixture spans
 * 225 x 128 x 233 m at its scene scale, and the 5th-95th percentile box is
 * still 64 x 69 x 108 m. A 0.1 m grid over that is 6.7e9 cells - three orders
 * of magnitude past the 4M ceiling - so the coarsen loop would take the voxel
 * to something like 2.6 m and hand back a collider made of house-sized blocks.
 *
 * Nearly all of that volume is sky and distant smear a walker can never reach.
 * So the sample is cropped to a BAND around the floor before it is voxelized,
 * and the crop is what buys the resolution: on the fixture, cropping Y alone
 * takes a requested 0.1 m to 0.225 m instead of 2.6 m, because the points left
 * in the band only span ~37 x 78 m horizontally. No XZ crop is needed - the
 * band does it, since the far smear is mostly above and below.
 *
 * This is why the collider is a WALK collider and not a general collision
 * asset for the whole capture. The band is baked in at build time, and
 * {@link SceneColliderData.bandMinY} / {@link SceneColliderData.bandMaxY}
 * record where it fell so a consumer can say so rather than discover it.
 *
 * ## Density is what makes the grid a surface
 *
 * The band crop and the voxel size are only half the problem. The other half is
 * how many points there are to fill the cells. A 20,000-point sample of a
 * 225 m capture leaves about 12,000 in the walkable band against 30,000 solid
 * cells: 0.41 points per cell, meaning most cells exist because DILATION grew
 * them out of one isolated splat. That is not a blunt collider, it is a
 * fictional one, and asking for a finer voxel makes it worse. The three knobs
 * that fix it, in the order they matter:
 *
 *  1. {@link ColliderTuning.samplePoints} - how many points to read at all.
 *  2. {@link ColliderTuning.opacityThreshold} - a wisp is not a floor.
 *  3. {@link ColliderTuning.bandAboveM} - a tighter ceiling is spent on voxel
 *     size.
 *
 * {@link SceneColliderStats.pointsPerCell} is the number that says which
 * regime you are in. Under about 1.0 the occupancy is islands, and no other
 * readout tells you that.
 *
 * ## Units: the grid is stored in the environment's own space
 *
 * Every length a caller passes is in WORLD METRES, and every length stored here
 * is in the environment's LOCAL units - world metres divided by the
 * environment's world scale. That choice is what makes the collider
 * scale-independent: moving or rescaling the environment entity scales the
 * collider with it for free, with no invalidation, no rebuild and no staleness,
 * because {@link ColliderFrame} is read at QUERY time and only the grid is
 * baked. See `scene-collider.ts` for the conversion and for the one edge this
 * leaves - a band that shrinks out from under a fixed-size walker.
 *
 * [1] Every measurement quoted in this file was taken on PINOC's `flow2d.ply`
 *     fixture (524,288 splats) at its scene's 10 m/unit scale. Re-measure
 *     against a real capture rather than trusting the figures after a change to
 *     the voxelizer.
 *
 * @module
 */

import { buildVoxelGrid } from '../proxy/voxelizer';
import type { ProxyGridVec } from '../proxy/voxelizer';

/**
 * Voxel edge for a walkable collider, in metres.
 *
 * 0.1 m, and for the reason a game editor's environment default is: a collider
 * wants the floor and the walls, not their texture. A character relight proxy
 * uses 0.03 m because it is being LIT, where a welded chin or a forearm fused
 * to a torso is visible; nothing about a walk cares. At 0.1 m a 0.42 m step
 * limit is four voxels and a 0.2 m parapet is two, which is all the fidelity a
 * 1.7 m body can act on.
 *
 * Expect this to be the REQUESTED size and not the delivered one on a large
 * capture - see {@link SceneColliderStats.coarsened}.
 */
export const COLLIDER_VOXEL_METRES = 0.1;

/**
 * How far below the detected floor the band reaches, in metres. One metre is
 * enough to give the ground a couple of voxels of substance under the one-voxel
 * shell a raw voxelization leaves, and to catch a step down.
 */
export const COLLIDER_BAND_BELOW_M = 1;

/**
 * How far above the detected floor the band reaches, in metres.
 *
 * Three metres, not the six this started at. Six was reasoned from headroom - a
 * storey and a half, so a mezzanine floor lands inside - and the reasoning was
 * backwards: the band's job is to be SMALL, because its bounding box is what
 * the coarsen loop spends on voxel size, and a mezzanine at +4 m is not
 * somewhere a 0.45 m step limit can get to anyway. Measured on the Flow2D
 * fixture at a requested 0.1 m, full sample, no opacity threshold: [1]
 *
 *     +6 m:  318k band points -> voxel 0.225 m, 163k cells, 283 ms
 *     +4 m:  293k            -> voxel 0.225 m, 128k cells, 209 ms
 *     +3 m:  267k            -> voxel 0.150 m, 198k cells, 312 ms
 *     +2 m:  235k            -> voxel 0.150 m, 150k cells, 340 ms
 *
 * The step from +4 to +3 is where the band's box finally fits a 0.15 m grid, so
 * a tighter ceiling does not buy a cheaper build - it buys RESOLUTION, a voxel
 * a third finer, which is the one knob that changes what the surface resolves.
 *
 * WHY IT STOPS AT THREE AND NOT LOWER, THOUGH LOWER MEASURES BETTER. On the
 * walk test in {@link COLLIDER_OPACITY_THRESHOLD}, +2.5 m is better again -
 * 4.8% rough strides against 5.5%, and a worst hop of 0.75 m against 1.65 m,
 * because the lower ceiling also crops the eaves and canopy that the ground
 * query was reading as a floor overhead. But the band hangs off the scene's
 * GLOBAL floor, not the walker's local one, so `bandAboveM - walkerHeight` is
 * how far she can climb before her own head leaves the grid and the wall in
 * front of her stops existing. Three metres gives a 1.7 m walker 1.3 m of that
 * margin; 2.5 gives 0.8 m, which a single raised walkway would spend. A
 * collider that silently loses its walls is a worse failure than a rough floor,
 * so the default keeps the margin and the knob is there for a scene that is
 * known to be flat.
 */
export const COLLIDER_BAND_ABOVE_M = 3;

/**
 * Splats fainter than this are not geometry.
 *
 * Zero - count every splat - is what a positions-only sampler forces, and on a
 * scanned city the omission is severe. The Flow2D fixture's median splat is
 * alpha 0.22 and a QUARTER of it is below alpha 0.03, so haze, bloom flare and
 * the soft shell a panorama reconstruction wraps itself in all voxelize into
 * solid floor and solid wall. On the full sample, band -1/+6, requested 0.1 m
 * (so the voxel is a constant 0.225 m and only the occupancy moves): [1]
 *
 *     threshold 0.00:  318k band points -> 163k solid cells
 *     threshold 0.05:  238k            ->  78k
 *     threshold 0.10:  214k            ->  72k
 *     threshold 0.20:  181k            ->  66k
 *     threshold 0.50:  107k            ->  52k
 *
 * Nearly two thirds of the solid cells were wisps. Note this is the opposite of
 * what the voxelizer records for a CHARACTER, where the same knob is "nearly
 * inert" because faint splats sit on top of bright ones - a character is a
 * dense surface seen from outside, a scanned room is mostly air.
 *
 * ## This knob, not the sample, is what stops the ground fluctuating
 *
 * Two symptoms have different causes. Walking 12 m out from the capture origin
 * in eight directions, sampling the floor the walk would stand on every 5 cm,
 * and counting the strides where it moves by more than a whole voxel - a
 * visible hop, not a slope: [1]
 *
 *     20k points, +6 m, no threshold:   12.1% of strides, worst hop 3.83 m
 *     200k points, +6 m, no threshold:  12.4%,            worst hop 3.15 m
 *     20k points, +6 m, threshold 0.2:   9.9%,            worst hop 1.13 m
 *     200k, +3 m, threshold 0.1:          5.5%,           worst hop 1.65 m
 *
 * Raising the sample does NOT settle the ground - it fixes the overlay and it
 * fixes falling through holes (readings with no floor at all drop from 271 to
 * 76), but the floor is just as rough. The threshold is what removes the 3.8 m
 * hop, because that hop was a wisp of haze at head height being read as a floor
 * to stand on. Both knobs are needed; they are not doing the same job.
 *
 * 0.1 and not higher. The roughness curve is flat from 0.1 to 0.4 (5.8%, 5.5%,
 * 5.7%, 5.5%), so everything above 0.1 buys nothing and only deletes real
 * floor - readings with no floor at all are lowest at 0.1 across that range.
 * The knob goes to 0.9 for a capture with a worse halo than this one.
 */
export const COLLIDER_OPACITY_THRESHOLD = 0.1;

/**
 * Voxels of growth applied to the occupied set.
 *
 * One, and the voxelizer's own measurement is why: at 0 a thousandth of the
 * splats escape the surface, and 2 grows the volume by half for coverage nobody
 * was missing. Here it is also what closes the gaps between sampled points, so
 * it is the knob to reach for only after the sample count.
 */
export const COLLIDER_DILATE = 1;

/**
 * How many points the collider's sample takes.
 *
 * THE knob. A world-point sampler's own default is usually 20,000, sized for
 * camera placement and scale estimation - both percentile work, which does not
 * get better with more points. The collider is the opposite: it is the one
 * consumer whose answer is a function of DENSITY. A Flow2D city spans 225 m, so
 * 20,000 points leave about 12,000 in the walkable band against 30,000 solid
 * cells - 0.41 points per cell, an occupancy of dilated islands.
 *
 * 200,000 gets 1.13 points per solid cell - above one, so the occupancy is
 * continuous rather than a scatter - for a 257 ms build against the 229 ms the
 * 20,000-point build already cost. The full fixture (524,288) gets 1.68 and
 * takes 330 ms; the knob reaches it for anyone who wants to look.
 */
export const COLLIDER_SAMPLE_POINTS = 200_000;

/**
 * Which Y percentile of the sample is taken as the floor the band hangs from.
 *
 * Low, because the band has to contain the floor whatever the scene's scale
 * happens to be - and tying the band to a fixed world Y would put it in the
 * wrong place the moment someone drags a scale slider. 5% is the percentile a
 * camera placement heuristic already trusts for its own box.
 */
const FLOOR_PERCENTILE = 0.05;

/**
 * Grid ceiling, in cells. The voxelizer's own default, restated because it is
 * the number {@link SceneColliderStats.coarsened} is about.
 */
export const COLLIDER_MAX_VOXELS = 4_000_000;

/** The smallest sample that can produce anything worth colliding with. */
const MIN_POINTS = 100;

/**
 * Solid islands smaller than this fraction of the largest one are floaters and
 * are dropped, unless the walker's floor is in them. Floors, walls and
 * furniture touch each other after dilation; a wisp blob in mid-air does not,
 * and left in it reads as an invisible wall.
 */
export const COLLIDER_ISLAND_KEEP_FRACTION = 0.05;

/**
 * Every knob the build reads. One flat object rather than a signature per knob,
 * so a tuning UI can move all six through one setter and a persisted override
 * has one shape to be validated against.
 *
 * Serializable by construction - six numbers. It is stored on
 * {@link SceneColliderData.tuning} so a grid always carries the settings that
 * produced it.
 */
export interface ColliderTuning {
  /** Points the sample takes. {@link COLLIDER_SAMPLE_POINTS}. */
  samplePoints: number;
  /** Voxel edge in world METRES. {@link COLLIDER_VOXEL_METRES}. */
  voxelMetres: number;
  /** Voxels of growth applied to the occupied set. {@link COLLIDER_DILATE}. */
  dilate: number;
  /** Metres of band below the detected floor. {@link COLLIDER_BAND_BELOW_M}. */
  bandBelowM: number;
  /** Metres of band above the detected floor. {@link COLLIDER_BAND_ABOVE_M}. */
  bandAboveM: number;
  /**
   * Splats with alpha below this are not geometry; `0` counts every splat.
   * {@link COLLIDER_OPACITY_THRESHOLD}. Inert when the sample carries no alpha.
   */
  opacityThreshold: number;
}

/** The shipped values, so "reset to defaults" is one assignment. */
export const DEFAULT_COLLIDER_TUNING: Readonly<ColliderTuning> = Object.freeze({
  samplePoints: COLLIDER_SAMPLE_POINTS,
  voxelMetres: COLLIDER_VOXEL_METRES,
  dilate: COLLIDER_DILATE,
  bandBelowM: COLLIDER_BAND_BELOW_M,
  bandAboveM: COLLIDER_BAND_ABOVE_M,
  opacityThreshold: COLLIDER_OPACITY_THRESHOLD,
});

/**
 * Range and step for each knob, for a control to read rather than restate.
 *
 * The ceilings are not arbitrary. `samplePoints` stops at 500,000 because a
 * sampler strides over the file and the largest fixture we have IS 524,288
 * splats, so past that the slider does nothing; `dilate` stops at 3, two past
 * the point the voxelizer measured as sufficient; the band is capped where a
 * walker could never reach; `opacityThreshold` stops at 0.9 because above that a
 * scanned floor has holes in it.
 *
 * ## Why the voxel floor is 0.01 and not something safer
 *
 * It was 0.05, on the argument that a real capture coarsens below that anyway so
 * the number stops meaning anything. Half of that is true and the conclusion was
 * wrong: this is the one knob that changes what the surface can RESOLVE, a small
 * capture does not coarsen at all, and a floor five stops below the default left
 * no room to look at a doorway or a kerb.
 *
 * What protects the build is not this bound, it is {@link COLLIDER_MAX_VOXELS}
 * and the coarsen loop, and that pair is honest about itself: a request it
 * cannot afford comes back as a larger voxel with
 * {@link SceneColliderStats.coarsened} set, which a reader sees as
 * `0.225 m (from 0.010)`. Asking for 0.01 degrades visibly in a bounded time
 * rather than hanging.
 *
 * WHAT THE FLOOR IS NOT. It is not a promise of delivery. The cell ceiling binds
 * long before it on anything scene-sized - the band box of a 7 x 4 x 10 m room
 * is already 294 million cells at 0.01 m against a 4 million ceiling, so that
 * room delivers about 0.045 m however far the slider goes down. The floor exists
 * so the request can be MADE and the answer read off, on the small captures and
 * tight bands where it can be met; on a big one the readout is the answer.
 *
 * NO LEAK FLOOR IS CLAMPED ABOVE, because the number where a scene collider
 * starts to come apart is a property of the capture's DENSITY, not of this
 * module. The voxelizer's nearest measurement - 0.02 starting to leak - is about
 * a CHARACTER, where a one-voxel dilation stops closing pinholes in a sparse
 * shell. Here the same failure appears as
 * {@link SceneColliderStats.pointsPerCell} falling under 1, and it moves with
 * the sample: `chamber.spz` at 0.045 m holds 0.83 points per cell on a
 * 200,000-point sample and 2.08 on a 500,000-point one, same capture, same
 * voxel. A constant would have been wrong for every capture but one; the readout
 * is right for all of them.
 *
 * The step is 0.001, a millimetre. Coarse enough not to pretend at precision the
 * voxelizer does not have, fine enough that the bottom decade of the range is a
 * usable ten stops instead of a single one.
 */
export const COLLIDER_TUNING_LIMITS: {
  readonly [K in keyof ColliderTuning]: { min: number; max: number; step: number };
} = Object.freeze({
  samplePoints: { min: 20_000, max: 500_000, step: 10_000 },
  voxelMetres: { min: 0.01, max: 1, step: 0.001 },
  dilate: { min: 0, max: 3, step: 1 },
  bandBelowM: { min: 0.25, max: 4, step: 0.25 },
  bandAboveM: { min: 1.5, max: 12, step: 0.25 },
  opacityThreshold: { min: 0, max: 0.9, step: 0.01 },
});

/**
 * Clamp every knob into {@link COLLIDER_TUNING_LIMITS} and replace anything
 * non-finite with its default.
 *
 * Runs on the way IN to every build, not only where a UI happens to call it.
 * Persisted settings outlive the ranges that produced them, a stale store can
 * hand over a voxel size of 0, and a 0 reaches the coarsen loop as a division -
 * so the clamp belongs where it cannot be skipped.
 */
export function clampColliderTuning(t: Partial<ColliderTuning> | null | undefined): ColliderTuning {
  const out: ColliderTuning = { ...DEFAULT_COLLIDER_TUNING };
  if (!t) return out;
  for (const key of Object.keys(out) as (keyof ColliderTuning)[]) {
    const v = t[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const { min, max } = COLLIDER_TUNING_LIMITS[key];
    out[key] = Math.min(max, Math.max(min, v));
  }
  out.dilate = Math.round(out.dilate);
  out.samplePoints = Math.round(out.samplePoints);
  return out;
}

/**
 * Where the environment sits, right now.
 *
 * The collider's grid is stored in the environment's LOCAL units with the
 * environment's own orientation already applied (the sample was taken in world
 * space, so it was). One local unit is `scale` world metres, and local
 * `(0,0,0)` is at world `origin`. So the mapping is a subtract and a divide in
 * each direction, with no matrix and no rotation:
 *
 *     local = (world - origin) / scale
 *
 * Read at QUERY time, never baked. That is the whole scale-independence story:
 * drag a scene-scale slider or move the environment and every answer moves with
 * it, exactly, with nothing to invalidate.
 *
 * ROTATING the environment after the build DOES invalidate the grid, because
 * the rotation is baked into where the sampled points landed. Captures are not
 * re-oriented at runtime, so this is stated rather than guarded.
 */
export interface ColliderFrame {
  /** World position of the environment entity. */
  origin: ProxyGridVec;
  /** World metres per local unit - the entity's largest axis scale. */
  scale: number;
}

/** The walker a build is seeded from, in world metres. */
export interface ColliderWalker extends ProxyGridVec {
  /** The body's horizontal radius - `capsuleForWalker`'s. */
  radius: number;
  /** The body's height. The seal seeds from her middle, which has to be open
   *  for her to stand there; her feet can sit inside the floor's top cells. */
  height?: number;
}

/** What the build decided, for a readout and for a report. */
export interface SceneColliderStats {
  /** Voxel edge actually used, in world metres AT BUILD SCALE. */
  voxelMetres: number;
  /** Voxel edge asked for, world metres. Differs when the grid coarsened. */
  requestedVoxelMetres: number;
  /**
   * The grid hit the cell ceiling and the voxel size was raised. User-visible:
   * a reader colliding with a 2.6 m grid they believe is 0.1 m has no way to
   * make sense of what they walk into.
   */
  coarsened: boolean;
  /** Grid dimensions, in cells. */
  dims: ProxyGridVec;
  /** `dims.x * dims.y * dims.z`. */
  cells: number;
  /** Solid cells after dilation and island removal. */
  occupiedVoxels: number;
  /** Floater islands removed, and their cells. Absent on grids built before
   *  the pass existed. */
  islandsDropped?: number;
  islandVoxelsDropped?: number;
  /** Empty cells the walker cannot reach, filled solid by {@link sealUnreachable}.
   *  Counted in {@link occupiedVoxels}, not in {@link pointsPerCell}. */
  sealedVoxels?: number;
  /** Points in the sample handed in. */
  samplePoints: number;
  /**
   * The sample carried per-splat alpha, so
   * {@link ColliderTuning.opacityThreshold} had something to act on.
   *
   * `false` means the knob is inert - the capture has no opacity property - and
   * that is the one way to tell "the threshold dropped nothing because this
   * capture has no wisps" from "the threshold dropped nothing because it is not
   * wired up". Two very different readings of the same zero.
   */
  hasAlpha: boolean;
  /** Points the opacity threshold threw away before anything else looked at them. */
  belowThresholdPoints: number;
  /** Points left after the threshold AND inside the band, i.e. the ones
   *  actually voxelized. */
  bandPoints: number;
  /**
   * {@link bandPoints} per occupied cell. THE diagnostic.
   *
   * Under about 1.0 the occupancy is islands that dilation grew out of single
   * splats and the collider is a fiction, whatever the voxel size says. It is
   * the number that catches a bad collider on the first build instead of after
   * a bug report about walking through walls.
   */
  pointsPerCell: number;
  /** Milliseconds the whole build took, band crop included. */
  buildMs: number;
}

/**
 * A built collider, as pure data.
 *
 * Deliberately nothing but numbers and one byte array: structured-cloneable, so
 * it crosses a worker boundary with the occupancy TRANSFERRED rather than
 * copied, and flat enough to serialize alongside an environment later without
 * this becoming a rewrite. {@link version} is what a reader checks first.
 *
 * Every length here is in LOCAL units (see {@link ColliderFrame}).
 * {@link stats} is the same build in world metres, for a human.
 */
export interface SceneColliderData {
  /** Format version of this record. Bump on any layout change. */
  version: 1;
  /** `dims.x * dims.y * dims.z` bytes, 1 where solid, `(z * dims.y + y) * dims.x + x`. */
  occupancy: Uint8Array;
  /** Grid dimensions, in cells. */
  dims: ProxyGridVec;
  /** Local position of cell `(0,0,0)`'s low corner. */
  gridOrigin: ProxyGridVec;
  /** Cell edge, in LOCAL units. */
  voxelSize: number;
  /** The Y the band was hung from - the floor percentile, local units. */
  floorRefY: number;
  /** Band extent, local Y. */
  bandMinY: number;
  bandMaxY: number;
  /** The knobs this grid was built with, already clamped. */
  tuning: ColliderTuning;
  /**
   * The environment transform at build time.
   *
   * Not used by any query - those read the CURRENT frame. It is here so a
   * consumer can say what the grid was measured against, and so the band's
   * world height can be compared against the walker's: the band is baked in
   * local units, so scaling the environment DOWN shrinks it until a fixed-size
   * walker no longer fits inside it. See `SceneCollider.walkerFits`.
   */
  builtFrame: ColliderFrame;
  /** The build, in world metres at {@link builtFrame}'s scale. */
  stats: SceneColliderStats;
}

/**
 * A world-space point sample with per-splat alpha, i.e. what
 * `Environment.sampleWorldSample` returns. Declared structurally so this module
 * stays free of the loader.
 */
export interface ColliderSample {
  /** `[x,y,z] * count`, WORLD space. */
  positions: Float32Array;
  /**
   * Per-splat alpha in `[0,1]`, one per point of {@link positions}. Null or
   * absent counts every splat, which makes
   * {@link ColliderTuning.opacityThreshold} inert.
   */
  alpha?: Float32Array | null;
}

/** Value at quantile `q` of an ascending array. */
function quantile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
}

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * Voxelize a world-space point sample into a collider grid, or say it cannot.
 *
 * Synchronous and not cheap - a few hundred milliseconds on a city-scale
 * capture at the shipped defaults. Nothing calls it on the main thread:
 * `collider-worker.ts` is where it runs, and `environment-collider.ts`'s
 * `buildSceneCollider` is the async front door. It is exported because a test,
 * a script or a build step has no worker and no reason to want one.
 *
 * @param sample world-space positions, ideally with alpha. The sampler's
 *   default count is sized for percentile work and is far too sparse here; see
 *   {@link COLLIDER_SAMPLE_POINTS}.
 * @param frame where the environment sits, so the metric knobs can be
 *   converted into the local units the grid is stored in.
 * @param tuning partial overrides on {@link DEFAULT_COLLIDER_TUNING}. Clamped.
 * @param walker where the walker stands and how wide she is, world space. The
 *   island under her is always kept, and empty space she cannot reach is
 *   sealed. Without one only the largest island and its peers are kept and
 *   nothing is sealed.
 * @returns `null` when there is nothing to collide with: fewer than 100 points
 *   survive the threshold, or the band is empty, or the grid came out solid-free.
 *   A distinct answer from "not built yet", which is the caller's `undefined`.
 */
export function buildColliderData(
  sample: ColliderSample,
  frame: ColliderFrame,
  tuning: Partial<ColliderTuning> = {},
  walker: ColliderWalker | null = null,
): SceneColliderData | null {
  const t0 = now();
  const t = clampColliderTuning(tuning);

  const scale = frame.scale;
  if (!(scale > 0) || !Number.isFinite(scale)) return null;

  const points = sample.positions;
  const n = Math.floor(points.length / 3);
  if (n < MIN_POINTS) return null;

  // Metric knobs -> local units. One place, so nothing downstream has to know
  // the difference.
  const voxelLocal = t.voxelMetres / scale;
  const bandBelowLocal = t.bandBelowM / scale;
  const bandAboveLocal = t.bandAboveM / scale;
  if (!(voxelLocal > 0)) return null;

  const ox = frame.origin.x, oy = frame.origin.y, oz = frame.origin.z;
  const inv = 1 / scale;

  // ── Opacity first, BEFORE the floor percentile. A panorama reconstruction
  //    wraps itself in a faint shell that reaches below the real ground, so a
  //    5th percentile taken over the wisps too hangs the band off the haze and
  //    spends its lowest metre on nothing. Taking it over the splats that
  //    survive the threshold moved the fixture's floor reference up 10 cm.
  const alpha = sample.alpha;
  const hasAlpha = !!alpha && alpha.length >= n && t.opacityThreshold > 0;
  const solid = hasAlpha ? new Uint8Array(n) : null;
  let solidCount = n;
  if (solid) {
    solidCount = 0;
    for (let i = 0; i < n; i++) {
      if (alpha![i] < t.opacityThreshold) continue;
      solid[i] = 1;
      solidCount++;
    }
    if (solidCount < MIN_POINTS) return null;
  }
  const belowThresholdPoints = n - solidCount;

  // ── The walkable band. See the module header: this crop is what lets a
  //    metric voxel size survive a panorama's radial smear.
  const ys = new Float32Array(solidCount);
  for (let i = 0, w = 0; i < n; i++) {
    if (solid && !solid[i]) continue;
    ys[w++] = (points[i * 3 + 1] - oy) * inv;
  }
  ys.sort();
  const floorRefY = quantile(ys, FLOOR_PERCENTILE);
  const bandMinY = floorRefY - bandBelowLocal;
  const bandMaxY = floorRefY + bandAboveLocal;

  // World -> local happens in the same pass as the crop: one traversal, and
  // the voxelizer never sees a world coordinate.
  const band = new Float32Array(solidCount * 3);
  let bandPoints = 0;
  for (let i = 0; i < n; i++) {
    if (solid && !solid[i]) continue;
    const y = (points[i * 3 + 1] - oy) * inv;
    if (y < bandMinY || y > bandMaxY) continue;
    band[bandPoints * 3] = (points[i * 3] - ox) * inv;
    band[bandPoints * 3 + 1] = y;
    band[bandPoints * 3 + 2] = (points[i * 3 + 2] - oz) * inv;
    bandPoints++;
  }
  if (bandPoints < MIN_POINTS) return null;

  const grid = buildVoxelGrid({ positions: band.subarray(0, bandPoints * 3) }, {
    voxelSize: voxelLocal,
    // The threshold is applied above, not handed down: the band crop and the
    // floor percentile both have to see the filtered set, so by the time the
    // voxelizer gets the points there is nothing left for it to reject.
    dilate: t.dilate,
    // A grid lookup reads the TOPMOST occupied cell in a column, so filling
    // underneath changes no answer it can give. Floor fill is for fast
    // rigidbodies tunnelling through a one-voxel shell, and there are none
    // here - and on a band-cropped grid it would fill the whole metre below
    // the floor solid for nothing.
    floorFill: false,
    maxVoxels: COLLIDER_MAX_VOXELS,
  });

  const cells = grid.dims.x * grid.dims.y * grid.dims.z;
  if (grid.occupiedVoxels === 0 || grid.occupancy.length !== cells) return null;

  const seedLocal = walker
    ? { x: (walker.x - ox) * inv, y: (walker.y - oy) * inv, z: (walker.z - oz) * inv }
    : null;
  const islands = dropIslands(grid.occupancy, grid.dims, grid.origin, grid.voxelSize, seedLocal);
  const surfaceVoxels = grid.occupiedVoxels - islands.voxels;
  const sealedVoxels = seedLocal
    ? sealUnreachable(
      grid.occupancy, grid.dims, grid.origin, grid.voxelSize, seedLocal, walker!.radius * inv,
      (walker!.height ?? 0) * inv,
      // Nothing taller than her body is climbed; without a height, any air is.
      walker!.height ? walker!.height * inv : Infinity,
    )
    : 0;
  const occupiedVoxels = surfaceVoxels + sealedVoxels;

  return {
    version: 1,
    occupancy: grid.occupancy,
    dims: grid.dims,
    gridOrigin: grid.origin,
    voxelSize: grid.voxelSize,
    floorRefY,
    bandMinY,
    bandMaxY,
    tuning: t,
    builtFrame: { origin: { x: ox, y: oy, z: oz }, scale },
    stats: {
      voxelMetres: grid.voxelSize * scale,
      requestedVoxelMetres: t.voxelMetres,
      coarsened: grid.coarsened,
      dims: grid.dims,
      cells,
      occupiedVoxels,
      islandsDropped: islands.count,
      islandVoxelsDropped: islands.voxels,
      sealedVoxels,
      samplePoints: n,
      hasAlpha: !!alpha && alpha.length >= n,
      belowThresholdPoints,
      bandPoints,
      pointsPerCell: bandPoints / surfaceVoxels,
      buildMs: now() - t0,
    },
  };
}

/** Cells searched sideways for the floor under the seed: a walker's radius
 *  at the finest voxel a build delivers on a real scene. */
const SEED_SEARCH_CELLS = 6;

/**
 * Label the grid's 26-connected solid islands and clear the floaters, in place.
 * Kept: the island under `seed` (local units), the largest, and every island at
 * least {@link COLLIDER_ISLAND_KEEP_FRACTION} of the largest.
 */
export function dropIslands(
  occ: Uint8Array,
  dims: ProxyGridVec,
  origin: ProxyGridVec,
  voxelSize: number,
  seed: ProxyGridVec | null,
): { count: number; voxels: number } {
  const nx = dims.x, ny = dims.y, nz = dims.z;
  const labels = new Int32Array(occ.length);
  const sizes: number[] = [0];
  let solid = 0;
  for (let i = 0; i < occ.length; i++) if (occ[i]) solid++;
  const queue = new Int32Array(solid);
  for (let start = 0; start < occ.length; start++) {
    if (!occ[start] || labels[start]) continue;
    const label = sizes.length;
    let head = 0, tail = 0;
    queue[tail++] = start;
    labels[start] = label;
    while (head < tail) {
      const i = queue[head++];
      const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= nx) continue;
            const j = (zz * ny + yy) * nx + xx;
            if (!occ[j] || labels[j]) continue;
            labels[j] = label;
            queue[tail++] = j;
          }
        }
      }
    }
    sizes.push(tail);
  }
  if (sizes.length <= 2) return { count: 0, voxels: 0 };

  let largest = 0;
  for (let l = 1; l < sizes.length; l++) if (sizes[l] > largest) largest = sizes[l];
  const keep = new Uint8Array(sizes.length);
  for (let l = 1; l < sizes.length; l++) {
    if (sizes[l] === largest || sizes[l] >= largest * COLLIDER_ISLAND_KEEP_FRACTION) keep[l] = 1;
  }
  const seedLabel = seed ? labelUnder(labels, dims, origin, voxelSize, seed) : 0;
  if (seedLabel) keep[seedLabel] = 1;

  let count = 0, voxels = 0;
  for (let l = 1; l < sizes.length; l++) {
    if (keep[l]) continue;
    count++;
    voxels += sizes[l];
  }
  if (count === 0) return { count, voxels };
  for (let i = 0; i < occ.length; i++) if (occ[i] && !keep[labels[i]]) occ[i] = 0;
  return { count, voxels };
}

/** The label of the highest solid cell at or below `seed`, nearest column
 *  first; 0 when there is none within {@link SEED_SEARCH_CELLS}. */
function labelUnder(
  labels: Int32Array,
  dims: ProxyGridVec,
  origin: ProxyGridVec,
  voxelSize: number,
  seed: ProxyGridVec,
): number {
  const nx = dims.x, ny = dims.y, nz = dims.z;
  const cx = Math.floor((seed.x - origin.x) / voxelSize);
  const cz = Math.floor((seed.z - origin.z) / voxelSize);
  const top = Math.min(ny - 1, Math.floor((seed.y - origin.y) / voxelSize) + 1);
  if (top < 0) return 0;
  for (let r = 0; r <= SEED_SEARCH_CELLS; r++) {
    let best = -1, bestLabel = 0;
    for (let z = cz - r; z <= cz + r; z++) {
      if (z < 0 || z >= nz) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= nx) continue;
        if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) !== r) continue;
        for (let y = top; y > best; y--) {
          const l = labels[(z * ny + y) * nx + x];
          if (!l) continue;
          best = y;
          bestLabel = l;
          break;
        }
      }
    }
    if (bestLabel) return bestLabel;
  }
  return 0;
}

/** Cells searched either side of the seed height for a passable cell. */
const SEAL_SEED_SEARCH_CELLS = 8;

/** How far a hole in the captured floor is bridged from floor around it, in
 *  climbs (body heights): a hole up to twice this across is crossed. */
const HOLE_BRIDGE_HEIGHTS = 0.4;

/**
 * Fill solid every empty cell a body of `radius` (local units) cannot reach
 * from `seed`, in place, and return how many. What is left is a closed shell
 * around the walkable space - what an exported mesh or a physics engine needs.
 *
 * The flood moves through cells with no solid within a square inscribed in the
 * body's disc, so it never refuses a gap the walker's capsule fits through:
 * sealing a doorway she can use would be a false wall. With a finite `climb`
 * it also keeps within that height of the floor under it - where she can stand
 * or step up - so it cannot go over a wall taller than she is and seal nothing
 * behind it. Reached cells are then carried up to the ceiling (the air over
 * her is open) and down to the floor, and grown by the full radius, because
 * her body fills more than her centre line.
 */
export function sealUnreachable(
  occ: Uint8Array,
  dims: ProxyGridVec,
  origin: ProxyGridVec,
  voxelSize: number,
  seed: ProxyGridVec,
  radius: number,
  height = 0,
  climb = Infinity,
): number {
  const nx = dims.x, ny = dims.y, nz = dims.z;
  const rCells = radius / voxelSize;
  // Inscribed in the disc, less half a cell for where her centre sits in its own.
  const erode = Math.max(0, Math.floor(rCells / Math.SQRT2 - 1));
  let tight = erode > 0 ? growXZ(occ, dims, erode) : occ;
  if (Number.isFinite(climb)) {
    // Closed too: anything more than `climb` above the floor under it. A
    // floorless column near captured floor is a hole she can cross, measured
    // from the floor around it; further out is the uncaptured outside, closed.
    const maxGap = Math.ceil(climb / voxelSize);
    const feet = Math.floor((seed.y - origin.y) / voxelSize);
    const floored = new Uint8Array(nx * nz);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        for (let y = 0; y <= Math.min(ny - 1, feet + 1); y++) {
          if (occ[(z * ny + y) * nx + x]) { floored[z * nx + x] = 1; break; }
        }
      }
    }
    const hole = growXZ(floored, { x: nx, y: 1, z: nz }, Math.ceil((climb * HOLE_BRIDGE_HEIGHTS) / voxelSize));
    tight = new Uint8Array(tight);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const bridged = hole[z * nx + x] === 1;
        let gap = -1;
        for (let y = 0; y < ny; y++) {
          const i = (z * ny + y) * nx + x;
          if (occ[i]) { gap = 0; continue; }
          if (gap >= 0) gap++;
          const closed = gap >= 0 ? gap > maxGap : !bridged || y < feet - 1 || y > feet + maxGap;
          if (closed) tight[i] = 1;
        }
      }
    }
  }

  const cx = Math.floor((seed.x - origin.x) / voxelSize);
  const cz = Math.floor((seed.z - origin.z) / voxelSize);
  const mid = Math.floor((seed.y + height * 0.5 - origin.y) / voxelSize);
  if (cx < 0 || cx >= nx || cz < 0 || cz >= nz) return 0;
  let start = -1;
  for (let d = 0; d <= SEAL_SEED_SEARCH_CELLS && start < 0; d++) {
    for (const y of d === 0 ? [mid] : [mid + d, mid - d]) {
      if (y < 0 || y >= ny) continue;
      const i = (cz * ny + y) * nx + cx;
      if (!tight[i]) { start = i; break; }
    }
  }
  if (start < 0) return 0;

  const reached = new Uint8Array(occ.length);
  const queue = new Int32Array(occ.length);
  let head = 0, tail = 0;
  queue[tail++] = start;
  reached[start] = 1;
  const row = nx, layer = nx * ny;
  while (head < tail) {
    const i = queue[head++];
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / layer);
    if (x > 0) visit(i - 1);
    if (x < nx - 1) visit(i + 1);
    if (y > 0) visit(i - row);
    if (y < ny - 1) visit(i + row);
    if (z > 0) visit(i - layer);
    if (z < nz - 1) visit(i + layer);
  }
  function visit(j: number): void {
    if (reached[j] || tight[j]) return;
    reached[j] = 1;
    queue[tail++] = j;
  }
  // A flood that reached less room than her own body started in a pocket
  // (inside a wall, under the floor's top cells): sealing from it would fill
  // the scene solid.
  const bodyCells = Math.PI * Math.max(1, erode) ** 2 * Math.max(1, height / voxelSize);
  if (tail < bodyCells) return 0;

  // The air over anywhere she reaches is open up to the ceiling, and she can
  // drop to the floor under it: carry each column's reach both ways to the
  // first solid cell, so a bumpy floor the narrowed flood could not get close
  // to is not raised.
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      let below = false;
      for (let y = 0; y < ny; y++) {
        const i = (z * ny + y) * nx + x;
        if (reached[i]) below = true;
        else if (occ[i]) below = false;
        else if (below) reached[i] = 1;
      }
      let above = false;
      for (let y = ny - 1; y >= 0; y--) {
        const i = (z * ny + y) * nx + x;
        if (reached[i]) above = true;
        else if (occ[i]) above = false;
        else if (above) reached[i] = 1;
      }
    }
  }
  const body = growXZ(reached, dims, Math.ceil(rCells) + 1);
  let sealed = 0;
  for (let i = 0; i < occ.length; i++) {
    if (occ[i] || body[i]) continue;
    occ[i] = 1;
    sealed++;
  }
  return sealed;
}

/** 1 wherever `src` has a 1 within `k` cells in X and Z (a square, same Y).
 *  Two sliding-window passes, so the cost does not grow with `k`. */
function growXZ(src: Uint8Array, dims: ProxyGridVec, k: number): Uint8Array {
  const nx = dims.x, ny = dims.y, nz = dims.z;
  const alongX = new Uint8Array(src.length);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const base = (z * ny + y) * nx;
      let count = 0;
      for (let x = 0; x < Math.min(k, nx); x++) count += src[base + x];
      for (let x = 0; x < nx; x++) {
        if (x + k < nx) count += src[base + x + k];
        if (x - k - 1 >= 0) count -= src[base + x - k - 1];
        alongX[base + x] = count > 0 ? 1 : 0;
      }
    }
  }
  const out = new Uint8Array(src.length);
  const stride = nx * ny;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const base = y * nx + x;
      let count = 0;
      for (let z = 0; z < Math.min(k, nz); z++) count += alongX[base + z * stride];
      for (let z = 0; z < nz; z++) {
        if (z + k < nz) count += alongX[base + (z + k) * stride];
        if (z - k - 1 >= 0) count -= alongX[base + (z - k - 1) * stride];
        out[base + z * stride] = count > 0 ? 1 : 0;
      }
    }
  }
  return out;
}
