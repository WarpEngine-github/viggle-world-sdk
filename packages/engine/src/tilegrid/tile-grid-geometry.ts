import type { Cell, TileGrid } from './tile-grid';

/**
 * Pure geometry helpers for {@link TileGrid} - neighbours, distances, ranges,
 * line-of-sight, and A* pathfinding. None of these touch the scene graph or
 * render anything; they operate purely on cell coordinates so they can run on
 * a server or in tests as well as in the browser.
 *
 * @group Primitives
 * @category TileGrid
 */

/** The four orthogonal steps (N/E/S/W), as `[dCol, dRow]`. */
export const ORTHO_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
];

/** The four diagonal steps, as `[dCol, dRow]`. */
export const DIAGONAL_STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, -1], [1, 1], [-1, 1], [-1, -1],
];

/** All eight steps (orthogonal + diagonal). */
export const ALL_STEPS: ReadonlyArray<readonly [number, number]> = [
  ...ORTHO_STEPS, ...DIAGONAL_STEPS,
];

/** Cell key used for de-duplication / set membership. */
function key(col: number, row: number): string {
  return `${col},${row}`;
}

/** Manhattan (taxicab) distance between two cells. */
export function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

/** Chebyshev (chessboard / king-move) distance between two cells. */
export function chebyshev(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

/**
 * In-bounds neighbours of a cell.
 *
 * @param diagonal include the four diagonal neighbours (default `false`).
 */
export function neighbors(grid: TileGrid, cell: Cell, diagonal = false): Cell[] {
  const steps = diagonal ? ALL_STEPS : ORTHO_STEPS;
  const out: Cell[] = [];
  for (const [dc, dr] of steps) {
    const col = cell.col + dc;
    const row = cell.row + dr;
    if (grid.inBounds(col, row)) out.push({ col, row });
  }
  return out;
}

/**
 * All in-bounds cells within `radius` of `center`.
 *
 * @param metric `'manhattan'` for a diamond, `'chebyshev'` for a square.
 *   Default `'chebyshev'`.
 * @param includeCenter include `center` itself (default `false`).
 */
export function cellsInRange(
  grid: TileGrid,
  center: Cell,
  radius: number,
  metric: 'manhattan' | 'chebyshev' = 'chebyshev',
  includeCenter = false,
): Cell[] {
  const dist = metric === 'manhattan' ? manhattan : chebyshev;
  const out: Cell[] = [];
  for (let col = center.col - radius; col <= center.col + radius; col++) {
    for (let row = center.row - radius; row <= center.row + radius; row++) {
      const c = { col, row };
      if (!grid.inBounds(col, row)) continue;
      if (!includeCenter && col === center.col && row === center.row) continue;
      if (dist(center, c) <= radius) out.push(c);
    }
  }
  return out;
}

/**
 * Cells along a straight ray from `from` stepping by `(dCol, dRow)`, stopping
 * at the grid edge or when `blocked` returns `true` for a cell (that blocking
 * cell is **not** included). Use this for rook/bishop-style sliding moves.
 *
 * @example
 * ```ts
 * // Rook moving right until it hits an occupied cell:
 * const path = ray(grid, { col: 0, row: 0 }, 1, 0, (c) => grid.occupied(c.col, c.row));
 * ```
 */
export function ray(
  grid: TileGrid,
  from: Cell,
  dCol: number,
  dRow: number,
  blocked?: (cell: Cell) => boolean,
): Cell[] {
  const out: Cell[] = [];
  let col = from.col + dCol;
  let row = from.row + dRow;
  while (grid.inBounds(col, row)) {
    const c = { col, row };
    if (blocked?.(c)) break;
    out.push(c);
    col += dCol;
    row += dRow;
  }
  return out;
}

/**
 * Cells on the straight line between two cells (Bresenham), inclusive of both
 * endpoints. Useful for line-of-sight checks and aimed effects.
 */
export function line(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [];
  let x0 = a.col, y0 = a.row;
  const x1 = b.col, y1 = b.row;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    out.push({ col: x0, row: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
  return out;
}

/**
 * Clear line-of-sight test: true if no cell strictly between `a` and `b`
 * (endpoints excluded) is blocked.
 */
export function hasLineOfSight(a: Cell, b: Cell, blocked: (cell: Cell) => boolean): boolean {
  const cells = line(a, b);
  for (let i = 1; i < cells.length - 1; i++) {
    if (blocked(cells[i])) return false;
  }
  return true;
}

/** Options for {@link findPath}. */
export interface PathOptions {
  /** Allow diagonal movement (default `false`). */
  diagonal?: boolean;
  /** Return `true` if a cell may NOT be entered. `goal` is always enterable. */
  blocked?: (cell: Cell) => boolean;
  /** Per-cell entry cost (default `1` for everything). */
  cost?: (cell: Cell) => number;
}

/**
 * A* pathfinding from `start` to `goal`. Returns the cell path inclusive of
 * both endpoints, or `null` if no path exists. Uses Manhattan heuristic for
 * orthogonal movement and Chebyshev when diagonals are allowed.
 *
 * @example
 * ```ts
 * const path = findPath(grid, from, to, {
 *   blocked: (c) => grid.occupied(c.col, c.row),
 * });
 * ```
 */
export function findPath(
  grid: TileGrid,
  start: Cell,
  goal: Cell,
  opts: PathOptions = {},
): Cell[] | null {
  if (!grid.inBounds(start.col, start.row) || !grid.inBounds(goal.col, goal.row)) {
    return null;
  }
  const diagonal = opts.diagonal ?? false;
  const heuristic = diagonal ? chebyshev : manhattan;
  const cost = opts.cost ?? (() => 1);
  const blocked = opts.blocked;
  const steps = diagonal ? ALL_STEPS : ORTHO_STEPS;
  const goalKey = key(goal.col, goal.row);

  const open = new Map<string, Cell>([[key(start.col, start.row), start]]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[key(start.col, start.row), 0]]);
  const fScore = new Map<string, number>([[key(start.col, start.row), heuristic(start, goal)]]);

  while (open.size) {
    // Pick the open cell with the lowest fScore.
    let currentKey = '';
    let current: Cell | null = null;
    let best = Infinity;
    for (const [k, c] of open) {
      const f = fScore.get(k) ?? Infinity;
      if (f < best) { best = f; currentKey = k; current = c; }
    }
    if (!current) break;

    if (currentKey === goalKey) {
      // Reconstruct.
      const path: Cell[] = [current];
      let ck = currentKey;
      while (cameFrom.has(ck)) {
        ck = cameFrom.get(ck)!;
        const [col, row] = ck.split(',').map(Number);
        path.unshift({ col, row });
      }
      return path;
    }

    open.delete(currentKey);
    const g = gScore.get(currentKey) ?? Infinity;

    for (const [dc, dr] of steps) {
      const col = current.col + dc;
      const row = current.row + dr;
      if (!grid.inBounds(col, row)) continue;
      const neighbor = { col, row };
      const nKey = key(col, row);
      // The goal is always enterable even if flagged blocked.
      if (nKey !== goalKey && blocked?.(neighbor)) continue;

      const tentative = g + cost(neighbor);
      if (tentative < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, currentKey);
        gScore.set(nKey, tentative);
        fScore.set(nKey, tentative + heuristic(neighbor, goal));
        if (!open.has(nKey)) open.set(nKey, neighbor);
      }
    }
  }

  return null;
}
