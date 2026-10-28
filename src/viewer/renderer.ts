import { createSceneProbe, Environment, FlyControls, Scene } from '@viggle/splat-engine';

import { fileToWorld, worldToFile, yawPitchOf } from '../core/pose.js';
import type { ScenePose } from '../core/types.js';
import { DEFAULT_CAPTURE_HEIGHT, FALLBACK_SCENE_SCALE, isUprightFile } from '../walk/placement.js';
import type { GapSearchOptions } from './gaps.js';
import { gapCandidates, horizontalFov, pickGaps, wallDistances } from './gaps.js';

export interface SceneRendererOptions {
  /** Clear colour, 0..1 floats. Default near-black. */
  background?: { r: number; g: number; b: number };
  /** Vertical field of view in degrees. Default 60. */
  fov?: number;
  /** Fly speed in scene units per second. Default 1 (a unit is a few metres). */
  flySpeed?: number;
}

export interface FindGapsOptions extends GapSearchOptions {
  /** Vertical field of view the fills will be generated at, degrees. Default the viewer's. */
  fov?: number;
  /** Also render a picture of each gap found (`SceneGap.preview`). Default false. */
  previews?: boolean;
  /** Called after each candidate view is measured. */
  onProgress?: (p: { measured: number; total: number }) => void;
  signal?: AbortSignal;
}

/** A view of the scene with a gap in it: somewhere a fill would add what the capture point could not see. */
export interface SceneGap {
  /** Where to stand and look, in the pose frame: `flyTo` it, or `expand` from it to fill the gap. */
  pose: ScenePose;
  /** Share of the view nothing covers, 0..1. */
  holeFraction: number;
  /** `data:image/jpeg;base64,...` of the view, the gaps black. With `previews`. */
  preview?: string;
}

export interface FlyToOptions {
  /** Default 900. 0 cuts. */
  durationMs?: number;
}

/** Probe frames are 16:9: the shape of a generated view. */
const PROBE_SIZE = { width: 128, height: 72 } as const;
const PREVIEW_SIZE = { width: 384, height: 216 } as const;

export interface LoadProgress {
  /** Files of this load that have landed. */
  loaded: number;
  total: number;
}

/**
 * A Gaussian-splat scene on a canvas, with a free-fly camera (drag to look,
 * WASD/QE to move, right-drag to pan, wheel to dolly).
 *
 * A POSE IS IN THE PROVIDER'S CAMERA FRAME (OpenCV, Y down), whichever way up
 * the splat FILE is: the provider's SPZ files are +Y up, its camera API is
 * not. The splat is mounted so that this world is always the pose frame
 * turned half about X - an SPZ as stored, a Y-down PLY with the half turn -
 * at scale 1 with no lift, so a pose converts by that half turn alone
 * (../core/pose). That is what lets `getPose()` be sent to the API as it is.
 *
 * Framework-free: `<SceneViewer>` is a thin React shell over this.
 */
export class SceneRenderer {
  private loadTicket = 0;
  private flyTicket = 0;
  private environments: Environment[] = [];
  /** The first file's name, which says which way up it is stored. */
  private filename = '';
  private height: number | null = null;
  private destroyed = false;

  private constructor(
    private readonly scene: Scene,
    private readonly fly: FlyControls,
    /** Vertical field of view, degrees. Send it with an expand so the fill matches what is on screen. */
    readonly fov: number,
  ) {}

  static async create(canvas: HTMLCanvasElement, opts: SceneRendererOptions = {}): Promise<SceneRenderer> {
    const bg = opts.background ?? { r: 0.06, g: 0.06, b: 0.08 };
    const fov = opts.fov ?? 60;
    const scene = await Scene.create(canvas, {
      bgColor: { ...bg, a: 1 },
      fov,
      // A panorama reconstruction's nearest surface can sit ~0.2 units out.
      near: 0.02,
      far: 1000,
      loadSkeleton: false,
      cameraPosition: { x: 0, y: 0, z: 0 },
      cameraTarget: { x: 0, y: 0, z: -1 },
    });
    const fly = new FlyControls({ flySpeed: opts.flySpeed ?? 1, yaw: 0, pitch: 0 });
    fly.attach({ canvas, cameraEntity: scene.cameraEntity });
    scene.app.on('update', (dt: number) => fly.update(dt));
    scene.start();
    return new SceneRenderer(scene, fly, fov);
  }

  /**
   * Show the splat files `urls` (usually one: a version's `splatUrl`; several
   * load as parts of one scene). The camera is left where it is, so swapping one version of
   * a place for another keeps the vantage. Resolves once the first file is
   * on screen; the rest stream in after it. A newer `load` cancels an older.
   */
  async load(urls: string[], onProgress?: (p: LoadProgress) => void): Promise<void> {
    const ticket = ++this.loadTicket;
    const total = urls.length;
    const landed: Environment[] = [];
    const isCurrent = () => ticket === this.loadTicket && !this.destroyed;

    const loadOne = async (url: string, i: number): Promise<Environment | null> => {
      // Signed URLs carry no extension the loader can read.
      const filename = filenameOf(url, i);
      const env = await Environment.load(this.scene, url, {
        // SPZ is stored +Y up (Niantic's canonical frame), so it goes in as
        // it is. A PLY from the provider is in its Y-down camera frame and
        // takes the half turn. Either way the world is the pose frame turned
        // half about X, so poses convert the same (see the class comment).
        rotation: { x: /\.ply$/i.test(filename) ? 180 : 0, y: 0, z: 0 },
        scale: 1,
        filename,
      });
      if (!isCurrent()) {
        env.destroy();
        return null;
      }
      return env;
    };

    if (total === 0) {
      this.replace([]);
      return;
    }

    const first = await loadOne(urls[0]!, 0);
    if (!first) return;
    landed.push(first);
    this.filename = filenameOf(urls[0]!, 0);
    this.height = null;
    // The old version goes only once the new one can stand in for it.
    this.replace(landed);
    onProgress?.({ loaded: 1, total });

    void (async () => {
      for (let i = 1; i < total; i++) {
        const env = await loadOne(urls[i]!, i).catch(() => null);
        if (!env) return;
        this.environments.push(env);
        onProgress?.({ loaded: i + 1, total });
      }
    })();
  }

  /** Where the camera stands and looks, in the scene file's frame - what an expand needs. */
  getPose(): ScenePose | null {
    if (this.destroyed || this.environments.length === 0) return null;
    const cam = this.scene.cameraEntity;
    const p = cam.getPosition();
    const f = cam.forward;
    return { position: worldToFile([p.x, p.y, p.z]), forward: worldToFile([f.x, f.y, f.z]) };
  }

  /** Put the camera at a pose given in the scene file's frame (an expand step's `fillView`, a candidate). */
  setPose(pose: ScenePose): void {
    this.flyTicket++;
    this.place(pose);
  }

  private place(pose: ScenePose): void {
    if (this.destroyed) return;
    const [x, y, z] = fileToWorld(pose.position);
    this.scene.cameraEntity.setPosition(x, y, z);
    const { yaw, pitch } = yawPitchOf(fileToWorld(pose.forward));
    this.fly.setOrientation(yaw, pitch);
  }

  /** Back to the capture point, looking straight ahead. */
  resetCamera(): void {
    this.setPose({ position: [0, 0, 0], forward: [0, 0, 1] });
  }

  /**
   * Find the views with gaps in them, emptiest first.
   *
   * Candidate cameras ring the capture point inside the room, looking back at
   * it, and each is rendered offscreen (nothing on screen moves) and measured:
   * the share of the frame no splat covers. Nothing is spent - pass a gap's
   * `pose` to `flyTo` to look at it, and to an expand to fill it.
   *
   * About 25 views by default, a few seconds on a scene-sized cloud. Rejects
   * when there is no scene, when `signal` aborts, or when another scene loads
   * meanwhile.
   */
  async findGaps(opts: FindGapsOptions = {}): Promise<SceneGap[]> {
    const env = this.environments[0];
    if (this.destroyed || !env) throw new Error('No scene is loaded.');
    const ticket = this.loadTicket;
    const height = this.captureHeight(env);
    const candidates = gapCandidates(height, wallDistances(env.sampleWorldPoints(40_000), height), opts);
    const probe = createSceneProbe(this.scene, {
      ...PROBE_SIZE,
      fovDeg: horizontalFov(opts.fov ?? this.fov, PROBE_SIZE.width / PROBE_SIZE.height),
    });
    const check = () => {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (this.destroyed || ticket !== this.loadTicket) throw new Error('The scene changed while it was being searched.');
    };
    try {
      const measured: { candidate: (typeof candidates)[number]; holeFraction: number }[] = [];
      for (const candidate of candidates) {
        check();
        const r = await probe.probe({ position: candidate.position, yawDeg: candidate.yawDeg, pitchDeg: candidate.pitchDeg });
        measured.push({ candidate, holeFraction: r.holeFraction });
        opts.onProgress?.({ measured: measured.length, total: candidates.length });
      }
      const gaps: SceneGap[] = [];
      for (const { candidate: c, holeFraction } of pickGaps(measured, opts)) {
        check();
        const gap: SceneGap = { pose: { position: worldToFile(c.position), forward: worldToFile(c.forward) }, holeFraction };
        if (opts.previews) {
          gap.preview = (await probe.capture({ position: c.position, yawDeg: c.yawDeg, pitchDeg: c.pitchDeg }, PREVIEW_SIZE)).dataUrl;
        }
        gaps.push(gap);
      }
      return gaps;
    } finally {
      probe.destroy();
    }
  }

  /** The share of a view (default: the camera's) that nothing covers, 0..1, measured offscreen. */
  async measureView(pose?: ScenePose, fov = this.fov): Promise<number> {
    const at = pose ?? this.getPose();
    if (!at) throw new Error('No scene is loaded.');
    const { yaw, pitch } = yawPitchOf(fileToWorld(at.forward));
    const probe = createSceneProbe(this.scene, { ...PROBE_SIZE, fovDeg: horizontalFov(fov, PROBE_SIZE.width / PROBE_SIZE.height) });
    try {
      return (await probe.probe({ position: fileToWorld(at.position), yawDeg: yaw, pitchDeg: pitch })).holeFraction;
    } finally {
      probe.destroy();
    }
  }

  /**
   * Glide the camera to a pose in the pose frame. Resolves on arrival, or
   * when a newer `flyTo` or `setPose` takes over.
   */
  flyTo(pose: ScenePose, opts: FlyToOptions = {}): Promise<void> {
    const ticket = ++this.flyTicket;
    const duration = Math.max(0, opts.durationMs ?? 900);
    if (this.destroyed) return Promise.resolve();
    if (duration === 0) {
      this.place(pose);
      return Promise.resolve();
    }
    const cam = this.scene.cameraEntity;
    const p = cam.getPosition();
    const from = { x: p.x, y: p.y, z: p.z, yaw: this.fly.yaw, pitch: this.fly.pitch };
    const [tx, ty, tz] = fileToWorld(pose.position);
    const to = yawPitchOf(fileToWorld(pose.forward));
    // The short way round.
    const dyaw = ((((to.yaw - from.yaw) % 360) + 540) % 360) - 180;
    const app = this.scene.app;
    return new Promise((resolve) => {
      let t = 0;
      const step = (dt: number) => {
        if (this.destroyed || ticket !== this.flyTicket) {
          app.off('update', step);
          resolve();
          return;
        }
        t += dt * 1000;
        const k = Math.min(1, t / duration);
        const e = k * k * (3 - 2 * k);
        cam.setPosition(from.x + (tx - from.x) * e, from.y + (ty - from.y) * e, from.z + (tz - from.z) * e);
        this.fly.setOrientation(from.yaw + dyaw * e, from.pitch + (to.pitch - from.pitch) * e);
        if (k >= 1) {
          app.off('update', step);
          resolve();
        }
      };
      app.on('update', step);
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadTicket++;
    this.fly.detach();
    for (const env of this.environments) env.destroy();
    this.environments = [];
    this.scene.destroy();
  }

  /** The capture point's height over the floor, file units: what the gap search's rings are measured in. */
  private captureHeight(env: Environment): number {
    if (this.height === null) {
      const depth = env.probeGroundDepth(isUprightFile(this.filename) ? -1 : 1)?.depth;
      this.height = depth && depth > 0 && Number.isFinite(depth) ? depth : lowestLayer(env.sampleWorldPoints(20_000));
    }
    return this.height;
  }

  private replace(next: Environment[]): void {
    for (const env of this.environments) env.destroy();
    this.environments = next;
  }
}

/**
 * How far below the capture point the lowest splats are (5th percentile of
 * world Y): the floor, when the ground probe finds none. A typical capture
 * height when that is not below the capture point either.
 */
function lowestLayer(points: Float32Array): number {
  const ys: number[] = [];
  for (let k = 1; k < points.length; k += 3) ys.push(points[k]!);
  ys.sort((a, b) => a - b);
  const low = ys[Math.floor(ys.length * 0.05)];
  return low !== undefined && low < 0 ? -low : DEFAULT_CAPTURE_HEIGHT / FALLBACK_SCENE_SCALE;
}

function filenameOf(url: string, i: number): string {
  const path = url.split('?')[0] ?? '';
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /\.(spz|ply|sog|sogs)$/i.test(base) ? base : `scene-${i}.spz`;
}
