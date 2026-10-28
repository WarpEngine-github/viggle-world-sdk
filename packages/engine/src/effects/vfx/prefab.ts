import type { AppBase, Entity, Vec3 } from 'playcanvas';

/**
 * One recycled VFX instance managed by {@link VfxPool}.
 *
 * Lifecycle:
 *   - `create` (by the prefab) → entity + GPU objects allocated, kept hidden.
 *   - `spawn(pos)` → entity enabled at `pos`, age timer reset.
 *   - `update(dt)` each frame → animate; return `true` once the effect has
 *      finished playing so the pool can recycle the slot.
 *   - `reset()` → hide and return to dormant. Called by the pool both when
 *      recycling a finished effect and when force-recycling the oldest slot.
 *   - `dispose()` → destroy entity + owned GPU objects. Called by the pool's
 *      destroy.
 *
 * @group Effects
 * @category Vfx
 */
export interface IVfxInstance {
  spawn(pos: Vec3): void;
  update(dt: number): boolean;
  reset(): void;
  dispose(): void;
  setScale(s: number): void;
  /** Optional RGB tint (0..1). Implementations may ignore. */
  setColor?(rgb: [number, number, number]): void;
  /** Move an active instance to a new world-space position. Optional -
   *  implementations like fire-and-forget bursts may ignore. */
  moveTo?(pos: Vec3): void;
  /** Apply world-space Euler rotation (degrees) to the effect root.
   *  Optional - fire-and-forget instances that don't care about orientation
   *  can omit this. */
  setRotation?(xDeg: number, yDeg: number, zDeg: number): void;
}

/**
 * Factory for one kind of VFX instance, consumed by {@link VfxPool}.
 *
 * @group Effects
 * @category Vfx
 */
export interface IVfxPrefab {
  create(app: AppBase, parent: Entity): IVfxInstance;
  /** Release shared GPU resources (mesh, texture, …). Called once per pool. */
  dispose?(): void;
}
