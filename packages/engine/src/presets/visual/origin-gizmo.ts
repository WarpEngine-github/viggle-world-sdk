import { Color, Vec3 } from 'playcanvas';

import type { Scene } from '../../scene';

/**
 * Configuration for {@link OriginGizmo.create}.
 *
 * @group Presets
 * @category Visual
 */
export interface OriginGizmoOptions {
  /** Axis line length in world units. Default `0.4`. */
  size?: number;
  /** Line color as CSS hex. Default `#000000` (black). */
  color?: string;
  /** Start enabled. Default `false`. */
  enabled?: boolean;
}

/**
 * Draws a small three-axis gizmo (+X, +Y, +Z) at the world origin so the user
 * can see where `(0, 0, 0)` is - the pivot the motion clean-up transform
 * rotates around and where the character's root sits before any translation.
 *
 * Rendered every frame via the engine's immediate-mode line renderer with no
 * depth test, so it reads as an on-top marker.
 *
 * @group Presets
 * @category Visual
 */
export class OriginGizmo {
  /** Draw the gizmo this frame? Cheap to toggle. */
  enabled: boolean;

  private _scene: Scene;
  private readonly _points: Vec3[];
  private readonly _color: Color;
  private readonly _update: () => void;

  static create(scene: Scene, opts?: OriginGizmoOptions): OriginGizmo {
    return new OriginGizmo(scene, opts);
  }

  private constructor(scene: Scene, opts?: OriginGizmoOptions) {
    this._scene = scene;
    this.enabled = opts?.enabled ?? false;
    const s = opts?.size ?? 0.4;
    // Three lines from the origin along +X, +Y, +Z.
    this._points = [
      new Vec3(0, 0, 0), new Vec3(s, 0, 0),
      new Vec3(0, 0, 0), new Vec3(0, s, 0),
      new Vec3(0, 0, 0), new Vec3(0, 0, s),
    ];
    this._color = new Color().fromString(opts?.color ?? '#000000');
    this._update = () => this._draw();
    scene.app.on('update', this._update);
  }

  /** Unhook from the scene's update loop. Unusable afterwards. */
  destroy(): void {
    this._scene.app.off('update', this._update);
  }

  private _draw(): void {
    if (!this.enabled) return;
    // depthTest false - the gizmo is a reference marker meant to stay visible
    // even when it would fall behind the character.
    this._scene.app.drawLines(this._points, this._color, false);
  }
}
