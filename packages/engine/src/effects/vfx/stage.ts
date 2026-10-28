import type { Vec3 } from 'playcanvas';

import type { Scene } from '../../scene';
import { VfxPool } from './pool';
import type { VfxSpawnOptions } from './pool';
import type { IVfxPrefab, IVfxInstance } from './prefab';
import { JsonVfxPrefab } from './json-vfx-prefab';
import type { VfxEffectData } from './data-types';
import { defaultLayerRegistry } from './layer-renderer';
import type { VfxLayerRegistry } from './layer-renderer';

/** Optional construction extras the editor + cutscene flows need. */
export interface VfxStageOptions {
  /** Layer id VFX-rendered geometry writes to. Omitted = default world-opaque. */
  layerId?: number;
  /** URL resolver for asset paths inside VfxEffectData (e.g. sprite textures).
   *  Identity when omitted - editor previews pass already-resolved URLs through. */
  resolveUrl?: (path: string) => string;
  /**
   * Layer-type → renderer registry. Defaults to `defaultLayerRegistry()`
   * (particle + mesh + sprite). Consumers extend it with their own stylized
   * renderers (cloud, shield, lightning, …) by registering them on a fresh
   * registry and passing it here.
   */
  registry?: VfxLayerRegistry;
}

/**
 * VFX render host for one scene.
 *
 * Two paths for spawning effects - pick by use case:
 *
 *  - Gameplay (fire-and-forget, pool-backed):
 *      stage.register('punch_hit', prefab, 8);
 *      stage.play('punch_hit', pos);   // recycled instance, you don't keep a handle
 *
 *  - Editor / cutscene (long-lived handle you control):
 *      const prefab = stage.buildPrefab(jsonData);
 *      const instance = stage.spawn(prefab);
 *      instance.seekTo(t); instance.moveTo(pos); instance.dispose();
 *
 * The two paths share the IVfxPrefab/IVfxInstance contracts; only the
 * lifecycle differs. Don't retain handles from `play` - the pool reserves
 * the right to recycle.
 *
 * @group Effects
 * @category Vfx
 */
export class VfxStage {
  private readonly _scene: Scene;
  private readonly _pools = new Map<string, VfxPool>();
  private readonly _resolveUrl?: (path: string) => string;
  private readonly _layerId?: number;
  private readonly _registry: VfxLayerRegistry;

  constructor(scene: Scene, opts: VfxStageOptions = {}) {
    this._scene = scene;
    this._resolveUrl = opts.resolveUrl;
    this._layerId = opts.layerId;
    this._registry = opts.registry ?? defaultLayerRegistry();
  }

  /** Convenience getters - used by buildPrefab and one-off instantiation. */
  get app() { return this._scene.app; }
  get contentRoot() { return this._scene.contentRoot; }
  get layerId(): number | undefined { return this._layerId; }
  get registry(): VfxLayerRegistry { return this._registry; }

  // ── Gameplay path: register once, play many times ───────────────────────

  /** Register a prefab under `name`. Allocates a pool of `poolSize` instances
   *  eagerly so first-spawn doesn't pay the GPU-allocation cost. Re-registering
   *  the same name disposes the previous pool. */
  register(name: string, prefab: IVfxPrefab, poolSize = 8): void {
    const existing = this._pools.get(name);
    if (existing) existing.destroy();
    const pool = new VfxPool(prefab, this._scene.app, this._scene.contentRoot, poolSize);
    this._pools.set(name, pool);
  }

  /** Fire one shot of a registered prefab at `pos`. Returns false if no
   *  prefab is registered under that name. Caller doesn't keep a handle -
   *  the pool reuses the slot when the effect finishes. */
  play(name: string, pos: Vec3, opts?: VfxSpawnOptions): boolean {
    const pool = this._pools.get(name);
    if (!pool) return false;
    pool.spawn(pos, opts);
    return true;
  }

  // ── Editor / cutscene path: handle-controlled live instance ──────────────

  /** Compile JSON layer data into a runnable prefab. Uses the stage's
   *  registry + resolveUrl + layerId defaults. The returned prefab can be
   *  passed to `spawn` (handle path) or `register` (pool path) interchangeably. */
  buildPrefab(data: VfxEffectData): JsonVfxPrefab {
    return new JsonVfxPrefab(data, this._registry, this._resolveUrl, this._layerId);
  }

  /** Create one instance you own. Returns the live handle - drive it with
   *  spawn(pos) / update(dt) / dispose() yourself. Bypasses the pool. */
  spawn(prefab: IVfxPrefab): IVfxInstance {
    return prefab.create(this._scene.app, this._scene.contentRoot);
  }

  // ── Shared ──────────────────────────────────────────────────────────────

  /** Tick every registered pool. Drive this from your scene's update loop.
   *  Handle-instances (from `spawn`) are NOT ticked here - caller owns the
   *  update loop for those. */
  update(dt: number): void {
    for (const pool of this._pools.values()) pool.update(dt);
  }

  /** Dispose every registered pool. Does NOT dispose handle-instances -
   *  caller is responsible for those. */
  destroy(): void {
    for (const pool of this._pools.values()) pool.destroy();
    this._pools.clear();
  }
}
