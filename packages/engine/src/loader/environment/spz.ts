/**
 * spz.ts
 *
 * `.spz` captures, read into the arrays PlayCanvas renders from.
 *
 * This used to go the long way round. `loadSpz` then `serializePly` built an
 * uncompressed float PLY and handed it to PlayCanvas's `PlyParser`, which
 * re-read and re-parsed it back into the same numbers that went in. On a
 * 524,288-splat capture - 8.64 MB on the wire, 35.65 MB once serialised -
 * that round trip measured ~90 ms of a ~250 ms decode at 1x CPU and ~430 ms
 * at 4x, plus 71 MB of allocation (the blob AND the 17 Float32Arrays the
 * parser filled from it) and the GC behind that. It bought nothing:
 * `serializePly` writes exactly the properties `readFloatPly` reads back out.
 *
 * So {@link spzToGsplatData} builds the `GSplatData` straight from what
 * `loadSpz` returns. The character path has always worked this way
 * (`buildLoadResult` -> `new GSplatResource(device, gsplatData)`); this is the
 * environment catching up to it.
 *
 * The CPU-side shuffling (unpack, de-interleave, Morton order) lives in
 * `spz-decode.ts` and runs in `spz-worker.ts`, off the main thread.
 */

import type { BoundingBox, GraphicsDevice } from 'playcanvas';
import { GSplatData, GSplatFormat, GSplatResource, GSplatResourceBase, PIXELFORMAT_RGBA32U, PIXELFORMAT_RGBA8 } from 'playcanvas';
import { serializePly } from 'spz-js';

import type { AssetSource } from '../shared/asset-source';
import { cacheKeyFor, cachedFetch } from '../shared/bin-cache';
import { createReadSource } from '../shared/asset-source';
import { copyInto } from '../shared/fast-transform-pack';
import type { DecodedSpz, PackedSplat } from './spz-decode';
import { decodeSpzQuantized, spzToProperties } from './spz-decode';
import type { SpzCloud } from './spz-format';
import type { QuantizedSpz } from './spz-quantized';
import { isQuantized, quantizedProperty } from './spz-quantized';
import { SPZ_READ_GLSL, SPZ_READ_WGSL } from './spz-quantized-shader';
import { readSpz } from './spz-read';

/**
 * Split an `SpzCloud` into a `GSplatData`, unordered. The conventions it
 * encodes are documented on {@link spzToProperties}.
 */
export function spzToGsplatData(cloud: SpzCloud): GSplatData {
  return new GSplatData([{ name: 'vertex', count: cloud.numPoints, properties: spzToProperties(cloud) }]);
}

// One worker shared by every load, as in `binary-gsplat.ts`: a 1M-splat
// unpack + Morton order is ~1 s of main thread on a phone otherwise.
type Decoded = QuantizedSpz | DecodedSpz;
type Pending = { resolve: (v: Decoded) => void; reject: (e: unknown) => void };
let sharedWorker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, Pending>();

function spawnWorker(): Worker {
  // Inline literal on purpose; see `spawnWorker` in `binary-gsplat.ts`.
  const worker = new Worker(
    new URL('./spz-worker.ts', import.meta.url),
    { type: 'module', name: 'spz-decode' },
  );
  worker.onmessage = (e: MessageEvent) => {
    const entry = pending.get(e.data.id);
    if (!entry) return;
    pending.delete(e.data.id);
    if (e.data.ok) entry.resolve(e.data.decoded);
    else entry.reject(new Error(e.data.error));
  };
  worker.onerror = (err) => {
    worker.terminate();
    if (sharedWorker === worker) sharedWorker = null;
    const detail = (err as ErrorEvent)?.message;
    const failure = new Error(`SPZ decode worker failed${detail ? `: ${detail}` : ''}`);
    const failed = [...pending.values()];
    pending.clear();
    failed.forEach((p) => p.reject(failure));
  };
  return worker;
}

/** Post the file to the worker chunk by chunk as it is read, so the worker
 *  inflates while the rest is still coming off the cache or the network. */
function decodeInWorker(file: ReadableStream<Uint8Array>): Promise<Decoded> {
  if (typeof Worker === 'undefined') return decodeSpzQuantized(file);
  sharedWorker ??= spawnWorker();
  const worker = sharedWorker;
  const id = nextRequestId++;
  const decoded = new Promise<Decoded>((resolve, reject) => pending.set(id, { resolve, reject }));
  void (async () => {
    try {
      for (const reader = file.getReader(); ;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Always a copy: a cloned response (bin-cache's shared download) can hold these
        // same chunks, and transferring them in place truncates that copy (Firefox).
        const chunk = value.slice();
        worker.postMessage({ id, chunk }, [chunk.buffer]);
      }
      worker.postMessage({ id, done: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      worker.postMessage({ id, error: message });
      const entry = pending.get(id);
      pending.delete(id);
      entry?.reject(err);
    }
  })();
  return decoded;
}

/** Splat data carrying the worker's {@link PackedSplat}. Each piece is used
 *  once, by the resource constructor (`fast-transform-pack.ts` copies the
 *  textures in); later calls get PlayCanvas's own code. */
export class PackedGSplatData extends GSplatData {
  packed: Partial<PackedSplat>;

  constructor({ count, properties, packed }: DecodedSpz) {
    super([{ name: 'vertex', count, properties }]);
    this.packed = packed;
  }

  getCenters(): Float32Array {
    const { centers } = this.packed;
    if (!centers) return super.getCenters();
    this.packed.centers = undefined;
    return centers;
  }

  calcAabb(result: BoundingBox, pred?: (i: number) => boolean): boolean {
    const { aabb } = this.packed;
    if (pred || !aabb) return super.calcAabb(result, pred);
    this.packed.aabb = undefined;
    result.center.set(aabb[0], aabb[1], aabb[2]);
    result.halfExtents.set(aabb[3], aabb[4], aabb[5]);
    return true;
  }
}

async function fetchAndDecode(assetSource: AssetSource): Promise<Decoded> {
  const { contents, url } = assetSource;
  if (contents || !url) {
    const buffer = await (await createReadSource(assetSource)).arrayBuffer();
    return decodeInWorker(new Blob([buffer]).stream());
  }
  // Spawn first so the worker's module load overlaps the fetch, which may wait out a whole shared download.
  if (typeof Worker !== 'undefined') sharedWorker ??= spawnWorker();
  const res = await cachedFetch(url);
  if (!res.ok) throw new Error(`Failed to fetch asset: ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error('Response has no body');
  return decodeInWorker(res.body);
}

// One decode started ahead of the engine; a newer one replaces it.
let early: { key: string; decoded: Promise<Decoded> } | null = null;

/**
 * Start fetching and decoding an `.spz` before the engine asks for it, so the
 * worker runs while the viewer is still being built. `loadSpzGsplatData` takes
 * the result if it asks for the same file next. Returns a release for a
 * caller that no longer wants it held.
 */
export function predecodeSpz(url: string): () => void {
  const key = cacheKeyFor(url);
  if (early?.key !== key) {
    const decoded = fetchAndDecode({ url });
    // A failed early decode is retried by the real load, which reports it.
    decoded.catch(() => {});
    early = { key, decoded };
  }
  const entry = early;
  return () => { if (early === entry) early = null; };
}

/** Read an `.spz` into Morton-ordered splat data, ready for {@link createSpzResource}. */
export async function loadSpzGsplatData(
  assetSource: AssetSource,
): Promise<GSplatData> {
  const entry = !assetSource.contents && assetSource.url && early?.key === cacheKeyFor(assetSource.url) ? early : null;
  if (entry) early = null;
  const decoded = (entry && await entry.decoded.catch(() => null)) || await fetchAndDecode(assetSource);
  return isQuantized(decoded) ? new QuantizedGSplatData(decoded) : new PackedGSplatData(decoded);
}

/** The resource for {@link loadSpzGsplatData}'s splats. */
export function createSpzResource(device: GraphicsDevice, gsplatData: GSplatData): GSplatResourceBase {
  return gsplatData instanceof QuantizedGSplatData
    ? new QuantizedSpzResource(device, gsplatData)
    : new GSplatResource(device, gsplatData);
}

const SH_BANDS: Record<number, number> = { 0: 0, 3: 1, 8: 2, 15: 3 };

/**
 * Splat data kept quantized (`spz-quantized.ts`). The float properties are
 * there by name but decoded on first read, so a load that only renders never
 * builds them.
 */
export class QuantizedGSplatData extends GSplatData {
  readonly quantized: QuantizedSpz;
  private centersTaken = false;

  constructor(quantized: QuantizedSpz) {
    const { floats } = quantized;
    const names = [
      'x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2',
      ...Array.from({ length: quantized.shDim * 3 }, (_, k) => `f_rest_${k}`),
      'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    ];
    const properties = names.map((name) => ({
      type: 'float', name, byteSize: 4,
      get storage(): Float32Array {
        let storage = floats.get(name);
        if (!storage) {
          storage = quantizedProperty(quantized, name);
          floats.set(name, storage);
        }
        return storage;
      },
      set storage(storage: Float32Array) { floats.set(name, storage); },
    }));
    super([{ name: 'vertex', count: quantized.count, properties }]);
    this.quantized = quantized;
  }

  get shBands(): number {
    return SH_BANDS[this.quantized.shDim];
  }

  getCenters(): Float32Array {
    if (this.centersTaken) return super.getCenters();
    this.centersTaken = true;
    return this.quantized.centers;
  }

  calcAabb(result: BoundingBox, pred?: (i: number) => boolean): boolean {
    const { aabb } = this.quantized;
    if (pred || !aabb) return super.calcAabb(result, pred);
    result.center.set(aabb[0], aabb[1], aabb[2]);
    result.halfExtents.set(aabb[3], aabb[4], aabb[5]);
    return true;
  }
}

/** PlayCanvas's quantized SPZ resource (its `GSplatSpzResource`), filled from the worker's arrays. */
export class QuantizedSpzResource extends GSplatResourceBase {
  constructor(device: GraphicsDevice, gsplatData: QuantizedGSplatData) {
    super(device, gsplatData);
    const q = gsplatData.quantized;
    this._format = new GSplatFormat(device, [
      { name: 'packedTexture', format: PIXELFORMAT_RGBA32U },
      { name: 'colorTexture', format: PIXELFORMAT_RGBA8 },
      ...q.sh.map((_, t) => ({ name: `shTexture${t}`, format: PIXELFORMAT_RGBA32U })),
    ], { readGLSL: SPZ_READ_GLSL, readWGSL: SPZ_READ_WGSL });
    this.streams.init(this.format, q.count);
    this.parameters.set('spzPositionScale', 1 / (1 << q.fractionalBits));
    this.refillStreams();
  }

  /** Upload the splats again, from the arrays the data keeps (`texture-cpu-copy.ts`). */
  refillStreams(): void {
    const q = (this.gsplatData as QuantizedGSplatData).quantized;
    copyInto(this.streams.getTexture('packedTexture'), q.packed);
    copyInto(this.streams.getTexture('colorTexture'), q.color);
    q.sh.forEach((words, t) => copyInto(this.streams.getTexture(`shTexture${t}`), words));
  }

  configureMaterialDefines(defines: Map<string, string | number | boolean>): void {
    defines.set('SH_BANDS', (this.gsplatData as QuantizedGSplatData).shBands);
  }
}

/**
 * Convert an `.spz` to an uncompressed PLY blob.
 *
 * NOT the viewer's path any more - {@link loadSpzGsplatData} is, and this
 * round trip is why. It stays for the scene PLY export, where a file in a
 * format other tools open IS the deliverable, and where one 35 MB blob built
 * off the main thread's critical path costs nobody a dropped frame.
 */
export async function convertSpzToPlyBlob(assetSource: AssetSource): Promise<Blob> {
  const source = await createReadSource(assetSource);
  const spzBuffer = await source.arrayBuffer();
  // READ BY `spz-read.ts` AND WRITTEN BY spz-js, which is the whole of why
  // that dependency is still here: it cannot open the provider's version 4,
  // and `SpzCloud` is field-for-field the `GaussianCloud` its writer takes.
  const plyBuffer = serializePly(await readSpz(new Uint8Array(spzBuffer)));
  return new Blob([plyBuffer], { type: 'application/octet-stream' });
}

