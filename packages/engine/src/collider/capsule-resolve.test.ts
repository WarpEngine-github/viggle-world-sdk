import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deepestPenetration, resolveCapsule } from './capsule-resolve.ts';
import type { PushCapsule, PushGrid } from './capsule-resolve.ts';

/** 80 x 20 x 80 unit cells, solid wherever `solid(x, z)` holds, every height. */
function grid(solid: (x: number, z: number) => boolean): PushGrid {
  const nx = 80, ny = 20, nz = 80;
  const occ = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    if (!solid(x, z)) continue;
    for (let y = 0; y < ny; y++) occ[(z * ny + y) * nx + x] = 1;
  }
  return { occ, nx, ny, nz, gx: 0, gy: 0, gz: 0, v: 1 };
}

const capsule: PushCapsule = { axisLo: 5, axisHi: 14, radius: 3 };
const free = (g: PushGrid, x: number, z: number) => !deepestPenetration(g, x, z, capsule, { x: 0, z: 0 });

describe('resolveCapsule', () => {
  it('leaves a free body where it is', () => {
    const g = grid(() => false);
    assert.deepEqual(resolveCapsule(g, 40, 40, capsule), { x: 40, z: 40 });
  });

  it('slides along a bumpy wall at an angle to the grid instead of stopping', () => {
    // A wall at about 27 degrees to the grid - a voxel staircase - with a bump
    // poking out every seventh row, like a scanned wall.
    const g = grid((x, z) => x * 2 + z >= 120 || (z % 7 === 0 && x * 2 + z >= 118));
    // Walk along the wall, aimed 15 degrees into it. The old refuse-then-try-
    // X-and-Z rule gets 13 of the 29 available here.
    const along = { x: -1 / Math.sqrt(5), z: 2 / Math.sqrt(5) };
    const into = 15 * Math.PI / 180;
    const dir = {
      x: along.x * Math.cos(into) + 2 / Math.sqrt(5) * Math.sin(into),
      z: along.z * Math.cos(into) + 1 / Math.sqrt(5) * Math.sin(into),
    };
    let p = resolveCapsule(g, 52, 10, capsule);
    const from = p;
    for (let i = 0; i < 60; i++) {
      p = resolveCapsule(g, p.x + dir.x * 0.5, p.z + dir.z * 0.5, capsule);
      assert.ok(free(g, p.x, p.z), `penetrating at step ${i}: ${p.x},${p.z}`);
    }
    const progress = (p.x - from.x) * along.x + (p.z - from.z) * along.z;
    const available = 30 * Math.cos(into);
    assert.ok(progress > 0.85 * available, `slid ${progress.toFixed(1)} of ${available.toFixed(1)}`);
  });

  it('settles out of both walls in a corner', () => {
    const g = grid((x, z) => x >= 50 || z >= 50);
    const p = resolveCapsule(g, 48.5, 48.5, capsule);
    assert.ok(free(g, p.x, p.z), `${p.x},${p.z}`);
    assert.ok(p.x <= 47 + 1e-6 && p.z <= 47 + 1e-6, `${p.x},${p.z}`);
  });
});
