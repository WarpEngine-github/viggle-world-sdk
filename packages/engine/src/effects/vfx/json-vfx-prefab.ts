/**
 * JsonVfxPrefab - generic JSON-walker that turns a `VfxEffectData` into a
 * runnable VFX. Knows nothing about specific layer types: looks each layer's
 * `type` up in a `VfxLayerRegistry` and delegates construction + per-frame
 * tick to the matched `VfxLayerRenderer`.
 *
 * Owns:
 *   - Root entity and its rotation animation (`rootRotationSpeed`).
 *   - Shared time math: `elapsed`, `loop`, per-layer `startDelay` + duration
 *     resolution. Renderers receive a clean `VfxLayerUpdateContext`.
 *   - Optional position trail (puff entities sampled from root's path).
 *
 * Implements the `IVfxPrefab` / `IVfxInstance` contracts so it plugs into
 * `VfxPool` (gameplay path) and `VfxStage.spawn` (editor path) unchanged.
 */

import { Entity, Vec3 } from 'playcanvas';
import type { AppBase, StandardMaterial } from 'playcanvas';

import type { IVfxInstance, IVfxPrefab } from './prefab';
import type { VfxEffectData, VfxLayer, VfxTrailConfig } from './data-types';
import type {
  VfxLayerBuildContext,
  VfxLayerInstance,
  VfxLayerRegistry,
  VfxLayerUpdateContext,
} from './layer-renderer';
import { buildVfxTrailEntity } from './layers/mesh';
import { isParticleLayerInstance } from './layers/particle';

// ── Per-layer cached snapshot ───────────────────────────────────────────────

interface LayerSlot {
  layer: VfxLayer;
  instance: VfxLayerInstance;
  /** Resolved layer duration: `layer.duration > 0 ? layer.duration : effectDuration`. */
  duration: number;
}

// ── JsonVfxInstance ──────────────────────────────────────────────────────────

export class JsonVfxInstance implements IVfxInstance {
  private readonly _root: Entity;
  private readonly _slots: LayerSlot[];
  private readonly _duration: number;
  private readonly _loop: boolean;
  private readonly _rootRotSpeed: [number, number, number] | undefined;

  private readonly _trailEntities: Entity[];
  private readonly _trailMaterials: StandardMaterial[];
  private readonly _trailBuf: Vec3[];
  private readonly _trailConfig: VfxTrailConfig | undefined;
  private _trailHead = 0;
  private _trailTimer = 0;

  private _elapsed = 0;
  private _alive = false;
  private _scale = 1;
  /** Base world-space Euler (degrees) from the last `setRotation`, used to
   *  aim directional effects (e.g. a slash arc at its target). The root's
   *  rotation each frame is this base plus any `rootRotSpeed` spin, so a
   *  spinning effect still respects its spawn-time aim. */
  private readonly _baseEuler: [number, number, number] = [0, 0, 0];

  constructor(
    root: Entity,
    slots: LayerSlot[],
    duration: number,
    loop: boolean,
    rootRotSpeed?: [number, number, number],
    trailEntities?: Entity[],
    trailMaterials?: StandardMaterial[],
    trailConfig?: VfxTrailConfig,
  ) {
    this._root = root;
    this._slots = slots;
    this._duration = duration;
    this._loop = loop;
    this._rootRotSpeed = rootRotSpeed;
    this._trailEntities = trailEntities ?? [];
    this._trailMaterials = trailMaterials ?? [];
    this._trailConfig = trailConfig;
    this._trailBuf = Array.from({ length: this._trailEntities.length }, () => new Vec3());
    this.reset();
  }

  spawn(pos: Vec3): void {
    this._alive = true;
    this._elapsed = 0;
    this._root.setLocalPosition(pos.x, pos.y, pos.z);
    // Start from the aim set via setRotation (spin, if any, is added on top
    // each frame in update()). At t=0 there's no spin yet, so this is the
    // base aim alone.
    this._applyRootRotation(0);
    this._root.enabled = true;

    for (const slot of this._slots) slot.instance.spawn(pos);

    this._trailHead = 0;
    this._trailTimer = 0;
    for (const b of this._trailBuf) b.copy(pos);
    for (let i = 0; i < this._trailEntities.length; i++) {
      this._trailMaterials[i].opacity = 0;
      this._trailMaterials[i].update();
      this._trailEntities[i].setLocalPosition(pos.x, -999, pos.z);
    }

    // Run one tick at t=0 so every layer is in a defined state on the next
    // render frame, matching the old hand-rolled `_updateXxx(0)` blast.
    this._tickAllLayers(0, 0);
  }

  update(dt: number): boolean {
    if (!this._alive) return true;
    this._elapsed += dt;

    if (this._loop && this._elapsed >= this._duration && this._duration > 0) {
      this._elapsed %= this._duration;
    }

    const capped = (!this._loop && this._duration > 0)
      ? Math.min(this._elapsed, this._duration)
      : this._elapsed;

    if (this._rootRotSpeed) this._applyRootRotation(capped);

    this._updateTrail(dt);
    this._tickAllLayers(capped, dt);

    if (!this._loop && this._elapsed >= this._duration && this._duration > 0) {
      this._alive = false;
      return true;
    }
    return false;
  }

  reset(): void {
    this._alive = false;
    this._root.enabled = false;
    // Clear the aim so a recycled pool slot doesn't inherit the previous
    // spawn's rotation when the next spawn omits `opts.rotation`.
    this._baseEuler[0] = this._baseEuler[1] = this._baseEuler[2] = 0;
    for (const slot of this._slots) slot.instance.reset();
    for (let i = 0; i < this._trailEntities.length; i++) {
      this._trailMaterials[i].opacity = 0;
      this._trailMaterials[i].update();
      this._trailEntities[i].setLocalPosition(0, -999, 0);
    }
  }

  moveTo(pos: Vec3): void {
    this._root.setLocalPosition(pos.x, pos.y, pos.z);
  }

  setScale(s: number): void {
    this._scale = s;
    this._root.setLocalScale(s, s, s);
  }

  /** Aim the effect root: world-space Euler in degrees. Stored as the base
   *  orientation; `rootRotSpeed` spin (if any) is layered on top each frame.
   *  Call before/at spawn - the next `_applyRootRotation` picks it up. */
  setRotation(xDeg: number, yDeg: number, zDeg: number): void {
    this._baseEuler[0] = xDeg;
    this._baseEuler[1] = yDeg;
    this._baseEuler[2] = zDeg;
  }

  /** Write the root's rotation as base aim + spin at `time` seconds. With no
   *  spin this is just the base aim; with spin, the effect rotates about its
   *  aimed orientation rather than snapping back to world axes. */
  private _applyRootRotation(time: number): void {
    const spin = this._rootRotSpeed;
    this._root.setLocalEulerAngles(
      this._baseEuler[0] + (spin ? spin[0] * time : 0),
      this._baseEuler[1] + (spin ? spin[1] * time : 0),
      this._baseEuler[2] + (spin ? spin[2] * time : 0),
    );
  }

  /** Jump to an absolute time and evaluate all layers (for editor scrubbing). */
  seekTo(time: number): void {
    const dt = time - this._elapsed;
    this._elapsed = time;
    this._alive = true;
    this._root.enabled = true;

    if (this._rootRotSpeed) this._applyRootRotation(time);

    this._tickAllLayers(time, Math.max(0, dt));
    if (dt > 0) this._updateTrail(dt);
  }

  get elapsed(): number { return this._elapsed; }
  get alive(): boolean { return this._alive; }

  /** Stop or resume PlayCanvas particle systems (for editor pause). */
  setParticlesPaused(paused: boolean): void {
    for (const slot of this._slots) {
      if (isParticleLayerInstance(slot.instance)) {
        slot.instance.setPaused(paused);
      }
    }
  }

  dispose(): void {
    for (const slot of this._slots) slot.instance.dispose();
    this._root.destroy();
    for (const ent of this._trailEntities) ent.destroy();
  }

  // ── internal ──────────────────────────────────────────────────────────────

  private _tickAllLayers(elapsed: number, dt: number): void {
    for (const slot of this._slots) {
      const { layer, duration, instance } = slot;
      const localT = elapsed - layer.startDelay;
      const alive = layer.enabled
        && localT >= 0
        && (this._loop || duration <= 0 || localT <= duration);
      const ctx: VfxLayerUpdateContext = {
        t: localT,
        dt,
        elapsed,
        alive,
        layerDuration: duration,
        loop: this._loop,
      };
      instance.update(ctx);
    }
  }

  private _updateTrail(dt: number): void {
    const cfg = this._trailConfig;
    if (!cfg || this._trailEntities.length === 0) return;

    this._trailTimer += dt;
    if (this._trailTimer >= cfg.sampleInterval) {
      this._trailTimer -= cfg.sampleInterval;
      const p = this._root.getLocalPosition();
      this._trailBuf[this._trailHead].set(p.x, p.y, p.z);
      this._trailHead = (this._trailHead + 1) % this._trailEntities.length;
    }

    const count = this._trailEntities.length;
    for (let i = 0; i < count; i++) {
      const bufIdx = (this._trailHead - 1 - i + count * 2) % count;
      const tp = this._trailBuf[bufIdx];
      const frac = (i + 1) / (count + 1);
      const alpha = Math.max(0, (1 - frac) * cfg.maxOpacity);
      const scale = Math.max(0.02, (1 - frac * cfg.shrinkFactor) * cfg.radius * this._scale);
      this._trailEntities[i].setLocalPosition(tp.x, tp.y, tp.z);
      this._trailEntities[i].setLocalScale(scale, scale, scale);
      this._trailMaterials[i].opacity = alpha;
      this._trailMaterials[i].update();
    }
  }
}

// ── JsonVfxPrefab ────────────────────────────────────────────────────────────

export class JsonVfxPrefab implements IVfxPrefab {
  private readonly _data: VfxEffectData;
  private readonly _registry: VfxLayerRegistry;
  private readonly _resolveUrl: (path: string) => string;
  private readonly _layerId: number | undefined;
  private _count = 0;

  constructor(
    data: VfxEffectData,
    registry: VfxLayerRegistry,
    resolveUrl?: (path: string) => string,
    layerId?: number,
  ) {
    this._data = data;
    this._registry = registry;
    this._resolveUrl = resolveUrl ?? (p => p);
    this._layerId = layerId;
  }

  create(app: AppBase, parent: Entity): IVfxInstance {
    const idx = this._count++;
    const root = new Entity(`vfx_${this._data.name}_${idx}`);
    parent.addChild(root);

    const slots: LayerSlot[] = [];
    const buildCtx: VfxLayerBuildContext = {
      app,
      parent: root,
      layerId: this._layerId,
      resolveUrl: this._resolveUrl,
    };

    for (const layer of this._data.layers) {
      const renderer = this._registry.get(layer.type);
      if (!renderer) {
        // eslint-disable-next-line no-console
        console.warn(`[VFX] no renderer registered for layer type '${layer.type}' in effect '${this._data.name}'`);
        continue;
      }
      // Disabled layers are still constructed so the editor can toggle them
      // without rebuilding the prefab; the renderer's `update` skips work
      // while `layer.enabled` is false.
      const instance = renderer.build(layer, buildCtx);
      const duration = layer.duration > 0 ? layer.duration : this._data.duration;
      slots.push({ layer, instance, duration });
    }

    // Optional position trail (puff entities tracking the root entity).
    let trailEntities: Entity[] | undefined;
    let trailMaterials: StandardMaterial[] | undefined;
    const trailCfg = this._data.trail;
    if (trailCfg && trailCfg.count > 0) {
      trailEntities = [];
      trailMaterials = [];
      for (let i = 0; i < trailCfg.count; i++) {
        const { ent, mat } = buildVfxTrailEntity(
          app,
          parent,
          trailCfg.shape,
          trailCfg.color,
          trailCfg.emissiveIntensity ?? 1,
          trailCfg.blendMode,
          trailCfg.radius,
          `vfx_trail_${idx}_${i}`,
        );
        trailEntities.push(ent);
        trailMaterials.push(mat);
      }
    }

    // Apply render-layer id to every entity in the subtree so VFX geometry
    // lands on the camera's transparent layer (when configured).
    if (this._layerId !== undefined) {
      applyLayerIdRecursive(root, this._layerId);
      if (trailEntities) {
        for (const e of trailEntities) applyLayerIdRecursive(e, this._layerId);
      }
    }

    return new JsonVfxInstance(
      root,
      slots,
      this._data.duration,
      this._data.loop ?? false,
      this._data.rootRotationSpeed,
      trailEntities,
      trailMaterials,
      trailCfg,
    );
  }
}

function applyLayerIdRecursive(ent: Entity, layerId: number): void {
  if (ent.render) ent.render.layers = [layerId];
  const children = ent.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c instanceof Entity) applyLayerIdRecursive(c, layerId);
  }
}
