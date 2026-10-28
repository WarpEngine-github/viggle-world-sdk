import assert from 'node:assert/strict';
import { it } from 'node:test';

import { GSplatData, GSplatResource, NullGraphicsDevice } from 'playcanvas';
import { loadSpz, serializePackedGaussians } from 'spz-js';

// @ts-expect-error - PlayCanvas ships its parser scripts untyped.
import { GSplatSpzResource } from 'playcanvas/scripts/esm/parsers/spz-parser.mjs';

import { decodeCloud, decodeSpzQuantized, packSplat, spzToProperties } from './spz-decode.ts';
import type { QuantizedSpz } from './spz-quantized.ts';
import { isQuantized } from './spz-quantized.ts';
import { readSpz } from './spz-read.ts';
import { PackedGSplatData, QuantizedGSplatData, QuantizedSpzResource } from './spz.ts';
import { installFastTransformPack } from '../shared/fast-transform-pack.ts';
import { dropStreamCopies, rebuildStreams } from '../shared/texture-cpu-copy.ts';

function cloud(n: number) {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const fill = (k: number, f: () => number) => Float32Array.from({ length: n * k }, f);
  const c = {
    numPoints: n, shDegree: 0, antialiased: false,
    positions: fill(3, () => rnd() * 20 - 10),
    scales: fill(3, () => rnd() * 16 - 12),
    rotations: fill(4, () => rnd() * 2 - 1),
    alphas: fill(1, () => rnd() * 20 - 10),
    colors: fill(3, () => rnd() * 6 - 3),
    sh: new Float32Array(0),
  };
  // Edge cases: a zero quaternion, a NaN position, an overflowing scale.
  c.rotations.fill(0, 0, 4);
  c.positions[3] = NaN;
  c.scales[6] = 40;
  return c;
}

it('builds the same textures, centres and bounds as GSplatResource', () => {
  const device = new NullGraphicsDevice({} as HTMLCanvasElement);
  const properties = spzToProperties(cloud(5000));
  const get = (name: string) => properties.find((p) => p.name === name)!.storage;
  const packed = packSplat(get, 5000);

  const plain = new GSplatResource(device, new GSplatData([{ name: 'vertex', count: 5000, properties }] as never));
  const data = new PackedGSplatData({ count: 5000, properties, packed });
  const original = installFastTransformPack();
  try {
    const fast = new GSplatResource(device, data);
    // Consumed, so the comparison below is of the worker's output.
    assert.deepEqual(Object.values(data.packed).filter(Boolean), []);

    for (const name of ['splatColor', 'transformA', 'transformB']) {
      assert.deepEqual(fast.streams.getTexture(name)!.lock(), plain.streams.getTexture(name)!.lock(), name);
    }
    assert.deepEqual(fast.centers, plain.centers);
    assert.deepEqual([fast.aabb.center, fast.aabb.halfExtents], [plain.aabb.center, plain.aabb.halfExtents]);
  } finally {
    Object.assign(GSplatResource.prototype, original);
  }
});

it('drops the texture copies and rebuilds the same bytes from the splat data', () => {
  const device = new NullGraphicsDevice({} as HTMLCanvasElement);
  const properties = spzToProperties(cloud(5000));
  const get = (name: string) => properties.find((p) => p.name === name)!.storage;
  const plain = new GSplatResource(device, new GSplatData([{ name: 'vertex', count: 5000, properties }] as never));
  const original = installFastTransformPack();
  const fast = new GSplatResource(device, new PackedGSplatData({ count: 5000, properties, packed: packSplat(get, 5000) }));
  Object.assign(GSplatResource.prototype, original);
  const names = ['splatColor', 'transformA', 'transformB'];
  const levels = (name: string) => (fast.streams.getTexture(name) as unknown as { _levels: unknown[] })._levels;
  // The null device never uploads, so stand in for `unlock()`'s upload.
  const uploaded = () => names.forEach((n) => { (fast.streams.getTexture(n) as unknown as { _needsUpload: boolean })._needsUpload = false; });

  uploaded();
  assert.equal(dropStreamCopies(fast), true);
  for (const name of names) assert.equal(levels(name)[0], null, name);

  const restore = fast.updateTransformData.bind(fast);
  fast.updateTransformData = (d) => { restore(d); uploaded(); };
  rebuildStreams(fast);
  for (const name of names) assert.equal(levels(name)[0], null, `${name} dropped again`);
  // Rebuild once more without the drop to compare what it wrote.
  fast.updateColorData(fast.gsplatData as never);
  fast.updateTransformData(fast.gsplatData as never);
  for (const name of names) {
    assert.deepEqual(fast.streams.getTexture(name)!.lock(), plain.streams.getTexture(name)!.lock(), name);
  }
});

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<BufferSource>({ start(c) { c.enqueue(bytes as Uint8Array<ArrayBuffer>); c.close(); } });
  return new Uint8Array(await new Response(stream.pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

/** A v2 file of random codes, every byte value included; raw and gzipped.
 *  Only a fixture: its attribute bytes go into the v4 files below. */
async function randomSpz(n: number, shDegree: number): Promise<[Uint8Array, Uint8Array]> {
  let seed = 5 + shDegree;
  const bytes = (k: number) => Uint8Array.from({ length: k }, (_, i) => (i < 256 ? i : (seed = (seed * 16807) % 2147483647) & 0xff));
  const shDim = [0, 3, 8, 15][shDegree];
  const raw = await serializePackedGaussians({
    numPoints: n, shDegree, fractionalBits: 12, antialiased: false,
    positions: bytes(n * 9), alphas: bytes(n), colors: bytes(n * 3), scales: bytes(n * 3), rotations: bytes(n * 3), sh: bytes(n * shDim * 3),
  });
  return [raw, await gzip(raw)];
}

/** `bytes` as a stream of uneven chunks, as a cache or network read delivers. */
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      const size = at === 0 ? 5 : 4093;
      c.enqueue(bytes.slice(at, at += size));
    },
  });
}

it('refuses anything but version 4, naming what it got', async () => {
  const [raw, gz] = await randomSpz(100, 0);
  await assert.rejects(decodeSpzQuantized(chunked(gz)), /gzipped SPZ \(version 1-3\); only version 4/);
  await assert.rejects(decodeSpzQuantized(chunked(raw)), /SPZ version 2; only version 4/);
  await assert.rejects(decodeSpzQuantized(chunked(new TextEncoder().encode('<html>'))), /not an SPZ/);
});

/**
 * The same attribute bytes in a VERSION 4 container: a plaintext header, a
 * table of contents, and one ZSTD stream each, written here rather than
 * recorded because no library in this repo writes one.
 *
 * `CompressionStream` has no zstd (which is the whole reason `zstddec` is a
 * dependency), so the frames are single raw blocks assembled by hand. zstddec
 * reads them as it reads the provider's, and that is what this is for.
 */
function buildV4(attrs: Uint8Array[], numPoints: number, shDegree = 0): Uint8Array {
  const frames = attrs.map((bytes) => {
    // Magic, a single-segment frame header with a 4-byte content size, then
    // raw blocks of at most 128 KB.
    const n = bytes.length;
    const out: number[] = [0x28, 0xb5, 0x2f, 0xfd, 0xa0, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
    for (let at = 0; at < bytes.length || at === 0;) {
      const size = Math.min(bytes.length - at, 0x1ffff);
      const last = at + size >= bytes.length ? 1 : 0;
      const header = last | (0 << 1) | (size << 3);
      out.push(header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff);
      for (let i = 0; i < size; i++) out.push(bytes[at + i]);
      at += size;
      if (last) break;
    }
    return Uint8Array.from(out);
  });

  const head = new Uint8Array(32);
  const view = new DataView(head.buffer);
  view.setUint32(0, 0x5053474e, true);
  view.setUint32(4, 4, true);
  view.setUint32(8, numPoints, true);
  head[12] = shDegree;
  head[13] = 12;
  head[14] = 0;
  head[15] = attrs.length;
  view.setUint32(16, 32, true);

  const toc = new Uint8Array(attrs.length * 16);
  const tocView = new DataView(toc.buffer);
  attrs.forEach((bytes, i) => {
    tocView.setBigUint64(i * 16, BigInt(frames[i].byteLength), true);
    tocView.setBigUint64(i * 16 + 8, BigInt(bytes.byteLength), true);
  });

  const total = head.length + toc.length + frames.reduce((n, f) => n + f.byteLength, 0);
  const file = new Uint8Array(total);
  let at = 0;
  for (const part of [head, toc, ...frames]) {
    file.set(part, at);
    at += part.byteLength;
  }
  return file;
}

/**
 * Smallest-three, PACKED: the 2-bit index of the dropped component, then the
 * other three in index order, each a sign bit and nine bits of magnitude over
 * sqrt(1/2).
 *
 * The input has to be a REAL quaternion and cannot be arbitrary bytes, which
 * is worth stating because arbitrary bytes look like they would do: three
 * components of up to sqrt(1/2) can square to 1.5, so random codes decode to
 * something half a unit long and no encoder ever emits them.
 */
function packRotation(q: number[]): number[] {
  let largest = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(q[i]) > Math.abs(q[largest])) largest = i;
  const sign = q[largest] < 0 ? -1 : 1;
  let bits = largest << 30;
  let shift = 20;
  for (let i = 0; i < 4; i++) {
    if (i === largest) continue;
    const v = q[i] * sign;
    const mag = Math.min(Math.round((Math.abs(v) / Math.SQRT1_2) * 511), 511);
    bits |= ((v < 0 ? 0x200 : 0) | mag) << shift;
    shift -= 10;
  }
  return [bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff];
}

/** {@link randomSpz}'s v2 bytes in a v4 container, with real rotations. */
async function randomV4(n: number, shDegree = 0) {
  const [raw, gz] = await randomSpz(n, shDegree);
  const shDim = [0, 3, 8, 15][shDegree];
  const slice = (from: number, to: number) => raw.subarray(16 + n * from, 16 + n * to);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1;
  const quats = Array.from({ length: n }, () => {
    const q = [rnd(), rnd(), rnd(), rnd()];
    const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return q.map((v) => v / len);
  });
  const rotations = Uint8Array.from(quats.flatMap(packRotation));
  const sh = shDim ? [slice(19, 19 + shDim * 3)] : [];
  const attrs = [slice(0, 9), slice(9, 10), slice(10, 13), slice(13, 16), rotations, ...sh];
  const v4 = buildV4(attrs, n, shDegree);
  return { v4, gz, quats, attrs };
}

it('decodes a version 4 file through zstd, as the version 2 of it', async () => {
  // THE CONTAINER IS ALMOST THE ONLY DIFFERENCE. Positions, alphas, colours
  // and scales are packed identically in both versions, so identical bytes
  // through two containers - one gzip stream against five zstd ones - must
  // give identical numbers, and anything else is this engine misreading the
  // provider's format rather than a disagreement about what a byte means.
  //
  // ROTATIONS ARE THE EXCEPTION and are checked differently: version 3
  // replaced version 2's three signed bytes with SMALLEST-THREE in four, so
  // there is nothing to reuse. They are round-tripped through {@link
  // packRotation} instead, which is the inverse operation written separately
  // from the one it checks.
  const n = 3_000;
  const { v4, gz, quats } = await randomV4(n);

  const got = await readSpz(v4);
  const want = (await loadSpz(gz))!;
  assert.equal(got.numPoints, want.numPoints);
  for (const key of ['positions', 'alphas', 'colors', 'scales'] as const) {
    assert.deepEqual(got[key], want[key], key);
  }
  for (let i = 0; i < n; i++) {
    const q = got.rotations.subarray(i * 4, i * 4 + 4);
    const norm = Math.hypot(q[0], q[1], q[2], q[3]);
    assert.ok(Math.abs(norm - 1) < 1e-6, `splat ${i} is not a unit quaternion: ${norm}`);
    // The dropped component comes back positive, so a quaternion packed from
    // a negative largest is the same rotation with every sign flipped.
    const flip = quats[i][quats[i].reduce((b, v, k) => (Math.abs(v) > Math.abs(quats[i][b]) ? k : b), 0)] < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) {
      assert.ok(
        Math.abs(q[k] - quats[i][k] * flip) < 2e-3,
        `splat ${i} component ${k}: ${q[k]} not ${quats[i][k] * flip}`,
      );
    }
  }
});

it('leaves a version 4 file it cannot read to the general path', async () => {
  const { v4 } = await randomV4(100);
  const bad = v4.slice();
  bad[15] = 6;
  await assert.rejects(decodeSpzQuantized(chunked(bad)), /streams/);
});

it('leaves a truncated, overlong or mis-sized version 4 stream to the general path', async () => {
  const { v4 } = await randomV4(3_000);
  // Cut inside the last stream: the general path names it.
  await assert.rejects(decodeSpzQuantized(chunked(v4.subarray(0, v4.length - 100))), /rotations stream runs past the end/);
  // Trailing bytes are the general path's to read.
  const long = new Uint8Array(v4.length + 7);
  long.set(v4);
  assert.deepEqual(await decodeSpzQuantized(chunked(long)), decodeCloud(await readSpz(long)));
  // A compressed size no zstd stream can have is refused, not allocated.
  const huge = v4.slice();
  new DataView(huge.buffer).setBigUint64(32, 1n << 60n, true);
  await assert.rejects(decodeSpzQuantized(chunked(huge)), /positions stream runs past the end/);
});

for (const shDegree of [0, 2]) {
  it(`keeps a version 4 file quantized, read in chunks, with the general path's splats (SH ${shDegree})`, async () => {
    const { v4 } = await randomV4(3_000, shDegree);
    const want = decodeCloud(await readSpz(v4));
    const got = await decodeSpzQuantized(chunked(v4));
    assert.ok(isQuantized(got));
    const data = new QuantizedGSplatData(got);
    for (const p of want.properties) assert.deepEqual(data.getProp(p.name), p.storage, p.name);
    assert.equal(data.shBands, shDegree);
    assert.deepEqual(data.getCenters(), want.packed.centers);
    assert.deepEqual(got.aabb, want.packed.aabb);
  });

  it(`uploads the textures PlayCanvas's own SPZ resource does (SH ${shDegree})`, async () => {
    const n = 3_000;
    const { v4, attrs } = await randomV4(n, shDegree);
    const device = new NullGraphicsDevice({} as HTMLCanvasElement);
    const q = (await decodeSpzQuantized(chunked(v4))) as QuantizedSpz;
    const ours = new QuantizedSpzResource(device, new QuantizedGSplatData(q));
    const [positions, alphas, colors, scales, rotations, sh] = attrs;
    const theirs = new GSplatSpzResource(device, {
      numSplats: n, fractionalBits: 12, shBands: shDegree, shDim: [0, 3, 8, 15][shDegree], antialiased: false,
      positions, alphas, colors, scales, rotations, sh: sh ?? null,
      getCenters: () => new Float32Array(n * 3), calcAabb: () => {},
    });
    const names = ['packedTexture', 'colorTexture', ...Array.from({ length: ours.streams.textures.size - 2 }, (_, t) => `shTexture${t}`)];
    // One row per splat across every texture, sorted: the same splats in any order.
    const rows = (r: { streams: { getTexture(name: string): unknown } }) => {
      // Four words a splat, but one for the RGBA8 colour.
      const data = names.map((name) => {
        const d = (r.streams.getTexture(name) as { lock(): Uint8Array | Uint32Array }).lock();
        return name === 'colorTexture' ? [new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2), 1] as const : [d as Uint32Array, 4] as const;
      });
      return Array.from({ length: n }, (_, i) => data.flatMap(([d, k]) => Array.from(d.subarray(i * k, i * k + k))).join(',')).sort();
    };
    assert.equal(ours.streams.textures.size, theirs.streams.textures.size);
    assert.deepEqual(rows(ours), rows(theirs));
  });
}

it('drops a quantized resource\'s texture copies and uploads the same bytes again', async () => {
  const { v4 } = await randomV4(3_000, 2);
  const device = new NullGraphicsDevice({} as HTMLCanvasElement);
  const resource = new QuantizedSpzResource(device, new QuantizedGSplatData((await decodeSpzQuantized(chunked(v4))) as QuantizedSpz));
  const names = [...resource.streams.textures.keys()];
  const before = names.map((name) => resource.streams.getTexture(name)!.lock().slice());
  names.forEach((name) => { (resource.streams.getTexture(name) as unknown as { _needsUpload: boolean })._needsUpload = false; });
  assert.equal(dropStreamCopies(resource), true);
  assert.ok(names.every((name) => (resource.streams.getTexture(name) as unknown as { _levels: unknown[] })._levels[0] === null));
  rebuildStreams(resource);
  assert.deepEqual(names.map((name) => resource.streams.getTexture(name)!.lock()), before);
});
