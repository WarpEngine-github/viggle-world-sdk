import {
  GraphNode,
  Mat4,
  Mesh,
  MeshInstance,
  PRIMITIVE_TRIANGLES,
  SEMANTIC_BLENDINDICES,
  SEMANTIC_BLENDWEIGHT,
  Skin,
  SkinInstance,
  TYPE_FLOAT32,
  Entity,
} from 'playcanvas';
import type { GraphicsDevice, Material } from 'playcanvas';

import type { Armature } from '../armature';

/**
 * Vertex data for a mesh that is to be skinned by an {@link Armature}.
 *
 * Positions and normals are in the rig's BIND space: the space
 * {@link Skeleton.inverseBindPose} undoes, which is the armature entity's
 * local space with the rest pose applied and the entity transform taken as
 * identity. Author the mesh by walking `computeBindPoseTransforms()` and it
 * lands in the right space by construction.
 *
 * `boneIndices` and `boneWeights` are 4 per vertex, flat. Unused influences
 * are index 0 / weight 0 - the weight is what turns the slot off, so index 0
 * is safe to use as filler even though bone 0 is a real bone.
 */
export interface SkinnedMeshData {
  /** `[x,y,z] * numVertices`, in bind space. */
  positions: Float32Array;
  /** `[x,y,z] * numVertices`, in bind space. */
  normals: Float32Array;
  /** Triangle list. */
  indices: Uint16Array | Uint32Array;
  /** `[b0,b1,b2,b3] * numVertices`. Float, not uint8 - see {@link createSkinnedMesh}. */
  boneIndices: Float32Array;
  /** `[w0,w1,w2,w3] * numVertices`. Should sum to 1 per vertex. */
  boneWeights: Float32Array;
}

/**
 * How the per-frame bone matrices reach PlayCanvas.
 *
 * - `graph-nodes` - one unparented `GraphNode` per bone, its world transform
 *   overwritten from {@link Armature.boneWorldMatrices} each frame.
 *   PlayCanvas's own `SkinInstance` then composes the palette and uploads it,
 *   exactly as it does for a glTF skinned mesh.
 * - `direct-palette` - the palette texel rows are written and uploaded by
 *   this module, and `SkinInstance.updateMatrixPalette` is stubbed out on the
 *   instance so the renderer does not overwrite them.
 *
 * `graph-nodes` is the recommendation; `direct-palette` is kept because it is
 * the obvious alternative and because having both in one place is what makes
 * the comparison re-runnable. See the notes on
 * {@link ArmatureSkinAdapter.route}.
 */
export type SkinPaletteRoute = 'graph-nodes' | 'direct-palette';

/** Options for {@link ArmatureSkinAdapter.attach}. */
export interface ArmatureSkinAdapterOptions {
  /** Bind-space geometry plus its per-vertex bone influences. */
  mesh: SkinnedMeshData;
  /** Material to render it with. A `StandardMaterial` gets PlayCanvas lighting. */
  material: Material;
  /** How bone matrices reach the GPU. Default `graph-nodes`. */
  route?: SkinPaletteRoute;
  /** Layer ids to render on. Default: the render component's own default (World). */
  layers?: number[];
  /** Default `true`. */
  castShadows?: boolean;
  /** Default `true`. */
  receiveShadows?: boolean;
  /** Entity name, for the scene graph. Default `'armature-skin'`. */
  name?: string;
}

/**
 * Renders an ordinary PlayCanvas mesh skinned by one of our {@link Armature}s,
 * so the engine's stock lighting and shadow path applies to it.
 *
 * Our bones are `Mat4`s in `Armature.boneWorldMatrices`, not `GraphNode`s, and
 * `SkinInstance` wants `GraphNode`s. That gap is the whole of this class.
 *
 * The matrix chain PlayCanvas ends up evaluating is
 * `inv(entityWorld) * boneWorld * inverseBindPose` - the same chain
 * `SplatSkinning.pushTransforms` builds for the gsplat palette, arrived at
 * from the other end. Scale is deliberately NOT stripped here, unlike there:
 * that normalization exists to stop a net scale inflating Gaussian sigmas,
 * and a triangle mesh wants scale to be honoured.
 *
 * Internal. Not part of the published surface.
 */
export class ArmatureSkinAdapter {
  /**
   * Which palette route is live. Read-only after construction: the mesh
   * instance's skin instance is wired differently per route.
   */
  readonly route: SkinPaletteRoute;

  /** Child of `armature.entity`, carrying the render component. */
  readonly entity: Entity;

  readonly meshInstance: MeshInstance;

  /**
   * Milliseconds spent in the most recent {@link update} that actually did
   * work. Frames skipped because no pose moved leave it alone.
   */
  lastUpdateMs = 0;

  /** Stop feeding bone matrices without tearing the mesh down. */
  enabled = true;

  private readonly _armature: Armature;
  private readonly _skin: Skin;
  private readonly _skinInstance: SkinInstance;
  private readonly _mesh: Mesh;
  /** `graph-nodes` only: one per bone, unparented, world transform overwritten. */
  private readonly _boneNodes: GraphNode[] = [];
  /** `direct-palette` only. */
  private readonly _invRoot = new Mat4();
  private readonly _update: () => void;
  private _lastPoseFrame = -2;

  static attach(armature: Armature, opts: ArmatureSkinAdapterOptions): ArmatureSkinAdapter {
    return new ArmatureSkinAdapter(armature, opts);
  }

  private constructor(armature: Armature, opts: ArmatureSkinAdapterOptions) {
    const scene = armature.scene;
    if (!scene) {
      throw new Error('[ArmatureSkinAdapter] armature is not attached to a scene');
    }
    this._armature = armature;
    this.route = opts.route ?? 'graph-nodes';

    const device = scene.graphicsDevice;
    const numBones = armature.numBones;

    // The Skin's inverse bind pose IS ours. PlayCanvas never recomputes it -
    // it only multiplies by it - so handing over the live array is safe and
    // means the two skinning paths can never disagree about the bind.
    const names = armature.rigBoneNames;
    const boneNames = Array.from(
      { length: numBones },
      (_, i) => names[i] ?? `bone${i}`,
    );
    this._skin = new Skin(device, armature.skeleton.inverseBindPose, boneNames);

    this._mesh = createSkinnedMesh(device, opts.mesh);
    // Before the mesh instance is ever culled: `_initBoneAabbs` reads
    // `mesh.skin.boneNames.length`, and the AABB is evaluated lazily on the
    // first cull. A mesh handed to a skin instance without this throws there.
    this._mesh.skin = this._skin;

    this.entity = new Entity(opts.name ?? 'armature-skin');
    armature.entity.addChild(this.entity);

    this.meshInstance = new MeshInstance(this._mesh, opts.material, this.entity);

    this._skinInstance = new SkinInstance(this._skin);
    this._skinInstance.rootBone = this.entity;
    // One node per bone either way. On the `direct-palette` route nothing
    // reads their transforms, but `SkinInstance` sizes its own loops off
    // `bones.length`, so the array still has to be the right length.
    for (let i = 0; i < numBones; i++) this._boneNodes.push(new GraphNode(boneNames[i]));
    this._skinInstance.bones = this._boneNodes;
    if (this.route === 'direct-palette') {
      // Both of these recompute the palette from `bones[i].getWorldTransform()`
      // on the renderer's schedule, which would overwrite what update() wrote
      // moments earlier - with identity matrices, since nothing drives those
      // nodes on this route. Stubbing them is what makes the route work, and
      // is also its whole cost: two private methods overridden per instance.
      this._skinInstance.updateMatrixPalette = () => { /* written by update() */ };
      this._skinInstance.updateMatrices = () => { /* written by update() */ };
    }
    this.meshInstance.skinInstance = this._skinInstance;

    this.entity.addComponent('render', {
      meshInstances: [this.meshInstance],
      castShadows: opts.castShadows ?? true,
      receiveShadows: opts.receiveShadows ?? true,
      ...(opts.layers ? { layers: opts.layers } : {}),
    });

    // Bone matrices for frame N have to be in place before the renderer culls
    // and draws frame N. `Character` registers its own `update` handler when
    // it loads, and handlers fire in registration order, so an adapter built
    // after the character reads the pose the character just evaluated.
    this._update = () => this.update();
    scene.app.on('update', this._update);
    // One eager pass so the very first rendered frame is posed rather than
    // showing the mesh collapsed at the origin.
    this.update();
  }

  /**
   * Push the armature's current bone world matrices into whatever PlayCanvas
   * will read this frame. Called automatically off the scene's `update`.
   *
   * Skipped when the scene reports that no armature re-evaluated its pose
   * this frame ({@link Scene.characterPoseUpdatedFrame}) - the matrices
   * already in place are still the right ones. That gate is scene-wide, not
   * per-armature, so it is conservative: one moving character keeps every
   * adapter working.
   */
  update(): void {
    if (!this.enabled) return;
    const armature = this._armature;
    const world = armature.boneWorldMatrices;
    // Empty until the armature's first evaluated frame, and grown to
    // `numBones` in one go by `Skeleton.applyLocal`. Anything short of the
    // full set would mean reading past the end below.
    if (world.length < this._boneNodes.length) return;

    const scene = armature.scene;
    if (scene) {
      // `characterPoseUpdatedFrame` is stamped by Armature.update on frames
      // that survive its LOD throttles. `-1` means nothing has posed yet.
      if (scene.characterPoseUpdatedFrame === this._lastPoseFrame) return;
      this._lastPoseFrame = scene.characterPoseUpdatedFrame;
    }

    const t0 = performance.now();
    if (this.route === 'graph-nodes') {
      this._pushToGraphNodes(world);
    } else {
      this._pushToPalette(world);
    }
    this.lastUpdateMs = performance.now() - t0;
  }

  /**
   * Overwrite each bone node's world transform in place.
   *
   * These nodes have no parent and nothing ever calls a setter on them, so
   * `_dirtyLocal` / `_dirtyWorld` are both false from construction onwards
   * and `getWorldTransform()` hands back exactly what was written, with no
   * sync. `worldTransform` is `@private` in the typings, hence the cast - it
   * has been a plain public field on `GraphNode` since PlayCanvas 1.x, and
   * the alternative (decompose to TRS, three setters, let PC re-multiply) is
   * strictly more work for the same answer.
   */
  private _pushToGraphNodes(world: readonly Mat4[]): void {
    const nodes = this._boneNodes;
    for (let i = 0; i < nodes.length; i++) {
      (nodes[i] as unknown as { worldTransform: Mat4 }).worldTransform.copy(world[i]);
    }
  }

  /**
   * Compose the palette here and upload it, skipping the `GraphNode` layer.
   *
   * This is the same arithmetic `SkinInstance._updateMatrices` would do -
   * written out only because the alternative route's whole cost IS that
   * arithmetic, so the comparison has to include it.
   */
  private _pushToPalette(world: readonly Mat4[]): void {
    const si = this._skinInstance;
    const ibp = this._skin.inverseBindPose;
    const mp = si.matrixPalette as Float32Array;
    const matrices = si.matrices as Mat4[];

    this._invRoot.copy(this.entity.getWorldTransform()).invert();

    const count = matrices.length;
    for (let i = 0; i < count; i++) {
      const m = matrices[i];
      m.mulAffine2(this._invRoot, world[i]);
      m.mulAffine2(m, ibp[i]);

      // 4x4 column-major -> the 4x3 row-major layout the skin chunk samples.
      const pe = m.data;
      const base = i * 12;
      mp[base] = pe[0];      mp[base + 1] = pe[4];  mp[base + 2] = pe[8];   mp[base + 3] = pe[12];
      mp[base + 4] = pe[1];  mp[base + 5] = pe[5];  mp[base + 6] = pe[9];   mp[base + 7] = pe[13];
      mp[base + 8] = pe[2];  mp[base + 9] = pe[6];  mp[base + 10] = pe[10]; mp[base + 11] = pe[14];
    }
    si.boneTexture.upload();
  }

  destroy(): void {
    this._armature.scene?.app.off('update', this._update);
    this.entity.destroy();
    this._mesh.destroy();
  }
}

/**
 * Build a PlayCanvas `Mesh` carrying the two skinning vertex streams.
 *
 * Bone indices go up as `TYPE_FLOAT32`, not the `TYPE_UINT8` glTF uses,
 * because a bone index here is an index into OUR rig and our rigs go past
 * 255: the facial rig is 441 bones. `TYPE_UINT8` was tried and it renders
 * correctly on both WebGL2 and WebGPU - but only while every weighted bone
 * happens to sit under 256, and it wraps silently the moment one does not.
 * Float is 16 bytes a vertex against 4. If that ever matters for a real
 * proxy mesh, `TYPE_UINT16` is the answer, not `TYPE_UINT8`.
 */
export function createSkinnedMesh(device: GraphicsDevice, data: SkinnedMeshData): Mesh {
  const numVertices = data.positions.length / 3;
  const mesh = new Mesh(device);
  mesh.setPositions(data.positions, 3, numVertices);
  mesh.setNormals(data.normals, 3, numVertices);
  mesh.setVertexStream(SEMANTIC_BLENDINDICES, data.boneIndices, 4, numVertices, TYPE_FLOAT32);
  mesh.setVertexStream(SEMANTIC_BLENDWEIGHT, data.boneWeights, 4, numVertices, TYPE_FLOAT32);
  mesh.setIndices(data.indices);
  mesh.update(PRIMITIVE_TRIANGLES);
  return mesh;
}
