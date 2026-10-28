import { Color, Entity, LAYERID_WORLD } from 'playcanvas';

import type { Scene } from '../../scene';

interface Vec3Like { x: number; y: number; z: number }

/**
 * Light for mesh characters: an ambient level plus a fill and a rim
 * directional light, each aimed from its position at the origin. Splats ignore
 * all three - they are lit by their own shader - so this touches nothing but
 * PlayCanvas standard materials.
 *
 * Intensities are on three.js's scale, where both light kinds are divided by π
 * in the shading; PlayCanvas applies them as given, so they are divided here.
 * A three.js stage's numbers carry over unchanged.
 */
export interface MeshLightsLook {
  ambient: number;
  fill: number;
  rim: number;
  fillPosition: Vec3Like;
  rimPosition: Vec3Like;
}

/** @group Presets */
export class MeshLights {
  private readonly _scene: Scene;
  private readonly _fill: Entity;
  private readonly _rim: Entity;
  /** The scene's ambient before {@link set}, put back on destroy. */
  private readonly _ambient: Color;

  private constructor(scene: Scene) {
    this._scene = scene;
    this._ambient = scene.app.scene.ambientLight.clone();
    // The overlay layer too: a see-through copy (`MeshCharacter.addOverlay`)
    // has to shade exactly like the body it repaints.
    const layers = [LAYERID_WORLD, scene.overlayLayerId];
    this._fill = directional('mesh-fill-light', layers);
    this._rim = directional('mesh-rim-light', layers);
    scene.app.root.addChild(this._fill);
    scene.app.root.addChild(this._rim);
  }

  static create(scene: Scene, look: MeshLightsLook): MeshLights {
    const lights = new MeshLights(scene);
    lights.set(look);
    return lights;
  }

  set(look: MeshLightsLook): void {
    const a = look.ambient / Math.PI;
    this._scene.app.scene.ambientLight.set(a, a, a);
    aim(this._fill, look.fillPosition, look.fill);
    aim(this._rim, look.rimPosition, look.rim);
  }

  destroy(): void {
    this._scene.app.scene.ambientLight.copy(this._ambient);
    this._fill.destroy();
    this._rim.destroy();
  }
}

function directional(name: string, layers: number[]): Entity {
  const e = new Entity(name);
  e.addComponent('light', { type: 'directional', color: new Color(1, 1, 1), castShadows: false, layers });
  return e;
}

function aim(light: Entity, from: Vec3Like, intensity: number): void {
  light.setPosition(from.x, from.y, from.z);
  light.lookAt(0, 0, 0);
  // A directional light shines down its local -Y; lookAt aimed -Z.
  light.rotateLocal(90, 0, 0);
  light.light!.intensity = intensity / Math.PI;
}
