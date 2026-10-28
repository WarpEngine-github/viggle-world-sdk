/**
 * Worker glue for the decompressed `.sog` decode (see `sog-decode.ts`). The
 * module URL is load-bearing: `fast-sog-decompress.ts` constructs the Worker
 * from `new URL('./sog-worker.ts', import.meta.url)`.
 */

import { decodeSog } from './sog-decode';
import type { SogPixels } from './sog-decode';

self.onmessage = (e: MessageEvent) => {
  const { id, input } = e.data as { id: number; input: SogPixels };
  try {
    const decoded = decodeSog(input);
    const { color, transformA, transformB, centers } = decoded.packed;
    // The pixels go back too: left here they are garbage an idle worker never collects.
    const pixels = [input.means_l, input.means_u, input.quats, input.scales, input.sh0, input.sh_labels, input.sh_centroids]
      .flatMap((p) => (p ? [p.buffer as ArrayBuffer] : []));
    const transfer = [...decoded.properties.map((p) => p.storage.buffer), color.buffer, transformA.buffer, transformB.buffer, centers.buffer, ...pixels];
    (self as unknown as Worker).postMessage({ id, ok: true, decoded }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
