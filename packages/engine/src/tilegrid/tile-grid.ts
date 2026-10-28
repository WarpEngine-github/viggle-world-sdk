import { Vec3 } from 'playcanvas';
import type { Scene } from '../scene';
import type { Vec3Like } from '../presets/camera/camera-preset';

/**
 * Configuration for {@link TileGrid.create}.
 *
 * The grid lies on a horizontal XZ plane: `col` runs along world **X**, `row`
 * runs along world **Z**, and `y` is the plane's height. Cell `(0, 0)` is the
 * corner nearest `origin` (or the centered equivalent when {@link centered}).
 *
 * @group Primitives
 * @category TileGrid
 */
export interface TileGridOptions {
  /** Number of columns (cells along world X). */
  cols: number;
  /** Number of rows (cells along world Z). */
  rows: number;
  /** World size of one (square) cell. Default `1`. */
  cellSize?: number;
  /**
   * World position the grid is anchored to. By default this is the outer
   * corner of cell `(0, 0)`; with {@link centered} it is the grid's center.
   * Default `{ x: 0, y: 0, z: 0 }`.
   */
  origin?: Vec3Like;
  /** Treat {@link origin} as the grid center instead of the `(0,0)` corner. Default `false`. */
  centered?: boolean;
  /** World-space Y of the grid plane. Overrides `origin.y` when set. Default `origin.y ?? 0`. */
  y?: number;
}

/**
 * Integer cell coordinate on a {@link TileGrid}.
 *
 * @group Primitives
 * @category TileGrid
 */
export interface Cell {
  /** Column index (along world X), `0 .. cols-1`. */
  col: number;
  /** Row index (along world Z), `0 .. rows-1`. */
  row: number;
}

/**
 * Gameplay-agnostic logic grid on the horizontal XZ plane.
 *
 * TileGrid is a **primitive**: it knows about cell ⇄ world coordinate mapping,
 * per-cell occupancy (a generic payload it never interprets), and screen/ray
 * picking. It deliberately knows nothing about chess, turns, or movement rules -
 * build those on top in the game layer.
 *
 * @example
 * ```ts
 * const board = TileGrid.create({ cols: 8, rows: 8, cellSize: 1, centered: true });
 *
 * // Place a piece and read it back
 * board.set(0, 0, rook);
 * const center = board.cellToWorld(4, 4); // Vec3 world position of that cell
 *
 * // Pick on click
 * canvas.addEventListener('pointerdown', (e) => {
 *   const cell = board.pickFromScreen(scene, e.offsetX, e.offsetY);
 *   if (cell) console.log('clicked', cell.col, cell.row, board.get(cell.col, cell.row));
 * });
 * ```
 *
 * @group Primitives
 * @category TileGrid
 */
export class TileGrid {
  /** Number of columns (cells along world X). */
  readonly cols: number;
  /** Number of rows (cells along world Z). */
  readonly rows: number;
  /** World size of one cell. */
  readonly cellSize: number;
  /** World-space Y of the grid plane. */
  readonly y: number;

  /** World X of the `(0,0)` cell's outer corner. */
  private readonly _ox: number;
  /** World Z of the `(0,0)` cell's outer corner. */
  private readonly _oz: number;
  /** Sparse occupancy map keyed by `row * cols + col`. */
  private readonly _cells = new Map<number, unknown>();

  private constructor(opts: TileGridOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.cellSize = opts.cellSize ?? 1;
    const origin = opts.origin ?? { x: 0, y: 0, z: 0 };
    this.y = opts.y ?? origin.y ?? 0;

    if (opts.centered) {
      // origin is the grid center → back out the (0,0) corner.
      this._ox = origin.x - (this.cols * this.cellSize) / 2;
      this._oz = origin.z - (this.rows * this.cellSize) / 2;
    } else {
      this._ox = origin.x;
      this._oz = origin.z;
    }
  }

  /** Create a logic grid. Does not touch the scene graph or render anything. */
  static create(opts: TileGridOptions): TileGrid {
    return new TileGrid(opts);
  }

  /**
   * World X of the `(0,0)` cell's outer corner. Together with {@link originZ}
   * this is the non-centered `origin` that reconstructs this grid's geometry.
   */
  get originX(): number { return this._ox; }
  /** World Z of the `(0,0)` cell's outer corner. See {@link originX}. */
  get originZ(): number { return this._oz; }

  // ── Coordinate mapping (pure) ─────────────────────────────────────────────

  /** True if `(col, row)` is inside the grid. */
  inBounds(col: number, row: number): boolean {
    return col >= 0 && col < this.cols && row >= 0 && row < this.rows;
  }

  /**
   * World position of a cell's **center**. Does not bounds-check, so callers
   * can map out-of-range coordinates (e.g. for ghost previews) if they want.
   */
  cellToWorld(col: number, row: number, out = new Vec3()): Vec3 {
    return out.set(
      this._ox + (col + 0.5) * this.cellSize,
      this.y,
      this._oz + (row + 0.5) * this.cellSize,
    );
  }

  /**
   * Cell containing a world point (its X/Z are used; Y is ignored), or `null`
   * if the point falls outside the grid.
   */
  worldToCell(world: Vec3Like): Cell | null {
    const col = Math.floor((world.x - this._ox) / this.cellSize);
    const row = Math.floor((world.z - this._oz) / this.cellSize);
    return this.inBounds(col, row) ? { col, row } : null;
  }

  // ── Picking ───────────────────────────────────────────────────────────────

  /**
   * Cell under a screen-space point, via the scene camera. `screenX`/`screenY`
   * are in CSS pixels relative to the canvas (e.g. `PointerEvent.offsetX/Y`).
   * Returns `null` if the camera ray misses the grid plane or lands off-grid.
   */
  pickFromScreen(scene: Scene, screenX: number, screenY: number): Cell | null {
    const cam = scene.cameraEntity.camera;
    if (!cam) return null;
    // Two points along the view ray (near & far), then intersect with the plane.
    const near = cam.screenToWorld(screenX, screenY, cam.nearClip);
    const far = cam.screenToWorld(screenX, screenY, cam.farClip);
    const dir = new Vec3().sub2(far, near);
    return this.rayToCell(near, dir);
  }

  /**
   * Cell hit by a world-space ray, intersected against the grid plane.
   * Returns `null` if the ray is parallel to the plane, points away from it,
   * or the hit lands off-grid.
   */
  rayToCell(origin: Vec3Like, dir: Vec3Like): Cell | null {
    const hit = this._rayPlaneHit(origin, dir);
    return hit ? this.worldToCell(hit) : null;
  }

  /** Ray ⇄ horizontal plane (y = this.y) intersection, or `null`. */
  private _rayPlaneHit(origin: Vec3Like, dir: Vec3Like): Vec3 | null {
    if (Math.abs(dir.y) < 1e-9) return null; // parallel to the plane
    const t = (this.y - origin.y) / dir.y;
    if (t < 0) return null; // plane is behind the ray
    return new Vec3(origin.x + dir.x * t, this.y, origin.z + dir.z * t);
  }

  // ── Per-cell occupancy (generic payload) ──────────────────────────────────

  private _key(col: number, row: number): number {
    return row * this.cols + col;
  }

  /** Value stored at a cell, or `undefined` if empty / out of bounds. */
  get<T = unknown>(col: number, row: number): T | undefined {
    if (!this.inBounds(col, row)) return undefined;
    return this._cells.get(this._key(col, row)) as T | undefined;
  }

  /** Store a value at a cell. No-op (returns `false`) if out of bounds. */
  set<T = unknown>(col: number, row: number, value: T): boolean {
    if (!this.inBounds(col, row)) return false;
    this._cells.set(this._key(col, row), value);
    return true;
  }

  /** Remove any value at a cell. Returns whether something was removed. */
  clear(col: number, row: number): boolean {
    if (!this.inBounds(col, row)) return false;
    return this._cells.delete(this._key(col, row));
  }

  /** True if a cell currently holds a value. */
  occupied(col: number, row: number): boolean {
    return this.inBounds(col, row) && this._cells.has(this._key(col, row));
  }

  /** Remove all stored values, leaving the grid geometry intact. */
  clearAll(): void {
    this._cells.clear();
  }

  /** Visit every occupied cell with its stored value. */
  forEach(fn: (cell: Cell, value: unknown) => void): void {
    for (const [key, value] of this._cells) {
      fn({ col: key % this.cols, row: Math.floor(key / this.cols) }, value);
    }
  }
}
