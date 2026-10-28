import type { ColliderFrame, Environment, SceneColliderData, WalkerCapsule } from '@viggle/splat-engine';
import {
  capsuleForWalker,
  COLLIDER_BAND_ABOVE_M,
  COLLIDER_BAND_BELOW_M,
  COLLIDER_SAMPLE_POINTS,
  minStepLimit,
  SceneCollider,
} from '@viggle/splat-engine';
import type { ColliderWorkerRequest, ColliderWorkerResponse } from '@viggle/splat-engine/collider/collider-worker.ts';
import { maxAxisScale } from '@viggle/splat-engine/proxy/environment-source.ts';

import type { FloorProbe, WalkerState, WallProbe } from '../walk/controller.js';

/**
 * Walk mode's walls: the engine's voxel collider, built in a worker around
 * the walker and rebuilt as she moves away from where it was built.
 *
 * The engine hangs its walkable band from the 5th percentile of the whole
 * sample, which is wrong wherever a scene keeps a lot of itself below the
 * floor. The walker's own floor is known here, so the sample is cropped to a
 * band and a radius around her first.
 *
 * The floor comes from the collider where its column has one below her, and
 * from the floor index where it does not: an empty column is a gap in the
 * capture (a sparse patch, or a drop deeper than the band), not a wall. Walls
 * come from the collider alone.
 */

/** Band kept above the walker's floor, in walker heights: room for her head
 *  on anything one jump and a step can put her on (0.55 + 0.25 heights), so
 *  a ceiling too low to stand there is in the grid. Never under the engine's
 *  3 m. */
const BAND_HEIGHTS = 2;

/** How far her feet may rise or fall from the floor a collider was built at
 *  before it is rebuilt around the new one; well inside the band both ways. */
const REBUILD_DRIFT = 0.5;

/** Horizontal radius of the scene kept around her, metres. Built whole, a big
 *  outdoor capture's grid coarsens until it has no floor detail left. */
const CROP_RADIUS = 15;

/** How far she may walk from where the collider was built before it is
 *  rebuilt around her; well inside the crop. */
const REBUILD_REACH = 6;

/** Points wanted inside the crop. The sample strides the whole file, so on a
 *  big scene few of its 200k land near her and it is taken again, denser. */
const CROP_POINTS = 200_000;

/** The densest sample taken, for the main-thread cost. */
const MAX_SAMPLE_POINTS = 2_000_000;

/** How far the collider's floor reads above the visible one, in voxels: the
 *  answer is a cell's TOP, and the build dilates by one cell. */
const FLOOR_BIAS_VOXELS = 1.5;

/** The floor is read from a disc this much narrower than her body, so she
 *  stands on an edge with her feet on it rather than hanging up to a full body
 *  radius off it. */
const FLOOR_READ_OF_RADIUS = 0.8;

/** What the walk knows about its ground before any collider exists. */
export interface WalkGround {
  /** The walker's height. */
  height: number;
  /** The walk's step limit; the capsule's feet clearance is measured from it. */
  stepLimit: number;
  /** The floor index, which answers wherever the collider has no floor. */
  floorIndexAt: (x: number, z: number, aperture: number, fromY: number, maxDrop: number) => number | null;
}

export interface WalkCollidersOptions {
  ground: WalkGround;
  /** The environment to collide with, or null for none (collider off, no
   *  scene). Read per call, so a scene swap rebuilds. */
  env: () => Environment | null;
  /** Where the walker is, or null before the session has one. */
  walker: () => WalkerState | null;
  /** Called once per environment, when its first collider finds her standing
   *  inside a wall, with where she was pushed out to. */
  onPushedOut?: (x: number, z: number) => void;
  /** True while the collider is only the follow camera's: the walk's floor
   *  and walls come from elsewhere (a host's own ground), so it answers
   *  neither and pushes no one out. Read per call. */
  cameraOnly?: () => boolean;
}

/**
 * One walk session's collider: builds it around the walker, rebuilds it as
 * she moves, and answers the walk's floor and wall queries from it. Dispose
 * with the session; the sample cache and the grid go with it.
 */
export class WalkColliders {
  readonly floorAt: FloorProbe;
  readonly walls: WallProbe;
  private readonly _opts: WalkCollidersOptions;
  private _entry: { env: Environment; revision: number; x: number; y: number; z: number; collider: SceneCollider | null; building: boolean } | null = null;
  /** Bumped whenever the collider answering changes. */
  private _generation = 0;
  /** The environment her one push-out has been spent on. */
  private _pushedOutOf: Environment | null = null;
  private _samples: SampleCache | null = { env: null, revision: 0, matrix: null, sample: null, count: 0 };

  constructor(opts: WalkCollidersOptions) {
    this._opts = opts;
    workerUsers++;
    const { ground } = opts;
    this.floorAt = (x, z, aperture, fromY) => this._floor(x, z, aperture, fromY, true);
    const cameraOnly = () => opts.cameraOnly?.() ?? false;
    const hasCollider = () => !cameraOnly() && this.colliderAt() !== null;
    const generation = () => this._generation;
    this.walls = {
      get active() { return hasCollider(); },
      get generation() { return generation(); },
      get bodyHeight() { return ground.height; },
      resolve: (x, z, y) => {
        const c = cameraOnly() ? null : this.colliderAt();
        return c ? c.resolve(x, z, y + bias(c), this._capsule(c)) : null;
      },
      overlap: (x, z, y, height) => {
        const c = cameraOnly() ? null : this.colliderAt();
        if (!c) return 0;
        const capsule = this._capsule(c);
        return c.overlap(x, z, y + bias(c), height === undefined ? capsule : { ...capsule, height });
      },
      groundAt: (x, z, aperture, fromY) => this._floor(x, z, aperture, fromY, false),
    };
  }

  /** The collider around the walker, starting a rebuild when she has moved
   *  away from the last one; the last one answers until it lands. */
  colliderAt(): SceneCollider | null {
    const env = this._opts.env();
    const samples = this._samples;
    if (!env || !samples) return null;
    const same = this._entry?.env === env ? this._entry : null;
    // A new revision is the rest of a split scene landing: rebuild from the whole sample, keeping the
    // old collider until the new one is ready.
    const have = same && same.revision === env.sampleRevision ? same : null;
    const at = this._opts.walker();
    // Not mid-air: a build around her apex would crop out the floor below,
    // and the floor index answers a fall deeper than the band.
    const near = have && at
      && Math.abs(at.y - have.y) < REBUILD_DRIFT
      && Math.hypot(at.x - have.x, at.z - have.z) < REBUILD_REACH;
    if (!at || at.airborne || same?.building || near) return same?.collider ?? null;

    const previous = same?.collider ?? null;
    const entry = { env, revision: env.sampleRevision, x: at.x, y: at.y, z: at.z, collider: previous, building: true };
    this._entry = entry;
    const { height, stepLimit } = this._opts.ground;
    buildWalkCollider(env, at, height, stepLimit, same?.y, samples).then(
      (collider) => {
        if (this._entry !== entry) return;
        entry.building = false;
        entry.collider = collider;
        this._generation++;
        if (collider) this._pushOutOnce(env, collider);
      },
      (e: unknown) => {
        if (this._entry === entry) entry.building = false;
        // eslint-disable-next-line no-console -- non-fatal: Walk keeps what it had
        console.warn('[walkCollider] build failed:', e);
      },
    );
    return previous;
  }

  /** What the walls answer from right now, for the debug overlay. Reads only:
   *  never starts a build, unlike {@link colliderAt}. `bias` lifts her feet to
   *  the height the collider is queried at. */
  debugView(): { collider: SceneCollider; capsule: WalkerCapsule; bias: number } | null {
    const collider = this.collider;
    return collider ? { collider, capsule: this._capsule(collider), bias: bias(collider) } : null;
  }

  /** The collider answering now, without starting a build. */
  get collider(): SceneCollider | null {
    const entry = this._entry;
    return entry && entry.env === this._opts.env() ? entry.collider : null;
  }

  dispose(): void {
    if (!this._samples) return;
    this._samples = null;
    this._entry = null;
    workerUsers--;
    releaseWorker();
  }

  /** Whether a first collider for this scene is on its way: asked for, not
   *  landed yet. False once a build lands, even empty, or fails. */
  get pending(): boolean {
    const env = this._opts.env();
    if (!env || !this._samples) return false;
    const entry = this._entry;
    return !entry || entry.env !== env || (entry.building && !entry.collider);
  }

  /** The visible floor under (x, z) looking down from `fromY`, from the
   *  collider alone (camera-only too): what a host stands other people on. */
  surfaceAt(x: number, z: number, fromY: number): number | null {
    const c = this.colliderAt();
    if (!c) return null;
    const ground = c.groundAt(x, z, fromY + bias(c), this._capsule(c).radius * FLOOR_READ_OF_RADIUS);
    return ground === null ? null : ground - bias(c);
  }

  private _capsule(c: SceneCollider): WalkerCapsule {
    const { height, stepLimit } = this._opts.ground;
    return capsuleForWalker(height, Math.max(stepLimit, minStepLimit(c.voxelMetres)), c.voxelMetres);
  }

  /** The visible floor under (x, z). With `bodyTest`, null where her body does
   *  not fit on the collider's floor (a wall). */
  private _floor(x: number, z: number, aperture: number, fromY: number, bodyTest: boolean): number | null {
    const c = this._opts.cameraOnly?.() ? null : this.colliderAt();
    if (c) {
      const capsule = this._capsule(c);
      const ground = c.groundAt(x, z, fromY, capsule.radius * FLOOR_READ_OF_RADIUS);
      if (ground !== null) {
        if (bodyTest && c.blocked(x, z, ground, capsule)) return null;
        return ground - bias(c);
      }
    }
    const { ground } = this._opts;
    return ground.floorIndexAt(x, z, aperture, fromY, ground.height * 3);
  }

  /** A spawn inside a wall, or inside the capture's own shell, can never step
   *  out; nudge her clear once, when walls first appear. */
  private _pushOutOnce(env: Environment, c: SceneCollider): void {
    if (this._pushedOutOf === env || this._opts.cameraOnly?.()) return;
    this._pushedOutOf = env;
    const at = this._opts.walker();
    if (!at) return;
    const capsule = this._capsule(c);
    const y = at.y + bias(c);
    if (c.overlap(at.x, at.z, y, capsule) === 0) return;
    const out = c.pushOut(at.x, at.z, y, capsule);
    if (out.x !== at.x || out.z !== at.z) this._opts.onPushedOut?.(out.x, out.z);
  }
}

function bias(c: SceneCollider): number {
  return c.voxelMetres * FLOOR_BIAS_VOXELS;
}

function frameOf(env: Environment): ColliderFrame {
  const m = env.entity.getWorldTransform();
  const d = m.data;
  return { origin: { x: d[12]!, y: d[13]!, z: d[14]! }, scale: maxAxisScale(m) };
}

type Sample = ReturnType<Environment['sampleWorldSample']>;

/** The last sample taken, so a rebuild re-crops it instead of re-walking every
 *  splat on the main thread. Retaken when the environment or its transform
 *  changes, or a denser one is wanted. */
interface SampleCache {
  env: Environment | null;
  revision: number;
  matrix: Float32Array | null;
  sample: Sample | null;
  count: number;
}

function sampleOf(cache: SampleCache, env: Environment, count: number): Sample {
  const matrix = env.entity.getWorldTransform().data;
  if (cache.sample && cache.env === env && cache.revision === env.sampleRevision && cache.count >= count && cache.matrix!.every((v, i) => v === matrix[i])) {
    return cache.sample;
  }
  cache.env = env;
  cache.revision = env.sampleRevision;
  cache.matrix = new Float32Array(matrix);
  cache.sample = env.sampleWorldSample(count);
  cache.count = count;
  return cache.sample;
}

/**
 * Build the collider for a walker whose feet are at `at.y`, standing at
 * (`at.x`, `at.z`). Null when the capture has nothing to collide with there.
 *
 * `floorBelow` is the floor she came up from (the last build's): kept in the
 * band, so a climb onto furniture still has the floor to step back down to.
 */
async function buildWalkCollider(
  env: Environment,
  at: { x: number; y: number; z: number },
  height: number,
  stepLimit: number,
  floorBelow: number | undefined,
  cache: SampleCache,
): Promise<SceneCollider | null> {
  // At least her own height below her feet, so a walk that starts on a ledge
  // has the ground below it in the grid.
  const lo = Math.min(at.y, floorBelow ?? at.y) - Math.max(COLLIDER_BAND_BELOW_M, height);
  const hi = at.y + Math.max(COLLIDER_BAND_ABOVE_M, height * BAND_HEIGHTS);
  let sample = sampleOf(cache, env, COLLIDER_SAMPLE_POINTS);
  let crop = cropAround(sample, at, lo, hi);
  const taken = sample.positions.length / 3;
  if (crop.kept < CROP_POINTS * 0.75 && taken >= COLLIDER_SAMPLE_POINTS) {
    const count = Math.min(MAX_SAMPLE_POINTS, Math.ceil((taken * CROP_POINTS) / Math.max(1, crop.kept)));
    sample = sampleOf(cache, env, count);
    crop = cropAround(sample, at, lo, hi);
  }
  const { positions, alpha } = crop;
  const data = await buildInWorker({
    positions,
    alpha,
    frame: frameOf(env),
    // The engine hangs its band from a floor percentile inside this crop, so
    // asking for the crop's full height keeps all of it.
    tuning: { bandAboveM: hi - lo },
    walker: { x: at.x, y: at.y, z: at.z, radius: capsuleForWalker(height, stepLimit, 0).radius, height },
  });
  return data ? SceneCollider.fromData(data, () => frameOf(env)) : null;
}

/** The sample's points inside the band [lo, hi] and within CROP_RADIUS of her. */
function cropAround(
  sample: Sample,
  at: { x: number; z: number },
  lo: number,
  hi: number,
): { positions: Float32Array; alpha: Float32Array | null; kept: number } {
  const src = sample.positions;
  const n = src.length / 3;
  const r2 = CROP_RADIUS * CROP_RADIUS;
  const inside = (i: number) => {
    const y = src[i * 3 + 1]!;
    if (y < lo || y > hi) return false;
    const dx = src[i * 3]! - at.x, dz = src[i * 3 + 2]! - at.z;
    return dx * dx + dz * dz <= r2;
  };
  let kept = 0;
  for (let i = 0; i < n; i++) if (inside(i)) kept++;
  const positions = new Float32Array(kept * 3);
  const alpha = sample.alpha ? new Float32Array(kept) : null;
  for (let i = 0, k = 0; i < n; i++) {
    if (!inside(i)) continue;
    positions[k * 3] = src[i * 3]!;
    positions[k * 3 + 1] = src[i * 3 + 1]!;
    positions[k * 3 + 2] = src[i * 3 + 2]!;
    if (alpha) alpha[k] = sample.alpha![i]!;
    k++;
  }
  return { positions, alpha, kept };
}

/** One worker shared by every live session. It answers in order, so pending
 *  builds are a FIFO; a crash fails them all and the next build starts a fresh
 *  one. Terminated once no session is left and nothing is pending. */
let worker: Worker | null = null;
let workerUsers = 0;
const pending: { resolve: (d: SceneColliderData | null) => void; reject: (e: Error) => void }[] = [];

function releaseWorker(): void {
  if (workerUsers > 0 || pending.length > 0 || !worker) return;
  worker.terminate();
  worker = null;
}

function failWorker(w: Worker, message: string): void {
  w.terminate();
  if (worker === w) worker = null;
  const error = new Error(`walk collider worker failed: ${message}`);
  for (const p of pending.splice(0)) p.reject(error);
}

function buildInWorker(request: ColliderWorkerRequest): Promise<SceneColliderData | null> {
  if (!worker) {
    const w = new Worker(new URL('./collider.worker.ts', import.meta.url), { type: 'module', name: 'walk-collider' });
    w.onmessage = (e: MessageEvent<ColliderWorkerResponse>) => {
      const next = pending.shift();
      if (next) {
        if (e.data.ok) next.resolve(e.data.data);
        else next.reject(new Error(e.data.error));
      }
      releaseWorker();
    };
    w.onerror = (e) => failWorker(w, e.message);
    w.onmessageerror = () => failWorker(w, 'reply could not be decoded');
    worker = w;
  }
  const w = worker;
  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    const transfer: ArrayBuffer[] = [request.positions.buffer as ArrayBuffer];
    if (request.alpha) transfer.push(request.alpha.buffer as ArrayBuffer);
    w.postMessage(request, transfer);
  });
}
