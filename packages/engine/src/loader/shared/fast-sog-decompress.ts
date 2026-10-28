import { GSplatSogData } from 'playcanvas';
import type { GSplatData, Texture } from 'playcanvas';

import type { DecodedSpz } from '../environment/spz-decode';
import { PackedGSplatData } from '../environment/spz';
import type { SogMeta, SogPixels } from './sog-decode';
import { decodeSog } from './sog-decode';

/*
 * `GSplatSogData.decompress` (our environments load .sog decompressed, for the
 * CPU-side splats) and the `GSplatResource` PlayCanvas then builds from it are
 * one long main-thread task. PlayCanvas still unzips, decodes and uploads the
 * images; this reads them back and hands the pixels to `sog-worker.ts`, which
 * returns the splat properties plus the resource's packed textures, centres
 * and bounds. The main thread only copies those in (fast-transform-pack.ts).
 * Bit-identical to PlayCanvas's path (fast-sog-decompress.test.ts).
 */

/** The fields of a `GSplatSogData` this reads (several are untyped or private in PlayCanvas's typings). */
type SogData = {
  meta: SogMeta;
  numSplats: number;
  shBands: number;
  means_l: Texture; means_u: Texture; quats: Texture; scales: Texture; sh0: Texture;
  sh_labels: Texture; sh_centroids: Texture;
  _patchCodebooks(): void;
};

/** PlayCanvas's `readImageDataAsync`. */
function readPixels(texture: Texture): Promise<Uint8Array> {
  if (texture.device.isNull) return Promise.resolve(new Uint8Array(texture.width * texture.height * 4));
  return texture.read(0, 0, texture.width, texture.height, { mipLevel: 0, face: 0, immediate: true }) as Promise<Uint8Array>;
}

// One worker shared by every load, as in `spz.ts`.
type Pending = { resolve: (v: DecodedSpz) => void; reject: (e: unknown) => void };
let sharedWorker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, Pending>();

function spawnWorker(): Worker {
  // Inline literal on purpose; see `spawnWorker` in `binary-gsplat.ts`.
  const worker = new Worker(
    new URL('./sog-worker.ts', import.meta.url),
    { type: 'module', name: 'sog-decode' },
  );
  worker.onmessage = (e: MessageEvent) => {
    const entry = pending.get(e.data.id);
    if (!entry) return;
    pending.delete(e.data.id);
    if (e.data.ok) entry.resolve(e.data.decoded);
    else entry.reject(new Error(e.data.error));
  };
  const fail = (detail: string | undefined) => {
    worker.terminate();
    if (sharedWorker === worker) sharedWorker = null;
    const failure = new Error(`SOG decode worker failed${detail ? `: ${detail}` : ''}`);
    const failed = [...pending.values()];
    pending.clear();
    failed.forEach((p) => p.reject(failure));
  };
  worker.onerror = (err) => fail(err?.message);
  // A reply that can't be deserialized names no request, so it fails them all too.
  worker.onmessageerror = () => fail('a reply could not be read');
  return worker;
}

function decodeInWorker(input: SogPixels): Promise<DecodedSpz> {
  if (typeof Worker === 'undefined') return Promise.resolve(decodeSog(input));
  sharedWorker ??= spawnWorker();
  const id = nextRequestId++;
  const decoded = new Promise<DecodedSpz>((resolve, reject) => pending.set(id, { resolve, reject }));
  const pixels = [input.means_l, input.means_u, input.quats, input.scales, input.sh0, input.sh_labels, input.sh_centroids];
  // Transfer, not copy: nothing reads the readbacks after this.
  const transfer = pixels.flatMap((p) => (p && p.byteLength === p.buffer.byteLength ? [p.buffer as ArrayBuffer] : []));
  try {
    sharedWorker.postMessage({ id, input }, transfer);
  } catch (err) {
    pending.delete(id);
    throw err;
  }
  return decoded;
}

async function fastDecompress(this: SogData): Promise<GSplatData> {
  this._patchCodebooks();
  const { shBands, meta, numSplats } = this;
  const { means_l, means_u, quats, scales, sh0, sh_labels, sh_centroids } = this;
  // Read back together, not one after another: on WebGL each waits on its own fence poll.
  const textures = shBands > 0 ? [means_l, means_u, quats, scales, sh0, sh_labels, sh_centroids] : [means_l, means_u, quats, scales, sh0];
  const [ml, mu, q, s, c, labels, centroids] = await Promise.all(textures.map(readPixels));
  try {
    return new PackedGSplatData(await decodeInWorker({
      meta, count: numSplats, shBands,
      means_l: ml, means_u: mu, quats: q, scales: s, sh0: c,
      sh_labels: labels, sh_centroids: centroids, centroidsWidth: sh_centroids?.width ?? 0,
    }));
  } catch {
    // The worker didn't start (a stale chunk after a deploy, CSP) or died: the textures are still up.
    return original.call(this as unknown as GSplatSogData);
  }
}

// eslint-disable-next-line typescript/unbound-method -- handed back for a test to restore
const original = GSplatSogData.prototype.decompress;

/** Swap in the worker SOG decompress. Idempotent; returns PlayCanvas's. */
export function installFastSogDecompress(): typeof original {
  GSplatSogData.prototype.decompress = fastDecompress as unknown as typeof original;
  return original;
}
