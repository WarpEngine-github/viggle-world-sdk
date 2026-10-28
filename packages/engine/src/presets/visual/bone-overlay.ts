import { Color, Vec3 } from 'playcanvas';

import type { Armature } from '../../armature';
import type { Scene } from '../../scene';

/**
 * Configuration for {@link BoneOverlay.create}.
 *
 * @group Presets
 * @category Visual
 */
export interface BoneOverlayOptions {
  /** Line color as CSS hex (e.g. `#40ffa0`). Default `#40ffa0`. */
  color?: string;
  /** Include `FACIAL_*` bones from the full 441-bone rig. Default `false` -
   *  the ~356 facial bones collapse into an unreadable blob at body scale. */
  includeFacial?: boolean;
  /** Start enabled. Default `false`. */
  enabled?: boolean;
}

const FACIAL_PREFIX = 'FACIAL_';

/**
 * Debug skeleton visualization: draws one line per parent→child bone pair of
 * an {@link Armature}, on top of everything (no depth test), refreshed every
 * frame via the engine's immediate-mode line renderer.
 *
 * Attach/detach armatures freely - the overlay survives character swaps:
 *
 * ```ts
 * const bones = BoneOverlay.create(scene, { color: '#40ffa0' });
 * bones.armature = character.armature;
 * bones.enabled = true;
 * ```
 *
 * @group Presets
 * @category Visual
 */
export class BoneOverlay {
  /** Draw the overlay this frame? Cheap to toggle - no scene graph churn. */
  enabled: boolean;

  private _scene: Scene;
  private _armature: Armature | null = null;
  private readonly _color: Color;
  private readonly _includeFacial: boolean;
  /** Per-bone draw filter, rebuilt when the armature (rig) changes. */
  private _boneVisible: boolean[] = [];
  /** Scratch endpoint pool reused across frames to avoid per-frame allocs. */
  private readonly _points: Vec3[] = [];
  private readonly _update: () => void;

  /** Create a bone overlay bound to `scene`. Assign {@link armature} to pick
   *  which rig it draws. */
  static create(scene: Scene, opts?: BoneOverlayOptions): BoneOverlay {
    return new BoneOverlay(scene, opts);
  }

  private constructor(scene: Scene, opts?: BoneOverlayOptions) {
    this._scene = scene;
    this._color = new Color().fromString(opts?.color ?? '#40ffa0');
    this._includeFacial = opts?.includeFacial ?? false;
    this.enabled = opts?.enabled ?? false;
    this._update = () => this._draw();
    scene.app.on('update', this._update);
  }

  /** The rig being visualized. Set `null` to blank the overlay (e.g. between
   *  character swaps) without destroying it. */
  get armature(): Armature | null {
    return this._armature;
  }

  set armature(a: Armature | null) {
    this._armature = a;
    this._boneVisible = [];
  }

  /** Change the line color at runtime. */
  setColor(hex: string): void {
    this._color.fromString(hex);
  }

  /** Unhook from the scene's update loop. The overlay is unusable afterwards. */
  destroy(): void {
    this._scene.app.off('update', this._update);
    this._armature = null;
    this._points.length = 0;
  }

  /** Resolve which bones to draw. Bone names live in the scene's skeleton
   *  library keyed by rig size (441 = body + facial, otherwise std body). */
  private _resolveFilter(numBones: number): boolean[] {
    const visible: boolean[] = Array.from({ length: numBones }, () => true);
    if (this._includeFacial) return visible;
    const lib = this._scene.skeletonLibrary;
    const names = numBones === lib?.boneNames441?.length ? lib.boneNames441 : lib?.boneNames;
    if (!names) return visible;
    const n = Math.min(numBones, names.length);
    for (let i = 0; i < n; i++) {
      if (names[i].startsWith(FACIAL_PREFIX)) visible[i] = false;
    }
    return visible;
  }

  private _draw(): void {
    if (!this.enabled) return;
    const arm = this._armature;
    const parents = arm?.armatureData.stdMaleParents;
    if (!arm || !parents) return;

    const numBones = arm.numBones;
    if (this._boneVisible.length !== numBones) {
      this._boneVisible = this._resolveFilter(numBones);
    }

    // Grow the endpoint pool to worst case once, then reuse.
    while (this._points.length < numBones * 2) this._points.push(new Vec3());

    let n = 0;
    for (let i = 0; i < numBones; i++) {
      const pi = parents[i];
      if (pi < 0 || !this._boneVisible[i] || !this._boneVisible[pi]) continue;
      const childM = arm.getBoneWorldMatrix(i);
      const parentM = arm.getBoneWorldMatrix(pi);
      if (!childM || !parentM) continue;
      parentM.getTranslation(this._points[n++]);
      childM.getTranslation(this._points[n++]);
    }
    if (n === 0) return;

    // depthTest false - the skeleton reads as an overlay on top of the splat,
    // and splat-only scenes have no depth buffer to test against anyway.
    this._scene.app.drawLines(this._points.slice(0, n), this._color, false);
  }
}
