import { Environment, FlyControls, Scene } from '@viggle/splat-engine';

import { fileToWorld, worldToFile, yawPitchOf } from '../core/pose.js';
import type { ScenePose } from '../core/types.js';

export interface SceneRendererOptions {
  /** Clear colour, 0..1 floats. Default near-black. */
  background?: { r: number; g: number; b: number };
  /** Vertical field of view in degrees. Default 60. */
  fov?: number;
  /** Fly speed in scene units per second. Default 1 (a unit is a few metres). */
  flySpeed?: number;
}

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
  private environments: Environment[] = [];
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadTicket++;
    this.fly.detach();
    for (const env of this.environments) env.destroy();
    this.environments = [];
    this.scene.destroy();
  }

  private replace(next: Environment[]): void {
    for (const env of this.environments) env.destroy();
    this.environments = next;
  }
}

function filenameOf(url: string, i: number): string {
  const path = url.split('?')[0] ?? '';
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /\.(spz|ply|sog|sogs)$/i.test(base) ? base : `scene-${i}.spz`;
}
