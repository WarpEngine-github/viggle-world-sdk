import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { spzToGsplatData } from './spz.ts';

/**
 * Two splats with every attribute set to a distinct value, so a swapped
 * channel cannot pass. `sh` is coefficient-major per splat, as `spz-js`
 * unpacks it: `sh[(i * shDim + j) * 3 + c]`.
 */
function cloud(shDim: number) {
  const n = 2;
  const sh = new Float32Array(n * shDim * 3);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < shDim; j++) {
      for (let c = 0; c < 3; c++) {
        sh[(i * shDim + j) * 3 + c] = 100 * i + 10 * j + c;
      }
    }
  }
  return {
    numPoints: n,
    shDegree: shDim === 3 ? 1 : 0,
    antialiased: false,
    positions: new Float32Array([1, 2, 3, 4, 5, 6]),
    scales: new Float32Array([-1, -2, -3, -4, -5, -6]),
    rotations: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    alphas: new Float32Array([0.25, 0.75]),
    colors: new Float32Array([11, 12, 13, 14, 15, 16]),
    sh,
  };
}

describe('spzToGsplatData', () => {
  it('de-interleaves positions, scales and colours', () => {
    const data = spzToGsplatData(cloud(0));
    assert.equal(data.numSplats, 2);
    assert.deepEqual([...data.getProp('x')!], [1, 4]);
    assert.deepEqual([...data.getProp('y')!], [2, 5]);
    assert.deepEqual([...data.getProp('z')!], [3, 6]);
    assert.deepEqual([...data.getProp('scale_0')!], [-1, -4]);
    assert.deepEqual([...data.getProp('scale_1')!], [-2, -5]);
    assert.deepEqual([...data.getProp('scale_2')!], [-3, -6]);
    assert.deepEqual([...data.getProp('f_dc_0')!], [11, 14]);
    assert.deepEqual([...data.getProp('f_dc_1')!], [12, 15]);
    assert.deepEqual([...data.getProp('f_dc_2')!], [13, 16]);
    assert.deepEqual([...data.getProp('opacity')!], [0.25, 0.75]);
  });

  // The one that is invisible when wrong: an xyzw source feeding a wxyz
  // destination rotates every splat and throws no error.
  it('puts the quaternion w in rot_0', () => {
    const data = spzToGsplatData(cloud(0));
    const near = (p: string, want: number[]) =>
      [...data.getProp(p)!].forEach((v, i) =>
        assert.ok(Math.abs(v - want[i]) < 1e-6, `${p}[${i}] = ${v}`));
    near('rot_0', [0.4, 0.8]);
    near('rot_1', [0.1, 0.5]);
    near('rot_2', [0.2, 0.6]);
    near('rot_3', [0.3, 0.7]);
  });

  it('writes no f_rest for a cloud with no SH', () => {
    const data = spzToGsplatData(cloud(0));
    assert.equal(data.getProp('f_rest_0'), void 0);
    assert.equal(data.shBands, 0);
  });

  // Channel-major: f_rest_{j}, f_rest_{j + shDim}, f_rest_{j + 2 * shDim} are
  // one coefficient's r, g, b - the layout `getSHData` re-interleaves from.
  it('lays f_rest out channel-major', () => {
    const data = spzToGsplatData(cloud(3));
    assert.equal(data.shBands, 1);
    for (let c = 0; c < 3; c++) {
      for (let j = 0; j < 3; j++) {
        assert.deepEqual(
          [...data.getProp(`f_rest_${c * 3 + j}`)!],
          [10 * j + c, 100 + 10 * j + c],
        );
      }
    }
  });
});
