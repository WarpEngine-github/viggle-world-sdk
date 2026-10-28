/**
 * Plug-in surface for VFX layer renderers.
 *
 * `JsonVfxPrefab` ships only mechanism - it walks `VfxEffectData.layers`,
 * resolves each layer's `type` against a `VfxLayerRegistry`, and asks the
 * matched renderer to build a `VfxLayerInstance`. The prefab owns the shared
 * time accounting (startDelay, duration, loop, alive flag) and per-frame
 * dispatch; the renderer owns everything specific to its layer type
 * (geometry, materials, per-frame uniform updates).
 *
 * Engine ships three renderers: `ParticleLayerRenderer`, `MeshLayerRenderer`,
 * `SpriteLayerRenderer` (one per primitive type in `data-types.ts`). Consumers
 * register their own (stylized fire ribbons, clouds, shields, ...) via the
 * editor / app boot code and extend `VfxLayerTypeMap` via declaration merging
 * so the union narrows correctly in user code.
 */

import type { AppBase, Entity, Vec3 } from 'playcanvas';
import type { VfxLayerBase } from './data-types';

/** Context passed when building a layer instance. */
export interface VfxLayerBuildContext {
  app: AppBase;
  /** Parent entity all per-layer entities attach under. */
  parent: Entity;
  /**
   * Render layer id for transparent geometry; `undefined` falls back to the
   * default world layer. The prefab applies this to every entity's render
   * component after the renderer returns, so most renderers can ignore it.
   */
  layerId?: number;
  /** Resolves asset paths (texture URLs etc.) found inside layer data. */
  resolveUrl: (path: string) => string;
}

/** Per-frame update context for a single layer instance. */
export interface VfxLayerUpdateContext {
  /**
   * Layer-local time in seconds since spawn, already shifted by
   * `layer.startDelay`. Negative when the layer hasn't started yet - most
   * renderers should just hide themselves while `alive` is false.
   */
  t: number;
  /** Frame delta in seconds. */
  dt: number;
  /** Wall-clock elapsed since spawn, ignoring `startDelay`. Useful for
   *  shader `uTime` uniforms that should run during the startDelay window
   *  (e.g. precomputed noise that doesn't depend on layer activation). */
  elapsed: number;
  /**
   * True while the layer is active - i.e. `t >= 0` AND (the effect loops OR
   * `t <= layerDuration`). Renderers should disable their entities and skip
   * uniform updates when this is false.
   */
  alive: boolean;
  /** Resolved layer duration: `layer.duration > 0 ? layer.duration : effectDuration`. */
  layerDuration: number;
  /** Whether the parent effect loops. */
  loop: boolean;
}

/** One runtime instance of a single layer. The prefab owns N of these. */
export interface VfxLayerInstance {
  /** Show + activate at world position. Called on `JsonVfxInstance.spawn`. */
  spawn(pos: Vec3): void;
  /** Hide + return to dormant. Called by `JsonVfxInstance.reset` / before recycle. */
  reset(): void;
  /** Per-frame tick. See `VfxLayerUpdateContext` for time semantics. */
  update(ctx: VfxLayerUpdateContext): void;
  /** Free GPU resources. Called on `JsonVfxInstance.dispose`. */
  dispose(): void;
  /** Optional: move the active instance to a new world position. */
  moveTo?(pos: Vec3): void;
  /** Optional: set per-instance uniform scale. */
  setScale?(s: number): void;
  /** Optional: set per-instance color tint. */
  setColor?(rgb: [number, number, number]): void;
}

/** Factory for one layer type, registered with the registry by name. */
export interface VfxLayerRenderer<L extends VfxLayerBase = VfxLayerBase> {
  /** The discriminator string this renderer handles ('particle', 'cloud', ...). */
  readonly type: string;
  /** Build a runtime instance from one layer definition. */
  build(layer: L, ctx: VfxLayerBuildContext): VfxLayerInstance;
}

/** Layer-type → renderer registry. Passed to `VfxStage` / `JsonVfxPrefab`. */
export class VfxLayerRegistry {
  private readonly _renderers = new Map<string, VfxLayerRenderer>();

  register<L extends VfxLayerBase>(renderer: VfxLayerRenderer<L>): this {
    this._renderers.set(renderer.type, renderer as unknown as VfxLayerRenderer);
    return this;
  }

  get(type: string): VfxLayerRenderer | undefined {
    return this._renderers.get(type);
  }

  has(type: string): boolean {
    return this._renderers.has(type);
  }
}

// Engine-default renderers live in `./layers/`. Imports are at module-top to
// keep the dependency graph static (layer modules only import _types_ back
// from this file, so there's no value-level cycle).
import { ParticleLayerRenderer } from './layers/particle';
import { MeshLayerRenderer } from './layers/mesh';
import { SpriteLayerRenderer } from './layers/sprite';
import { ShaderLayerRenderer } from './layers/shader';

/**
 * Returns a registry pre-populated with the engine-default layer renderers
 * (`particle`, `mesh`, `sprite`, `shader`). Consumers extend it with their
 * own stylized renderers and pass the result to `VfxStage`.
 */
export function defaultLayerRegistry(): VfxLayerRegistry {
  return new VfxLayerRegistry()
    .register(new ParticleLayerRenderer())
    .register(new MeshLayerRenderer())
    .register(new SpriteLayerRenderer())
    .register(new ShaderLayerRenderer());
}
