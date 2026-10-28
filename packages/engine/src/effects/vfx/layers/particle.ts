/**
 * Particle layer - wraps PlayCanvas `ParticleSystemComponent` with the same
 * JSON schema the editor speaks. The renderer translates the JSON keys into
 * the component's option bag once at build time; per-frame `update` only
 * stops/restarts the emitter based on lifetime + loop semantics (the heavy
 * lifting happens inside PlayCanvas).
 */

import {
  BLEND_ADDITIVE,
  BLEND_NORMAL,
  Curve,
  Entity,
  Vec3,
} from 'playcanvas';
import type { AppBase } from 'playcanvas';

import type {
  CurvePoint,
  ColorCurvePoint,
  VfxLayerBase,
} from '../data-types';
import type {
  VfxLayerBuildContext,
  VfxLayerInstance,
  VfxLayerRenderer,
  VfxLayerUpdateContext,
} from '../layer-renderer';
import {
  colorCurveToPcSet,
  curveToPc,
  vec3CurveSet,
  vec3OrUndefined,
} from './shared';

export interface VfxParticleLayer extends VfxLayerBase {
  type: 'particle';

  numParticles: number;
  lifetime: number;
  rate: number;
  rate2?: number;

  emitterShape: 'box' | 'sphere';
  emitterRadius?: number;
  emitterExtents?: [number, number, number];

  localVelocity?: [number, number, number];
  localVelocity2?: [number, number, number];
  velocity?: [number, number, number];
  velocity2?: [number, number, number];

  initialVelocity?: number;
  gravity?: [number, number, number];

  startAngle?: number;
  startAngle2?: number;

  scaleGraph?: CurvePoint[];
  colorGraph?: ColorCurvePoint[];
  alphaGraph?: CurvePoint[];
  rotationSpeedGraph?: CurvePoint[];
  radialSpeedGraph?: CurvePoint[];
  radialSpeedGraph2?: CurvePoint[];

  blendType: 'additive' | 'alpha';
  depthWrite: boolean;
  depthSoftening?: number;

  loop: boolean;
  preWarm: boolean;

  stretch?: number;
  alignToMotion?: boolean;
  localSpace?: boolean;
  positionOffset?: [number, number, number];
}

class ParticleLayerInstance implements VfxLayerInstance {
  private readonly _ent: Entity;
  private readonly _layer: VfxParticleLayer;

  constructor(ent: Entity, layer: VfxParticleLayer) {
    this._ent = ent;
    this._layer = layer;
  }

  spawn(_pos: Vec3): void {
    if (!this._layer.enabled) return;
    this._ent.enabled = true;
    const ps = this._ent.particlesystem;
    if (ps) {
      ps.reset();
      ps.play();
    }
  }

  update(ctx: VfxLayerUpdateContext): void {
    const layer = this._layer;
    if (!layer.enabled) { this._ent.enabled = false; return; }
    if (ctx.t < 0) { this._ent.enabled = false; return; }

    this._ent.enabled = true;
    if (!layer.loop && ctx.t > ctx.layerDuration) {
      const ps = this._ent.particlesystem;
      if (ps) ps.stop();
    }
  }

  reset(): void {
    const ps = this._ent.particlesystem;
    if (ps) { ps.stop(); ps.reset(); }
    this._ent.enabled = false;
  }

  dispose(): void {
    // Owned by the prefab's root entity - it's destroyed when the root is.
  }

  /** Editor pause/resume escape hatch. Surfaced through JsonVfxInstance. */
  setPaused(paused: boolean): void {
    const ps = this._ent.particlesystem;
    if (!ps) return;
    if (paused) {
      ps.stop();
    } else if (this._layer.enabled) {
      ps.reset();
      ps.play();
    }
  }
}

export class ParticleLayerRenderer implements VfxLayerRenderer<VfxParticleLayer> {
  readonly type = 'particle';

  build(layer: VfxParticleLayer, ctx: VfxLayerBuildContext): VfxLayerInstance {
    const ent = buildParticleEntity(ctx.app, ctx.parent, layer);
    return new ParticleLayerInstance(ent, layer);
  }
}

function buildParticleEntity(_app: AppBase, parent: Entity, layer: VfxParticleLayer): Entity {
  const ent = new Entity(`vfx_particle_${layer.id}`);

  const colorGraph = colorCurveToPcSet(layer.colorGraph);
  const alphaGraph = curveToPc(layer.alphaGraph);
  const scaleGraph = curveToPc(layer.scaleGraph);
  const rotSpeedGraph = curveToPc(layer.rotationSpeedGraph);

  const blendType = layer.blendType === 'additive' ? BLEND_ADDITIVE : BLEND_NORMAL;
  const isBox = layer.emitterShape === 'box';

  const opts: Record<string, unknown> = {
    autoPlay: true,
    numParticles: layer.numParticles ?? 30,
    lifetime: layer.lifetime ?? 1,
    rate: layer.rate ?? 10,
    rate2: layer.rate2 ?? layer.rate ?? 10,
    emitterShape: isBox ? 0 : 1,
    emitterRadius: layer.emitterRadius ?? 0.1,
    emitterExtents: vec3OrUndefined(layer.emitterExtents) ?? new Vec3(0.1, 0.1, 0.1),
    startAngle: layer.startAngle ?? 0,
    startAngle2: layer.startAngle2 ?? 0,
    loop: layer.loop ?? false,
    preWarm: layer.preWarm ?? false,
    blendType,
    depthWrite: layer.depthWrite ?? false,
    depthSoftening: layer.depthSoftening ?? 0,
    stretch: layer.stretch ?? 0,
    alignToMotion: layer.alignToMotion ?? false,
    initialVelocity: layer.initialVelocity ?? 0,
    localSpace: layer.localSpace ?? false,
  };

  const localVelGraph = vec3CurveSet(layer.localVelocity);
  if (localVelGraph) {
    opts.localVelocityGraph = localVelGraph;
    opts.localVelocityGraph2 = vec3CurveSet(layer.localVelocity2 ?? layer.localVelocity) ?? localVelGraph;
  }
  const velGraph = vec3CurveSet(layer.velocity);
  if (velGraph) {
    opts.velocityGraph = velGraph;
    opts.velocityGraph2 = vec3CurveSet(layer.velocity2 ?? layer.velocity) ?? velGraph;
  }
  if (colorGraph) opts.colorGraph = colorGraph;
  if (alphaGraph) opts.alphaGraph = alphaGraph;
  if (scaleGraph) { opts.scaleGraph = scaleGraph; } else { opts.scaleGraph = new Curve([0, 0.1, 1, 0.1]); }
  if (rotSpeedGraph) opts.rotationSpeedGraph = rotSpeedGraph;

  if (layer.gravity) {
    opts.gravity = new Vec3(layer.gravity[0], layer.gravity[1], layer.gravity[2]);
  }

  if (layer.radialSpeedGraph && layer.radialSpeedGraph.length > 0) {
    const keys: number[] = [];
    for (const [t, v] of layer.radialSpeedGraph) { keys.push(t, v); }
    opts.radialSpeedGraph = new Curve(keys);
  }
  if (layer.radialSpeedGraph2 && layer.radialSpeedGraph2.length > 0) {
    const keys: number[] = [];
    for (const [t, v] of layer.radialSpeedGraph2) { keys.push(t, v); }
    opts.radialSpeedGraph2 = new Curve(keys);
  } else if (opts.radialSpeedGraph) {
    opts.radialSpeedGraph2 = opts.radialSpeedGraph;
  }

  const [px, py, pz] = layer.positionOffset ?? [0, 0, 0];
  ent.setLocalPosition(px, py, pz);

  parent.addChild(ent);
  ent.addComponent('particlesystem', opts);

  return ent;
}

/** Type guard for the prefab's editor escape hatch `setParticlesPaused`. */
export function isParticleLayerInstance(inst: VfxLayerInstance): inst is ParticleLayerInstance {
  return inst instanceof ParticleLayerInstance;
}
