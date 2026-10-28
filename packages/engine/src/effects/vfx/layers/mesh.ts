/**
 * Mesh layer - procedural primitives (sphere / ring / spike / quad) with
 * animated material params, optional fan-out instancing, and an animated
 * scale/opacity/color stack driven by keyframes + sin pulses.
 *
 * Mesh builders are inlined here (instead of shared) because they're only
 * referenced by this renderer; the stylized stuff that used to live next to
 * them (ribbon / cloud / slash / etc.) moved out to GameEditor with its own
 * mesh code.
 */

import {
  BLEND_ADDITIVE,
  BLEND_NORMAL,
  CULLFACE_BACK,
  CULLFACE_NONE,
  Color,
  Entity,
  Mesh,
  MeshInstance,
  StandardMaterial,
  Vec3,
} from 'playcanvas';
import type { AppBase, GraphicsDevice } from 'playcanvas';

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
import { lerpColorCurve, lerpCurve, quatFromForward } from './shared';

// ── Public data type ─────────────────────────────────────────────────────────

export type MeshShape = 'sphere' | 'ring' | 'spike' | 'quad';

export type InstancePattern =
  | 'single'
  | 'uniform-sphere'
  | 'uniform-circle'
  | 'custom';

export interface VfxMeshInstancing {
  pattern: InstancePattern;
  count: number;
  customDirections?: [number, number, number][];
}

export interface VfxSinPulse {
  amplitude: number;
  frequency: number;
  offset?: number;
}

export interface VfxMeshLayer extends VfxLayerBase {
  type: 'mesh';

  shape: MeshShape;

  radius?: number;
  innerRatio?: number;
  segments?: number;
  width?: number;
  length?: number;

  color: [number, number, number];
  emissiveIntensity: number;
  opacity: number;
  blendMode: 'additive' | 'alpha';
  depthTest: boolean;
  depthWrite: boolean;
  cullFace: boolean;

  positionOffset: [number, number, number];
  rotation: [number, number, number];
  scale: number;

  scaleKeys?: CurvePoint[];
  opacityKeys?: CurvePoint[];
  rotationSpeed?: [number, number, number];
  colorKeys?: ColorCurvePoint[];
  extensionKeys?: CurvePoint[];

  scalePulse?: VfxSinPulse;
  opacityPulse?: VfxSinPulse;

  instancing?: VfxMeshInstancing;
}

// ── Mesh primitive builders (engine-internal) ────────────────────────────────

/** Unit UV-sphere (radius 1). */
export function buildVfxSphereMesh(device: GraphicsDevice, lat = 10, lon = 14): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= lat; i++) {
    const theta = (i / lat) * Math.PI;
    for (let j = 0; j <= lon; j++) {
      const phi = (j / lon) * Math.PI * 2;
      const nx = Math.sin(theta) * Math.cos(phi);
      const ny = Math.cos(theta);
      const nz = Math.sin(theta) * Math.sin(phi);
      positions.push(nx, ny, nz);
      normals.push(nx, ny, nz);
    }
  }
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * (lon + 1) + j;
      const b = a + lon + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const mesh = new Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setIndices(indices);
  mesh.update();
  return mesh;
}

/** Flat annular ring in XZ plane. Outer radius 1, inner = innerRatio. */
export function buildVfxRingMesh(device: GraphicsDevice, innerRatio = 0.62, segments = 20): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    positions.push(cos, 0, sin);
    normals.push(0, 1, 0);
    positions.push(innerRatio * cos, 0, innerRatio * sin);
    normals.push(0, 1, 0);
  }

  for (let i = 0; i < segments; i++) {
    const o0 = i * 2;
    const o1 = o0 + 2;
    const i0 = o0 + 1;
    const i1 = o1 + 1;
    indices.push(o0, o1, i0);
    indices.push(o1, i1, i0);
  }

  const mesh = new Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setIndices(indices);
  mesh.update();
  return mesh;
}

/** Diamond-spike pointing along +Z in [0, 1]. */
export function buildVfxSpikeMesh(device: GraphicsDevice): Mesh {
  const BZ = 0.18;
  const BR = 0.5;

  const positions = [
     0,    0,   0,
     BR,   0,   BZ,
     0,    BR,  BZ,
    -BR,   0,   BZ,
     0,   -BR,  BZ,
     0,    0,   1,
  ];

  const normals = [
     0,  0, -1,
     1,  0,  0,
     0,  1,  0,
    -1,  0,  0,
     0, -1,  0,
     0,  0,  1,
  ];

  const indices = [
    0, 2, 1,  0, 3, 2,  0, 4, 3,  0, 1, 4,
    5, 1, 2,  5, 2, 3,  5, 3, 4,  5, 4, 1,
  ];

  const mesh = new Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setIndices(indices);
  mesh.update();
  return mesh;
}

/** Unit billboard quad in XY plane, centred at origin, size 1x1. Includes UVs. */
export function buildVfxQuadMesh(device: GraphicsDevice): Mesh {
  const h = 0.5;
  const positions = [
    -h, -h, 0,
     h, -h, 0,
     h,  h, 0,
    -h,  h, 0,
  ];
  const normals = [
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const indices = [0, 1, 2, 0, 2, 3];

  const mesh = new Mesh(device);
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setUvs(0, uvs);
  mesh.setIndices(indices);
  mesh.update();
  return mesh;
}

// ── Per-device mesh cache ────────────────────────────────────────────────────

const _meshCache = new WeakMap<object, Map<string, Mesh>>();

/**
 * Cache-keyed by `shape + innerRatio + segments` so a single mesh primitive
 * is built once per (device, shape, params) tuple. Exported so that consumers
 * adding their own mesh-backed renderers can share the same buffer pool -
 * the spiral-converge layer in GameEditor reuses the engine sphere this way.
 */
export function getVfxMesh(
  device: GraphicsDevice,
  shape: MeshShape,
  opts: { innerRatio?: number; segments?: number } = {},
): Mesh {
  let devCache = _meshCache.get(device);
  if (!devCache) { devCache = new Map(); _meshCache.set(device, devCache); }

  const key = `${shape}_${opts.innerRatio ?? 0.62}_${opts.segments ?? 12}`;
  let mesh = devCache.get(key);
  if (!mesh) {
    switch (shape) {
      case 'sphere': mesh = buildVfxSphereMesh(device, opts.segments ?? 10, (opts.segments ?? 14)); break;
      case 'ring':   mesh = buildVfxRingMesh(device, opts.innerRatio ?? 0.62, opts.segments ?? 20); break;
      case 'spike':  mesh = buildVfxSpikeMesh(device); break;
      case 'quad':   mesh = buildVfxQuadMesh(device); break;
      default:       mesh = buildVfxSphereMesh(device); break;
    }
    // Hold an extra refCount so the cache keeps the mesh alive. Without this,
    // MeshInstance.destroy() (called when entities are disposed) drops
    // refCount to 0 and frees the GPU buffers, leaving the cached Mesh object
    // as a dead shell that renders black on reuse.
    mesh.incRefCount();
    devCache.set(key, mesh);
  }
  return mesh;
}

// ── Direction generator for instancing fan-out ───────────────────────────────

function generateDirections(inst: VfxMeshInstancing | undefined): Vec3[] {
  if (!inst || inst.pattern === 'single') return [new Vec3(0, 0, 1)];

  const dirs: Vec3[] = [];
  const n = Math.max(1, inst.count);

  if (inst.pattern === 'uniform-circle') {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      dirs.push(new Vec3(Math.cos(a), Math.sin(a), 0));
    }
    return dirs;
  }

  if (inst.pattern === 'uniform-sphere') {
    const phi = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / Math.max(1, n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = phi * i;
      dirs.push(new Vec3(Math.cos(th) * r, y, Math.sin(th) * r));
    }
    return dirs;
  }

  if (inst.pattern === 'custom' && inst.customDirections) {
    for (const [x, y, z] of inst.customDirections) {
      dirs.push(new Vec3(x, y, z).normalize());
    }
    return dirs;
  }

  return [new Vec3(0, 0, 1)];
}

// ── Instance + Renderer ──────────────────────────────────────────────────────

class MeshLayerInstance implements VfxLayerInstance {
  private readonly _layer: VfxMeshLayer;
  private readonly _entities: Entity[];
  private readonly _materials: StandardMaterial[];
  private readonly _baseColor: Color;

  constructor(layer: VfxMeshLayer, entities: Entity[], materials: StandardMaterial[]) {
    this._layer = layer;
    this._entities = entities;
    this._materials = materials;
    this._baseColor = new Color(layer.color[0], layer.color[1], layer.color[2]);
  }

  spawn(_pos: Vec3): void {
    // Visibility is driven by `update`; the prefab calls update(t=0) on spawn.
  }

  update(ctx: VfxLayerUpdateContext): void {
    const layer = this._layer;
    if (!layer.enabled) {
      for (const e of this._entities) e.enabled = false;
      return;
    }
    if (!ctx.alive) {
      for (const e of this._entities) e.enabled = false;
      return;
    }

    const nt = ctx.layerDuration > 0 ? (ctx.t / ctx.layerDuration) : 0;

    let s = (layer.scale ?? 1) * lerpCurve(layer.scaleKeys ?? [[0, 1]], nt);
    let o = lerpCurve(layer.opacityKeys ?? [[0, layer.opacity]], nt);
    const ext = lerpCurve(layer.extensionKeys ?? [[0, 1]], nt);

    if (layer.scalePulse) {
      const p = layer.scalePulse;
      s *= 1 + p.amplitude * Math.sin(ctx.elapsed * p.frequency * Math.PI * 2 + (p.offset ?? 0));
    }
    if (layer.opacityPulse) {
      const p = layer.opacityPulse;
      o *= 1 + p.amplitude * Math.sin(ctx.elapsed * p.frequency * Math.PI * 2 + (p.offset ?? 0));
    }

    const rotSpeed = layer.rotationSpeed;

    for (let i = 0; i < this._entities.length; i++) {
      const ent = this._entities[i];
      const mat = this._materials[i];
      ent.enabled = true;

      if (layer.shape === 'spike') {
        const len = (layer.length ?? 0.55) * ext;
        const w = (layer.width ?? 0.038) * s;
        ent.setLocalScale(w, w, len);
      } else if (layer.shape === 'ring') {
        const r = (layer.radius ?? 0.3) * s;
        ent.setLocalScale(r, r, r);
      } else {
        const r = (layer.radius ?? 0.2) * s;
        ent.setLocalScale(r, r, r);
      }

      if (rotSpeed && (rotSpeed[0] || rotSpeed[1] || rotSpeed[2])) {
        const dt = 1 / 60;
        ent.rotateLocal(rotSpeed[0] * dt, rotSpeed[1] * dt, rotSpeed[2] * dt);
      }

      if (layer.colorKeys && layer.colorKeys.length > 0) {
        lerpColorCurve(layer.colorKeys, nt, this._baseColor);
        mat.emissive.set(
          this._baseColor.r * (layer.emissiveIntensity ?? 1),
          this._baseColor.g * (layer.emissiveIntensity ?? 1),
          this._baseColor.b * (layer.emissiveIntensity ?? 1),
        );
      }

      mat.opacity = o;
      mat.update();
    }
  }

  reset(): void {
    for (const e of this._entities) e.enabled = false;
    for (const m of this._materials) { m.opacity = 0; m.update(); }
  }

  dispose(): void {
    // Entities are children of the prefab root, destroyed via root.destroy().
  }
}

export class MeshLayerRenderer implements VfxLayerRenderer<VfxMeshLayer> {
  readonly type = 'mesh';

  build(layer: VfxMeshLayer, ctx: VfxLayerBuildContext): VfxLayerInstance {
    const { app, parent } = ctx;
    const mesh = getVfxMesh(app.graphicsDevice, layer.shape, {
      innerRatio: layer.innerRatio,
      segments: layer.segments,
    });
    const dirs = generateDirections(layer.instancing);
    const entities: Entity[] = [];
    const materials: StandardMaterial[] = [];

    for (let d = 0; d < dirs.length; d++) {
      const mat = makeMeshMaterial(layer);
      const mi = new MeshInstance(mesh, mat);
      const ent = new Entity(`vfx_mesh_${layer.id}_${d}`);
      ent.addComponent('render', { meshInstances: [mi] });

      if (layer.instancing && layer.instancing.pattern !== 'single') {
        ent.setLocalRotation(quatFromForward(dirs[d]));
      } else {
        const [rx, ry, rz] = layer.rotation ?? [0, 0, 0];
        ent.setLocalEulerAngles(rx, ry, rz);
      }

      const [px, py, pz] = layer.positionOffset ?? [0, 0, 0];
      ent.setLocalPosition(px, py, pz);

      parent.addChild(ent);
      entities.push(ent);
      materials.push(mat);
    }

    return new MeshLayerInstance(layer, entities, materials);
  }
}

function makeMeshMaterial(layer: VfxMeshLayer): StandardMaterial {
  const mat = new StandardMaterial();
  mat.diffuse = new Color(0, 0, 0);
  mat.emissive = new Color(
    layer.color[0] * (layer.emissiveIntensity ?? 1),
    layer.color[1] * (layer.emissiveIntensity ?? 1),
    layer.color[2] * (layer.emissiveIntensity ?? 1),
  );
  mat.blendType = layer.blendMode === 'additive' ? BLEND_ADDITIVE : BLEND_NORMAL;
  mat.depthTest = layer.depthTest ?? false;
  mat.depthWrite = layer.depthWrite ?? false;
  mat.cull = layer.cullFace ? CULLFACE_BACK : CULLFACE_NONE;
  mat.opacity = layer.opacity ?? 0.8;
  mat.update();
  return mat;
}

// ── Internal: trail support exposed to JsonVfxInstance ───────────────────────

/**
 * Build a single trail "puff" entity (one mesh primitive + StandardMaterial).
 * The trail is owned by `JsonVfxInstance`, not a layer renderer, but uses the
 * same mesh cache + material construction as the mesh layer renderer.
 */
export function buildVfxTrailEntity(
  app: AppBase,
  parent: Entity,
  shape: MeshShape,
  color: [number, number, number],
  emissiveIntensity: number,
  blendMode: 'additive' | 'alpha',
  radius: number,
  name: string,
): { ent: Entity; mat: StandardMaterial } {
  const mesh = getVfxMesh(app.graphicsDevice, shape, { innerRatio: 0.62, segments: 10 });
  const mat = new StandardMaterial();
  mat.diffuse = new Color(0, 0, 0);
  mat.emissive = new Color(
    color[0] * emissiveIntensity,
    color[1] * emissiveIntensity,
    color[2] * emissiveIntensity,
  );
  mat.blendType = blendMode === 'additive' ? BLEND_ADDITIVE : BLEND_NORMAL;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.cull = CULLFACE_NONE;
  mat.opacity = 0;
  mat.update();

  const mi = new MeshInstance(mesh, mat);
  const ent = new Entity(name);
  ent.addComponent('render', { meshInstances: [mi] });
  ent.setLocalScale(radius, radius, radius);
  parent.addChild(ent);

  return { ent, mat };
}
