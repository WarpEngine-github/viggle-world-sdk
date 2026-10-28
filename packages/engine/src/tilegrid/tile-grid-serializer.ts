import { TileGrid } from './tile-grid';
import type { Cell } from './tile-grid';

/**
 * Serialization helpers for {@link TileGrid} - turn a grid (geometry +
 * per-cell payloads) into plain JSON and back. Use for save games, netcode
 * sync, and recorded match transcripts.
 *
 * Because the engine never interprets cell payloads, you provide the
 * payload ⇄ JSON conversion. For payloads that are already plain data you can
 * pass the identity function (the default).
 *
 * @group Primitives
 * @category TileGrid
 */

/** A single serialized occupied cell. */
export interface SerializedCell<P = unknown> {
  col: number;
  row: number;
  value: P;
}

/** Plain-data snapshot of a {@link TileGrid}. Safe to `JSON.stringify`. */
export interface TileGridSnapshot<P = unknown> {
  /** Snapshot format version, for forward-compatible migrations. */
  version: 1;
  cols: number;
  rows: number;
  cellSize: number;
  /** Grid plane height. */
  y: number;
  /** World X/Z of the `(0,0)` cell's outer corner. */
  originX: number;
  originZ: number;
  /** Only the occupied cells, in row-major order. */
  cells: SerializedCell<P>[];
}

/** Options for {@link serializeTileGrid}. */
export interface SerializeOptions<T, P> {
  /** Convert a stored payload into JSON-safe data. Default: identity. */
  encode?: (value: T, cell: Cell) => P;
}

/** Options for {@link deserializeTileGrid}. */
export interface DeserializeOptions<T, P> {
  /** Rebuild a stored payload from its JSON form. Default: identity. */
  decode?: (value: P, cell: Cell) => T;
}

/**
 * Snapshot a grid into a plain object. The result captures the grid geometry
 * and every occupied cell; empty cells are omitted.
 *
 * @example
 * ```ts
 * const json = JSON.stringify(serializeTileGrid(board, {
 *   encode: (piece) => ({ kind: piece.kind, color: piece.color }),
 * }));
 * ```
 */
export function serializeTileGrid<T = unknown, P = T>(
  grid: TileGrid,
  opts: SerializeOptions<T, P> = {},
): TileGridSnapshot<P> {
  const encode = opts.encode ?? ((v: T) => v as unknown as P);
  const cells: SerializedCell<P>[] = [];
  grid.forEach((cell, value) => {
    cells.push({ col: cell.col, row: cell.row, value: encode(value as T, cell) });
  });
  return {
    version: 1,
    cols: grid.cols,
    rows: grid.rows,
    cellSize: grid.cellSize,
    y: grid.y,
    originX: grid.originX,
    originZ: grid.originZ,
    cells,
  };
}

/**
 * Rebuild a {@link TileGrid} from a snapshot produced by
 * {@link serializeTileGrid}. Restores geometry and re-populates occupied cells.
 *
 * @example
 * ```ts
 * const board = deserializeTileGrid<ChessPiece, PieceJson>(JSON.parse(json), {
 *   decode: (data) => makePiece(data.kind, data.color),
 * });
 * ```
 */
export function deserializeTileGrid<T = unknown, P = T>(
  snapshot: TileGridSnapshot<P>,
  opts: DeserializeOptions<T, P> = {},
): TileGrid {
  if (snapshot.version !== 1) {
    throw new Error(`[TileGrid] unsupported snapshot version: ${String(snapshot.version)}`);
  }
  const decode = opts.decode ?? ((v: P) => v as unknown as T);
  const grid = TileGrid.create({
    cols: snapshot.cols,
    rows: snapshot.rows,
    cellSize: snapshot.cellSize,
    y: snapshot.y,
    // originX/originZ are the non-centered (0,0) corner, so centered stays false.
    origin: { x: snapshot.originX, y: snapshot.y, z: snapshot.originZ },
  });
  for (const { col, row, value } of snapshot.cells) {
    grid.set(col, row, decode(value, { col, row }));
  }
  return grid;
}
