import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dropIslands, sealUnreachable } from './collider-grid.ts';

/** A 20 x 10 x 20 grid of unit cells with boxes filled solid. */
function grid(boxes: [number, number, number, number, number, number][]): Uint8Array {
  const occ = new Uint8Array(20 * 10 * 20);
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      occ[(z * 10 + y) * 20 + x] = 1;
    }
  }
  return occ;
}

const at = (occ: Uint8Array, x: number, y: number, z: number) => occ[(z * 10 + y) * 20 + x];
const dims = { x: 20, y: 10, z: 20 };
const origin = { x: 0, y: 0, z: 0 };
const FLOOR: [number, number, number, number, number, number] = [0, 0, 0, 19, 0, 19];
const WALL: [number, number, number, number, number, number] = [0, 1, 0, 19, 5, 0];

describe('dropIslands', () => {
  it('drops a floater and keeps the floor and the wall standing on it', () => {
    const occ = grid([FLOOR, WALL, [10, 4, 10, 10, 4, 10]]);
    const out = dropIslands(occ, dims, origin, 1, null);
    assert.deepEqual(out, { count: 1, voxels: 1 });
    assert.equal(at(occ, 10, 4, 10), 0);
    assert.equal(at(occ, 5, 0, 5), 1);
    assert.equal(at(occ, 5, 3, 0), 1);
  });

  it('keeps a diagonal neighbour: 26-connected, not 6', () => {
    const occ = grid([FLOOR, [10, 1, 10, 10, 1, 10], [11, 2, 11, 11, 2, 11]]);
    assert.equal(dropIslands(occ, dims, origin, 1, null).count, 0);
  });

  it('keeps the small island under the walker', () => {
    const occ = grid([FLOOR, [2, 6, 2, 3, 6, 3]]);
    const out = dropIslands(occ, dims, origin, 1, { x: 2.5, y: 7.5, z: 2.5 });
    assert.equal(out.count, 0);
    assert.equal(at(occ, 2, 6, 2), 1);
  });

  it('keeps an island at least the keep fraction of the largest', () => {
    // 400-cell floor; a 20-cell slab is 5% of it.
    const occ = grid([FLOOR, [0, 5, 10, 19, 5, 10]]);
    assert.equal(dropIslands(occ, dims, origin, 1, null).count, 0);
  });
});

describe('sealUnreachable', () => {
  // A room x 2..17, z 2..17, floor y 0, walls to y 8, open to the sky.
  const ROOM: [number, number, number, number, number, number][] = [
    FLOOR, [2, 1, 2, 17, 8, 2], [2, 1, 17, 17, 8, 17], [2, 1, 2, 2, 8, 17], [17, 1, 2, 17, 8, 17],
  ];
  const inside = { x: 10.5, y: 1, z: 6.5 };

  it('seals nothing on open ground', () => {
    const occ = grid([FLOOR]);
    assert.equal(sealUnreachable(occ, dims, origin, 1, inside, 3), 0);
  });

  it('seals a second room she cannot get into, and leaves hers open', () => {
    // A ceiling at y 9 and a dividing wall at z 10 make two closed rooms.
    const occ = grid([...ROOM, [2, 9, 2, 17, 9, 17], [2, 1, 10, 17, 8, 10]]);
    assert.ok(sealUnreachable(occ, dims, origin, 1, inside, 3) > 0);
    assert.equal(at(occ, 10, 4, 6), 0);
    assert.equal(at(occ, 10, 4, 14), 1);
  });

  it('does not seal a doorway the body fits through', () => {
    const occ = grid([...ROOM, [2, 9, 2, 17, 9, 17], [2, 1, 10, 7, 8, 10], [13, 1, 10, 17, 8, 10]]);
    sealUnreachable(occ, dims, origin, 1, inside, 3);
    assert.equal(at(occ, 10, 4, 10), 0);
    assert.equal(at(occ, 10, 4, 14), 0);
  });

  it('seals behind a gap narrower than the body', () => {
    const occ = grid([...ROOM, [2, 9, 2, 17, 9, 17], [2, 1, 10, 9, 8, 10], [11, 1, 10, 17, 8, 10]]);
    sealUnreachable(occ, dims, origin, 1, inside, 3);
    assert.equal(at(occ, 10, 4, 14), 1);
  });

  it('seeds from her middle, not a pocket in the floor under her feet', () => {
    // A double floor with a hollow layer between: her feet are in the hollow.
    // Seeded there, the flood would fill the room above solid.
    const occ = grid([FLOOR, [0, 2, 0, 19, 2, 19]]);
    const sealed = sealUnreachable(occ, dims, origin, 1, { x: 10.5, y: 1, z: 6.5 }, 3, 6);
    assert.equal(at(occ, 10, 5, 6), 0);
    assert.equal(sealed, 400, 'only the hollow');
  });

  it('seals nothing when the flood starts in a pocket smaller than her', () => {
    // A solid slab with a one-cell pocket, and an open room above it.
    const occ = grid([[0, 0, 0, 19, 2, 19]]);
    occ[(6 * 10 + 1) * 20 + 10] = 0;
    assert.equal(sealUnreachable(occ, dims, origin, 1, { x: 10.5, y: 1, z: 6.5 }, 1, 0), 0);
    assert.equal(at(occ, 10, 5, 6), 0);
  });

  it('does not raise a bumpy floor', () => {
    const occ = grid([FLOOR, [8, 1, 8, 8, 1, 8]]);
    assert.equal(sealUnreachable(occ, dims, origin, 1, inside, 3), 0);
    assert.equal(at(occ, 9, 1, 8), 0);
  });

  it('without a climb, floods over walls open to the sky and seals nothing', () => {
    assert.equal(sealUnreachable(grid(ROOM), dims, origin, 1, inside, 1), 0);
  });

  it('with a climb, seals outside walls taller than her, and keeps the air over her', () => {
    const occ = grid(ROOM);
    assert.ok(sealUnreachable(occ, dims, origin, 1, inside, 1, 3, 3) > 0);
    assert.equal(at(occ, 10, 2, 6), 0);
    assert.equal(at(occ, 10, 9, 6), 0, 'above her head, up to the top of the grid');
    assert.equal(at(occ, 0, 4, 10), 1);
    assert.equal(at(occ, 0, 9, 10), 1, 'over the wall top too');
  });

  it('with a climb, crosses a hole in the floor at her own level', () => {
    // No floor captured across z 8..11: the walk crosses it on its floor index.
    const occ = grid([FLOOR]);
    for (let z = 8; z <= 11; z++) for (let x = 0; x < 20; x++) occ[(z * 10 + 0) * 20 + x] = 0;
    assert.equal(sealUnreachable(occ, dims, origin, 1, inside, 1, 3, 3), 0);
    assert.equal(at(occ, 10, 2, 15), 0);
  });

  it('with a climb, still reaches the top of furniture she could step onto', () => {
    const occ = grid([FLOOR, [12, 1, 12, 15, 2, 15]]);
    assert.equal(sealUnreachable(occ, dims, origin, 1, inside, 1, 3, 3), 0);
    assert.equal(at(occ, 13, 3, 13), 0);
  });
});
