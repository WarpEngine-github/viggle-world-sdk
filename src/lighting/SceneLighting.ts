import type { SplatRelightOptions } from '@viggle/splat-engine';
import { SplatRelight } from '@viggle/splat-engine';

import { internalsOf } from '../explorer/internals.js';
import type { SceneTransform } from '../walk/placement.js';
import { fileToWorldAzimuth, fileToWorldPoint } from '../walk/placement.js';

/**
 * A sun over a scene's splats, cheap enough for a phone: the walker is lit by
 * it and throws a shadow on the floor. The scene's own baked light stays; the
 * sun only nudges it (`sceneStrength`).
 *
 * Directions and places are in the scene FILE's frame, as authored, and are
 * turned into the world by the explorer's placement.
 */
export interface SunLight {
  /** Where the sun is, degrees in the file's frame: 0 = +Z, 90 = +X. */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
  /** Default 1.8. */
  intensity?: number;
  /** CSS colour. Default a warm white. */
  color?: string;
  /** Sky fill. Default a soft blue at 0.35. */
  sky?: { color?: string; intensity?: number };
  /** How far the sun replaces the scene's baked look, 0..1. Default 0.1. */
  sceneStrength?: number;
  /** How far it replaces the walker's own colours, 0..1. Default 0.35. */
  bodyStrength?: number;
  /** How dark the walker's shadow is, 0..1. Default 0.5. */
  shadowStrength?: number;
  /** Shadow map texels a side. Default 2048 (1024 with `quality: 'low'`). */
  shadowResolution?: number;
  /** Default true. */
  shadows?: boolean;
  /** Where the floor takes shadows: a polygon of file (x, z) points. Default a 10 m box round the walk start. */
  region?: readonly (readonly [number, number])[];
  /** The scene's own lamps and glowing windows, as point lights in the file's frame (no shadows). */
  lamps?: readonly SceneLamp[];
}

export interface SceneLamp {
  at: readonly [number, number, number];
  /** CSS colour. Default a warm white. */
  color?: string;
  /** Default 1. */
  intensity?: number;
  /** Metres it reaches. Default 4. */
  range?: number;
}

export interface SceneLightingOptions {
  /** 'low' draws into smaller targets and lights one lamp: for phones. Default 'high'. */
  quality?: 'high' | 'low';
}

/** Metres a voxel of the floor's shadow proxy: it only has to receive a shadow. */
const FLOOR_VOXEL = 0.1;
/** Metres a voxel of the walker's proxy: a rough box of a person, not fingers. */
const BODY_VOXEL = 0.08;
/** The floor's lit band, metres below and above the walk start. */
const FLOOR_BELOW = 1.5;
const FLOOR_ABOVE = 3.5;
/** Half the side of the default shadow region, metres. */
const SPAWN_REGION = 5;

/**
 * Lights a loaded `SceneExplorer`. Create it after `explorer.load()`; it
 * ends by itself when the explorer loads another scene or is destroyed.
 */
export class SceneLighting {
  private relight: SplatRelight | null;
  private readonly stopListening: () => void;

  private constructor(relight: SplatRelight, stopListening: () => void, private transform: SceneTransform) {
    this.relight = relight;
    this.stopListening = stopListening;
  }

  /** Throws when the explorer has nothing loaded. */
  static create(explorer: object, sun: SunLight, opts: SceneLightingOptions = {}): SceneLighting {
    const internals = internalsOf(explorer);
    const loaded = internals.loaded;
    if (!loaded) throw new Error('SceneLighting.create: load a scene into the explorer first');
    const { environment, character, transform } = loaded;
    const low = opts.quality === 'low';
    const relight = SplatRelight.create(internals.scene, relightOptions(sun, transform, low));
    try {
      // The floor that takes the walker's shadow. A generated (+Y down) file is
      // filled from its own bottom, the ceiling, so its floor is left as it is.
      const region = sun.region?.map(([x, z]) => fileToWorldPoint(transform, [x, 0, z]))
        ?? [{ x: -SPAWN_REGION, z: -SPAWN_REGION }, { x: SPAWN_REGION, z: SPAWN_REGION }];
      const xs = region.map((p) => p.x), zs = region.map((p) => p.z);
      void relight.add(environment, {
        proxy: { voxelSize: FLOOR_VOXEL, ...(transform.rotation.x === 180 && { floorFill: false }) },
        bounds: {
          min: { x: Math.min(...xs), y: -FLOOR_BELOW, z: Math.min(...zs) },
          max: { x: Math.max(...xs), y: FLOOR_ABOVE, z: Math.max(...zs) },
        },
      }).catch(warn('floor not lit'));
      relight.setParams(environment, { strength: sun.sceneStrength ?? 0.1, shadowStrength: sun.shadowStrength ?? 0.5 });

      const lamps = low ? [...(sun.lamps ?? [])].sort((a, b) => Math.hypot(...a.at) - Math.hypot(...b.at)).slice(0, 1) : sun.lamps ?? [];
      for (const lamp of lamps) {
        relight.addPointLight({
          position: fileToWorldPoint(transform, lamp.at),
          color: lamp.color ?? '#ffd9a8',
          intensity: lamp.intensity ?? 1,
          range: lamp.range ?? 4,
        });
      }

      lightBody(relight, character, sun);
    } catch (e) {
      relight.destroy();
      throw e;
    }
    let lighting: SceneLighting | null = null;
    const stopUnload = internals.onUnload(() => lighting?.destroy());
    // A new body (`setCharacter`) takes the old one's light and shadow.
    const stopSwap = internals.onCharacterChange((previous) => {
      const r = lighting?.relight;
      const now = internals.loaded?.character;
      if (!r || !now) return;
      r.remove(previous);
      lightBody(r, now, sun);
    });
    lighting = new SceneLighting(relight, () => { stopUnload(); stopSwap(); }, transform);
    return lighting;
  }

  /** Move the sun (degrees, in the file's frame). */
  setSun(sun: { azimuth?: number; elevation?: number; intensity?: number }): void {
    const r = this.relight;
    if (!r) return;
    if (sun.azimuth !== undefined) r.lightAzimuth = fileToWorldAzimuth(this.transform, sun.azimuth);
    if (sun.elevation !== undefined) r.lightElevation = sun.elevation;
    if (sun.intensity !== undefined) r.lightIntensity = sun.intensity;
  }

  destroy(): void {
    if (!this.relight) return;
    this.stopListening();
    this.relight.destroy();
    this.relight = null;
  }
}

/**
 * The walker takes the sun but no shadow on itself (its blocky proxy would
 * speckle it); it still casts one on the floor.
 */
function lightBody(relight: SplatRelight, character: Parameters<SplatRelight['add']>[0], sun: SunLight): void {
  const bodyStrength = sun.bodyStrength ?? 0.35;
  void relight.add(character, { proxy: { voxelSize: BODY_VOXEL, dilate: 0 }, lightingReceiver: bodyStrength > 0 }).catch(warn('walker not lit'));
  relight.setParams(character, { strength: bodyStrength, shadowStrength: 0, ambient: 0.55 });
}

function relightOptions(sun: SunLight, transform: SceneTransform, low: boolean): SplatRelightOptions {
  const shadowResolution = sun.shadowResolution ?? 2048;
  return {
    light: {
      azimuth: fileToWorldAzimuth(transform, sun.azimuth),
      elevation: sun.elevation,
      intensity: sun.intensity ?? 1.8,
      color: sun.color ?? '#fff1d6',
      castShadows: sun.shadows ?? true,
      shadowResolution: low ? Math.min(shadowResolution, 1024) : shadowResolution,
      shadowDistance: 14,
      // The proxies are coarse blocks: a body must not shadow itself.
      shadowBias: 0.15,
      normalOffsetBias: 0.25,
    },
    sky: { color: sun.sky?.color ?? '#9db8e8', intensity: sun.sky?.intensity ?? 0.35 },
    receiveShadows: sun.shadows ?? true,
    resolutionScale: low ? 0.5 : 0.6,
    // Nothing is lit or shaded unless registered with its own values: the
    // walker's see-through copy must not take the floor's shadows.
    strength: 0,
    shadowStrength: 0,
    proxy: { surface: 'blocky', smoothIterations: 0, dilate: 0, voxelSize: BODY_VOXEL },
    blur: false,
    environmentRefresh: 'auto',
  };
}

const warn = (what: string) => (e: unknown) => {
  // eslint-disable-next-line no-console -- lighting is decoration: the scene still plays without it
  console.warn(`[SceneLighting] ${what}:`, e);
};
