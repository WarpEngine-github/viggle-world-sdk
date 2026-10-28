import { Vec3 } from 'playcanvas';
import type { AppBase, Entity } from 'playcanvas';

import type { IVfxInstance, IVfxPrefab } from './prefab';

interface PoolEntry {
  instance: IVfxInstance;
  active: boolean;
}

/**
 * Per-spawn knobs forwarded to the underlying {@link IVfxInstance}.
 *
 * @group Effects
 * @category Vfx
 */
export interface VfxSpawnOptions {
  /** Uniform scale multiplier applied via {@link IVfxInstance.setScale}. */
  scale?: number;
  /** RGB tint (0..1). Ignored if the prefab doesn't implement `setColor`. */
  color?: [number, number, number];
  /** Position offset added to the spawn position. */
  offset?: { x?: number; y?: number; z?: number };
  /** World-space Euler rotation (degrees) for the effect root. Ignored if
   *  the prefab doesn't implement `setRotation`. Use to aim directional
   *  effects (slash arcs, cones) at a target. */
  rotation?: { x?: number; y?: number; z?: number };
}

/**
 * Generic ring-buffer pool for VFX. Contains zero VFX-specific code - the
 * pool only knows how to call the {@link IVfxInstance} lifecycle. Prefab
 * choice (particles, mesh flashes, etc.) is supplied at construction.
 *
 * @group Effects
 * @category Vfx
 */
export class VfxPool {
  private readonly _entries: PoolEntry[];
  private readonly _prefab: IVfxPrefab;
  private readonly _scratchPos = new Vec3();

  constructor(prefab: IVfxPrefab, app: AppBase, root: Entity, size: number) {
    this._prefab = prefab;
    this._entries = Array.from({ length: size }, () => ({
      instance: prefab.create(app, root),
      active: false,
    }));
  }

  /**
   * Activate an effect at `pos`. If no free slot exists, the oldest slot
   * (index 0) is force-recycled.
   */
  spawn(pos: Vec3, opts?: VfxSpawnOptions): void {
    const entry = this._entries.find((e) => !e.active) ?? this._entries[0];
    if (entry.active) entry.instance.reset();
    entry.active = true;
    if (opts?.scale !== undefined) entry.instance.setScale(opts.scale);
    if (opts?.color && entry.instance.setColor) entry.instance.setColor(opts.color);
    if (opts?.rotation && entry.instance.setRotation) {
      entry.instance.setRotation(opts.rotation.x ?? 0, opts.rotation.y ?? 0, opts.rotation.z ?? 0);
    }
    const o = opts?.offset;
    const sp = o
      ? this._scratchPos.set(pos.x + (o.x ?? 0), pos.y + (o.y ?? 0), pos.z + (o.z ?? 0))
      : pos;
    entry.instance.spawn(sp);
  }

  /** Advance all active effects. Call once per frame. */
  update(dt: number): void {
    for (const entry of this._entries) {
      if (!entry.active) continue;
      const finished = entry.instance.update(dt);
      if (finished) {
        entry.active = false;
        entry.instance.reset();
      }
    }
  }

  /** Dispose all instances and the prefab's shared GPU resources. */
  destroy(): void {
    for (const entry of this._entries) entry.instance.dispose();
    this._prefab.dispose?.();
  }
}
