import {
  BLEND_ADDITIVE,
  Color,
  Entity,
  StandardMaterial,
} from 'playcanvas';
import type { AppBase, Vec3 } from 'playcanvas';

import type { IVfxInstance, IVfxPrefab } from '../../effects/vfx/prefab';

/**
 * Options for {@link MeshFlash}.
 *
 * @group Effects
 * @category Vfx
 */
export interface MeshFlashOptions {
  /** Total lifetime in seconds. Default 0.4. */
  duration?: number;
  /** Base RGB emissive color (0..1). Default `[1.0, 0.8, 0.4]` (warm spark). */
  color?: [number, number, number];
  /** Peak radius the sphere grows to. Default 0.5 (world units). */
  peakRadius?: number;
}

/**
 * Generic VFX builtin: an additively-blended sphere that grows from a tiny
 * point to {@link MeshFlashOptions.peakRadius peakRadius} while its emissive
 * intensity fades to zero. Useful for hit-sparks, pickup glows, small impact
 * highlights.
 *
 * Single shared `StandardMaterial` per pool - `setColor` mutates the shared
 * emissive, so all currently-active flashes in one pool render the same
 * tint. That keeps the cost flat and is the right trade-off for one-shot
 * effects; a future builtin with per-instance color would clone the material
 * per slot.
 *
 * ```ts
 * import { VfxStage, MeshFlash } from '@viggle/splat-engine';
 *
 * const stage = new VfxStage(scene);
 * stage.register('flash', new MeshFlash({ color: [1, 0.6, 0.2] }));
 * stage.play('flash', somePosition);
 * ```
 *
 * @group Effects
 * @category Vfx
 */
export class MeshFlash implements IVfxPrefab {
  private readonly _duration: number;
  private readonly _peakRadius: number;
  private readonly _color: Color;
  private readonly _material: StandardMaterial;

  constructor(opts: MeshFlashOptions = {}) {
    this._duration = opts.duration ?? 0.4;
    this._peakRadius = opts.peakRadius ?? 0.5;
    const c = opts.color ?? [1.0, 0.8, 0.4];
    this._color = new Color(c[0], c[1], c[2]);

    const mat = new StandardMaterial();
    mat.diffuse = new Color(0, 0, 0);
    mat.emissive = this._color;
    mat.emissiveIntensity = 1;
    mat.useLighting = false;
    mat.blendType = BLEND_ADDITIVE;
    mat.depthWrite = false;
    mat.opacity = 1;
    mat.update();
    this._material = mat;
  }

  create(_app: AppBase, parent: Entity): IVfxInstance {
    return new MeshFlashInstance(parent, this._material, this._duration, this._peakRadius);
  }

  /** Update the shared emissive color in-place. Affects all active instances. */
  setColor(rgb: [number, number, number]): void {
    this._color.set(rgb[0], rgb[1], rgb[2]);
    this._material.emissive = this._color;
    this._material.update();
  }

  dispose(): void {
    this._material.destroy();
  }
}

class MeshFlashInstance implements IVfxInstance {
  private readonly _entity: Entity;
  private readonly _material: StandardMaterial;
  private readonly _duration: number;
  private readonly _peakRadius: number;
  private _baseScale = 1;
  private _age = 0;

  constructor(parent: Entity, material: StandardMaterial, duration: number, peakRadius: number) {
    this._material = material;
    this._duration = duration;
    this._peakRadius = peakRadius;

    this._entity = new Entity('vfx-flash');
    this._entity.addComponent('render', { type: 'sphere' });
    const render = this._entity.render;
    if (render) {
      for (const mi of render.meshInstances) mi.material = material;
    }
    this._entity.enabled = false;
    parent.addChild(this._entity);
  }

  spawn(pos: Vec3): void {
    this._entity.setPosition(pos.x, pos.y, pos.z);
    this._age = 0;
    // Sphere primitive has unit diameter (radius 0.5). Start near-zero.
    const s = 0.05 * this._baseScale;
    this._entity.setLocalScale(s, s, s);
    this._entity.enabled = true;
  }

  update(dt: number): boolean {
    this._age += dt;
    const t = this._age / this._duration;
    if (t >= 1) return true;
    // Ease-out scale 0.05 → peak.
    const k = 1 - (1 - t) * (1 - t);
    const radius = (0.05 + (this._peakRadius * 2 - 0.05) * k) * this._baseScale;
    this._entity.setLocalScale(radius, radius, radius);
    // Linear alpha fade. StandardMaterial caches this - update() pushes it.
    this._material.opacity = 1 - t;
    this._material.update();
    return false;
  }

  reset(): void {
    this._entity.enabled = false;
  }

  dispose(): void {
    this._entity.destroy();
  }

  setScale(s: number): void {
    this._baseScale = s;
  }
}
