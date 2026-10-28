/**
 * spz-read.ts
 *
 * The decompression half of {@link spz-format.ts}, on a browser.
 *
 * ── Why there is a library here and not in node ─────────────────────────
 *
 * An SPZ version 4 - which is what the scene provider writes now - compresses
 * each attribute with ZSTD. A browser has `DecompressionStream`, which does
 * gzip and deflate and not that: Chrome accepts zstd as a *Content-Encoding*,
 * which is a different thing and not reachable from script, and Safari has
 * neither. So the one format this fleet cannot avoid is the one the platform
 * does not decompress, and `zstddec` (the reference zstd decoder as WASM)
 * fills the gap - ~10x faster than the pure-JS fzstd it replaced.
 *
 * ── Why gzip still goes through the platform ────────────────────────────
 *
 * `SpzInflate` asks for gzip too, for the versions before 4 that the shared
 * `spz-format.ts` still opens (the PLY export and the opacity scan read through
 * it). `DecompressionStream` reads those natively, so they add no library.
 * The viewer's own decode (`spz-decode.ts`) reads version 4 only.
 */

import { ZSTDDecoder } from 'zstddec';

import type { SpzCloud, SpzInflate } from './spz-format';
import { decodeSpz } from './spz-format';

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('gzip') as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let zstd: Promise<ZSTDDecoder> | null = null;

function zstdDecoder(): Promise<ZSTDDecoder> {
  if (!zstd) {
    const decoder = new ZSTDDecoder();
    zstd = decoder.init().then(() => decoder);
    // A failed init is retried by the next file rather than cached.
    zstd.catch(() => { zstd = null; });
  }
  return zstd;
}

/**
 * `SpzInflate` for a browser.
 *
 * `size` comes from the file's own table of contents, already checked against
 * the header's point count, so the output is allocated once. `spz-format.ts`
 * re-checks the inflated length, which is what refuses a bad stream: zstddec
 * returns an empty array rather than throwing.
 */
export const browserInflate: SpzInflate = {
  zstd: async (bytes, size) => (await zstdDecoder()).decode(bytes, size),
  gzip: async (bytes) => gunzip(bytes),
};

/**
 * An `.spz` of any version this engine reads, decoded into its cloud.
 *
 * THIS REPLACED spz-js's `loadSpz` AT EVERY CALL SITE, and the two are
 * interchangeable by design: `SpzCloud` is field-for-field `GaussianCloud`, so
 * `serializePly` and everything else spz-js still does keeps working on the
 * result. What changed is the range of files that get this far - spz-js reads
 * a gzipped version 2 and nothing else, and refuses the provider's version 4
 * as a decompression error rather than as a version.
 */
export async function readSpz(bytes: Uint8Array): Promise<SpzCloud> {
  return decodeSpz(bytes, browserInflate);
}
