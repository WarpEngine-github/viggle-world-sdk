import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bakeBoneBoxes, posedBound } from './posed-bound.ts';

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Column-major rotation about a random axis, scaled, then translated. */
function boneMatrix(r: () => number): { data: Float32Array } {
  const ax = r() - 0.5, ay = r() - 0.5, az = r() - 0.5;
  const len = Math.hypot(ax, ay, az) || 1;
  const x = ax / len, y = ay / len, z = az / len;
  const a = r() * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const k = 0.5 + r();
  return { data: new Float32Array([
    (t * x * x + c) * k, (t * x * y + s * z) * k, (t * x * z - s * y) * k, 0,
    (t * x * y - s * z) * k, (t * y * y + c) * k, (t * y * z + s * x) * k, 0,
    (t * x * z + s * y) * k, (t * y * z - s * x) * k, (t * z * z + c) * k, 0,
    r() * 4 - 2, r() * 4 - 2, r() * 4 - 2, 1,
  ]) };
}

/** The skin `Splat.updatePositions` runs, for one packed splat. */
function skin(packed: Float32Array, base: number, bones: { data: Float32Array }[]): [number, number, number] {
  const rx = packed[base], ry = packed[base + 1], rz = packed[base + 2];
  let ox = 0, oy = 0, oz = 0, tw = 0;
  for (let k = 0; k < 4; k++) {
    const w = packed[base + 3 + k * 2];
    if (w < 0.001) continue;
    const b = packed[base + 4 + k * 2] | 0;
    if (b >= bones.length) continue;
    const m = bones[b].data;
    ox += (rx * m[0] + ry * m[4] + rz * m[8] + m[12]) * w;
    oy += (rx * m[1] + ry * m[5] + rz * m[9] + m[13]) * w;
    oz += (rx * m[2] + ry * m[6] + rz * m[10] + m[14]) * w;
    tw += w;
  }
  return tw > 0.001 ? [ox / tw, oy / tw, oz / tw] : [rx, ry, rz];
}

function packedSplats(r: () => number, n: number, numBones: number): Float32Array {
  const packed = new Float32Array(n * 11);
  for (let i = 0; i < n; i++) {
    const base = i * 11;
    packed[base] = r() * 2 - 1; packed[base + 1] = r() * 2; packed[base + 2] = r() * 2 - 1;
    // Every 10th splat unweighted, else 1-4 influences of mixed size.
    if (i % 10 === 0) continue;
    const count = 1 + Math.floor(r() * 4);
    for (let k = 0; k < count; k++) {
      packed[base + 3 + k * 2] = r() < 0.2 ? 0.0005 : r();
      packed[base + 4 + k * 2] = Math.floor(r() * numBones);
    }
  }
  return packed;
}

function assertContains(packed: Float32Array, n: number, bones: { data: Float32Array }[], out: Float32Array) {
  const eps = 1e-4;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = skin(packed, i * 11, bones);
    assert.ok(x >= out[0] - eps && y >= out[1] - eps && z >= out[2] - eps, `splat ${i} below the bound`);
    assert.ok(x <= out[3] + eps && y <= out[4] + eps && z <= out[5] + eps, `splat ${i} above the bound`);
  }
}

describe('posedBound', () => {
  it('contains every skinned center over random poses', () => {
    const r = rng(7);
    const n = 2000, numBones = 12;
    const packed = packedSplats(r, n, numBones);
    const boxes = bakeBoneBoxes(packed, n);
    const out = new Float32Array(6);
    for (let pose = 0; pose < 20; pose++) {
      const bones = Array.from({ length: numBones }, () => boneMatrix(r));
      posedBound(boxes, bones, out);
      assertContains(packed, n, bones, out);
    }
  });

  it('keeps splats of bones the pose lacks at rest', () => {
    const r = rng(11);
    const n = 500;
    const packed = packedSplats(r, n, 8);
    const boxes = bakeBoneBoxes(packed, n);
    const bones = Array.from({ length: 5 }, () => boneMatrix(r));
    const out = new Float32Array(6);
    posedBound(boxes, bones, out);
    assertContains(packed, n, bones, out);
  });

  it('is the exact box for rigid single-bone splats under translation', () => {
    const packed = new Float32Array([
      0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
      1, 2, 3, 1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const boxes = bakeBoneBoxes(packed, 2);
    const bone = { data: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]) };
    const out = new Float32Array(6);
    posedBound(boxes, [bone], out);
    assert.deepEqual([...out], [5, 0, 0, 6, 2, 3]);
  });
});
