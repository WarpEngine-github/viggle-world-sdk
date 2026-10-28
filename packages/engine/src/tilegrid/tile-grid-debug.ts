import { Color, Vec3 } from 'playcanvas';
import type { Scene } from '../scene';
import type { Cell, TileGrid } from './tile-grid';

/**
 * Immediate-mode debug overlay for {@link TileGrid}, drawn with the app's
 * line renderer. Call {@link TileGridDebug.draw} once per frame (lines are
 * one-shot in PlayCanvas immediate mode). Nothing here is meant for shipping
 * visuals - use it to see cell boundaries, occupancy, and picks while building.
 *
 * @example
 * ```ts
 * const dbg = new TileGridDebug(scene, board);
 * // per frame:
 * dbg.draw();                          // grid lines + occupied cells
 * if (lastPick) dbg.markCell(lastPick); // highlight the picked cell
 * ```
 *
 * @group Primitives
 * @category TileGrid
 */
export class TileGridDebug {
  /** Color of the grid cell boundaries. */
  lineColor = new Color(0.4, 0.4, 0.4);
  /** Color of the box drawn around occupied cells. */
  occupiedColor = new Color(1, 0.4, 0.2);
  /** Color used by {@link markCell} / {@link markCells}. */
  markColor = new Color(0.2, 1, 0.4);
  /** Lift debug lines this far above the grid plane to avoid z-fighting. */
  yLift = 0.02;
  /** Whether debug lines are occluded by scene geometry. Default `false`. */
  depthTest = false;

  private readonly scene: Scene;
  private readonly grid: TileGrid;

  // Explicit fields, not parameter properties: consumers compiling this source
  // with `erasableSyntaxOnly` reject the parameter-property form.
  constructor(scene: Scene, grid: TileGrid) {
    this.scene = scene;
    this.grid = grid;
  }

  /**
   * Draw the cell boundary lines, plus a box around every occupied cell.
   * @param showOccupied draw occupied-cell boxes (default `true`).
   */
  draw(showOccupied = true): void {
    const g = this.grid;
    const y = g.y + this.yLift;
    const x0 = g.originX;
    const z0 = g.originZ;
    const w = g.cols * g.cellSize;
    const h = g.rows * g.cellSize;

    // Vertical lines (constant X, varying Z).
    for (let c = 0; c <= g.cols; c++) {
      const x = x0 + c * g.cellSize;
      this._line(x, y, z0, x, y, z0 + h, this.lineColor);
    }
    // Horizontal lines (constant Z, varying X).
    for (let r = 0; r <= g.rows; r++) {
      const z = z0 + r * g.cellSize;
      this._line(x0, y, z, x0 + w, y, z, this.lineColor);
    }

    if (showOccupied) {
      g.forEach((cell) => this._cellBox(cell, this.occupiedColor));
    }
  }

  /** Outline a single cell (e.g. the last picked cell). */
  markCell(cell: Cell, color: Color = this.markColor): void {
    this._cellBox(cell, color);
  }

  /** Outline several cells (e.g. a move range or a path). */
  markCells(cells: Iterable<Cell>, color: Color = this.markColor): void {
    for (const cell of cells) this._cellBox(cell, color);
  }

  /**
   * Draw a small cross at a world point and a vertical stem down to the grid
   * plane - handy for visualizing where a picking ray landed.
   */
  markHit(world: Vec3, color: Color = this.markColor): void {
    const y = this.grid.y + this.yLift;
    const s = this.grid.cellSize * 0.15;
    this._line(world.x - s, y, world.z, world.x + s, y, world.z, color);
    this._line(world.x, y, world.z - s, world.x, y, world.z + s, color);
    this._line(world.x, world.y, world.z, world.x, y, world.z, color);
  }

  /** Box around one cell's footprint at the (lifted) grid plane. */
  private _cellBox(cell: Cell, color: Color): void {
    const g = this.grid;
    const y = g.y + this.yLift;
    const x0 = g.originX + cell.col * g.cellSize;
    const z0 = g.originZ + cell.row * g.cellSize;
    const x1 = x0 + g.cellSize;
    const z1 = z0 + g.cellSize;
    this._line(x0, y, z0, x1, y, z0, color);
    this._line(x1, y, z0, x1, y, z1, color);
    this._line(x1, y, z1, x0, y, z1, color);
    this._line(x0, y, z1, x0, y, z0, color);
  }

  private _line(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    color: Color,
  ): void {
    this.scene.app.drawLine(
      new Vec3(x0, y0, z0),
      new Vec3(x1, y1, z1),
      color,
      this.depthTest,
    );
  }
}
