import assert from 'node:assert/strict';
import { it } from 'node:test';

import { GSplatData } from 'playcanvas';

import { mortonOrder } from './morton-order.ts';

function cloud(xs: number[], ys: number[], zs: number[]): GSplatData {
  const prop = (name: string, values: number[]) => ({ type: 'float', name, storage: Float32Array.from(values), byteSize: 4 });
  return new GSplatData([{
    name: 'vertex',
    count: xs.length,
    properties: [prop('x', xs), prop('y', ys), prop('z', zs)],
  }] as never);
}

function same(xs: number[], ys: number[], zs: number[]) {
  const data = cloud(xs, ys, zs);
  const want = data.calcMortonOrder();
  const got = mortonOrder(data.getProp('x')!, data.getProp('y')!, data.getProp('z')!);
  assert.deepEqual(got, want);
}

it('matches PlayCanvas on a random cloud with many shared cells', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = 50_000;
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < n; i++) {
    // Quantised so thousands of splats share a code and the tie order counts.
    xs.push(Math.round(rnd() * 40) / 4 - 3);
    ys.push(rnd() * 2);
    zs.push(rnd() < 0.1 ? 5 : rnd() * -10);
  }
  same(xs, ys, zs);
});

it('matches PlayCanvas on a flat axis and a non-finite value', () => {
  same([0, 1, 2, 3, 1], [4, 4, 4, 4, 4], [1, 0, NaN, 2, 0]);
});
