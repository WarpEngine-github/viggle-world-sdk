/**
 * Worker glue for the `.spz` decode, and nothing else (see `spz-decode.ts`).
 * The module URL is load-bearing: `spz.ts` constructs the Worker from
 * `new URL('./spz-worker.ts', import.meta.url)`.
 *
 * A file arrives as `{ id, chunk }` messages ending in `{ id, done }` (or
 * `{ id, error }`), and is decoded as the chunks come in.
 */

import { decodeSpzQuantized } from './spz-decode';
import { isQuantized } from './spz-quantized';

const streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>();

function open(id: number): ReadableStreamDefaultController<Uint8Array> {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const file = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  decodeSpzQuantized(file)
    .then((decoded) => {
      const transfer = isQuantized(decoded)
        ? [
          decoded.packed.buffer, decoded.color.buffer, decoded.centers.buffer,
          ...decoded.sh.map((w) => w.buffer), ...[...decoded.floats.values()].map((f) => f.buffer),
        ]
        : [
          ...decoded.properties.map((p) => p.storage.buffer),
          decoded.packed.color.buffer, decoded.packed.transformA.buffer, decoded.packed.transformB.buffer, decoded.packed.centers.buffer,
        ];
      (self as unknown as Worker).postMessage({ id, ok: true, decoded }, transfer as ArrayBuffer[]);
    })
    .catch((err: unknown) => {
      (self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  streams.set(id, controller);
  return controller;
}

self.onmessage = (e: MessageEvent) => {
  const { id, chunk, done, error } = e.data as { id: number; chunk?: Uint8Array; done?: true; error?: string };
  const controller = streams.get(id) ?? open(id);
  if (chunk) controller.enqueue(chunk);
  if (done || error) {
    streams.delete(id);
    if (error) controller.error(new Error(error));
    else controller.close();
  }
};
