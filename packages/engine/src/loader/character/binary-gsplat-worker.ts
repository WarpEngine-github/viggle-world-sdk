/**
 * Worker glue for the character-bundle reader, and nothing else.
 *
 * The decoders live in `./character`: `parseCharacterBundle` takes one branch
 * on the 8-byte magic and, for `VIGGCHAR`, looks the payload version up in a
 * table. None of that needs a Worker, and none of it is here - this file exists
 * only to keep the decode off the main thread and to hand the result back with
 * its buffers transferred rather than copied.
 *
 * The module URL is load-bearing: `binary-gsplat.ts` constructs the Worker from
 * `new URL('./binary-gsplat-worker.ts', import.meta.url)`, so the bundler needs
 * this path to stay put.
 */

import { parseCharacterBundle } from './index';
import { CharacterBundleError } from './types';

self.onmessage = (e: MessageEvent) => {
  // The worker is shared across loads; the id lets the caller match replies.
  const { id, buffer } = e.data as { id: number; buffer: ArrayBuffer };
  // The result is a promise because a handler MAY need to be one: the legacy
  // planar reader inflates its planes before it can decode them. The version 1
  // path is straight-line and never yields.
  parseCharacterBundle(buffer)
    .then(({ result, transferables }) => {
      (self as unknown as Worker).postMessage({ id, ok: true, ...result }, transferables);
    })
    .catch((err: unknown) => {
      // The category rides along with the message so the main thread can tell
      // "not our file" from "our file, broken" without re-reading the bytes.
      (self as unknown as Worker).postMessage({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        category: err instanceof CharacterBundleError ? err.category : undefined,
      });
    });
};
