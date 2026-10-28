/**
 * Draw what the collider actually is, so a bad setting is visible rather than
 * inferred.
 *
 * ## The grid and the surface are two different answers, and both are drawn
 *
 * They are not more and less of the same picture, so neither replaces the other
 * and they are independently switchable:
 *
 * - **The occupancy grid** is what {@link SceneCollider.groundAt} and
 *   {@link SceneCollider.blocked} read. Drawn as cell faces, because the cells
 *   ARE the answer.
 * - **The Surface Nets surface** is what an exported mesh is and what a game
 *   engine's collider component would receive. Its vertices sit up to a voxel
 *   off the cell boundary - that is the whole point of dual contouring, and it
 *   is exactly the magnitude someone tuning a voxel size is trying to judge - so
 *   it must never be mistaken for the thing the queries test against.
 *
 * The surface is drawn OPAQUE, not as a wireframe. A wireframe over a splat
 * cloud does not read as a surface: you cannot see whether it is closed, where
 * it bulges, or how it sits against the splats, which is the entire reason to
 * look at it. It is shaded from baked vertex colours rather than from a scene
 * light, so adding this view cannot change how the capture itself is lit.
 *
 * Three things, drawn three ways for the same reason - how often they move:
 *
 * - **The occupancy**, as the cell faces the grid exposes, in a line MESH that
 *   is rebuilt only when the collider changes or the focus has moved a
 *   meaningful fraction of the drawn box. Uploaded once, then free per frame,
 *   which is what lets the budget be tens of thousands of cells. An
 *   immediate-mode overlay has to resubmit every vertex every frame, so it has
 *   to stay an order of magnitude smaller - and an overlay that thins a dense
 *   floor into a scatter is worse than no overlay at all, because it reports a
 *   good collider as a broken one.
 * - **The surface**, as a triangle mesh rebuilt only when the collider or the
 *   finish changes. Never decimated: Surface Nets emits about one vertex per
 *   boundary cell, so the whole surface is a smaller mesh than the grid's own
 *   line set and there is nothing to gain by capping it.
 * - **The walker's capsule**, in immediate-mode lines, because it moves every
 *   frame and is a few hundred vertices.
 *
 * The capsule is drawn in the colour of its own answer: green where the body
 * fits, red where {@link SceneCollider.blocked} says it does not. A wall you
 * cannot see is the failure this exists to make visible.
 *
 * Internal. Not part of the published surface.
 */

import {
  BLEND_NONE,
  BLEND_NORMAL,
  Color,
  Entity,
  LAYERID_IMMEDIATE,
  CULLFACE_BACK,
  Mesh,
  MeshInstance,
  PRIMITIVE_LINES,
  PRIMITIVE_TRIANGLES,
  StandardMaterial,
} from 'playcanvas';

import type { SurfaceSettings } from '../proxy/voxelizer';
import type { Scene } from '../scene';

import type { ColliderOverlayFaces, SceneCollider, WalkerCapsule } from './scene-collider';

/** What the overlay draws. */
export type ColliderDebugMode = 'off' | 'top' | 'all';

/** Configuration for {@link SceneColliderDebug.create}. */
export interface SceneColliderDebugOptions {
  /** Grid line colour, CSS hex. Default `#f59e0b`. */
  color?: string;
  /** Capsule colour where the body fits. Default `#00e13f`. */
  freeColor?: string;
  /** Capsule colour where the body is blocked. Default `#ff4d4d`. */
  blockedColor?: string;
  /** Half-extent of the drawn box around the focus, world metres. Default `8`. */
  radius?: number;
  /** Cell budget handed to {@link SceneCollider.overlay}. */
  maxCells?: number;
  /** Start in this mode. Default `off`. */
  mode?: ColliderDebugMode;
  /** Surface colour, CSS hex. Default `#22d3ee` - the proxy-mesh preview's. */
  surfaceColor?: string;
  /** Draw the surface from the start. Default `false`. */
  surface?: boolean;
}

/** What the last overlay rebuild came out as, for a HUD to state honestly. */
export interface ColliderDebugStats {
  /** Solid cells inside the drawn box that had a face to draw. */
  cellsInBox: number;
  /** Cells actually drawn. */
  cellsDrawn: number;
  /** `1` when the whole box is drawn; above 1 the picture is that much sparser. */
  stride: number;
  /** Line segments in the mesh. */
  segments: number;
  /** Milliseconds the last rebuild took. */
  rebuildMs: number;
}

const EMPTY_STATS: ColliderDebugStats = {
  cellsInBox: 0, cellsDrawn: 0, stride: 1, segments: 0, rebuildMs: 0,
};

/** What the surface view came out as. */
export interface ColliderSurfaceStats {
  vertices: number;
  triangles: number;
  /** Milliseconds the extraction plus the upload took. */
  buildMs: number;
  /**
   * Whether any of the surface was dropped to fit a budget. Always `false`, and
   * reported anyway: the grid overlay DOES thin itself and says so, so the
   * surface saying it does not is the same promise kept rather than an omission.
   */
  capped: boolean;
}

const EMPTY_SURFACE_STATS: ColliderSurfaceStats = {
  vertices: 0, triangles: 0, buildMs: 0, capped: false,
};

/**
 * Direction the baked vertex shading is lit from, and the light/dark ends of it.
 *
 * Baked rather than lit by the scene, because a real light added for this view
 * would also fall on the capture - the environment splats respond to the
 * lighting registry - and a debug view must not change what it is drawn over.
 */
const SHADE_DIR = (() => {
  const d = [0.38, 0.86, 0.34];
  const len = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / len, d[1] / len, d[2] / len];
})();
/** How dark a face pointing straight away from {@link SHADE_DIR} goes. */
const SHADE_FLOOR = 0.18;
/**
 * Curve on the hemisphere term. Above 1 it darkens the middle, which is where a
 * scanned room's walls all sit - a plain linear term leaves them within a few
 * percent of the floor's brightness and the shell reads as one flat colour.
 */
const SHADE_CONTRAST = 1.8;

export class SceneColliderDebug {
  /** What to draw. Flipping it costs one rebuild, not a frame of churn. */
  get mode(): ColliderDebugMode { return this._mode; }
  set mode(next: ColliderDebugMode) {
    if (next === this._mode) return;
    this._mode = next;
    this._entity.enabled = next !== 'off';
    this._dirty = true;
  }

  /** Half-extent of the drawn box, world metres. */
  get radius(): number { return this._radius; }
  set radius(next: number) {
    if (next === this._radius) return;
    this._radius = next;
    this._dirty = true;
  }

  /**
   * Draw the triangulated surface as an opaque mesh, independently of
   * {@link mode}. Both can be on at once, which is how the up-to-a-voxel
   * difference between the two is seen rather than described.
   */
  get surface(): boolean { return this._surfaceOn; }
  set surface(next: boolean) {
    if (next === this._surfaceOn) return;
    this._surfaceOn = next;
    this._surfaceEntity.enabled = next;
    this._surfaceDirty = true;
  }

  /** The finish the surface is extracted at. Setting it re-extracts. */
  get surfaceSettings(): SurfaceSettings { return { ...this._surfaceSettings }; }
  set surfaceSettings(next: SurfaceSettings) {
    this._surfaceSettings = { ...next };
    this._surfaceDirty = true;
  }

  /** The capsule to draw, and to colour by its own blocked test. `null` draws none. */
  capsule: WalkerCapsule | null = null;
  /** Where the capsule stands: world XZ and the floor Y under its feet. */
  capsuleAt: { x: number; y: number; z: number } | null = null;

  private readonly _scene: Scene;
  private readonly _entity: Entity;
  private readonly _material: StandardMaterial;
  private readonly _free: Color;
  private readonly _blocked: Color;
  private readonly _surfaceTint: Color;
  private readonly _update: () => void;
  private _mesh: Mesh | null = null;
  private _instance: MeshInstance | null = null;
  private _collider: SceneCollider | null = null;
  private _mode: ColliderDebugMode;
  private _radius: number;
  private _maxCells: number | undefined;
  private _dirty = true;
  private _builtAt = { x: Infinity, y: Infinity, z: Infinity };
  private _stats: ColliderDebugStats = EMPTY_STATS;

  private readonly _surfaceEntity: Entity;
  private readonly _surfaceMaterial: StandardMaterial;
  private _surfaceMesh: Mesh | null = null;
  private _surfaceInstance: MeshInstance | null = null;
  private _surfaceOn: boolean;
  private _surfaceSettings: SurfaceSettings = {};
  private _surfaceDirty = true;
  private _surfaceStats: ColliderSurfaceStats = EMPTY_SURFACE_STATS;

  static create(scene: Scene, opts?: SceneColliderDebugOptions): SceneColliderDebug {
    return new SceneColliderDebug(scene, opts);
  }

  private constructor(scene: Scene, opts?: SceneColliderDebugOptions) {
    this._scene = scene;
    this._mode = opts?.mode ?? 'off';
    this._radius = opts?.radius ?? 8;
    this._maxCells = opts?.maxCells;
    this._free = new Color().fromString(opts?.freeColor ?? '#00e13f');
    this._blocked = new Color().fromString(opts?.blockedColor ?? '#ff4d4d');

    // Emissive-only and unlit: the grid is an annotation, not geometry in the
    // scene, and a shaded line reads as part of the capture.
    const material = new StandardMaterial();
    material.diffuse = new Color(0, 0, 0);
    material.emissive = new Color().fromString(opts?.color ?? '#f59e0b');
    material.useLighting = false;
    // Opaque in effect - alpha is 1 - but tagged as a BLENDED material, which is
    // what puts it in the layer's transparent sublayer and therefore AFTER the
    // opaque surface below. Without that the grid draws first, the surface
    // covers it, and turning both views on shows only one of them. `BLEND_NONE`
    // here would be the truthful description of the pixels and the wrong answer
    // for the ordering.
    material.blendType = BLEND_NORMAL;
    material.opacity = 1;
    // A splat-only scene has no depth to test against, and the grid is meant to
    // read through the splats - and through the surface - anyway.
    material.depthTest = false;
    material.depthWrite = false;
    material.update();
    this._material = material;

    this._entity = new Entity('scene-collider-debug');
    this._entity.enabled = this._mode !== 'off';
    scene.app.root.addChild(this._entity);

    // The surface is OPAQUE and depth-tested against itself, which is what makes
    // it read as a solid shell rather than a tangle. Its shading is baked into
    // the vertex colours, so `useLighting` stays off and no light is added to a
    // scene whose splats would respond to one.
    const surfaceMaterial = new StandardMaterial();
    surfaceMaterial.diffuse = new Color(0, 0, 0);
    surfaceMaterial.emissive = new Color(1, 1, 1);
    surfaceMaterial.emissiveVertexColor = true;
    surfaceMaterial.useLighting = false;
    surfaceMaterial.blendType = BLEND_NONE;
    surfaceMaterial.depthTest = true;
    surfaceMaterial.depthWrite = true;
    // BACKFACE CULLED, which is not a performance choice - it is what makes the
    // view usable. The surface's normals point out of the solid, so a camera
    // orbiting a walker inside a scanned room spends most of its arc buried in
    // the wall slab, and a two-sided shell fills the screen with the inside of
    // that slab: a flat colour that reads as the page having broken. Culled, the
    // solid the camera is inside of disappears and the room is seen from within,
    // which is the same bargain every DCC tool makes.
    surfaceMaterial.cull = CULLFACE_BACK;
    surfaceMaterial.update();
    this._surfaceMaterial = surfaceMaterial;
    this._surfaceTint = new Color().fromString(opts?.surfaceColor ?? '#22d3ee');

    this._surfaceOn = opts?.surface ?? false;
    this._surfaceEntity = new Entity('scene-collider-surface');
    this._surfaceEntity.enabled = this._surfaceOn;
    scene.app.root.addChild(this._surfaceEntity);

    this._update = () => this._draw();
    scene.app.on('update', this._update);
  }

  /** The collider to draw. `null` blanks the overlay. */
  setCollider(collider: SceneCollider | null): void {
    this._collider = collider;
    this._dirty = true;
    this._surfaceDirty = true;
    this._builtAt = { x: Infinity, y: Infinity, z: Infinity };
    if (!collider) {
      this._stats = EMPTY_STATS;
      this._surfaceStats = EMPTY_SURFACE_STATS;
    }
  }

  /** What the last rebuild drew, and what it left out. Put `stride` on screen. */
  get stats(): ColliderDebugStats {
    return this._stats;
  }

  /** What the surface view is showing. */
  get surfaceStats(): ColliderSurfaceStats {
    return this._surfaceStats;
  }

  /** Force the next frame to rebuild the mesh - after a knob that changes it. */
  invalidate(): void {
    this._dirty = true;
    this._surfaceDirty = true;
  }

  destroy(): void {
    this._scene.app.off('update', this._update);
    this._entity.destroy();
    this._surfaceEntity.destroy();
    this._mesh?.destroy();
    this._surfaceMesh?.destroy();
    this._material.destroy();
    this._surfaceMaterial.destroy();
    this._mesh = null;
    this._surfaceMesh = null;
    this._instance = null;
    this._surfaceInstance = null;
    this._collider = null;
  }

  private _draw(): void {
    const collider = this._collider;
    if (!collider) return;

    if (this._surfaceOn) {
      if (this._surfaceDirty) this._rebuildSurface(collider);
      // The surface is extracted in the capture's own units, so the entity
      // carries the frame - which means the scale slider moves it for free,
      // exactly as it moves every query, with no re-extraction.
      const f = collider.frame;
      this._surfaceEntity.setPosition(f.origin.x, f.origin.y, f.origin.z);
      this._surfaceEntity.setLocalScale(f.scale, f.scale, f.scale);
    }

    const at = this.capsuleAt ?? { x: 0, y: 0, z: 0 };

    // Before the grid's early-out, not after: with the grid off and the surface
    // on there is still a walker to see, and losing it there would read as the
    // page having stopped rather than as a display choice.
    const capsule = this.capsule;
    if (capsule && this.capsuleAt) {
      const blocked = collider.blocked(at.x, at.z, at.y, capsule);
      this._scene.app.drawLineArrays(
        capsuleLines(at, capsule),
        blocked ? this._blocked : this._free,
        false,
      );
    }

    if (this._mode === 'off') return;

    // Rebuild when the focus has drifted a quarter of the box. Any smaller and
    // a walk rebuilds constantly; any larger and the box's far edge arrives in
    // view before its contents do.
    const moved = Math.max(
      Math.abs(at.x - this._builtAt.x),
      Math.abs(at.y - this._builtAt.y),
      Math.abs(at.z - this._builtAt.z),
    );
    if (this._dirty || moved > this._radius * 0.25) this._rebuild(collider, at);
  }

  /**
   * Extract the surface and upload it, whole.
   *
   * Reads {@link SceneCollider.surface}, which memoizes - so this and the
   * exporter are handed the SAME `ProxyMeshResult` object, not two extractions
   * that ought to agree. That is what makes "what you see is what the file
   * contains" a structural fact rather than a convention.
   */
  private _rebuildSurface(collider: SceneCollider): void {
    const t0 = performance.now();
    this._surfaceDirty = false;
    const result = collider.surface(this._surfaceSettings);

    if (this._surfaceInstance) {
      this._surfaceEntity.removeComponent('render');
      this._surfaceInstance = null;
    }
    const old = this._surfaceMesh;
    this._surfaceMesh = null;
    if (result.vertexCount === 0 || result.indices.length === 0) {
      old?.destroy();
      this._surfaceStats = EMPTY_SURFACE_STATS;
      return;
    }

    const mesh = new Mesh(this._scene.graphicsDevice);
    mesh.setPositions(result.positions, 3, result.vertexCount);
    mesh.setNormals(result.normals, 3, result.vertexCount);
    mesh.setColors(shadeFromNormals(result.normals, result.vertexCount, this._surfaceTint), 4, result.vertexCount);
    mesh.setIndices(result.indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    this._surfaceMesh = mesh;

    this._surfaceInstance = new MeshInstance(mesh, this._surfaceMaterial, this._surfaceEntity);
    this._surfaceEntity.addComponent('render', {
      meshInstances: [this._surfaceInstance],
      // The same layer as the grid, and for the same reason: it is the only one
      // that draws after the capture's splats.
      layers: [LAYERID_IMMEDIATE],
      castShadows: false,
      receiveShadows: false,
    });
    old?.destroy();

    this._surfaceStats = {
      vertices: result.vertexCount,
      triangles: result.triangleCount,
      buildMs: performance.now() - t0,
      capped: false,
    };
  }

  private _rebuild(collider: SceneCollider, at: { x: number; y: number; z: number }): void {
    const t0 = performance.now();
    const faces: ColliderOverlayFaces = this._mode === 'all' ? 'all' : 'top';
    const overlay = collider.overlay(at, {
      radius: this._radius,
      faces,
      maxCells: this._maxCells,
    });
    this._dirty = false;
    this._builtAt = { x: at.x, y: at.y, z: at.z };

    const verts = overlay.vertices;
    this._stats = {
      cellsInBox: overlay.cellsInBox,
      cellsDrawn: overlay.cellsDrawn,
      stride: overlay.stride,
      segments: overlay.segments,
      rebuildMs: performance.now() - t0,
    };
    if (verts.length === 0) {
      if (this._instance) this._instance.visible = false;
      return;
    }

    // A fresh Mesh per rebuild rather than a resized one: the vertex count
    // changes every time the focus moves, and PlayCanvas reallocates the buffer
    // for that anyway.
    const old = this._mesh;
    const mesh = new Mesh(this._scene.graphicsDevice);
    // A copy, because `overlay` hands back a view of a buffer it reuses.
    mesh.setPositions(verts.slice(), 3, verts.length / 3);
    mesh.update(PRIMITIVE_LINES);
    this._mesh = mesh;

    if (this._instance) {
      this._entity.removeComponent('render');
      this._instance = null;
    }
    this._instance = new MeshInstance(mesh, this._material, this._entity);
    this._entity.addComponent('render', {
      meshInstances: [this._instance],
      // The IMMEDIATE layer, which is the only one that reliably draws AFTER
      // the splats. An environment splat renders on its own layer inserted at
      // World's transparent slot, so an overlay on World.opaque - the default
      // for a `BLEND_NONE` material - is painted over by the capture and looks
      // like it failed to build.
      layers: [LAYERID_IMMEDIATE],
      castShadows: false,
      receiveShadows: false,
    });
    old?.destroy();
  }
}

/**
 * Bake a diffuse-looking shade into vertex colours, so the surface reads as a
 * solid with a form instead of a silhouette, without a light existing anywhere.
 *
 * A hemisphere term rather than a clamped `N dot L`: a face pointing away still
 * gets {@link SHADE_FLOOR} of the tint, so the underside of a floor is dark but
 * not black, and the shell stays legible from inside it - which is where a
 * walker is standing.
 */
function shadeFromNormals(normals: Float32Array, vertexCount: number, tint: Color): Float32Array {
  const out = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    const d = normals[v * 3] * SHADE_DIR[0]
      + normals[v * 3 + 1] * SHADE_DIR[1]
      + normals[v * 3 + 2] * SHADE_DIR[2];
    const k = SHADE_FLOOR + (1 - SHADE_FLOOR) * (0.5 + 0.5 * d) ** SHADE_CONTRAST;
    out[v * 4] = tint.r * k;
    out[v * 4 + 1] = tint.g * k;
    out[v * 4 + 2] = tint.b * k;
    out[v * 4 + 3] = 1;
  }
  return out;
}

/**
 * The capsule as a wireframe: three rings - feet, waist, head - and four
 * verticals joining them. Enough to read where the body is and how wide, without
 * a sphere's worth of lines a frame.
 */
function capsuleLines(
  at: { x: number; y: number; z: number },
  capsule: WalkerCapsule,
): number[] {
  const out: number[] = [];
  const lo = at.y + capsule.feetClearance;
  const hi = at.y + capsule.height;
  const mid = (lo + hi) * 0.5;
  const SEGMENTS = 24;
  for (const y of [lo, mid, hi]) {
    for (let i = 0; i < SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const b = ((i + 1) / SEGMENTS) * Math.PI * 2;
      out.push(
        at.x + Math.cos(a) * capsule.radius, y, at.z + Math.sin(a) * capsule.radius,
        at.x + Math.cos(b) * capsule.radius, y, at.z + Math.sin(b) * capsule.radius,
      );
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const x = at.x + Math.cos(a) * capsule.radius;
    const z = at.z + Math.sin(a) * capsule.radius;
    out.push(x, lo, z, x, hi, z);
  }
  // The feet, so the clearance below the collided span is visible as the gap it
  // is rather than read as the capsule floating.
  out.push(at.x, at.y, at.z, at.x, lo, at.z);
  return out;
}
