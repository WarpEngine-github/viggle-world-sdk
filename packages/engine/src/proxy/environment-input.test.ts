import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AUTO_LOD_SPLATS_PER_VOXEL,
  cropInputToWorldBox,
  denseEnough,
  lodSlices,
  occupiedVoxelCount,
  resolveLodLevel,
} from './environment-input.ts';
import type { OctreeLike } from './environment-input.ts';

/**
 * The two places an environment proxy can silently read the wrong splats: an
 * LOD level assembled from the wrong runs of a chunk file (the proxy then
 * describes some other part of the octree, or a mix of levels), and a crop
 * applied in the wrong space (local vs world - a scaled or rotated environment
 * would keep the wrong room).
 */

const node = (...lods: [number, number, number][]) => ({
  lods: lods.map(([fileIndex, offset, count]) => ({ fileIndex, offset, count })),
});

describe('environment proxy LOD slices', () => {
  const octree: OctreeLike = {
    lodLevels: 2,
    files: [{ url: 'a' }, { url: 'b' }],
    nodes: [
      node([0, 0, 10], [1, 0, 3]),
      node([0, 10, 5], [-1, 0, 0]),
      node([0, 15, 7], [1, 3, 2]),
    ],
  };

  it('takes each node\'s run at the level, and skips nodes with none', () => {
    assert.deepEqual(lodSlices(octree, 1), [
      { fileIndex: 1, offset: 0, count: 3 },
      { fileIndex: 1, offset: 3, count: 2 },
    ]);
    assert.equal(lodSlices(octree, 0).reduce((n, s) => n + s.count, 0), 22);
  });

  it('resolves coarsest to the last level and clamps numbers into range', () => {
    assert.equal(resolveLodLevel('coarsest', 7), 6);
    assert.equal(resolveLodLevel(99, 7), 6);
    assert.equal(resolveLodLevel(-3, 7), 0);
    assert.equal(resolveLodLevel(2.4, 7), 2);
    assert.equal(resolveLodLevel('coarsest', 0), 0);
    assert.equal(resolveLodLevel('auto', 7), 6);
  });
});

describe('environment proxy crop', () => {
  const positions = new Float32Array([
    0, 0, 0,
    1, 0, 0,
    2, 0, 0,
    0, 5, 0,
  ]);
  const opacities = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it('returns the input itself when nothing is outside', () => {
    const input = { positions, opacities };
    assert.equal(cropInputToWorldBox(input, identity, { x: -9, y: -9, z: -9 }, { x: 9, y: 9, z: 9 }), input);
  });

  it('keeps positions and opacities paired', () => {
    const out = cropInputToWorldBox({ positions, opacities }, identity, { x: -0.5, y: -1, z: -1 }, { x: 1.5, y: 1, z: 1 });
    assert.deepEqual([...out.positions], [0, 0, 0, 1, 0, 0]);
    assert.deepEqual([...out.opacities!], [0.1, 0.2].map(Math.fround));
  });

  it('tests the WORLD position, through the node transform', () => {
    // Scale 2, then translate +10 in x (column-major): local x=2 lands at world 14.
    const m = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1];
    const out = cropInputToWorldBox({ positions, opacities }, m, { x: 13, y: -1, z: -1 }, { x: 15, y: 1, z: 1 });
    assert.deepEqual([...out.positions], [2, 0, 0]);
    // The kept positions stay LOCAL - the proxy is parented to the node.
  });
});

describe('environment proxy auto LOD density', () => {
  /** `perCell` opaque splats in each of `cells` voxels along x, voxel 1. */
  const grid = (cells: number, perCell: number, alpha = 1) => {
    const positions = new Float32Array(cells * perCell * 3);
    for (let c = 0; c < cells; c++) {
      for (let k = 0; k < perCell; k++) positions[(c * perCell + k) * 3] = c + (k + 0.5) / (perCell + 1);
    }
    return { positions, opacities: new Float32Array(cells * perCell).fill(alpha) };
  };

  it('counts distinct voxels, ignoring splats under the threshold', () => {
    assert.equal(occupiedVoxelCount(grid(10, 4), 1, 0.2), 10);
    assert.equal(occupiedVoxelCount(grid(10, 4), 2, 0.2), 5);
    assert.equal(occupiedVoxelCount(grid(10, 4, 0.1), 1, 0.2), 0);
  });

  it('calls a level dense at the threshold and sparse below it', () => {
    assert.equal(denseEnough(grid(10, AUTO_LOD_SPLATS_PER_VOXEL), 1, 0.2), true);
    assert.equal(denseEnough(grid(10, AUTO_LOD_SPLATS_PER_VOXEL - 1), 1, 0.2), false);
    // The same splats are dense at a coarser voxel.
    assert.equal(denseEnough(grid(10, AUTO_LOD_SPLATS_PER_VOXEL - 1), 2, 0.2), true);
  });
});
