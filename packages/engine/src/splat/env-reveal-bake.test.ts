import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bakeEnvRevealDistances, envRevealRadius } from './env-reveal-bake.ts';

/** `n` splats on the +X axis at radius 1, plus the given floater radii. */
function room(n: number, floaters: readonly number[]) {
  const total = n + floaters.length;
  const x = new Float32Array(total);
  const y = new Float32Array(total);
  const z = new Float32Array(total);
  for (let i = 0; i < n; i++) x[i] = 1;
  for (let i = 0; i < floaters.length; i++) x[n + i] = floaters[i];
  return { x, y, z, numSplats: total };
}

describe('envRevealRadius', () => {
  it('ignores the floaters a max would normalise against', () => {
    const r = room(1000, [100, 250]);
    assert.equal(envRevealRadius(r.x, r.y, r.z, r.numSplats), 1);
  });

  it('is zero when every splat sits on the origin', () => {
    const r = room(0, []);
    assert.equal(envRevealRadius(new Float32Array(8), new Float32Array(8), new Float32Array(8), 8), 0);
    assert.equal(envRevealRadius(r.x, r.y, r.z, 0), 0);
  });
});

describe('bakeEnvRevealDistances', () => {
  it('normalises the room to 0..1 and clamps what is past it', () => {
    const r = room(1000, [100]);
    const out = new Float32Array(r.numSplats).fill(1);
    assert.equal(bakeEnvRevealDistances(out, r.x, r.y, r.z, r.numSplats), true);
    assert.equal(out[0], 1);
    assert.equal(out[r.numSplats - 1], 1, 'the floater is clamped, not 100');
  });

  it('spreads a graded cloud across the sweep', () => {
    const n = 1000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (i / (n - 1)) * 10;
    const out = new Float32Array(n).fill(1);
    bakeEnvRevealDistances(out, x, new Float32Array(n), new Float32Array(n), n);
    assert.equal(out[0], 0);
    assert.ok(Math.abs(out[Math.floor(n / 2)] - 0.51) < 0.02, `midpoint was ${out[n / 2]}`);
    assert.equal(out[n - 1], 1);
  });

  it('leaves the caller hidden rather than guessing when there is no radius', () => {
    const out = new Float32Array(4).fill(1);
    const zeros = new Float32Array(4);
    assert.equal(bakeEnvRevealDistances(out, zeros, zeros, zeros, 4), false);
    assert.deepEqual([...out], [1, 1, 1, 1]);
  });
});
