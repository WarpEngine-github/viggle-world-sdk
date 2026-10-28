import type { OverlaySplatStyle, SceneCollider, Splat } from '@viggle/splat-engine';
import {
  Animation, applyOverlaySplatStyle, Character, defaultShouldIgnoreKeystroke, Environment, OrbitControls, Scene, SceneColliderDebug,
} from '@viggle/splat-engine';

import { boomFor, boomLimit, eyeAt, fadeFor, pivotFor, stepBoom, stepFade } from '../walk/cameraArm.js';
import { FOLLOW, followYaw, wrapDeg } from '../walk/cameraFollow.js';
import type { FloorProbe, WalkerState, WalkParams } from '../walk/controller.js';
import { stepWalker, walkInputFromKeys } from '../walk/controller.js';
import type { FloorIndex } from '../walk/floorIndex.js';
import { ring, walkableOutline } from '../walk/outline.js';
import { buildFloorIndex, walkerAperture } from '../walk/floorIndex.js';
import type { LocoMachine, LocoState } from '../walk/locomotion.js';
import { createLocoMachine, JUMP_CLIP_LAND_S, JUMP_RATE, stepLocomotion } from '../walk/locomotion.js';
import type { AutoPlacement, SceneTransform, WalkPlacement } from '../walk/placement.js';
import { isAutoPlacement, isUprightFile, placeWalkScene, placementFromGround } from '../walk/placement.js';
import { WALK_TUNING, walkParamsFor } from '../walk/tuning.js';
import { WalkColliders } from './collider.js';
import type { ExplorerInternals } from './internals.js';
import { INTERNALS } from './internals.js';

/** URLs of the four locomotion clips, `.glb` (a skeletal clip on the splat rig) or a baked `.anim`. */
export interface LocomotionClips {
  idle: string;
  walk: string;
  run: string;
  jump: string;
}

/** Viggle's public locomotion set, retargeted to every Viggle splat character. The default. */
export const VIGGLE_LOCOMOTION_CLIPS: LocomotionClips = {
  idle: 'https://assets.viggle.ai/pub/www/jst2-gallery/pinoc-standing-idle-3e1a1f20.glb',
  walk: 'https://assets.viggle.ai/pub/www/jst2-gallery/pinoc-walking-a0293881.glb',
  run: 'https://assets.viggle.ai/pub/www/jst2-gallery/pinoc-running-1902fd18.glb',
  jump: 'https://assets.viggle.ai/pub/www/jst2-gallery/pinoc-jump-75ac6fd5.glb',
};

export interface SceneExplorerOptions {
  /** Clear colour, 0..1 floats. Default near-black. */
  background?: { r: number; g: number; b: number };
  /** Field of view in degrees, on the canvas's shorter edge (so an upright phone is not a keyhole). Default 60. */
  fov?: number;
}

/** How a walker hidden behind the scene shows: not at all, or as a see-through copy. */
export type WalkerBehind = 'occluded' | 'screendoor' | 'ghost';

export interface ExplorerCameraOptions {
  /** The widest follow distance, metres for a 1.7 m body; the camera opens there. Default 3.1. */
  maxDistance?: number;
  /** The closest the wheel or a pinch zooms, metres for a 1.7 m body. Default 1.2. */
  minDistance?: number;
  /** Pitch limits, degrees (0 level, 85 nearly overhead). Default [0, 85]. */
  pitchRange?: [number, number];
  /** Pitch the camera opens at, degrees. Default 15. */
  pitch?: number;
  /** Swing round behind the walker as they walk, slowly. Default true. */
  follow?: boolean;
  /** Where the camera aims, as a fraction of the body's height. Default 0.5. */
  aimHeight?: number;
}

export interface ExplorerLoadOptions {
  /**
   * The splat file (`.sog`, `.spz`, `.ply`) and how it is placed: given (see
   * `placeWalkScene`), or `{ auto: true }` to measure it from the scene's own
   * floor - for a scene just generated or uploaded. `getPlacement()` then
   * reads what was measured, to keep and pass next time.
   */
  scene: { url: string; placement: WalkPlacement | AutoPlacement; filename?: string };
  /** A Viggle `.vsplat` character, and how tall it should stand in metres (default 1.7). */
  character: { url: string; height?: number };
  /** Default `VIGGLE_LOCOMOTION_CLIPS`. A clip that fails to load is skipped. */
  clips?: Partial<LocomotionClips>;
  /** Walls from the scene's own splats, built in a worker: the walker and camera stay out of them. Default true. */
  collision?: boolean;
  /** Default 'screendoor'. */
  walkerBehind?: WalkerBehind;
  camera?: ExplorerCameraOptions;
  /** Walk speed multiplier. Default 1. */
  speed?: number;
}

export interface ExplorerProgress {
  /** Parts landed: the scene, the character, the clips. */
  loaded: number;
  total: number;
}

/** The walker, in world metres: the scene's walk start is the origin, its floor y = 0, -Z the way they start facing. */
export interface WalkerPose {
  position: [number, number, number];
  /** Degrees about Y; 0 faces -Z. */
  heading: number;
  moving: boolean;
  running: boolean;
  airborne: boolean;
}

/** Where a loaded scene's placement came from: given, measured off its floor, or a typical scale because no floor was found. */
export type PlacementSource = 'given' | 'measured' | 'fallback';

/**
 * What `showCollision` draws over the scene:
 * - `outline`: the edge of where the walker can go, as lines on the floor -
 *   walls, holes and ledges alike - and a ring at the walker's feet, green,
 *   red where a wall stops it. The clean one.
 * - `cells`: every voxel of the collider, as lines.
 * - `floor`: only the voxels' tops - the floor the walker can stand on.
 * - `surface`: the solid surface a game engine would collide with.
 * The last three also draw the walker's capsule.
 */
export type CollisionView = 'off' | 'outline' | 'cells' | 'floor' | 'surface';

/** How `playAction` plays a clip. */
export interface ActionOptions {
  /** Repeat until something else plays. Default false: once, then back to standing. */
  loop?: boolean;
  /** Seconds to blend in from the current pose. Default 0.25. */
  blend?: number;
}

/** An analog move, as a touch stick gives it: x right, z forward, camera-relative, length 0..1. */
export interface WalkMove {
  x: number;
  z: number;
  run?: boolean;
}

const DEFAULT_HEIGHT = 1.7;
/** Points the floor index samples from the scene. */
const FLOOR_SAMPLE_POINTS = 200_000;
/** The see-through copy's opacity, behind a wall. */
const GHOST_ALPHA = 0.4;
/** The walk's clips face +Z at rest; the walk's heading 0 faces -Z. */
const FACING_OFFSET = 180;
/** The walk clips' frame rate. */
const CLIP_FPS = 30;
const NO_KEYS: ReadonlySet<string> = new Set();
/** Body heights below the spawn floor that count as having fallen out of the scene. */
const FALL_LIMIT_HEIGHTS = 12;

interface Loaded {
  environment: Environment;
  character: Character;
  placement: WalkPlacement;
  placementSource: PlacementSource;
  /** The camera the walk opened with, for `respawn`. */
  spawnView: { pitch: number; distance: number };
  transform: SceneTransform;
  overlay: Splat | null;
  disposeOverlay: () => void;
  clips: Partial<Record<LocoState, string>>;
  /** Clips `playAction` loaded, by URL. */
  actions: Map<string, string>;
  /** The action playing, if any: it holds the body until it ends or the walker moves. */
  action: { url: string; key: string; loop: boolean } | null;
  behind: WalkerBehind;
  colliders: WalkColliders | null;
  height: number;
  aim: number;
  follow: boolean;
  params: WalkParams;
  floorAt: FloorProbe;
  index: { revision: number; floor: FloorIndex };
  state: WalkerState;
  loco: LocoMachine;
  current: LocoState | null;
  speedRatio: number;
  // The follow camera.
  arm: number | null;
  armSpeed: number;
  easeIn: boolean;
  lastEye: { x: number; y: number; z: number } | null;
  lastPivot: { x: number; y: number; z: number } | null;
  lastYaw: number | null;
  fade: number;
  fadeShown: number;
  swing: { vx: number; vz: number; last: { x: number; z: number } | null; writtenYaw: number; heldUntil: number };
  unloads: Set<() => void>;
  characterChanges: Set<(previous: Character) => void>;
}

/**
 * A third-person walk through a Gaussian-splat scene: a splat character on
 * its floor, WASD to walk, Shift to run, Space to jump, drag to look round,
 * wheel or pinch to zoom; the camera follows and keeps out of walls.
 *
 * WORLD UNITS ARE METRES. The scene is mounted by `placeWalkScene` so its
 * walk start is the origin and its floor y = 0; the character is scaled to
 * its `height`. Everything the walk does is a multiple of that height.
 *
 * Framework-free: `<SceneExplorerView>` (`@viggle/scene-sdk/react`) is a thin
 * shell over this, and `@viggle/scene-sdk/lighting` adds a sun and shadows.
 */
export class SceneExplorer {
  private loaded: Loaded | null = null;
  private loadTicket = 0;
  private destroyed = false;
  private readonly keys = new Set<string>();
  private jumpQueued = false;
  private move: WalkMove | null = null;
  private actionTicket = 0;
  private characterTicket = 0;
  private collisionView: CollisionView = 'off';
  private debug: { overlay: SceneColliderDebug; shown: SceneCollider | null } | null = null;
  /** The `outline` view's lines, and where (and for which collider) they were traced. */
  private outline: { collider: SceneCollider; at: { x: number; z: number }; positions: number[]; colors: number[] } | null = null;
  private readonly actionListeners = new Set<(url: string | null) => void>();
  private readonly removeInput: () => void;

  private constructor(
    private readonly scene: Scene,
    private readonly orbit: OrbitControls,
    private readonly canvas: HTMLCanvasElement,
    private readonly fov: number,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- read by the getter below
    const explorer = this;
    const internals: ExplorerInternals = {
      scene,
      get loaded() {
        const l = explorer.loaded;
        return l ? { environment: l.environment, character: l.character, transform: l.transform, height: l.height } : null;
      },
      onUnload: (cb) => {
        const l = this.loaded;
        if (!l) { cb(); return () => {}; }
        l.unloads.add(cb);
        return () => l.unloads.delete(cb);
      },
      onCharacterChange: (cb) => {
        const l = this.loaded;
        if (!l) return () => {};
        l.characterChanges.add(cb);
        return () => l.characterChanges.delete(cb);
      },
    };
    INTERNALS.set(this, internals);
    this.removeInput = this.listen();
    scene.app.on('update', this.tick);
  }

  static async create(canvas: HTMLCanvasElement, opts: SceneExplorerOptions = {}): Promise<SceneExplorer> {
    const bg = opts.background ?? { r: 0.06, g: 0.06, b: 0.08 };
    const fov = opts.fov ?? 60;
    const scene = await Scene.create(canvas, {
      bgColor: { ...bg, a: 1 },
      fov,
      near: 0.05,
      far: 500,
      cameraPosition: { x: 0, y: 1.6, z: 3 },
      cameraTarget: { x: 0, y: 0.85, z: 0 },
    });
    const orbit = new OrbitControls({ yaw: 0, pitch: 15, distance: 3.1, target: { x: 0, y: 0.85, z: 0 } });
    orbit.attach({ canvas, cameraEntity: scene.cameraEntity });
    scene.start();
    return new SceneExplorer(scene, orbit, canvas, fov);
  }

  /**
   * Show a scene with a character standing at its walk start. Resolves once
   * both are on screen and the walk has begun; a newer `load` cancels this one.
   */
  async load(opts: ExplorerLoadOptions, onProgress?: (p: ExplorerProgress) => void): Promise<void> {
    const ticket = ++this.loadTicket;
    const isCurrent = () => ticket === this.loadTicket && !this.destroyed;
    const scene = this.scene;
    const asked = opts.scene.placement;
    const filename = opts.scene.filename ?? filenameOf(opts.scene.url);
    const auto = isAutoPlacement(asked) ? { ...asked, upright: asked.upright ?? isUprightFile(filename) } : null;
    // Measured: mounted at the file's own scale first, moved once the floor is found.
    let placement: WalkPlacement = auto ? { upright: auto.upright, scale: 1, floor: 0, start: [0, 0] } : asked as WalkPlacement;
    let transform = placeWalkScene(placement);
    let placementSource: PlacementSource = 'given';
    const height = opts.character.height ?? DEFAULT_HEIGHT;
    const clipUrls = { ...VIGGLE_LOCOMOTION_CLIPS, ...opts.clips };
    for (const url of Object.values(clipUrls)) if (url) Animation.prefetch(url);

    let landed = 0;
    const total = 3;
    const done = <T>(value: T): T => { if (isCurrent()) onProgress?.({ loaded: ++landed, total }); return value; };
    const clips: Partial<Record<LocoState, string>> = {};
    const loadClip = async (name: LocoState, url: string | undefined) => {
      if (!url) return;
      const key = `explorer_${name}_${ticket}_${Math.random().toString(36).slice(2)}`;
      try {
        await (/\.glb(\?|#|$)/i.test(url) ? Animation.loadGlb(scene, url, key) : Animation.load(scene, url, key));
        clips[name] = key;
      } catch (e) {
        // eslint-disable-next-line no-console -- a missing clip degrades the walk, never blocks it
        console.warn(`[SceneExplorer] ${name} clip failed to load:`, e);
      }
    };
    const dropClips = () => { for (const key of Object.values(clips)) scene.skeletalAnimationLibrary.delete(key); };

    const results = await Promise.allSettled([
      Environment.load(scene, opts.scene.url, {
        rotation: transform.rotation,
        position: transform.position,
        scale: transform.scale,
        filename,
      }).then(done),
      Character.load(scene, opts.character.url).then(done),
      Promise.all((['idle', 'walk', 'run', 'jump'] as const).map((name) => loadClip(name, clipUrls[name]))).then(done),
    ]);
    const [envResult, charResult] = results;
    const environment = envResult.status === 'fulfilled' ? envResult.value : null;
    const character = charResult.status === 'fulfilled' ? charResult.value : null;
    if (!isCurrent() || !environment || !character) {
      environment?.destroy();
      character?.destroy();
      dropClips();
      if (!isCurrent()) return;
      throw envResult.status === 'rejected' ? envResult.reason : (charResult as PromiseRejectedResult).reason;
    }

    if (auto) {
      const ground = environment.probeGroundDepth(auto.upright ? -1 : 1);
      if (!ground?.depth) {
        // eslint-disable-next-line no-console -- the walk still opens, at a typical scale
        console.warn('[SceneExplorer] no floor found under the capture point; using a typical scale');
      }
      placement = placementFromGround(ground?.depth ?? null, auto);
      placementSource = ground?.depth ? 'measured' : 'fallback';
      transform = placeWalkScene(placement);
      const { position: p, rotation: r, scale: k } = transform;
      environment.entity.setPosition(p.x, p.y, p.z);
      environment.entity.setEulerAngles(r.x, r.y, r.z);
      environment.entity.setLocalScale(k, k, k);
    }

    this.unload();

    // The body is the yardstick: scaled to `height` metres, feet on the origin.
    const behind = opts.walkerBehind ?? 'screendoor';
    const { overlay, disposeOverlay } = this.dress(character, height, behind);

    const index = { revision: environment.sampleRevision, floor: floorIndexOf(environment) };
    const stepLimit = height * WALK_TUNING.stepFraction;
    const spawn: WalkerState = { x: 0, y: 0, z: 0, heading: 0, moving: false, running: false, vy: 0, airborne: false, safe: { x: 0, y: 0, z: 0 } };
    const floorIndexAt = (x: number, z: number, aperture: number, fromY: number, maxDrop: number) =>
      index.floor.floorAt(x, z, aperture, fromY, maxDrop);
    // The collider asks where the walker is before the session exists.
    let session: Loaded | null = null;
    const colliders = opts.collision === false ? null : new WalkColliders({
      ground: { height, stepLimit, floorIndexAt },
      env: () => environment,
      walker: () => session?.state ?? spawn,
      onPushedOut: (x, z) => {
        const at = session;
        if (at) { at.state = { ...at.state, x, z }; placeCharacter(at.character, x, at.state.y, z); }
      },
    });
    colliders?.colliderAt();

    const camera = opts.camera ?? {};
    const k = height / DEFAULT_HEIGHT;
    const maxDistance = (camera.maxDistance ?? 3.1) * k;
    this.orbit.distanceRange = [Math.min(maxDistance, (camera.minDistance ?? 1.2) * k), maxDistance];
    this.orbit.pitchRange = camera.pitchRange ?? [0, 85];
    this.orbit.yaw = 0;
    this.orbit.pitch = camera.pitch ?? 15;
    this.orbit.distance = maxDistance;
    this.orbit.eyeLimit = null;

    session = {
      environment, character, placement, placementSource, transform, overlay, disposeOverlay, clips, colliders, height, behind,
      actions: new Map(), action: null,
      spawnView: { pitch: this.orbit.pitch, distance: maxDistance },
      aim: camera.aimHeight ?? 0.5,
      follow: camera.follow ?? true,
      params: walkParamsFor(height, index.floor.cell, Boolean(colliders), opts.speed ?? 1),
      floorAt: colliders?.floorAt ?? ((x, z, aperture, fromY) => floorIndexAt(x, z, aperture, fromY, height * 3)),
      index,
      state: spawn,
      loco: createLocoMachine(),
      current: null,
      speedRatio: 1,
      arm: null, armSpeed: 0, easeIn: false, lastEye: null, lastPivot: null, lastYaw: null, fade: 1, fadeShown: 1,
      swing: { vx: 0, vz: 0, last: null, writtenYaw: Number.NaN, heldUntil: 0 },
      unloads: new Set(),
      characterChanges: new Set(),
    };
    placeCharacter(character, 0, 0, 0);
    character.setRotation(0, FACING_OFFSET, 0);
    const first = clips.idle ?? clips.walk;
    if (first) { character.playAnimation(first, { loop: true, rootMotion: false }); session.current = 'idle'; }
    this.loaded = session;
    this.aimOrbit(session);
    this.emitAction(null);
  }

  /**
   * Swap the walker for another character, where it stands: the scene, the
   * walls, the clips and the camera stay. The new body stands as tall as the
   * old one. Resolves once it is on screen; `SceneLighting` follows it.
   */
  async setCharacter(character: { url: string }): Promise<void> {
    const l = this.loaded;
    if (!l) throw new Error('SceneExplorer.setCharacter: load a scene first');
    const ticket = ++this.characterTicket;
    const next = await Character.load(this.scene, character.url);
    // A newer swap (or load) won while this body downloaded.
    if (this.loaded !== l || this.destroyed || ticket !== this.characterTicket) { next.destroy(); return; }
    const previous = l.character;
    const { overlay, disposeOverlay } = this.dress(next, l.height, l.behind);
    l.disposeOverlay();
    if (l.overlay) previous.removeOverlaySplat(l.overlay);
    Object.assign(l, { character: next, overlay, disposeOverlay, fadeShown: 1 });
    const { x, y, z, heading } = l.state;
    placeCharacter(next, x, y, z);
    next.setRotation(0, heading + FACING_OFFSET, 0);
    if (l.fade < 1) next.setOpacity((l.fadeShown = l.fade > 0.98 ? 1 : Math.round(l.fade * 32) / 32));
    // Pick the motion up where the old body was in it.
    const key = l.action?.key ?? (l.current ? l.clips[l.current] : void 0) ?? l.clips.idle;
    if (key) {
      next.playAnimation(key, { loop: l.action ? l.action.loop : l.current !== 'jump', rootMotion: false });
      next.animationTime = previous.animationTime;
      next.playbackSpeed = previous.playbackSpeed;
    }
    for (const cb of [...l.characterChanges]) {
      try { cb(previous); } catch (e) {
        // eslint-disable-next-line no-console -- an add-on's follow-up must not stop the swap
        console.warn('[SceneExplorer] character change callback failed:', e);
      }
    }
    previous.destroy();
  }

  /**
   * Play a clip on the walker - a wave, a dance, a cheer: a `.glb` retargeted
   * to the Viggle splat rig, or a baked `.anim`. It holds the body until it
   * ends (or loops), and walking or jumping cuts it short. `null` stops it.
   * Loaded once per scene and kept, so playing it again starts at once.
   */
  async playAction(url: string | null, opts: ActionOptions = {}): Promise<void> {
    const l = this.loaded;
    if (!l) throw new Error('SceneExplorer.playAction: load a scene first');
    const ticket = ++this.actionTicket;
    if (url === null) {
      this.endAction(l);
      return;
    }
    let key = l.actions.get(url);
    if (!key) {
      key = `explorer_action_${l.actions.size}_${Math.random().toString(36).slice(2)}`;
      await (/\.glb(\?|#|$)/i.test(url) ? Animation.loadGlb(this.scene, url, key) : Animation.load(this.scene, url, key));
      if (this.loaded !== l) { this.scene.skeletalAnimationLibrary.delete(key); return; }
      l.actions.set(url, key);
    }
    // A newer call won while this one loaded.
    if (ticket !== this.actionTicket) return;
    const loop = opts.loop ?? false;
    l.action = { url, key, loop };
    l.character.crossfadeTo(key, { duration: opts.blend ?? 0.25, loop, rootMotion: false });
    l.character.playbackSpeed = 1;
    this.emitAction(url);
  }

  /**
   * Draw the walls the walker collides with - for tuning a scene, not for
   * players. The collider is built in a worker after the scene shows, so the
   * lines appear a moment later. Ignored with `collision: false`.
   */
  showCollision(view: CollisionView): void {
    this.collisionView = view;
    this.outline = null;
    const grid = view === 'cells' || view === 'floor' || view === 'surface';
    if (!grid && !this.debug) return;
    const debug = this.debug ??= { overlay: SceneColliderDebug.create(this.scene, { mode: 'off' }), shown: null };
    debug.overlay.mode = view === 'cells' ? 'all' : view === 'floor' || view === 'surface' ? 'top' : 'off';
    debug.overlay.surface = view === 'surface';
    if (!grid) {
      debug.overlay.capsule = null;
      debug.overlay.capsuleAt = null;
    }
  }

  getCollisionView(): CollisionView {
    return this.collisionView;
  }

  /** The URL of the action playing, or null while the walker walks or stands. */
  getAction(): string | null {
    return this.loaded?.action?.url ?? null;
  }

  /** Called with the action's URL when one starts, and null when it ends, is cut short or stopped. */
  onActionChange(cb: (url: string | null) => void): () => void {
    this.actionListeners.add(cb);
    return () => this.actionListeners.delete(cb);
  }

  /** Back to the walk's own clips, from the next frame. */
  private endAction(l: Loaded): void {
    if (!l.action) return;
    l.action = null;
    // Re-chosen by the next tick.
    l.current = null;
    this.emitAction(null);
  }

  private emitAction(url: string | null): void {
    for (const cb of [...this.actionListeners]) cb(url);
  }

  /** A body, ready for the walk: `height` metres tall, on the scene's layer, with its see-through copy. */
  private dress(character: Character, height: number, behind: WalkerBehind): { overlay: Splat | null; disposeOverlay: () => void } {
    const restHeight = 2 * character.splat.localBound.halfExtents.y;
    const s = restHeight > 1e-6 ? height / restHeight : 1;
    character.setScale(s, s, s);
    // On the scene's layer, so its splats sort with the scene's.
    character.setLayers([this.scene.envLayerId]);
    if (behind === 'occluded') return { overlay: null, disposeOverlay: () => {} };
    const overlay = character.addOverlaySplat([this.scene.overlayLayerId]);
    const style: OverlaySplatStyle = { mode: behind, alpha: GHOST_ALPHA };
    return { overlay, disposeOverlay: applyOverlaySplatStyle(this.scene, () => style) };
  }

  /** How the scene is placed - the measured one, for `{ auto: true }` - or null before a load. */
  getPlacement(): WalkPlacement | null {
    const p = this.loaded?.placement;
    return p ? { ...p, start: [...p.start] as [number, number] } : null;
  }

  /** Whether `getPlacement()` was given, measured, or a fallback (no floor found under the start). */
  getPlacementSource(): PlacementSource | null {
    return this.loaded?.placementSource ?? null;
  }

  /** Where the walker stands, or null before a load. */
  getWalker(): WalkerPose | null {
    const l = this.loaded;
    if (!l) return null;
    const { x, y, z, heading, moving, running, airborne } = l.state;
    return { position: [x, y, z], heading, moving, running, airborne };
  }

  /** Put the walker at a world position (metres), facing `heading` degrees (0 = -Z). */
  teleport(position: readonly [number, number, number], heading?: number): void {
    const l = this.loaded;
    if (!l) return;
    const [x, y, z] = position;
    l.state = { ...l.state, x, y, z, vy: 0, airborne: false, heading: heading ?? l.state.heading, safe: { x, y, z } };
    l.swing.last = null;
    placeCharacter(l.character, x, y, z);
    l.character.setRotation(0, l.state.heading + FACING_OFFSET, 0);
  }

  /**
   * Back to the walk start - the scene's spawn point - facing the way the
   * walk began, with the camera as it opened. Also what happens by itself
   * when the walker falls out of the scene.
   */
  respawn(): void {
    const l = this.loaded;
    if (!l) return;
    this.endAction(l);
    this.teleport([0, 0, 0], 0);
    l.loco = createLocoMachine();
    l.current = null;
    l.arm = null;
    l.armSpeed = 0;
    l.lastEye = l.lastPivot = null;
    l.lastYaw = null;
    l.swing = { vx: 0, vz: 0, last: null, writtenYaw: Number.NaN, heldUntil: 0 };
    this.orbit.yaw = 0;
    this.orbit.pitch = l.spawnView.pitch;
    this.orbit.distance = l.spawnView.distance;
    this.aimOrbit(l);
  }

  /** A touch stick's move, camera-relative; null when released. Keys win while any are held. */
  setMove(move: WalkMove | null): void {
    this.move = move;
  }

  /** One jump, as a Space press. */
  jump(): void {
    this.jumpQueued = true;
  }

  /** The camera's yaw (degrees, 0 looks down -Z) and pitch. */
  getView(): { yaw: number; pitch: number; distance: number } {
    return { yaw: this.orbit.yaw, pitch: this.orbit.pitch, distance: this.orbit.distance };
  }

  setView(view: { yaw?: number; pitch?: number; distance?: number }): void {
    if (view.yaw !== undefined) this.orbit.yaw = view.yaw;
    if (view.pitch !== undefined) this.orbit.pitch = view.pitch;
    if (view.distance !== undefined) this.orbit.distance = view.distance;
    this.orbit.update();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadTicket++;
    this.scene.app.off('update', this.tick);
    this.removeInput();
    this.unload();
    this.actionListeners.clear();
    this.debug?.overlay.destroy();
    this.debug = null;
    this.orbit.detach();
    INTERNALS.delete(this);
    this.scene.destroy();
  }

  private unload(): void {
    const l = this.loaded;
    if (!l) return;
    this.loaded = null;
    for (const cb of [...l.unloads]) {
      try { cb(); } catch (e) {
        // eslint-disable-next-line no-console -- an add-on's teardown must not stop the explorer's
        console.warn('[SceneExplorer] unload callback failed:', e);
      }
    }
    this.outline = null;
    if (this.debug) {
      this.debug.overlay.setCollider(null);
      this.debug.shown = null;
    }
    l.colliders?.dispose();
    l.disposeOverlay();
    if (l.overlay) l.character.removeOverlaySplat(l.overlay);
    l.character.destroy();
    l.environment.destroy();
    for (const key of Object.values(l.clips)) this.scene.skeletalAnimationLibrary.delete(key);
    for (const key of l.actions.values()) this.scene.skeletalAnimationLibrary.delete(key);
  }

  private listen(): () => void {
    const ignore = (e: KeyboardEvent) => {
      if (defaultShouldIgnoreKeystroke(e)) return true;
      if (this.canvas.closest('[aria-hidden="true"], [inert]')) return true;
      const popup = e.target instanceof Element ? e.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') : null;
      return !!popup && !popup.contains(this.canvas);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (ignore(e)) return;
      const key = e.key.toLowerCase();
      this.keys.add(key);
      if (key === ' ' && !e.repeat) this.jumpQueued = true;
      // Space and the arrows would scroll the page under the walk.
      if (key === ' ' || key.startsWith('arrow')) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()); };
    const onBlur = () => this.keys.clear();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }

  /** The field of view on the canvas's shorter edge. */
  private fitFov(): void {
    const cam = this.scene.cameraEntity.camera;
    if (!cam) return;
    const portrait = this.canvas.clientHeight > this.canvas.clientWidth;
    if (cam.horizontalFov !== portrait) cam.horizontalFov = portrait;
    if (cam.fov !== this.fov) cam.fov = this.fov;
  }

  private aimOrbit(l: Loaded): void {
    const { x, y, z } = l.state;
    this.orbit.target.set(x, y + l.height * l.aim, z);
    this.orbit.update();
  }

  private readonly tick = (dt: number): void => {
    this.fitFov();
    const l = this.loaded;
    if (!l) return;
    // The rest of a split scene landing: its floor is denser now.
    if (l.environment.sampleRevision !== l.index.revision) {
      l.index.revision = l.environment.sampleRevision;
      l.index.floor = floorIndexOf(l.environment);
    }
    l.params.reach = walkerAperture(l.height, l.index.floor.cell);

    const input = walkInputFromKeys(this.keys.size ? this.keys : NO_KEYS);
    input.jump = this.jumpQueued;
    this.jumpQueued = false;
    const keyMove = input.forward || input.back || input.left || input.right;
    const stick = keyMove ? null : this.move;
    if (stick) { input.move = { x: stick.x, z: stick.z }; input.run ||= Boolean(stick.run); }
    const moving = keyMove || (!!stick && Math.hypot(stick.x, stick.z) > 0.05);
    const before = l.state;

    // The locomotion machine owns the jump's timing: the press starts the
    // clip's crouch, the body launches when the clip's feet leave the ground.
    const step = stepLocomotion(l.loco, { moving, running: moving && input.run, jump: input.jump, airborne: before.airborne }, dt, l.speedRatio);
    l.loco = step.machine;
    // Camera-relative through the orbit's yaw: yaw 0 looks down -Z, as stepWalker expects.
    l.state = stepWalker(before, { ...input, jump: step.launch }, dt, this.orbit.yaw, l.params, l.floorAt, l.colliders?.walls);
    // Fell out of the scene (through a hole, off an edge): start again.
    if (l.state.y < -FALL_LIMIT_HEIGHTS * l.height) {
      this.respawn();
      return;
    }
    const { x, y, z, heading, running } = l.state;
    placeCharacter(l.character, x, y, z);
    l.character.setRotation(0, heading + FACING_OFFSET, 0);
    // An action holds the body until it ends; any move or jump takes it back.
    if (l.action) {
      if (moving || input.jump || l.state.airborne) this.endAction(l);
      else if (!l.action.loop && l.character.isFinished) this.endAction(l);
      else {
        this.followCamera(l, dt, false);
        this.feedDebug(l);
        return;
      }
    }
    const nominal = l.params.speed * (running ? l.params.runMultiplier : 1);
    const actual = dt > 0 ? Math.hypot(x - before.x, z - before.z) / dt : nominal;
    l.speedRatio = nominal > 0 ? actual / nominal : 1;
    if (step.changed || l.current === null) {
      const key = l.clips[step.clip] ?? l.clips.idle ?? l.clips.walk;
      if (key && key !== (l.current ? l.clips[l.current] : null)) {
        l.character.crossfadeTo(key, { duration: step.blend, loop: step.clip !== 'jump', rootMotion: false });
      }
      l.current = step.clip;
    }
    const rate = step.clip === 'jump' ? JUMP_RATE : step.rate;
    if (l.character.playbackSpeed !== rate) l.character.playbackSpeed = rate;
    // Touchdown: the clip lands where the physics did.
    if (step.landed && l.current === 'jump' && l.clips.jump) l.character.animationTime = JUMP_CLIP_LAND_S * CLIP_FPS;

    this.followCamera(l, dt, moving);
    this.feedDebug(l);
  };

  /**
   * The `outline` view: where the walker can go, traced round them and traced
   * again once they have walked a fair way from where it was traced; the ring
   * at their feet every frame.
   */
  private drawOutline(l: Loaded | null): void {
    const view = l?.colliders?.debugView() ?? null;
    if (!l || !view) return;
    const { collider, capsule } = view;
    const { x, y, z } = l.state;
    const radius = l.height * 3.5;
    let o = this.outline;
    if (!o || o.collider !== collider || Math.hypot(x - o.at.x, z - o.at.z) > radius * 0.35) {
      const traced = walkableOutline((px, pz, fromY) => collider.standAt(px, pz, fromY, capsule), {
        centre: { x, y, z },
        radius,
        step: Math.max(collider.voxelMetres, l.height * 0.1),
        stepUp: l.params.stepLimit,
        lift: l.height * 0.02,
      });
      const positions = Array.from(traced.segments);
      o = this.outline = { collider, at: { x, z }, positions, colors: rgba(OUTLINE_RGBA, positions.length / 3) };
    }
    const app = this.scene.app;
    if (o.positions.length) app.drawLineArrays(o.positions, o.colors, false);
    const feet = Array.from(ring(x, y + l.height * 0.02, z, capsule.radius));
    const free = !collider.blocked(x, z, y, capsule);
    app.drawLineArrays(feet, rgba(free ? FREE_RGBA : BLOCKED_RGBA, feet.length / 3), false);
  }

  /** The collision overlay follows the collider as it lands and the walker as it moves. */
  private feedDebug(l: Loaded | null): void {
    if (this.collisionView === 'outline') return this.drawOutline(l);
    const debug = this.debug;
    if (!debug || this.collisionView === 'off') return;
    const view = l?.colliders?.debugView() ?? null;
    const collider = view?.collider ?? null;
    if (collider !== debug.shown) {
      debug.overlay.setCollider(collider);
      debug.shown = collider;
    }
    debug.overlay.capsule = view?.capsule ?? null;
    debug.overlay.capsuleAt = view && l ? { x: l.state.x, y: l.state.y + view.bias, z: l.state.z } : null;
  }

  /** The orbit keeps the walker in view: its target follows them, it swings lazily behind their walk, and walls hold its eye in. */
  private followCamera(l: Loaded, dt: number, walking: boolean): void {
    const orbit = this.orbit;
    // A yaw that is not the one written last frame is the reader's (a drag): leave the view to them for a moment.
    const now = performance.now();
    const sw = l.swing;
    if (!Number.isNaN(sw.writtenYaw) && Math.abs(wrapDeg(orbit.yaw - sw.writtenYaw)) > 0.05) sw.heldUntil = now + FOLLOW.holdSeconds * 1000;
    const { x, z } = l.state;
    if (!walking) { sw.vx = 0; sw.vz = 0; } else if (sw.last && dt > 0) {
      const vx = (x - sw.last.x) / dt, vz = (z - sw.last.z) / dt;
      // A teleport is not a walk.
      const blend = Math.hypot(vx, vz) > 15 ? 0 : 1 - Math.exp(-dt / FOLLOW.smoothSeconds);
      sw.vx += (vx - sw.vx) * blend;
      sw.vz += (vz - sw.vz) * blend;
    }
    sw.last = { x, z };
    if (l.follow && now >= sw.heldUntil) orbit.yaw = followYaw(orbit.yaw, sw.vx, sw.vz, dt);
    sw.writtenYaw = orbit.yaw;

    this.aimOrbit(l);
    // Never through a wall: the eye slides in along a boom from the head. In
    // at once when it would be inside a wall, or when the walker would stay
    // hidden behind one; out again on a spring.
    const collider = l.colliders?.colliderAt() ?? null;
    let fade = 1;
    if (collider) {
      const boom = boomFor(l.height);
      const pivot = pivotFor(l.state, l.height);
      const eye = eyeAt(orbit.target, orbit.yaw, orbit.pitch, orbit.distance);
      const full = Math.hypot(eye.x - pivot.x, eye.y - pivot.y, eye.z - pivot.z);
      const rate = dt > 0 ? 1 / dt : 0;
      const limit = boomLimit(collider, {
        pivot, eye, target: orbit.target, yaw: orbit.yaw, pitch: orbit.pitch, distance: orbit.distance,
        velocity: l.lastPivot ? { x: (pivot.x - l.lastPivot.x) * rate, y: 0, z: (pivot.z - l.lastPivot.z) * rate } : { x: 0, y: 0, z: 0 },
        yawRate: l.lastYaw === null ? 0 : wrapDeg(orbit.yaw - l.lastYaw) * rate,
        lastEye: l.lastEye,
      }, boom, l.height);
      l.lastPivot = pivot;
      l.lastYaw = orbit.yaw;
      if (l.easeIn && limit < full - 1e-3) {
        // The collider landed with the view already showing: spring in to the wall rather than cut to it.
        const [arm, speed] = stepBoom(Math.min(l.arm ?? full, full), l.armSpeed, limit, dt);
        l.arm = arm;
        l.armSpeed = speed;
        if (arm - limit < 1e-3) l.easeIn = false;
      } else if (l.arm !== null || limit < full - 1e-3) {
        l.easeIn = false;
        let [arm, speed] = stepBoom(Math.min(l.arm ?? full, full), l.armSpeed, full, dt);
        if (arm > limit) { arm = limit; speed = 0; }
        l.arm = arm < full - 1e-3 ? arm : null;
        l.armSpeed = l.arm === null ? 0 : speed;
      } else {
        l.easeIn = false;
      }
      orbit.eyeLimit = l.arm === null ? null : { pivot, length: l.arm };
      orbit.update();
      const drawn = this.scene.cameraEntity.getPosition();
      l.lastEye = { x: drawn.x, y: drawn.y, z: drawn.z };
      fade = fadeFor(drawn, pivot, l.height);
    } else {
      l.easeIn = !!l.colliders?.pending;
      orbit.eyeLimit = null;
      l.arm = null;
      l.armSpeed = 0;
      l.lastEye = l.lastPivot = null;
      l.lastYaw = null;
    }
    // A camera inside the head fades the body out; coarse steps, since a splat body re-uploads its opacity on each.
    l.fade = stepFade(l.fade, fade, dt);
    const shown = l.fade > 0.98 ? 1 : Math.round(l.fade * 32) / 32;
    if (shown !== l.fadeShown) {
      l.fadeShown = shown;
      l.character.setOpacity(shown);
    }
  }
}

/** The `outline` view's colours, RGBA. */
const OUTLINE_RGBA = [0.45, 0.95, 1, 1];
const FREE_RGBA = [0.35, 1, 0.55, 1];
const BLOCKED_RGBA = [1, 0.35, 0.35, 1];

function rgba(rgba: readonly number[], vertices: number): number[] {
  const out = new Array<number>(vertices * 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i % 4]!;
  return out;
}

function floorIndexOf(env: Environment): FloorIndex {
  try {
    return buildFloorIndex(env.sampleWorldSample(FLOOR_SAMPLE_POINTS));
  } catch (e) {
    // eslint-disable-next-line no-console -- non-fatal: the collider still answers where it has a floor
    console.warn('[SceneExplorer] floor sample failed:', e);
    return buildFloorIndex({ positions: new Float32Array(0), alpha: null });
  }
}

/** Feet at (x, y, z). Not `Character.setPosition`, which lowers `.vsplat` v1 feet that already sit on the origin. */
function placeCharacter(character: Character, x: number, y: number, z: number): void {
  const arm = character.armature;
  arm.move(arm.entity.getLocalPosition().clone().set(x, y, z));
}

function filenameOf(url: string): string {
  const path = url.split('?')[0] ?? '';
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /\.(spz|ply|sog|sogs|splat)$/i.test(base) ? base : 'scene.spz';
}
