/**
 * The queries over a built collider grid: where the floor is, whether a body
 * fits, and how to push one out of a wall.
 *
 * All synchronous, all plain grid lookups, all microseconds - a walk calls
 * several of them per frame. The BUILD is the expensive half and it is async and
 * off-thread (`environment-collider.ts`); nothing here allocates per call
 * except the overlay's scratch buffer, which is reused.
 *
 * Pure: no GPU, no scene, no PlayCanvas type. `collider-debug.ts` is what draws
 * the overlay this module computes.
 *
 * ## World in, world out, grid in local
 *
 * Every coordinate and every length crossing this API is in WORLD metres. The
 * grid underneath is in the environment's local units, and the conversion is a
 * subtract and a divide read from {@link ColliderFrame} on every call.
 *
 * So moving or rescaling the environment scales the collider with it, exactly,
 * with nothing to invalidate and no rebuild - the grid is a property of the
 * capture, and the transform is a property of the moment. LOD streaming does
 * not invalidate it either, because the grid was never tied to which level was
 * resident.
 *
 * THE ONE EDGE. The walkable band is baked into the grid in local units, so
 * scaling the environment DOWN shrinks the band's world height. At the default
 * 3 m of band above the floor, a 1.7 m walker stops fitting inside it at about
 * a 1.7x shrink, and from then on the wall in front of her can be above the
 * grid and therefore not exist. That is the ONLY condition scaling can break,
 * so it gets a check of its own - {@link SceneCollider.walkerFits} - rather than
 * a general "the transform changed, rebuild" rule that would throw away the
 * whole point.
 *
 * @module
 */

import { extractSurface } from '../proxy/voxelizer';
import type { ProxyMeshResult, SurfaceSettings } from '../proxy/voxelizer';

import { resolveCapsule } from './capsule-resolve';
import type { PushCapsule, PushGrid } from './capsule-resolve';
import type { ColliderFrame, SceneColliderData, SceneColliderStats } from './collider-grid';

/**
 * The walker's body, in world metres.
 *
 * Not baked into the collider: a height slider moves live and a rebuild for it
 * would be absurd. Every query that needs a body takes one of these, so an app
 * with two characters of different sizes collides both against the one grid.
 */
export interface WalkerCapsule {
  /** Horizontal radius. */
  radius: number;
  /**
   * How far above the floor the collided span STARTS. Below this the body is
   * allowed to overlap solid, which is the whole point: the feet are standing
   * ON solid, and a kerb under this height is something to step onto rather
   * than a wall. Set it from the walk's own step limit.
   */
  feetClearance: number;
  /** Top of the collided span above the floor - the walker's height. */
  height: number;
}

/**
 * Voxels of step a walk must allow, whatever its own step limit says.
 *
 * A voxel collider cannot resolve a step finer than its own cell. Two columns
 * of a perfectly flat floor disagree by a whole voxel depending on where the
 * bin boundary fell, and a scanned floor's own roughness stacks on top of that,
 * so a walker with a step limit of one or two cells is stopped by ARITHMETIC
 * rather than by geometry - and from the reader's side that is indistinguishable
 * from an invisible wall in the middle of open ground.
 *
 * Three is measured, not guessed. Flood-filling the walkable neighbourhood of
 * the Flow2D fixture (voxel 0.225 m, a 0.25 m lattice, a walk's own step and
 * capsule rules) from the spawn:
 *
 *     1.9 voxels (a 1.7 m walker's own 0.425 m):   84 m2 reachable
 *     2.9 voxels:                                 228 m2
 *     3.9 voxels:                                 311 m2
 *     4.9 voxels:                                 346 m2
 *
 * The knee is at three: below it the quantization dominates and nearly two
 * thirds of the open ground is unreachable; above it the gain is real geometry
 * being climbed over, which is not what a step limit is for.
 */
export const GROUND_STEP_VOXELS = 3;

/**
 * The smallest step limit worth using against a grid this coarse, in world
 * metres. See {@link GROUND_STEP_VOXELS}. Pass
 * {@link SceneCollider.voxelMetres}, not the requested voxel size - the
 * delivered one is what quantizes the floor.
 */
export function minStepLimit(voxelMetres: number): number {
  return voxelMetres * GROUND_STEP_VOXELS;
}

/**
 * Laplacian relaxation passes {@link SceneCollider.surface} applies by default.
 *
 * Two, which is the Unity package's collider preset and its inspector default
 * for the same knob. Surface Nets is already smooth, so this is polish rather
 * than the thing doing the smoothing; every pass also shrinks the surface
 * slightly, which is why the volume is dilated outward first.
 *
 * It moves VERTICES. It cannot move a query, because no query reads the surface
 * - see {@link SceneCollider.surface}.
 */
export const DEFAULT_SURFACE_SMOOTHING = 2;

/**
 * The capsule for a walker this tall, in world metres.
 *
 * `stepLimit` is the walk's own limit, so the one height a kerb is climbed at
 * and the one it is collided at are the same number by construction rather than
 * by coincidence. Pass {@link SceneCollider.voxelMetres} for `voxelMetres`.
 */
export function capsuleForWalker(height: number, stepLimit: number, voxelMetres: number): WalkerCapsule {
  return {
    // 0.3 m on a 1.7 m body: shoulders, not a point. Wider and she cannot pass
    // a real doorway at this voxel size; narrower and she clips corners.
    radius: height * 0.18,
    // At least one and a half voxels, whatever the step limit says: a clearance
    // under one voxel would put the capsule's bottom slice inside the floor she
    // is standing on and read as permanently stuck.
    feetClearance: Math.max(stepLimit, voxelMetres * 1.5),
    height,
  };
}

/** Which faces {@link SceneCollider.overlay} draws. */
export type ColliderOverlayFaces = 'top' | 'all';

/** What to draw, and how much of it. */
export interface ColliderOverlayOptions {
  /** Half-extent of the world-space box drawn around the focus, metres. Default `8`. */
  radius?: number;
  /**
   * `top` draws only the up-facing exposed face of each solid cell - the
   * walkable surface, and the cheapest honest picture of the floor's density.
   * `all` draws every face that borders empty space, which is what shows walls
   * and undersides. Default `top`.
   */
  faces?: ColliderOverlayFaces;
  /**
   * Cell budget, or `0` for no cap. Default 60,000 for `top` and 20,000 for
   * `all`.
   *
   * Generous because the overlay is geometry a consumer uploads ONCE and
   * redraws for free, not something resubmitted per frame - see
   * `collider-debug.ts`. A per-frame immediate-mode overlay has to stay an
   * order of magnitude smaller than this, and that is exactly how an overlay
   * ends up drawing a dense floor as a scatter. See {@link ColliderOverlay.stride}.
   */
  maxCells?: number;
}

/**
 * The overlay, and an honest account of what it left out.
 *
 * The counts are not diagnostics-for-later, they are part of the drawing: an
 * overlay that silently thins a dense surface makes a good collider look like a
 * bad one, which is worse than drawing nothing. A caller is expected to put
 * {@link stride} on screen whenever it is above 1.
 */
export interface ColliderOverlay {
  /** `[x,y,z] * 2` per line segment, WORLD space. Reused between calls - copy
   *  it if you mean to keep it. */
  vertices: Float32Array;
  /** Line segments in {@link vertices}. */
  segments: number;
  /** Solid cells inside the box that had a face to draw. */
  cellsInBox: number;
  /** Cells actually drawn. Equals {@link cellsInBox} when nothing was dropped. */
  cellsDrawn: number;
  /**
   * `1` when the whole box is drawn. Above 1, every `stride`-th qualifying cell
   * was drawn and the picture is that much sparser than the grid. Thinning
   * evenly rather than cropping is deliberate - taking the first `maxCells`
   * spends the whole budget on one corner of the box, which showed as standing
   * in dense foliage and seeing the foliage drawn and the ground blank.
   */
  stride: number;
}

/** Reads the environment's current transform. See {@link ColliderFrame}. */
export type ColliderFrameSource = () => ColliderFrame;

/**
 * A built collider: the grid, plus the queries over it.
 *
 * Construct it with `buildSceneCollider` (`environment-collider.ts`), or with
 * {@link SceneCollider.fromData} over a grid that was serialized earlier.
 */
export class SceneCollider {
  /** The grid as pure data. Serializable; see {@link SceneColliderData}. */
  readonly data: SceneColliderData;

  private readonly _frameSource: ColliderFrameSource;
  private readonly _occ: Uint8Array;
  private readonly _nx: number;
  private readonly _ny: number;
  private readonly _nz: number;
  /** Grid origin in LOCAL units. */
  private readonly _gx: number;
  private readonly _gy: number;
  private readonly _gz: number;
  /** Cell edge in LOCAL units, and its reciprocal. */
  private readonly _v: number;
  private readonly _invV: number;

  /** Cell indices with an exposed top face, built on first `top` overlay. */
  private _topCells: Int32Array | null = null;
  /** Cell indices with any exposed face, built on first `all` overlay. */
  private _surfaceCells: Int32Array | null = null;
  private _lines = new Float32Array(0);
  /** The extracted surface and the settings key it was extracted at. */
  private _surface: ProxyMeshResult | null = null;
  private _surfaceKey = '';

  /**
   * Wrap a grid that already exists - one deserialized from an export, or one
   * handed back by a worker.
   *
   * `frameSource` is read on every query, so a live one (the environment's own
   * transform) is what makes the collider scale with the scene. Omit it and the
   * collider is pinned to the frame it was built at, which is right for a
   * static scene and wrong for one with a scale slider.
   */
  static fromData(data: SceneColliderData, frameSource?: ColliderFrameSource): SceneCollider {
    return new SceneCollider(data, frameSource);
  }

  private constructor(data: SceneColliderData, frameSource?: ColliderFrameSource) {
    if (data.version !== 1) {
      throw new RangeError(`[SceneCollider] unsupported collider data version ${data.version as number}`);
    }
    const cells = data.dims.x * data.dims.y * data.dims.z;
    if (data.occupancy.length !== cells) {
      throw new RangeError(
        `[SceneCollider] occupancy is ${data.occupancy.length} bytes for a `
        + `${data.dims.x}x${data.dims.y}x${data.dims.z} grid (${cells} cells)`,
      );
    }
    this.data = data;
    this._frameSource = frameSource ?? (() => data.builtFrame);
    this._occ = data.occupancy;
    this._nx = data.dims.x;
    this._ny = data.dims.y;
    this._nz = data.dims.z;
    this._gx = data.gridOrigin.x;
    this._gy = data.gridOrigin.y;
    this._gz = data.gridOrigin.z;
    this._v = data.voxelSize;
    this._invV = 1 / data.voxelSize;
  }

  /** What the build decided, in world metres at the scale it was built at. */
  get stats(): SceneColliderStats {
    return this.data.stats;
  }

  /** Where the environment is right now. */
  get frame(): ColliderFrame {
    return this._frameSource();
  }

  /**
   * Cell edge in world metres AT THE CURRENT SCALE - so the number a step limit
   * and a capsule clearance should be derived from. {@link stats} reports the
   * size at build scale, which is the same number until something rescales the
   * environment.
   */
  get voxelMetres(): number {
    return this._v * this._frameSource().scale;
  }

  /**
   * World metres of band above the floor reference, at the current scale.
   *
   * The baked band, rescaled. Compare it against a walker's height:
   * {@link walkerFits} does exactly that.
   */
  get bandAboveM(): number {
    return (this.data.bandMaxY - this.data.floorRefY) * this._frameSource().scale;
  }

  /** World metres of band below the floor reference, at the current scale. */
  get bandBelowM(): number {
    return (this.data.floorRefY - this.data.bandMinY) * this._frameSource().scale;
  }

  /**
   * World Y the band was hung from - the sample's 5th Y percentile, i.e. "the
   * ground" of the capture as a whole.
   *
   * Where to start looking for a spawn, and the reference
   * {@link bandAboveM} and {@link bandBelowM} are measured from. Not a floor to
   * stand on: use {@link standAt} for that.
   */
  get floorRefY(): number {
    const f = this._frameSource();
    return f.origin.y + this.data.floorRefY * f.scale;
  }

  /**
   * Does a walker this tall still fit inside the baked band at the current
   * scale?
   *
   * `false` means her head is at or above the top of the grid, so solid
   * geometry at head height was never voxelized and a wall in front of her can
   * silently not exist. The fix is a rebuild - the band is the one thing
   * rescaling cannot carry - or a smaller walker. `margin` is the headroom to
   * insist on above her head; one voxel by default, since a grid that ends
   * exactly at her scalp is already ambiguous.
   *
   * This is the ONLY condition a transform change can break. Everything else
   * about the collider rescales exactly, which is why there is no invalidation
   * rule here and no change event to subscribe to.
   */
  walkerFits(height: number, margin = this.voxelMetres): boolean {
    return this.bandAboveM >= height + margin;
  }

  /**
   * Highest solid surface at or below `fromY` within `radius` of `(x, z)`, with
   * no body test. The ground alone; {@link standAt} is this plus the capsule.
   *
   * `fromY` is the height the query is made FROM - normally the walker's feet
   * plus a step. The answer being the highest surface at or below it is what
   * makes standing on a table read the table and walking under it read the
   * floor. `null` when there is nothing: off the grid, or no solid cell below.
   *
   * A DISC of columns, not one: a single column is narrower than a foot, so one
   * missing cell in a sparse floor would read as a hole to fall through.
   */
  groundAt(x: number, z: number, fromY: number, radius: number): number | null {
    const f = this._frameSource();
    const s = f.scale;
    if (!(s > 0)) return null;
    const invS = 1 / s;
    const lx = (x - f.origin.x) * invS;
    const ly = (fromY - f.origin.y) * invS;
    const lz = (z - f.origin.z) * invS;
    const lr = radius * invS;

    const gx = this._gx, gy = this._gy, gz = this._gz;
    const v = this._v, invV = this._invV;
    const nx = this._nx, ny = this._ny, nz = this._nz;
    const occ = this._occ;

    if (lx < gx - lr || lz < gz - lr) return null;
    if (lx > gx + nx * v + lr || lz > gz + nz * v + lr) return null;
    const yTop = Math.floor((ly - gy) * invV);
    if (yTop < 0) return null;
    const y0 = yTop > ny - 1 ? ny - 1 : yTop;

    const cx0 = clamp(Math.floor((lx - lr - gx) * invV), nx);
    const cx1 = clamp(Math.floor((lx + lr - gx) * invV), nx);
    const cz0 = clamp(Math.floor((lz - lr - gz) * invV), nz);
    const cz1 = clamp(Math.floor((lz + lr - gz) * invV), nz);
    const r2 = lr * lr;
    let best: number | null = null;
    for (let cz = cz0; cz <= cz1; cz++) {
      const dz = gz + (cz + 0.5) * v - lz;
      for (let cx = cx0; cx <= cx1; cx++) {
        const dx = gx + (cx + 0.5) * v - lx;
        if (dx * dx + dz * dz > r2) continue;
        for (let cy = y0; cy >= 0; cy--) {
          if (!occ[(cz * ny + cy) * nx + cx]) continue;
          // The TOP of the cell - she stands on it, not in it. The highest
          // surface found wins: stepping onto a kerb, not into it.
          const top = gy + (cy + 1) * v;
          if (best === null || top > best) best = top;
          break;
        }
      }
    }
    return best === null ? null : f.origin.y + best * s;
  }

  /** Does `capsule`, standing on floor `groundY`, overlap anything solid? */
  blocked(x: number, z: number, groundY: number, capsule: WalkerCapsule): boolean {
    return !this._walkCapsule(x, z, groundY, capsule, () => false);
  }

  /**
   * The floor a body of `capsule` can stand on at `(x, z)`, or `null` when
   * there is none - off the grid, nothing solid below, or solid where the body
   * would be.
   *
   * That last case is the wall, and it is the point of the whole module: a wall
   * reads as "no floor here", the same shape of answer a floor probe gives,
   * now MEASURED rather than inferred from a gap in the samples.
   */
  standAt(x: number, z: number, fromY: number, capsule: WalkerCapsule): number | null {
    const g = this.groundAt(x, z, fromY, capsule.radius);
    if (g === null) return null;
    return this.blocked(x, z, g, capsule) ? null : g;
  }

  /** Solid cells inside `capsule` standing on `groundY`; 0 when it fits. */
  overlap(x: number, z: number, groundY: number, capsule: WalkerCapsule): number {
    let cells = 0;
    this._walkCapsule(x, z, groundY, capsule, () => { cells++; return true; });
    return cells;
  }

  /**
   * Collide and slide: where a body of `capsule` standing on `groundY` ends up
   * at `(x, z)` once pushed out of every wall it entered. Each push points away
   * from the nearest point of the voxel it clears, so a move along a bumpy or
   * angled wall keeps its along-wall part instead of stopping. Returns the
   * input when nothing overlapped. See `capsule-resolve.ts`.
   */
  resolve(x: number, z: number, groundY: number, capsule: WalkerCapsule): { x: number; z: number } {
    const f = this._frameSource();
    const s = f.scale;
    if (!(s > 0)) return { x, z };
    const shape = this._pushCapsule(groundY, capsule, f);
    if (!shape) return { x, z };
    const invS = 1 / s;
    const lx = (x - f.origin.x) * invS;
    const lz = (z - f.origin.z) * invS;
    const out = resolveCapsule(this._pushGrid(), lx, lz, shape);
    // Exactly the input when nothing overlapped, so a caller can test a fit
    // by equality rather than through a round trip's rounding.
    if (out.x === lx && out.z === lz) return { x, z };
    return { x: f.origin.x + out.x * s, z: f.origin.z + out.z * s };
  }

  /**
   * Nudge a penetrating body out of the walls: {@link resolve}, refused when
   * the push is wider than the body - that is the inside of a solid block, not
   * a graze, and the caller should leave the position alone.
   */
  pushOut(x: number, z: number, groundY: number, capsule: WalkerCapsule): { x: number; z: number } {
    const out = this.resolve(x, z, groundY, capsule);
    return Math.hypot(out.x - x, out.z - z) > capsule.radius * 6 ? { x, z } : out;
  }

  /**
   * World distance along `dir` from `origin` to the first solid cell, or
   * `null` when none lies within `maxT`. `dir` need not be unit length.
   *
   * Solid the ray STARTS in is passed through first, so a camera boom anchored
   * in a wall's top cells does not read a hit at zero. Off the grid is empty.
   */
  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxT: number,
  ): number | null {
    const f = this._frameSource();
    const s = f.scale;
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(s > 0) || !(len > 0) || !(maxT > 0)) return null;
    // Grid units: one cell is 1.
    const k = 1 / (s * this._v);
    const ox = ((origin.x - f.origin.x) / s - this._gx) * this._invV;
    const oy = ((origin.y - f.origin.y) / s - this._gy) * this._invV;
    const oz = ((origin.z - f.origin.z) / s - this._gz) * this._invV;
    const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;
    const nx = this._nx, ny = this._ny, nz = this._nz;

    // Clip to the grid box.
    let t0 = 0;
    let t1 = maxT * k;
    for (const [o, d, n] of [[ox, dx, nx], [oy, dy, ny], [oz, dz, nz]] as const) {
      if (d === 0) {
        if (o < 0 || o >= n) return null;
        continue;
      }
      const a = (0 - o) / d, b = (n - o) / d;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
    }
    if (t0 > t1) return null;

    const cellOf = (p: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(p)));
    let cx = cellOf(ox + dx * t0, nx), cy = cellOf(oy + dy * t0, ny), cz = cellOf(oz + dz * t0, nz);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const ddx = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
    const ddy = dy !== 0 ? 1 / Math.abs(dy) : Infinity;
    const ddz = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
    let tx = dx !== 0 ? (cx + (dx > 0 ? 1 : 0) - ox) / dx : Infinity;
    let ty = dy !== 0 ? (cy + (dy > 0 ? 1 : 0) - oy) / dy : Infinity;
    let tz = dz !== 0 ? (cz + (dz > 0 ? 1 : 0) - oz) / dz : Infinity;
    // Only an origin inside the grid can start inside solid.
    let leaving = t0 === 0;
    let t = t0;
    const occ = this._occ;
    while (t <= t1) {
      if (occ[(cz * ny + cy) * nx + cx]) {
        if (!leaving) return t / k;
      } else {
        leaving = false;
      }
      if (tx <= ty && tx <= tz) {
        t = tx; tx += ddx; cx += sx;
        if (cx < 0 || cx >= nx) break;
      } else if (ty <= tz) {
        t = ty; ty += ddy; cy += sy;
        if (cy < 0 || cy >= ny) break;
      } else {
        t = tz; tz += ddz; cz += sz;
        if (cz < 0 || cz >= nz) break;
      }
    }
    return null;
  }

  /**
   * Whether a ball of `radius` world units at `point` touches no solid cell.
   * Off the grid is empty, as for {@link raycast}.
   */
  isClear(point: { x: number; y: number; z: number }, radius: number): boolean {
    const f = this._frameSource();
    const s = f.scale;
    if (!(s > 0)) return true;
    // Grid units: one cell is 1.
    const px = ((point.x - f.origin.x) / s - this._gx) * this._invV;
    const py = ((point.y - f.origin.y) / s - this._gy) * this._invV;
    const pz = ((point.z - f.origin.z) / s - this._gz) * this._invV;
    const r = Math.max(0, radius) / (s * this._v);
    const r2 = r * r;
    const nx = this._nx, ny = this._ny, nz = this._nz;
    const x0 = Math.max(0, Math.floor(px - r)), x1 = Math.min(nx - 1, Math.floor(px + r));
    const y0 = Math.max(0, Math.floor(py - r)), y1 = Math.min(ny - 1, Math.floor(py + r));
    const z0 = Math.max(0, Math.floor(pz - r)), z1 = Math.min(nz - 1, Math.floor(pz + r));
    // How far `p` lies outside the cell [c, c + 1] on one axis.
    const gap = (p: number, c: number) => Math.max(c - p, 0, p - c - 1);
    const occ = this._occ;
    for (let z = z0; z <= z1; z++) {
      const dz = gap(pz, z);
      for (let y = y0; y <= y1; y++) {
        const dy = gap(py, y);
        if (dz * dz + dy * dy > r2) continue;
        const row = (z * ny + y) * nx;
        for (let x = x0; x <= x1; x++) {
          const dx = gap(px, x);
          if (occ[row + x] && dx * dx + dy * dy + dz * dz <= r2) return false;
        }
      }
    }
    return true;
  }

  /**
   * Line vertices for a debug overlay, in world space.
   *
   * Draws the exposed faces of the OCCUPANCY - the cells themselves, not a mesh
   * extracted from them. That is the point: the overlay has to be the thing
   * being collided with, and a dual-contoured surface moves its vertices off
   * the cell boundary by up to a voxel, which is exactly the magnitude a reader
   * is trying to judge.
   *
   * Read {@link ColliderOverlay.stride} and put it on screen when it is above 1.
   */
  overlay(
    focus: { x: number; y: number; z: number },
    options: ColliderOverlayOptions = {},
  ): ColliderOverlay {
    const f = this._frameSource();
    const s = f.scale;
    const faces = options.faces ?? 'top';
    const cap = Math.max(0, Math.floor(options.maxCells ?? (faces === 'top' ? 60_000 : 20_000)));
    const radius = options.radius ?? 8;

    const list = faces === 'top' ? this._topList() : this._surfaceList();
    const nx = this._nx, ny = this._ny;
    const gx = this._gx, gy = this._gy, gz = this._gz;
    const v = this._v;
    const invS = s > 0 ? 1 / s : 0;
    // The cull runs in LOCAL units so it is four compares per cell with no
    // per-cell transform.
    const lr = radius * invS;
    const fx = (focus.x - f.origin.x) * invS;
    const fy = (focus.y - f.origin.y) * invS;
    const fz = (focus.z - f.origin.z) * invS;

    // Cell-index bounds of the box, so the qualifying test is integer compares.
    const bx0 = Math.floor((fx - lr - gx) / v), bx1 = Math.floor((fx + lr - gx) / v);
    const by0 = Math.floor((fy - lr - gy) / v), by1 = Math.floor((fy + lr - gy) / v);
    const bz0 = Math.floor((fz - lr - gz) / v), bz1 = Math.floor((fz + lr - gz) / v);

    let cellsInBox = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const cx = c % nx;
      const t = (c - cx) / nx;
      const cy = t % ny;
      const cz = (t - cy) / ny;
      if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1 || cz < bz0 || cz > bz1) continue;
      cellsInBox++;
    }
    const stride = cap > 0 && cellsInBox > cap ? Math.ceil(cellsInBox / cap) : 1;

    // 6 faces at most, 4 edges a face, 2 endpoints an edge, 3 floats an endpoint.
    const perCell = faces === 'top' ? 24 : 144;
    const need = Math.min(cellsInBox, cap || cellsInBox) * perCell;
    if (this._lines.length < need) this._lines = new Float32Array(need);
    const out = this._lines;

    let w = 0;
    let seen = 0;
    let drawn = 0;
    for (let i = 0; i < list.length; i++) {
      if (cap > 0 && drawn >= cap) break;
      const c = list[i];
      const cx = c % nx;
      const t = (c - cx) / nx;
      const cy = t % ny;
      const cz = (t - cy) / ny;
      if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1 || cz < bz0 || cz > bz1) continue;
      if (seen++ % stride !== 0) continue;
      drawn++;

      // Cell corners, world space.
      const x0 = f.origin.x + (gx + cx * v) * s, x1 = f.origin.x + (gx + (cx + 1) * v) * s;
      const y0 = f.origin.y + (gy + cy * v) * s, y1 = f.origin.y + (gy + (cy + 1) * v) * s;
      const z0 = f.origin.z + (gz + cz * v) * s, z1 = f.origin.z + (gz + (cz + 1) * v) * s;

      if (faces === 'top') {
        w = square(out, w, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1);
        continue;
      }
      if (!this._solid(cx, cy + 1, cz)) w = square(out, w, x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1);
      if (!this._solid(cx, cy - 1, cz)) w = square(out, w, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
      if (!this._solid(cx - 1, cy, cz)) w = square(out, w, x0, y0, z0, x0, y1, z0, x0, y1, z1, x0, y0, z1);
      if (!this._solid(cx + 1, cy, cz)) w = square(out, w, x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1);
      if (!this._solid(cx, cy, cz - 1)) w = square(out, w, x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0);
      if (!this._solid(cx, cy, cz + 1)) w = square(out, w, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
    }

    return {
      vertices: out.subarray(0, w),
      segments: w / 6,
      cellsInBox,
      cellsDrawn: drawn,
      stride,
    };
  }

  /**
   * The triangulated surface of this grid - Surface Nets by default, which the
   * voxelizer's own header calls the right choice for a collider: one vertex per
   * boundary cell, free to sit anywhere inside it, so a sloped floor comes out
   * sloped instead of as steps.
   *
   * NOT what the queries read. {@link groundAt} and {@link blocked} read the
   * OCCUPANCY, and a Surface Nets vertex sits up to a voxel off the cell
   * boundary those cells describe. The surface is what a MESH consumer gets -
   * an exported `.obj`, a game engine's collider component, a picture of the
   * thing being exported - and a reader has to be told which of the two they
   * are looking at.
   *
   * Memoized on the settings, because the two callers that want it - the
   * on-screen view and the exporter - must be handed the same geometry rather
   * than two extractions that happen to agree. Extraction is a few tens of
   * milliseconds on a scanned room, so the memo is also what lets a display
   * toggle be instant.
   *
   * @param settings finish only. Default: `smooth`, 2 relaxation passes, the
   *   collider finish this is ported from.
   */
  surface(settings: SurfaceSettings = {}): ProxyMeshResult {
    const s: Required<SurfaceSettings> = {
      surface: settings.surface ?? 'smooth',
      smoothIterations: settings.smoothIterations ?? DEFAULT_SURFACE_SMOOTHING,
      mergeCoplanar: settings.mergeCoplanar ?? false,
    };
    const key = `${s.surface}|${s.smoothIterations}|${s.mergeCoplanar}`;
    if (this._surfaceKey === key && this._surface) return this._surface;
    this._surface = extractSurface({
      occupancy: this._occ,
      dims: this.data.dims,
      origin: this.data.gridOrigin,
      voxelSize: this._v,
      requestedVoxelSize: this._v,
      coarsened: false,
      occupiedVoxels: this.data.stats.occupiedVoxels,
      splatsUsed: this.data.stats.bandPoints,
      buildMs: 0,
    }, s);
    this._surfaceKey = key;
    return this._surface;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private _solid(x: number, y: number, z: number): boolean {
    if (x < 0 || y < 0 || z < 0 || x >= this._nx || y >= this._ny || z >= this._nz) return false;
    return this._occ[(z * this._ny + y) * this._nx + x] !== 0;
  }

  /** Solid cells whose neighbour above is empty. Built once, kept. */
  private _topList(): Int32Array {
    if (this._topCells) return this._topCells;
    const nx = this._nx, ny = this._ny, nz = this._nz, occ = this._occ;
    const out: number[] = [];
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const c = (z * ny + y) * nx + x;
          if (!occ[c]) continue;
          if (y + 1 < ny && occ[(z * ny + y + 1) * nx + x]) continue;
          out.push(c);
        }
      }
    }
    this._topCells = new Int32Array(out);
    return this._topCells;
  }

  /** Solid cells with at least one empty 6-neighbour. Built once, kept. */
  private _surfaceList(): Int32Array {
    if (this._surfaceCells) return this._surfaceCells;
    const nx = this._nx, ny = this._ny, nz = this._nz, occ = this._occ;
    const out: number[] = [];
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const c = (z * ny + y) * nx + x;
          if (!occ[c]) continue;
          if (this._solid(x - 1, y, z) && this._solid(x + 1, y, z)
            && this._solid(x, y - 1, z) && this._solid(x, y + 1, z)
            && this._solid(x, y, z - 1) && this._solid(x, y, z + 1)) continue;
          out.push(c);
        }
      }
    }
    this._surfaceCells = new Int32Array(out);
    return this._surfaceCells;
  }

  /**
   * Per-slice capsule test, world coordinates in. The axis runs from
   * `groundY + feetClearance + r` to `groundY + height - r`; each slice is a
   * disc of the capsule's radius at that height, tapering through the two
   * spherical caps. `visit` gets every overlapping cell and stops the walk when
   * it returns false; the return is `false` iff the walk was stopped.
   */
  private _walkCapsule(
    x: number, z: number, groundY: number, capsule: WalkerCapsule,
    visit: (cx: number, cy: number, cz: number) => boolean,
  ): boolean {
    const f = this._frameSource();
    if (!(f.scale > 0)) return true;
    const invS = 1 / f.scale;
    return this._walkCapsuleLocal(
      (x - f.origin.x) * invS, (z - f.origin.z) * invS, groundY, capsule, f, visit,
    );
  }

  /** The grid as `capsule-resolve.ts` reads it. */
  private _pushGrid(): PushGrid {
    return {
      occ: this._occ, nx: this._nx, ny: this._ny, nz: this._nz,
      gx: this._gx, gy: this._gy, gz: this._gz, v: this._v,
    };
  }

  /** The walker's capsule in local units, with the same span and caps
   *  {@link _walkCapsuleLocal} tests; null when it has no height. */
  private _pushCapsule(groundY: number, capsule: WalkerCapsule, f: ColliderFrame): PushCapsule | null {
    const invS = 1 / f.scale;
    const r = capsule.radius * invS;
    const lo = (groundY + capsule.feetClearance - f.origin.y) * invS;
    const hi = (groundY + capsule.height - f.origin.y) * invS;
    if (!(hi > lo)) return null;
    const mid = (lo + hi) * 0.5;
    return { axisLo: Math.min(lo + r, mid), axisHi: Math.max(hi - r, mid), radius: r };
  }

  /** {@link _walkCapsule} with `x`/`z` already in local units. */
  private _walkCapsuleLocal(
    lx: number, lz: number, groundY: number, capsule: WalkerCapsule, f: ColliderFrame,
    visit: (cx: number, cy: number, cz: number) => boolean,
  ): boolean {
    const invS = 1 / f.scale;
    const r = capsule.radius * invS;
    const lo = (groundY + capsule.feetClearance - f.origin.y) * invS;
    const hi = (groundY + capsule.height - f.origin.y) * invS;
    if (!(hi > lo)) return true;

    const gx = this._gx, gy = this._gy, gz = this._gz;
    const v = this._v, invV = this._invV;
    const nx = this._nx, ny = this._ny, nz = this._nz;
    const occ = this._occ;

    // Cap centres. A body shorter than two radii degenerates to a sphere at the
    // midpoint rather than inverting.
    const axisLo = Math.min(lo + r, (lo + hi) * 0.5);
    const axisHi = Math.max(hi - r, (lo + hi) * 0.5);
    const cy0 = Math.floor((lo - gy) * invV);
    const cy1 = Math.floor((hi - gy) * invV);
    if (cy1 < 0 || cy0 > ny - 1) return true;
    const r2 = r * r;
    const cyEnd = clamp(cy1, ny);
    for (let cy = clamp(cy0, ny); cy <= cyEnd; cy++) {
      const yc = gy + (cy + 0.5) * v;
      if (yc < lo || yc > hi) continue;
      // Radius of the capsule at this height: full through the cylinder,
      // sqrt(r^2 - d^2) inside a cap.
      const d = yc < axisLo ? axisLo - yc : yc > axisHi ? yc - axisHi : 0;
      const rr2 = r2 - d * d;
      if (rr2 <= 0) continue;
      const rr = Math.sqrt(rr2);
      const cx0 = clamp(Math.floor((lx - rr - gx) * invV), nx);
      const cx1 = clamp(Math.floor((lx + rr - gx) * invV), nx);
      const cz0 = clamp(Math.floor((lz - rr - gz) * invV), nz);
      const cz1 = clamp(Math.floor((lz + rr - gz) * invV), nz);
      for (let cz = cz0; cz <= cz1; cz++) {
        const dz = gz + (cz + 0.5) * v - lz;
        for (let cx = cx0; cx <= cx1; cx++) {
          const dx = gx + (cx + 0.5) * v - lx;
          if (dx * dx + dz * dz > rr2) continue;
          if (!occ[(cz * ny + cy) * nx + cx]) continue;
          if (!visit(cx, cy, cz)) return false;
        }
      }
    }
    return true;
  }
}

/** Clamp a cell index into `[0, n-1]`. */
function clamp(v: number, n: number): number {
  return v < 0 ? 0 : v > n - 1 ? n - 1 : v;
}

/** Four corners -> four line segments. Returns the new write cursor. */
function square(
  out: Float32Array, w: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx: number, dy: number, dz: number,
): number {
  out[w++] = ax; out[w++] = ay; out[w++] = az; out[w++] = bx; out[w++] = by; out[w++] = bz;
  out[w++] = bx; out[w++] = by; out[w++] = bz; out[w++] = cx; out[w++] = cy; out[w++] = cz;
  out[w++] = cx; out[w++] = cy; out[w++] = cz; out[w++] = dx; out[w++] = dy; out[w++] = dz;
  out[w++] = dx; out[w++] = dy; out[w++] = dz; out[w++] = ax; out[w++] = ay; out[w++] = az;
  return w;
}
