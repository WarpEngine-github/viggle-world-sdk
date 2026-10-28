import assert from 'node:assert/strict';
import { it } from 'node:test';

import { GSplatResource, GSplatSogData, NullGraphicsDevice } from 'playcanvas';

import { installFastSogDecompress } from './fast-sog-decompress.ts';
import { installFastTransformPack } from './fast-transform-pack.ts';

/** A SOG of random bytes; textures are stand-ins that `read` back those bytes. */
function sog(n: number, version: 1 | 2, shBands: 0 | 1 | 3): GSplatSogData {
  let seed = 5 + version * 10 + shBands;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const side = Math.ceil(Math.sqrt(n));
  const texture = (width: number, height: number, fill: (i: number) => number) => {
    const bytes = Uint8Array.from({ length: width * height * 4 }, (_, i) => fill(i));
    return { device: { isNull: false }, width, height, _levels: [] as Uint8Array[], read: () => Promise.resolve(bytes.slice()) };
  };
  const byte = () => Math.floor(rnd() * 256);
  const codebook = () => Array.from({ length: 256 }, () => rnd() * 8 - 4);
  const range = (k: number) => ({ mins: Array.from({ length: k }, () => -rnd() * 4), maxs: Array.from({ length: k }, () => rnd() * 4) });
  const meta = version === 2
    ? { version: 2, means: range(3), scales: { codebook: codebook() }, sh0: { codebook: codebook() }, shN: { codebook: codebook() } }
    : { means: range(3), scales: range(3), sh0: range(4), shN: { mins: -1.5, maxs: 1.5 } };
  // A null first entry is what _patchCodebooks repairs.
  if (version === 2) meta.sh0.codebook![0] = null as never;
  const coeffs = [0, 3, 8, 15][shBands];
  const data = new GSplatSogData() as unknown as Record<string, unknown>;
  Object.assign(data, {
    meta, numSplats: n, shBands,
    means_l: texture(side, side, byte),
    means_u: texture(side, side, byte),
    // Mode bytes 252-255, with a few outside that range (the rotation then carries over).
    quats: texture(side, side, (i) => (i % 4 === 3 ? (rnd() < 0.03 ? byte() : 252 + Math.floor(rnd() * 4)) : byte())),
    scales: texture(side, side, byte),
    sh0: texture(side, side, byte),
    sh_labels: shBands ? texture(side, side, (i) => (i % 4 === 1 ? Math.floor(rnd() * 4) : byte())) : undefined,
    sh_centroids: shBands ? texture(64 * coeffs, 4, byte) : undefined,
  });
  return data as unknown as GSplatSogData;
}

async function props(data: GSplatSogData) {
  const out = await data.decompress();
  return out.elements[0].properties.map((p) => [p.name, Array.from(p.storage as Float32Array)]);
}

it('decompresses a SOG to the same splats as PlayCanvas, both versions, with SH', async () => {
  const cases = [[2, 0], [2, 3], [1, 0], [1, 1]] as const;
  const plain = await Promise.all(cases.map(([v, sh]) => props(sog(2000, v, sh))));
  const original = installFastSogDecompress();
  try {
    const fast = await Promise.all(cases.map(([v, sh]) => props(sog(2000, v, sh))));
    for (let c = 0; c < cases.length; c++) assert.deepEqual(fast[c], plain[c], `version ${cases[c][0]}, SH ${cases[c][1]}`);
  } finally {
    GSplatSogData.prototype.decompress = original;
  }
});

/** What the parser builds from a decompressed SOG: every stream texture, centres and bounds. */
async function resource(data: GSplatSogData) {
  const splats = await data.decompress();
  const r = new GSplatResource(new NullGraphicsDevice({} as HTMLCanvasElement), splats);
  const packed = (splats as { packed?: object }).packed;
  return {
    left: packed ? Object.values(packed).filter(Boolean).length : 0,
    textures: [...r.streams.textures].map(([name, t]) => [name, Array.from(t.lock() as Uint16Array)]),
    centers: Array.from(r.centers),
    aabb: [r.aabb.center, r.aabb.halfExtents].map((v) => [v.x, v.y, v.z]),
  };
}

it('builds the same resource from a SOG as PlayCanvas, with the worker packing copied in', async () => {
  const cases = [[2, 0], [2, 3], [1, 0], [1, 1]] as const;
  const plain = await Promise.all(cases.map(([v, sh]) => resource(sog(2000, v, sh))));
  const decompress = installFastSogDecompress();
  const pack = installFastTransformPack();
  try {
    const fast = await Promise.all(cases.map(([v, sh]) => resource(sog(2000, v, sh))));
    for (let c = 0; c < cases.length; c++) {
      // Every packed piece was consumed, so the textures compared are the worker's.
      assert.equal(fast[c].left, 0);
      assert.deepEqual(fast[c], plain[c], `version ${cases[c][0]}, SH ${cases[c][1]}`);
    }
  } finally {
    GSplatSogData.prototype.decompress = decompress;
    Object.assign(GSplatResource.prototype, pack);
  }
});

it('falls back to PlayCanvas\'s decompress when the worker fails', async () => {
  const plain = await resource(sog(500, 2, 0));
  const decompress = installFastSogDecompress();
  const pack = installFastTransformPack();
  const global = globalThis as { Worker?: unknown };
  global.Worker = class {
    onerror?: (e: { message: string }) => void;
    postMessage() { queueMicrotask(() => this.onerror?.({ message: 'chunk 404' })); }
    terminate() {}
  };
  try {
    assert.deepEqual(await resource(sog(500, 2, 0)), plain);
  } finally {
    delete global.Worker;
    GSplatSogData.prototype.decompress = decompress;
    Object.assign(GSplatResource.prototype, pack);
  }
});
