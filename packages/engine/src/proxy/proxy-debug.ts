import { Color, Mat4 } from 'playcanvas';
import type { GraphNode } from 'playcanvas';

import type { Armature } from '../armature';
import type { Scene } from '../scene';

import type { ProxyMeshResult } from './voxelizer';

/**
 * What the overlay draws.
 *
 * - `off` - nothing. Consumers still get the mesh; only the preview stops.
 * - `voxels` - the exact cell boundary, blocky on purpose. This is what you
 *   judge {@link ProxySettings.voxelSize} against, and it stays blocky
 *   whatever finish the real mesh is using.
 * - `mesh` - the reconstructed surface, i.e. exactly what a consumer gets.
 */
export type ProxyDebugMode = 'off' | 'voxels' | 'mesh';

/** Configuration for {@link ProxyMeshDebug.create}. */
export interface ProxyMeshDebugOptions {
  /** `mesh` mode line colour, CSS hex. Default `#22d3ee`. */
  color?: string;
  /** `voxels` mode line colour, CSS hex. Default `#f59e0b`. */
  voxelColor?: string;
  /** Start in this mode. Default `off`. */
  mode?: ProxyDebugMode;
  /**
   * Hide lines behind geometry. Default `false` - the overlay reads as an
   * overlay, and a splat-only scene has no depth buffer to test against
   * anyway.
   */
  depthTest?: boolean;
}

/**
 * Immediate-mode wireframe preview of a proxy mesh, skinned by the same rig
 * the mesh is.
 *
 * The whole surface goes up in ONE `drawLineArrays` call per frame. That is
 * not an optimization detail, it is the only way this works: a character proxy
 * is thousands of quads, and one `drawWireAlignedBox` per voxel would be
 * thousands of immediate-mode submissions a frame.
 *
 * Edges come from {@link ProxyMeshResult.quads}, not from the triangle list.
 * The triangulation diagonals are an artefact of the index buffer, and drawing
 * them turns a readable voxel boundary into a hatched mess that hides the
 * thing you switched the overlay on to see.
 *
 * ```ts
 * const debug = ProxyMeshDebug.create(scene);
 * debug.setMesh(buildProxyMesh(input, settings));
 * debug.setVoxels(buildProxyMesh(input, { ...settings, surface: 'blocky', smoothIterations: 0 }));
 * debug.armature = character.armature;
 * debug.mode = 'voxels';
 * ```
 *
 * Internal. Not part of the published surface.
 */
export class ProxyMeshDebug {
  /** What to draw. Cheap to flip - no rebuild, no scene-graph churn. */
  mode: ProxyDebugMode;

  /**
   * Rig to skin the lines by. `null` draws the geometry where it was built,
   * which is right for a static capture and wrong for a character.
   *
   * The surface must be in BIND space, the same space
   * {@link ArmatureSkinAdapter} wants - which is what the voxelizer produces
   * when it is fed the splats' rest positions.
   */
  armature: Armature | null = null;

  /**
   * Node the surface was built in the local space of, for a static proxy -
   * a splat that no armature drives. Ignored while {@link armature} is set,
   * whose chain already ends in world space. `null` draws the positions as
   * world-space.
   */
  node: GraphNode | null = null;

  private readonly _scene: Scene;
  private readonly _color: Color;
  private readonly _voxelColor: Color;
  private readonly _depthTest: boolean;
  private readonly _update: () => void;

  private _mesh: LineSet | null = null;
  private _voxels: LineSet | null = null;

  /** `boneWorld[i] * inverseBindPose[i]`, rebuilt each drawn frame. */
  private _skin: Mat4[] = [];

  static create(scene: Scene, opts?: ProxyMeshDebugOptions): ProxyMeshDebug {
    return new ProxyMeshDebug(scene, opts);
  }

  private constructor(scene: Scene, opts?: ProxyMeshDebugOptions) {
    this._scene = scene;
    this._color = new Color().fromString(opts?.color ?? '#22d3ee');
    this._voxelColor = new Color().fromString(opts?.voxelColor ?? '#f59e0b');
    this._depthTest = opts?.depthTest ?? false;
    this.mode = opts?.mode ?? 'off';
    this._update = () => this._draw();
    scene.app.on('update', this._update);
  }

  /** The reconstructed surface, for `mesh` mode. `null` blanks that mode. */
  setMesh(result: ProxyMeshResult | null): void {
    this._mesh = result ? lineSetOf(result) : null;
  }

  /**
   * The blocky cell boundary, for `voxels` mode. Pass a build made with
   * `{ surface: 'blocky', smoothIterations: 0 }` over the SAME input and voxel
   * size - previewing the cells means showing the cells, whatever finish the
   * real mesh is using.
   */
  setVoxels(result: ProxyMeshResult | null): void {
    this._voxels = result ? lineSetOf(result) : null;
  }

  /** Line segments the current mode would submit. For a HUD. */
  get lineCount(): number {
    const set = this.mode === 'voxels' ? this._voxels : this.mode === 'mesh' ? this._mesh : null;
    return set ? set.edges.length / 2 : 0;
  }

  destroy(): void {
    this._scene.app.off('update', this._update);
    this.armature = null;
    this.node = null;
    this._mesh = null;
    this._voxels = null;
  }

  private _draw(): void {
    if (this.mode === 'off') return;
    const set = this.mode === 'voxels' ? this._voxels : this._mesh;
    if (!set || set.edges.length === 0) return;

    this._deform(set);

    // Fill by index rather than push: the buffer is sized once at setMesh
    // time, and a per-frame push of 30k numbers is a per-frame reallocation.
    const buf = set.buffer;
    const world = set.world;
    const edges = set.edges;
    for (let e = 0, w = 0; e < edges.length; e++, w += 3) {
      const v = edges[e] * 3;
      buf[w] = world[v];
      buf[w + 1] = world[v + 1];
      buf[w + 2] = world[v + 2];
    }

    this._scene.app.drawLineArrays(
      buf,
      this.mode === 'voxels' ? this._voxelColor : this._color,
      this._depthTest,
    );
  }

  /**
   * Bind-space vertices to world, by linear blend skinning.
   *
   * The chain is `boneWorld * inverseBindPose * v`, with no entity transform
   * in it. That is not an omission: `ArmatureSkinAdapter` parents its render
   * entity under the armature and evaluates
   * `entityWorld * inv(entityWorld) * boneWorld * invBind * v`, in which the
   * entity transform cancels. Applying it here as well would put the overlay
   * somewhere the mesh is not, by exactly that transform.
   */
  private _deform(set: LineSet): void {
    const arm = this.armature;
    const world = set.world;
    const rest = set.rest;

    if (!arm || !set.boneIndices || !set.boneWeights) {
      if (!this.node) { world.set(rest); return; }
      const m = this.node.getWorldTransform().data;
      for (let v = 0; v < rest.length; v += 3) {
        const rx = rest[v], ry = rest[v + 1], rz = rest[v + 2];
        world[v] = m[0] * rx + m[4] * ry + m[8] * rz + m[12];
        world[v + 1] = m[1] * rx + m[5] * ry + m[9] * rz + m[13];
        world[v + 2] = m[2] * rx + m[6] * ry + m[10] * rz + m[14];
      }
      return;
    }

    const boneWorld = arm.boneWorldMatrices;
    const invBind = arm.skeleton.inverseBindPose;
    const numBones = Math.min(boneWorld.length, invBind.length);
    if (numBones === 0) { world.set(rest); return; }

    while (this._skin.length < numBones) this._skin.push(new Mat4());
    for (let i = 0; i < numBones; i++) this._skin[i].mulAffine2(boneWorld[i], invBind[i]);

    const idx = set.boneIndices;
    const wts = set.boneWeights;
    const count = rest.length / 3;
    for (let v = 0; v < count; v++) {
      const rx = rest[v * 3], ry = rest[v * 3 + 1], rz = rest[v * 3 + 2];
      let ox = 0, oy = 0, oz = 0, total = 0;
      for (let j = 0; j < 4; j++) {
        const w = wts[v * 4 + j];
        if (!(w > 0)) continue;
        const b = idx[v * 4 + j];
        if (b < 0 || b >= numBones) continue;
        const m = this._skin[b].data;
        ox += w * (m[0] * rx + m[4] * ry + m[8] * rz + m[12]);
        oy += w * (m[1] * rx + m[5] * ry + m[9] * rz + m[13]);
        oz += w * (m[2] * rx + m[6] * ry + m[10] * rz + m[14]);
        total += w;
      }
      if (total > 0) {
        world[v * 3] = ox; world[v * 3 + 1] = oy; world[v * 3 + 2] = oz;
      } else {
        // No usable influence. Leaving it at bind is the same thing the
        // skinning shader does, so the overlay keeps agreeing with the mesh.
        world[v * 3] = rx; world[v * 3 + 1] = ry; world[v * 3 + 2] = rz;
      }
    }
  }
}

/** One surface, pre-chewed into everything the per-frame path needs. */
interface LineSet {
  /** Bind-space vertex positions, `[x,y,z] * vertexCount`. */
  rest: Float32Array;
  /** Skinned output, same shape. */
  world: Float32Array;
  boneIndices: Float32Array | null;
  boneWeights: Float32Array | null;
  /** Deduplicated edge endpoints, 2 vertex indices a segment. */
  edges: Uint32Array;
  /** Flat `[x,y,z]` per endpoint, refilled each frame and handed to the batch. */
  buffer: number[];
}

/**
 * Deduplicate the quad edges of a surface.
 *
 * Every interior edge is shared by two quads, so this halves the segment count
 * - which on a proxy mesh is the difference between 36k and 18k points going
 * through the immediate batch every frame.
 */
function lineSetOf(result: ProxyMeshResult): LineSet {
  const seen = new Set<number>();
  const edges: number[] = [];
  const stride = result.vertexCount;
  const quads = result.quads;
  for (let f = 0; f < quads.length; f += 4) {
    for (let k = 0; k < 4; k++) {
      const a = quads[f + k];
      const b = quads[f + ((k + 1) & 3)];
      const key = a < b ? a * stride + b : b * stride + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(a, b);
    }
  }
  return {
    rest: result.positions,
    world: new Float32Array(result.positions.length),
    boneIndices: result.boneIndices,
    boneWeights: result.boneWeights,
    edges: new Uint32Array(edges),
    buffer: Array.from({ length: edges.length * 3 }, () => 0),
  };
}
