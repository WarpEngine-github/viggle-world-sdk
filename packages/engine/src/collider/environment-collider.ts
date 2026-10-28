/**
 * The one call an app makes: an {@link Environment} in, a {@link SceneCollider}
 * out.
 *
 * Everything the feature does is behind this function - the sample, the opacity
 * filter, the walkable-band crop, the voxelization, the dilation, and the grid
 * the queries run on. A consumer configures and calls; it does not assemble a
 * pipeline, and it does not need to know that a voxelizer exists.
 *
 * ## Why it is async and the queries are not
 *
 * The build is a few hundred milliseconds on a city-scale capture, so it runs in
 * a Worker and this returns a Promise. The QUERIES are synchronous grid lookups
 * in microseconds, and a walk hits several of them every frame; making those
 * async would be a lie about their cost and would put a microtask in a movement
 * loop.
 *
 * The signature is the part that cannot change without breaking consumers, so it
 * is a Promise even where the work happens to run inline - which it does on a
 * platform with no `Worker`, and when `worker: false` asks for it.
 *
 * @module
 */

import type { Environment } from '../loader/environment';
import { maxAxisScale } from '../proxy/environment-source';

import { buildColliderData, clampColliderTuning } from './collider-grid';
import type { ColliderFrame, ColliderTuning, SceneColliderData } from './collider-grid';
import type { ColliderWorkerRequest, ColliderWorkerResponse } from './collider-worker';
import { SceneCollider } from './scene-collider';

/** Knobs, plus the two things that are about the call rather than the grid. */
export interface BuildSceneColliderOptions extends Partial<ColliderTuning> {
  /**
   * Run the voxelization in a Worker. Default `true`, and the only reason to
   * turn it off is a platform that has none or a test that wants the work on
   * its own thread. The promise resolves the same either way.
   */
  worker?: boolean;
}

/**
 * Sample an environment's splats and voxelize them into a walkable collider.
 *
 * @param env the environment to collide with. Its world transform is read now
 *   for the build AND on every later query, so moving or rescaling it scales the
 *   collider with it rather than invalidating it - see
 *   {@link SceneCollider.walkerFits} for the one exception.
 * @param options overrides on `DEFAULT_COLLIDER_TUNING`, all clamped into
 *   `COLLIDER_TUNING_LIMITS` on the way in, so a stale persisted setting can
 *   never reach the coarsen loop as a voxel size of zero.
 * @returns `null` when the capture has nothing to collide with: fewer than a
 *   hundred points survive the opacity threshold, or the walkable band is empty,
 *   or the grid came out with no solid cell. A caller should treat that as
 *   "this scene has no collider" and say so, not retry.
 * @throws when the environment carries no readable splat positions, or when the
 *   worker cannot be started.
 */
export async function buildSceneCollider(
  env: Environment,
  options: BuildSceneColliderOptions = {},
): Promise<SceneCollider | null> {
  const { worker = true, ...requested } = options;
  // Clamped HERE and not only inside the build, because `samplePoints` is spent
  // before the build ever sees it. A stale persisted 0 would otherwise sample
  // one splat and come back as "this capture has no collider".
  const tuning = clampColliderTuning(requested);
  const frame = environmentColliderFrame(env);
  const sample = env.sampleWorldSample(tuning.samplePoints);
  if (sample.positions.length === 0) {
    throw new Error(
      `[buildSceneCollider] ${env.entity.name}: the environment carries no CPU-side splat `
      + 'positions to sample. A streaming LOD bundle keeps none - build the collider from a '
      + 'monolithic capture, or from the bundle file itself.',
    );
  }

  const data = worker && typeof Worker !== 'undefined'
    ? await buildInWorker(sample.positions, sample.alpha, frame, tuning)
    : buildColliderData(sample, frame, tuning);

  if (!data) return null;
  // The frame source is LIVE: every query re-reads the entity's transform, so a
  // scale slider moves the collider with the splats and nothing has to be
  // rebuilt or invalidated.
  return SceneCollider.fromData(data, () => environmentColliderFrame(env));
}

/**
 * Where the environment sits, as the collider's grid space is defined against
 * it: its world position, and its largest axis scale as metres per local unit.
 *
 * The grid holds points that were sampled in WORLD space and then had this
 * position and scale divided out, so the environment's ROTATION is already baked
 * into them and no rotation appears here. Re-orienting a capture after the build
 * therefore does invalidate it; captures are not re-oriented at runtime, so that
 * is stated rather than guarded.
 *
 * Exported because a collider does not have to come from
 * {@link buildSceneCollider}: one deserialized from a file needs the same live
 * frame source to rescale with its environment, and a second hand-rolled copy of
 * this is a second thing to get out of step with the build.
 *
 * ```ts
 * const collider = SceneCollider.fromData(data, () => environmentColliderFrame(env));
 * ```
 */
export function environmentColliderFrame(env: Environment): ColliderFrame {
  const m = env.entity.getWorldTransform();
  const d = m.data;
  return { origin: { x: d[12], y: d[13], z: d[14] }, scale: maxAxisScale(m) };
}

/** Post the sample to a throwaway worker and wait for the grid. */
function buildInWorker(
  positions: Float32Array,
  alpha: Float32Array | null,
  frame: ColliderFrame,
  tuning: Partial<ColliderTuning>,
): Promise<SceneColliderData | null> {
  return new Promise((resolve, reject) => {
    // Two readers, two spellings, same bargain as the character decoder: this
    // is the SOURCE spelling and `build.mjs` swaps the extension for the
    // published build. Written inline because
    // `new Worker(new URL(<literal>, import.meta.url))` is a syntactic pattern
    // to Vite and webpack, not an expression they evaluate - hoist the URL into
    // a variable and neither one emits the worker.
    const w = new Worker(
      new URL('./collider-worker.ts', import.meta.url),
      { type: 'module', name: 'scene-collider' },
    );
    w.onmessage = (e: MessageEvent) => {
      w.terminate();
      const res = e.data as ColliderWorkerResponse;
      if (res.ok) resolve(res.data);
      else reject(new Error(`[buildSceneCollider] ${res.error}`));
    };
    w.onerror = (err) => {
      w.terminate();
      const detail = typeof err === 'string' ? err : (err as ErrorEvent)?.message;
      reject(new Error(
        `[buildSceneCollider] the collider worker failed to start${detail ? `: ${detail}` : ''}. `
        + 'It ships as a separate file next to the engine bundle; if your bundler moved the '
        + "bundle without re-emitting it, the URL no longer resolves. For Vite dev servers add "
        + "optimizeDeps: { exclude: ['@viggle/splat-engine'] }.",
      ));
    };
    const request: ColliderWorkerRequest = { positions, alpha, frame, tuning };
    // The sample was allocated for this call and nothing else reads it, so it
    // goes across transferred rather than copied - 2.4 MB at 200,000 points.
    const transfer: ArrayBuffer[] = [positions.buffer as ArrayBuffer];
    if (alpha) transfer.push(alpha.buffer as ArrayBuffer);
    w.postMessage(request, transfer);
  });
}
