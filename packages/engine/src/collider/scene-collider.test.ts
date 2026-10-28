import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SceneColliderData } from './collider-grid.ts';
import { SceneCollider } from './scene-collider.ts';

/** A 10 x 10 x 10 grid of 0.5-unit cells at the origin, `solid` cells filled. */
function collider(solid: [number, number, number][], frame = { origin: { x: 0, y: 0, z: 0 }, scale: 1 }): SceneCollider {
  const occupancy = new Uint8Array(1000);
  for (const [x, y, z] of solid) occupancy[(z * 10 + y) * 10 + x] = 1;
  return SceneCollider.fromData({
    version: 1,
    occupancy,
    dims: { x: 10, y: 10, z: 10 },
    gridOrigin: { x: 0, y: 0, z: 0 },
    voxelSize: 0.5,
    builtFrame: frame,
  } as unknown as SceneColliderData);
}

/** A wall filling the z = 6 slab. */
const WALL: [number, number, number][] = [];
for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) WALL.push([x, y, 6]);

describe('SceneCollider.raycast', () => {
  it('hits the near face of a wall', () => {
    const hit = collider(WALL).raycast({ x: 2.2, y: 2.2, z: 0.2 }, { x: 0, y: 0, z: 1 }, 10);
    assert.ok(hit !== null && Math.abs(hit - 2.8) < 1e-9);
  });

  it('misses past maxT, and away from the wall', () => {
    const c = collider(WALL);
    assert.equal(c.raycast({ x: 2.2, y: 2.2, z: 0.2 }, { x: 0, y: 0, z: 1 }, 2.5), null);
    assert.equal(c.raycast({ x: 2.2, y: 2.2, z: 2.2 }, { x: 0, y: 0, z: -1 }, 10), null);
  });

  it('measures along a diagonal, with any length of dir', () => {
    const hit = collider(WALL).raycast({ x: 2.25, y: 2.25, z: 2.25 }, { x: 0, y: 3, z: 3 }, 10);
    assert.ok(hit !== null && Math.abs(hit - 0.75 * Math.SQRT2) < 1e-9);
  });

  it('passes through the solid it starts in', () => {
    const c = collider([[4, 4, 4], [4, 4, 8]]);
    const hit = c.raycast({ x: 2.25, y: 2.25, z: 2.25 }, { x: 0, y: 0, z: 1 }, 10);
    assert.ok(hit !== null && Math.abs(hit - 1.75) < 1e-9);
  });

  it('enters from outside the grid', () => {
    const hit = collider(WALL).raycast({ x: 2.2, y: 2.2, z: 8 }, { x: 0, y: 0, z: -1 }, 10);
    assert.ok(hit !== null && Math.abs(hit - 4.5) < 1e-9);
  });

  it('follows the frame: moved and scaled', () => {
    const c = collider(WALL, { origin: { x: 10, y: 0, z: 0 }, scale: 2 });
    const hit = c.raycast({ x: 14.4, y: 4.4, z: 0.4 }, { x: 0, y: 0, z: 1 }, 20);
    assert.ok(hit !== null && Math.abs(hit - 5.6) < 1e-9);
  });
});

describe('SceneCollider.isClear', () => {
  it('touches a wall only within the radius', () => {
    const c = collider(WALL);
    assert.equal(c.isClear({ x: 2.2, y: 2.2, z: 2.8 }, 0.15), true);
    assert.equal(c.isClear({ x: 2.2, y: 2.2, z: 2.8 }, 0.25), false);
  });

  it('measures to a cell\'s corner, not its box', () => {
    const c = collider([[4, 4, 4]]);
    // 0.1 off the corner on each axis: 0.173 away.
    assert.equal(c.isClear({ x: 1.9, y: 1.9, z: 1.9 }, 0.15), true);
    assert.equal(c.isClear({ x: 1.9, y: 1.9, z: 1.9 }, 0.2), false);
  });

  it('reads off the grid as empty, and follows the frame', () => {
    assert.equal(collider(WALL).isClear({ x: -3, y: 2, z: 3.2 }, 0.5), true);
    const c = collider(WALL, { origin: { x: 10, y: 0, z: 0 }, scale: 2 });
    assert.equal(c.isClear({ x: 14.4, y: 4.4, z: 5.6 }, 0.3), true);
    assert.equal(c.isClear({ x: 14.4, y: 4.4, z: 5.6 }, 0.5), false);
  });
});
