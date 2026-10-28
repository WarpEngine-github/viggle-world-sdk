/**
 * WHICH SURFACE IS THE FLOOR, and at what height.
 *
 * Kept against this repo's default of not adding tests, because this one
 * question has been got wrong four times running - the walker has stood under
 * the ground, failed to move at all, fallen through after a jump, and sunk
 * into the floor - and because the symptom only ever appears in a real
 * reconstruction, in a browser, seconds into a walk. These cases are the
 * shapes that actually broke it, as point clouds, in milliseconds.
 *
 * The last two are the ones a percentile could not pass at all, and are why
 * the model is now an opacity march.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildFloorIndex, walkerAperture } from './floorIndex.js';

const WALKER = 1.7;

interface Layer {
  /** Height of the layer. */
  y: number;
  /** Alpha of every splat in it. */
  alpha: number;
  /** Only within this radius of the origin; omitted means everywhere. */
  radius?: number;
}

/** A 20x20 patch of ground, plus whatever layers the case needs above or
 *  below it. Dense enough that a 7 cm aperture gathers plenty. */
function cloud(layers: Layer[]): { positions: Float32Array; alpha: Float32Array } {
  const pos: number[] = [];
  const a: number[] = [];
  const N = 260;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = -10 + (i / (N - 1)) * 20;
      const z = -10 + (j / (N - 1)) * 20;
      for (const L of layers) {
        if (L.radius !== undefined && Math.hypot(x, z) > L.radius) continue;
        pos.push(x, L.y, z);
        a.push(L.alpha);
      }
    }
  }
  return { positions: new Float32Array(pos), alpha: new Float32Array(a) };
}

function groundAt(c: ReturnType<typeof cloud>, x: number, z: number, fromY: number): number | null {
  const fi = buildFloorIndex(c);
  return fi.floorAt(x, z, walkerAperture(WALKER, fi.cell), fromY, WALKER * 3);
}

test('a plain floor reads at the floor', () => {
  const y = groundAt(cloud([{ y: 0, alpha: 1 }]), 0, 0, 0.4);
  assert.ok(y !== null && Math.abs(y) < 0.02, `expected ~0, got ${y}`);
});

test("a panorama's shell underside metres down does not win", () => {
  const y = groundAt(cloud([{ y: 0, alpha: 1 }, { y: -3, alpha: 1 }]), 0, 0, 0.4);
  assert.ok(y !== null && Math.abs(y) < 0.02, `expected the floor ~0, got ${y}`);
});

test('standing ON a table reads the table; walking under it reads the floor', () => {
  const scene = cloud([{ y: 0, alpha: 1 }, { y: 0.8, alpha: 1, radius: 1 }]);
  const on = groundAt(scene, 0, 0, 1.3);
  assert.ok(on !== null && Math.abs(on - 0.8) < 0.05, `expected the table 0.8, got ${on}`);
  const under = groundAt(scene, 0, 0, 0.4);
  assert.ok(under !== null && Math.abs(under) < 0.02, `expected the floor ~0, got ${under}`);
});

test('nothing under the spot answers null, never the lowest splat', () => {
  const y = groundAt(cloud([{ y: 0, alpha: 1 }, { y: -3, alpha: 1 }]), 500, 500, 0.4);
  assert.equal(y, null);
});

test('HAZE IS NOT A SURFACE: a faint layer above the floor is marched through', () => {
  // Reconstruction fog at 0.3, well under the alpha threshold. A percentile
  // over the points would have stood her on it; the march ignores it.
  const y = groundAt(cloud([{ y: 0, alpha: 1 }, { y: 0.35, alpha: 0.2 }]), 0, 0, 0.9);
  assert.ok(y !== null && Math.abs(y) < 0.02, `expected the floor ~0, got ${y}`);
});

test('A LONE BRIGHT STRAY LOSES: one opaque splat under the walker is not a floor', () => {
  // A single solid splat at 0.5, and the real floor below it. The stray
  // clears the alpha threshold, so "the first thing you hit" would stand on
  // it; only accumulated opacity gets this right.
  const scene = cloud([{ y: 0, alpha: 1 }]);
  const pos = Array.from(scene.positions);
  const alpha = Array.from(scene.alpha);
  pos.push(0, 0.5, 0);
  alpha.push(1);
  const c = { positions: new Float32Array(pos), alpha: new Float32Array(alpha) };
  const y = groundAt(c, 0, 0, 0.9);
  assert.ok(y !== null && Math.abs(y) < 0.02, `expected the floor ~0, not the stray, got ${y}`);
});

test('a capture that never gets opaque still has a floor, and its haze is still haze', () => {
  // Pink static: the floor is all alpha 0.49, under the usual 0.5 cut.
  const y = groundAt(cloud([{ y: 0, alpha: 0.49 }, { y: 0.35, alpha: 0.1 }]), 0, 0, 0.9);
  assert.ok(y !== null && Math.abs(y) < 0.02, `expected the floor ~0, got ${y}`);
});

test('a file with no alpha counts every splat rather than none', () => {
  const c = cloud([{ y: 0, alpha: 1 }]);
  const fi = buildFloorIndex({ positions: c.positions, alpha: null });
  const y = fi.floorAt(0, 0, walkerAperture(WALKER, fi.cell), 0.4, WALKER * 3);
  assert.ok(y !== null && Math.abs(y) < 0.02, `expected ~0, got ${y}`);
});
