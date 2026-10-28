/**
 * Worker glue for the collider build, and nothing else.
 *
 * The build is in `./collider-grid`, which imports nothing outside this source
 * tree and touches no PlayCanvas type - that is what makes it runnable here.
 * This file exists only to keep a few hundred milliseconds of voxelization off
 * the main thread and to hand the grid back with its buffer TRANSFERRED rather
 * than copied.
 *
 * The module URL is load-bearing: `environment-collider.ts` constructs the
 * Worker from `new URL('./collider-worker.ts', import.meta.url)`, so this path
 * has to stay put. `build.mjs` rewrites that literal's extension for the
 * published build and fails if it stops matching.
 */

import { buildColliderData } from './collider-grid';
import type { ColliderFrame, ColliderTuning, ColliderWalker, SceneColliderData } from './collider-grid';

/** What `environment-collider.ts` posts in. The two arrays are transferred. */
export interface ColliderWorkerRequest {
  positions: Float32Array;
  alpha: Float32Array | null;
  frame: ColliderFrame;
  tuning: Partial<ColliderTuning>;
  /** The walker the build is seeded from; see `buildColliderData`. */
  walker?: ColliderWalker | null;
}

/** What comes back. `data` is null when there was nothing to collide with. */
export type ColliderWorkerResponse =
  | { ok: true; data: SceneColliderData | null }
  | { ok: false; error: string };

self.onmessage = (e: MessageEvent) => {
  const req = e.data as ColliderWorkerRequest;
  try {
    const data = buildColliderData(
      { positions: req.positions, alpha: req.alpha },
      req.frame,
      req.tuning,
      req.walker ?? null,
    );
    const response: ColliderWorkerResponse = { ok: true, data };
    (self as unknown as Worker).postMessage(
      response,
      data ? [data.occupancy.buffer] : [],
    );
  } catch (err) {
    const response: ColliderWorkerResponse = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
