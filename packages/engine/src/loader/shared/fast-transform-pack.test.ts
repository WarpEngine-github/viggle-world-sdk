import assert from 'node:assert/strict';
import { it } from 'node:test';

import { GSplatData, GSplatResource, NullGraphicsDevice } from 'playcanvas';

import { installFastTransformPack } from './fast-transform-pack.ts';

function splats(n: number, activated: boolean): GSplatData {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const prop = (name: string, f: () => number) =>
    ({ type: 'float', name, storage: Float32Array.from({ length: n }, f), byteSize: 4 });
  const properties = [
    ...['x', 'y', 'z'].map((name) => prop(name, () => rnd() * 20 - 10)),
    ...['rot_0', 'rot_1', 'rot_2', 'rot_3'].map((name) => prop(name, () => rnd() * 2 - 1)),
    ...['scale_0', 'scale_1', 'scale_2'].map((name) => prop(name, () => (activated ? rnd() * 3 : rnd() * 16 - 12))),
    ...['f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'].map((name) => prop(name, () => rnd() * 6 - 3)),
  ];
  const get = (name: string) => properties.find((p) => p.name === name)!.storage;
  // Edge cases: a zero quaternion, a negative w, a NaN position, an overflowing scale.
  for (const r of ['rot_0', 'rot_1', 'rot_2', 'rot_3']) get(r)[0] = 0;
  get('rot_0')[1] = -0.9;
  get('x')[2] = NaN;
  get('scale_0')[3] = activated ? 1e6 : 40;
  const data = new GSplatData([{ name: 'vertex', count: n, properties }] as never);
  data.activated = activated;
  return data;
}

function textures(data: GSplatData) {
  const resource = new GSplatResource(new NullGraphicsDevice({} as HTMLCanvasElement), data);
  return ['transformA', 'transformB'].map((name) => Array.from(resource.streams.getTexture(name)!.lock() as Uint16Array));
}

it('packs the same transform textures as PlayCanvas, raw and activated', () => {
  const plain = [splats(3000, false), splats(3000, true)].map(textures);
  const original = installFastTransformPack();
  try {
    const fast = [splats(3000, false), splats(3000, true)].map(textures);
    assert.deepEqual(fast, plain);
  } finally {
    Object.assign(GSplatResource.prototype, original);
  }
});
