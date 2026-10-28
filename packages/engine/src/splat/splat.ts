import type { AppBase, Asset, GraphicsDevice, GraphNode, GSplatComponent, GSplatData, GSplatResource } from 'playcanvas';
import {
  ADDRESS_CLAMP_TO_EDGE,
  BoundingBox,
  Entity,
  FILTER_NEAREST,
  Mat4,
  PIXELFORMAT_R32F,
  PIXELFORMAT_RGBA32F,
  Texture,
  Vec3,
} from 'playcanvas';

import { WORK_BUFFER_MODIFIER_GLSL, WORK_BUFFER_MODIFIER_WGSL } from './splat-shader';
import { bakeRevealDistances } from './reveal-bake';
import type { RevealSkeleton } from './reveal-bake';
import { DEFAULT_REVEAL_LOOK, packRevealLook } from './reveal-look';
import type { RevealLook } from './reveal-look';
import { seedRelightDefaults } from '../relight/relight-placeholder';
import { TransformPalette } from './transform-palette';
import { bakeBoneBoxes, posedBound } from './posed-bound';
import { getAssetExtras } from '../loader/shared/asset-extras';
import type { Armature } from '../armature';
import type { Scene } from '../scene';
import type { SplatWeights } from '../types';

const WHITE_TINT = { r: 1, g: 1, b: 1 };

/** PC keeps a component's placement private; only its id is read here. */
function placementOf(gsplat: GSplatComponent): { id: number } | null {
  return (gsplat as unknown as { _placement: { id: number } | null })._placement;
}

// WebGL CPU sort. A layer's CPU sort reads only the worker's copy of the
// centers, the splat transforms and the camera, yet PC re-sorts the whole layer
// whenever any splat in it re-renders or moves at all: every frame for an
// animated character (WORKBUFFER_UPDATE_ALWAYS) or an NPC nudged by foot lock.
// Big layers re-sort instead when something moved enough to matter:
/** Layers up to this many splats (a character alone, the overlay copy) keep sorting on every change - cheap, and full quality. */
const SMALL_SORT_LAYER = 250_000;
/** Bigger ones once a splat (pose or transform) moved this fraction of its camera distance since the last sort, */
const SORT_DRIFT = 0.005;
/** but for a character animating in place at most this often, unless the layer sorts anyway. */
const POSE_SORT_INTERVAL_MS = 100;

type GSplatLayerData = NonNullable<AppBase['renderer']['gsplatDirector']>['camerasMap'] extends Map<unknown, infer C>
  ? C extends { layersMap: Map<unknown, infer L> } ? L : never : never;
type GSplatManager = NonNullable<GSplatLayerData['gsplatManager']>;
type GSplatWorldState = Parameters<GSplatManager['sortCpu']>[0];
type GSplatInfo = GSplatWorldState['splats'][number];
const cpuSortPatched = new WeakSet<object>();
/** Each GSplatInfo's world matrix at its manager's last posted sort. */
const sortedWorlds = new WeakMap<object, Mat4>();
/** When each big layer last re-sorted for a character's drift. */
const poseSortAt = new WeakMap<object, number>();
/** GSplatInfos whose drift updatePositions judged this frame (pose and transform together). */
const posedInfos = new WeakSet<object>();
/**
 * Per resource: the bone matrices its `centers` were last skinned with, and
 * their exact bounds. A body and its overlay copy share one resource, so the
 * second skin of a pose is skipped.
 */
const skinnedPoses = new WeakMap<object, { bones: Float32Array; min: Vec3; max: Vec3 }>();
const _poseBound = new Float32Array(6);
const _sortDelta = new Mat4();
const _sortA = new Vec3();
const _sortB = new Vec3();
const _sortCorner = new Vec3();

/** Whether `info`'s transform moved its bounds more than SORT_DRIFT of the camera distance since the last sort. */
function movedFar(info: GSplatInfo, cameraPos: Vec3): boolean {
  const now = info.node.getWorldTransform();
  const last = sortedWorlds.get(info);
  if (!last) return !info.previousWorldTransform.equals(now);
  if (last.equals(now)) return false;
  const { center: c, halfExtents: h } = info.aabb;
  let move = 0;
  for (let i = 0; i < 8; i++) {
    _sortCorner.set(c.x + (i & 1 ? h.x : -h.x), c.y + (i & 2 ? h.y : -h.y), c.z + (i & 4 ? h.z : -h.z));
    move = Math.max(move, now.transformPoint(_sortCorner, _sortA).distance(last.transformPoint(_sortCorner, _sortB)));
  }
  const dist = Math.max(cameraPos.distance(now.transformPoint(c, _sortA)), h.length() * now.getScale(_sortB).x);
  return move > SORT_DRIFT * dist;
}

/**
 * Patch one PC 2.23 GSplatManager's CPU-sort path. Upstream equivalent:
 * `world.applyWorkBufferUpdates` should flag a CPU sort only for transform
 * changes (thresholded), and the sorter should keep the latest request it
 * can't post.
 * - a work-buffer re-render alone no longer requests a sort, nor (big layers)
 *   a transform change below SORT_DRIFT;
 * - a request the busy worker drops (PC still marks it done) is re-issued once
 *   it frees, so the final camera pose of a fast turn always gets sorted.
 */
function patchCpuSort(manager: GSplatManager): void {
  if (cpuSortPatched.has(manager)) return;
  cpuSortPatched.add(manager);
  const update = manager.update.bind(manager);
  const sortCpu = manager.sortCpu.bind(manager);
  const world = manager.world;
  const applyWorkBufferUpdates = world.applyWorkBufferUpdates.bind(world);
  let deferred = false;
  manager.update = () => {
    if (deferred && manager.cpuSorter?.jobsInFlight === 0) {
      deferred = false;
      manager.sortNeeded = true;
    }
    return update();
  };
  manager.sortCpu = (state: GSplatWorldState) => {
    const sorter = manager.cpuSorter;
    deferred = !!sorter && sorter.jobsInFlight > 0 && !sorter.hasNewVersion;
    sortCpu(state);
    if (deferred) return;
    for (const s of state.splats) {
      const world = s.node.getWorldTransform();
      const last = sortedWorlds.get(s);
      if (last) last.copy(world);
      else sortedWorlds.set(s, world.clone());
    }
  };
  // Returns whether to sort; PC ORs it into manager.sortNeeded.
  world.applyWorkBufferUpdates = (state: GSplatWorldState, camera: GraphNode) => {
    if (!manager.cpuSorter || manager.sortNeeded) return applyWorkBufferUpdates(state, camera);
    const big = state.totalActiveSplats > SMALL_SORT_LAYER;
    const cameraPos = manager.cameraNode.getPosition();
    let moved = false;
    // Before applying: it copies each world matrix into previousWorldTransform.
    for (const s of state.splats) {
      if (posedInfos.delete(s)) continue;
      if (big ? movedFar(s, cameraPos) : !s.previousWorldTransform.equals(s.node.getWorldTransform())) moved = true;
    }
    return applyWorkBufferUpdates(state, camera) && moved;
  };
}

const _sortCenter = new Vec3();
const _sortScale = new Vec3();

/** Whether `bones` are exactly the matrices `snapshot` holds. */
function sameBones(snapshot: Float32Array, bones: Mat4[]): boolean {
  if (snapshot.length !== bones.length * 16) return false;
  for (let b = 0, o = 0; b < bones.length; b++) {
    const d = bones[b].data;
    for (let j = 0; j < 16; j++, o++) if (snapshot[o] !== d[j]) return false;
  }
  return true;
}

/**
 * Gaussian splat renderer.
 *
 * Wraps a PlayCanvas `gsplat` entity, holds the bone index/weight textures
 * used for skeletal deformation, and manages the transform palette written
 * to by the linked {@link Armature}. A custom work-buffer shader modifier is
 * installed that blends bone transforms on the GPU when `splatWeights` are
 * present, and leaves splats static otherwise (for environment splats).
 *
 * {@link Character.load} constructs this internally. Direct construction is
 * only needed for custom loading pipelines.
 *
 * @group Splats
 */
export class Splat {
  /** Source PlayCanvas asset. */
  asset: Asset;
  /** Parsed splat geometry (positions, rotations, scales, SH coefficients). */
  splatData: GSplatData;
  /** Splat count. */
  numSplats: number;
  /** PlayCanvas entity carrying the `gsplat` component. */
  entity: Entity;
  /** GPU texture of per-splat bone indices (RGBA32F, top-4 bones). Only present when skinned. */
  boneIndicesTexture?: Texture;
  /** GPU texture of per-splat bone weights (RGBA32F, top-4 bones). Only present when skinned. */
  boneWeightsTexture?: Texture;
  /**
   * GPU texture of per-splat group IDs (R32F, one float per splat). Sampled
   * with {@link variantMaskTexture} to collapse splats whose group bit is 0.
   * Allocated lazily on first {@link setSplatGroups} call - splats that
   * never opt into the variant system pay no GPU memory and the shader
   * skips the mask path entirely (`#define USE_VARIANT_MASK` is off).
   *
   * "Group" is opaque to the splat - game code decides what each ID means
   * (body part, material zone, LOD ring, whatever). See the
   * `DamageVariant` preset for the body-part scheme used by humanoid
   * characters.
   */
  groupIdsTexture?: Texture;
  /**
   * GPU texture of the per-group visibility mask. `maskWidth × 1` R32F.
   * Each texel `(g, 0)` is ≥0.5 to show splats in group `g`, <0.5 to hide
   * (collapse `scale → 0` in the work-buffer shader). Allocated lazily on
   * first {@link setSplatGroups} call.
   */
  variantMaskTexture?: Texture;
  /** CPU-side mirror of the variant mask. Undefined until the variant
   *  system is enabled via {@link setSplatGroups}. */
  variantMask?: Float32Array;
  /** Per-splat group IDs. Caller-supplied via {@link setSplatGroups}. */
  groupIds?: Uint8Array;
  /**
   * Per-bone transform texture fed to the GPU deformation shader.
   * @internal
   */
  transformPalette: TransformPalette;
  /**
   * 2×1 RGBA32F texture: texel 0 is the per-instance tint (rgb colour, a =
   * intensity), texel 1's r the opacity. Bound to the shader as
   * `splatTintTex`. Game code drives this for effects like hit flash,
   * invulnerability blink, freeze, etc.
   */
  tintTexture: Texture;
  /**
   * 1×1 RGBA32F color-grade texture: r = contrast, g = saturation. Defaults
   * (1,1) = identity. Bound as `splatGradeTex`. Drive via {@link setGrade}.
   */
  gradeTexture: Texture;
  /**
   * Per-splat distance along the feet-to-head reveal path (R32F). Allocated
   * the first time the reveal is used - see {@link setReveal}.
   */
  revealDistanceTexture?: Texture;
  /** The {@link Armature} currently driving this splat, if any. */
  linkedArmature: Armature | null = null;
  /** Top-4 bone indices + weights per splat. Undefined for non-skinned (environment) splats. */
  splatWeights?: SplatWeights;
  /** Bone count the splat weights were authored against. Used for rig compatibility checks. */
  sourceBoneCount?: number;
  /** Local-space AABB from the gsplat resource. */
  localBound: BoundingBox;
  private _scene: Scene | null = null;
  private _deformedAabb = new BoundingBox();
  private _deformedAabbMin = new Vec3();
  private _deformedAabbMax = new Vec3();
  // Centers (and their bounds) last uploaded to the big CPU-sorted layers
  // holding this splat. See updatePositions.
  private _sortedCenters: Float32Array | null = null;
  private _sortedAabb = new BoundingBox();
  private _driftCheckAt = -Infinity;
  private _sortAabb = new BoundingBox();
  // Scratch for isInFrustum - world-space AABB + its bounding sphere.
  private _worldAabb = new BoundingBox();
  private _worldSphere = { center: new Vec3(), radius: 0 };
  // Pre-baked interleaved buffer for updatePositions: [x, y, z, w0, b0, w1, b1] per splat.
  // Built once at construction; eliminates per-frame getProp calls and collapses 5 separate
  // array streams into 1 for better cache utilisation in the hot skinning loop.
  private _cpuInfluences: Float32Array | null = null;
  // Per-bone boxes of rest centers, for a pose's bound without skinning (posed-bound.ts).
  private _boneBoxes: Float32Array | null = null;
  // Latest pushed pose; `centers` are skinned from it only when read. See updatePositions.
  private _poseBones: Mat4[] | null = null;
  // Cache key for shared bone textures. Non-null means this instance's
  // boneIndicesTexture/boneWeightsTexture live in _sharedBoneTextureCache
  // and must not be destroyed until the last referencing instance is gone.
  private _boneTextureCacheKey: string | null = null;
  // True once the work-buffer modifier has been recompiled with
  // `USE_VARIANT_MASK` enabled (one-shot per Splat instance - flips on
  // first setSplatGroups call). Splats that never opt into the variant
  // system stay at false and the shader skips two texelFetches per pixel.
  private _variantMaskEnabled = false;
  // Set on first reveal use; compiles `USE_REVEAL` in (one-shot, like the
  // variant mask). See setReveal.
  private _revealEnabled = false;
  // Set once bakeReveal has run. A splat opted in before it had an armature
  // is enabled but unbaked, and gets baked when it links.
  private _revealBaked = false;
  // uRevealBand / uRevealSketch / uRevealTint. See setRevealLook.
  private readonly _revealBand = new Float32Array(4);
  private readonly _revealSketch = new Float32Array(4);
  private readonly _revealTint = new Float32Array(4);
  // Bone-length scaling: when true the work-buffer modifier is compiled with
  // USE_NONRIGID_COV so the palette's scale stretches Gaussian covariance
  // (set via SplatSkinning.setCovStretch → setNonRigidCovariance).
  private _nonRigidCov = false;
  // Captured at construction for lazy texture allocation when the variant
  // system is opted into post-hoc via setSplatGroups / setVariantMask.
  private _device: GraphicsDevice;

  /**
   * @param app - Owning application. REQUIRED so the entity binds to the
   *   right `AppBase` instead of PlayCanvas's module-level
   *   `currentApplication` global. Without it, any second app that is
   *   "current" at construction time (e.g. an offscreen thumbnail
   *   renderer mid-render) silently steals ownership of this entity, and
   *   the splat never renders in the game scene - characters spawn but
   *   show no gaussian body.
   */
  /**
   * Whether {@link destroy} may unload {@link asset}.
   *
   * False for a splat that SHARES another's asset - an overlay copy from
   * `Character.addOverlaySplat` is the case that matters, and it is built from
   * the body's own asset so the two animate in lockstep. Destroying one of
   * those used to unload the asset out from under the body still rendering it,
   * which surfaced a frame later as `Cannot read properties of undefined
   * (reading 'centers')` inside the armature's update. Only the owner unloads.
   */
  ownsAsset = true;

  constructor(asset: Asset, orientation: Vec3, app: AppBase) {
    const splatResource = asset.resource as GSplatResource;
    const splatData = splatResource.gsplatData;
    const { device } = splatResource;
    this._device = device as GraphicsDevice;

    this.asset = asset;
    this.splatData = splatData as GSplatData;
    this.numSplats = splatData.numSplats;

    const extras = getAssetExtras(asset);
    const assetWeights = extras?.splatWeights;
    if (assetWeights?.indices && assetWeights?.weights) {
      this.splatWeights = {
        indices: assetWeights.indices,
        weights: assetWeights.weights,
      };
      this._bakeInfluences();
    }
    this.sourceBoneCount = extras?.splatSourceBoneCount;

    this.entity = new Entity('splatEntity', app);
    this.entity.setEulerAngles(orientation);
    this.entity.addComponent('gsplat', { asset });

    // Use resource bounds
    this.localBound = splatResource.aabb;

    const { x: width, y: height } = splatResource.textureDimensions;

    const createTexture = (name: string, format: number) => {
      return new Texture(device, {
        name,
        width,
        height,
        format,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
      });
    };

    if (this.splatWeights) {
      const boneTexCache = Splat._boneTextureCacheFor(this._device);
      const cacheKey = Splat._assetCacheKey(asset);
      const cached = cacheKey ? boneTexCache.get(cacheKey) : null;
      if (cached) {
        this.boneIndicesTexture = cached.boneIndicesTexture;
        this.boneWeightsTexture = cached.boneWeightsTexture;
        cached.refCount++;
        this._boneTextureCacheKey = cacheKey;
      } else {
        this.boneIndicesTexture = createTexture('boneIndices', PIXELFORMAT_RGBA32F);
        this.boneWeightsTexture = createTexture('boneWeights', PIXELFORMAT_RGBA32F);
        if (cacheKey) {
          boneTexCache.set(cacheKey, {
            boneIndicesTexture: this.boneIndicesTexture,
            boneWeightsTexture: this.boneWeightsTexture,
            refCount: 1,
          });
          this._boneTextureCacheKey = cacheKey;
        }
      }
    }

    this.transformPalette = new TransformPalette(device);

    // RGBA32F: rgb = tint colour (default white), a = intensity. The
    // shader does `mix(color, tint.rgb, tint.a)` so a=0 leaves the
    // splat at its original colour regardless of what's in rgb. Texel 1's r
    // multiplies alpha (see setOpacity).
    this.tintTexture = new Texture(device, {
      name: 'splatTint',
      width: 2,
      height: 1,
      format: PIXELFORMAT_RGBA32F,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    {
      const d = this.tintTexture.lock() as Float32Array;
      d[0] = 1; d[1] = 1; d[2] = 1; d[3] = 0;
      d[4] = 1;
      this.tintTexture.unlock();
    }

    // RGBA32F color-grade: r = contrast, g = saturation, b = reveal front,
    // a = reveal mode (0 forward, 1 inverse, 2 + strength pulse). Defaults
    // (1,1,1,0) = identity, so an ungraded splat renders unchanged.
    this.gradeTexture = new Texture(device, {
      name: 'splatGrade',
      width: 1,
      height: 1,
      format: PIXELFORMAT_RGBA32F,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    {
      const d = this.gradeTexture.lock() as Float32Array;
      d[0] = 1; d[1] = 1; d[2] = 1; d[3] = 0;
      this.gradeTexture.unlock();
    }

    packRevealLook(DEFAULT_REVEAL_LOOK, this._revealBand, this._revealSketch, this._revealTint);

    // Register in the live-instances set so subsystems that care about splat
    // lifecycle (RelightPass, Scene.destroy) can observe add/remove.
    Splat._liveInstances.add(this);

    // Install work buffer modifier for palette / bone-blended transforms and
    // colour tweaks. USE_BONE_BLENDING is set for skinned splats so the
    // shader picks up the bone-blended path. USE_VARIANT_MASK is OFF here
    // - it flips on lazily when setSplatGroups runs, recompiling the shader
    // once. Splats that never opt in pay no mask-sample cost per pixel.
    this._installWorkBufferModifier();

    // Animated characters (with bone weights) need their work buffer re-
    // rendered every frame so `dataTransformA` reflects the current pose.
    // Without this, PC's AUTO mode only re-renders on centersVersion /
    // sort changes, which doesn't fire per-frame for pure palette updates
    // - shadow content stays frozen on the first-rendered pose. Env
    // splats stay AUTO for perf.
    if (this.splatWeights) {
      const gsplat = this.entity.gsplat;
      if (gsplat) gsplat.workBufferUpdate = 2; // WORKBUFFER_UPDATE_ALWAYS
    }
  }

  /**
   * (Re-)install the work-buffer shader modifier with the current set of
   * compile-time defines. Called once at construction; called again from
   * {@link setSplatGroups} when the variant-mask path is opted into.
   * Recompiling here is a one-time cost - game code is expected to opt in
   * at character load time, not per frame.
   */
  private _installWorkBufferModifier(): void {
    const gsplat = this.entity.gsplat;
    if (!gsplat) return;
    let defines = '';
    if (this.splatWeights) defines += '#define USE_BONE_BLENDING\n';
    if (this._variantMaskEnabled) defines += '#define USE_VARIANT_MASK\n';
    if (this._revealEnabled) defines += '#define USE_REVEAL\n';
    if (this._nonRigidCov) defines += '#define USE_NONRIGID_COV\n';
    gsplat.setWorkBufferModifier({
      glsl: defines + WORK_BUFFER_MODIFIER_GLSL,
      wgsl: defines + WORK_BUFFER_MODIFIER_WGSL,
    });
  }

  /**
   * Toggle the `USE_NONRIGID_COV` shader path so the palette's per-axis scale
   * stretches Gaussian covariance (used by bone-length scaling). Recompiles
   * the work-buffer modifier once. Driven by {@link SplatSkinning.setCovStretch}.
   */
  setNonRigidCovariance(on: boolean): void {
    if (this._nonRigidCov === on) return;
    this._nonRigidCov = on;
    this._installWorkBufferModifier();
  }

  /**
   * Attach the splat entity to a scene. Uploads bone index/weight textures
   * and wires up the transform-palette parameter on the gsplat component.
   */
  addToScene(scene: Scene) {
    this._scene = scene;
    scene.contentRoot.addChild(this.entity);

    this.uploadBoneTextures();
    this.updateUnifiedWorkBufferParams();
    // Neutral relight bindings, once. Every sampler the work-buffer shader
    // declares has to be bound on the first draw, and the relight chunk is
    // compiled into every splat whether or not a `RelightPass` exists. A live
    // pass overwrites these each frame from its own prerender hook.
    seedRelightDefaults(this.entity.gsplat, scene.graphicsDevice);
  }

  private uploadBoneTextures() {
    if (!this.splatWeights || !this.boneIndicesTexture || !this.boneWeightsTexture) return;
    // Skip if another instance already uploaded these shared textures to the GPU
    if (this._boneTextureCacheKey) {
      const entry = Splat._boneTextureCacheFor(this._device).get(this._boneTextureCacheKey);
      if (entry && entry.refCount > 1) return;
    }

    const { indices, weights } = this.splatWeights;
    const topK = indices.length / this.numSplats;

    // Write bone indices as floats (shader reads as float then casts to uint)
    const indicesData = this.boneIndicesTexture.lock() as Float32Array;
    for (let i = 0; i < this.numSplats; i++) {
      for (let j = 0; j < 4; j++) {
        indicesData[i * 4 + j] = j < topK ? indices[i * topK + j] : 0;
      }
    }
    this.boneIndicesTexture.unlock();

    // Write bone weights
    const weightsData = this.boneWeightsTexture.lock() as Float32Array;
    for (let i = 0; i < this.numSplats; i++) {
      for (let j = 0; j < 4; j++) {
        weightsData[i * 4 + j] = j < topK ? weights[i * topK + j] : 0;
      }
    }
    this.boneWeightsTexture.unlock();
  }

  // ── Bone-weight privatization (for runtime mutation: ragdoll limb
  //    detachment, hit-based weight pruning, etc.) ─────────────────────────

  /**
   * `true` if this splat's bone-weight data (both the JS
   * `splatWeights` arrays and the GPU bone textures) has been
   * privatized - safe to mutate without affecting other instances of
   * the same asset. `false` while still sharing.
   */
  get boneWeightsArePrivate(): boolean {
    return !!this.splatWeights && this._boneTextureCacheKey === null;
  }

  /**
   * Detach this splat's bone-weight data from the shared cache, so
   * the JS `splatWeights.indices`/`weights` arrays and the GPU bone
   * textures become private to this instance. After this call,
   * mutating those arrays and calling {@link reuploadBoneWeights}
   * flushes the change to the GPU without affecting siblings.
   *
   * Costs: O(numSplats × K) memcpy + two RGBA32F texture allocations
   * + one full upload. Idempotent.
   *
   * Used by the ragdoll system for limb detachment (snap each splat's
   * weights to one side of a broken joint), and intended for any
   * downstream effect that needs to mutate per-splat bone influence
   * at runtime.
   */
  privatizeBoneWeights(): void {
    if (!this.splatWeights) return;
    if (this._boneTextureCacheKey === null) return; // already private

    // Clone the JS weight arrays so subsequent mutations don't leak
    // to siblings that still share the underlying asset.
    this.splatWeights = {
      indices: new Uint16Array(this.splatWeights.indices),
      weights: new Float32Array(this.splatWeights.weights),
    };

    // Drop our reference on the shared cache entry. Don't delete the
    // entry - sibling instances and future asset loads still benefit.
    // When the last shared owner destroys, the entry's refcount hits
    // zero and its textures are freed via the normal destroy path.
    const oldKey = this._boneTextureCacheKey;
    const cached = Splat._boneTextureCacheFor(this._device).get(oldKey);
    if (cached) cached.refCount--;
    this._boneTextureCacheKey = null;

    // Allocate new private textures with the same shape/format as the
    // shared ones. We read width/height/device off the old textures
    // rather than re-querying the splat resource - same result, less
    // plumbing.
    const oldIdx = this.boneIndicesTexture;
    const oldW = this.boneWeightsTexture;
    if (!oldIdx || !oldW) return; // defensive - splatWeights present should imply textures
    const mk = (name: string, src: Texture) => new Texture(src.device, {
      name,
      width: src.width,
      height: src.height,
      format: PIXELFORMAT_RGBA32F,
      mipmaps: false,
      minFilter: FILTER_NEAREST,
      magFilter: FILTER_NEAREST,
      addressU: ADDRESS_CLAMP_TO_EDGE,
      addressV: ADDRESS_CLAMP_TO_EDGE,
    });
    this.boneIndicesTexture = mk('boneIndicesPrivate', oldIdx);
    this.boneWeightsTexture = mk('boneWeightsPrivate', oldW);

    // Upload the (just-cloned) weights to the new textures and
    // rebind the gsplat shader params to point at them.
    this.uploadBoneTextures();
    this.updateUnifiedWorkBufferParams();
  }

  /**
   * Re-upload the current `splatWeights.indices`/`weights` arrays to
   * the bone textures. Call after mutating those arrays to flush the
   * change to the GPU. Throws if the splat's bone weights are still
   * shared - call {@link privatizeBoneWeights} first.
   */
  reuploadBoneWeights(): void {
    if (this._boneTextureCacheKey !== null) {
      throw new Error(
        '[Splat] reuploadBoneWeights: bone weights are still shared with ' +
        'other instances. Call privatizeBoneWeights() first or you will ' +
        'corrupt sibling characters.',
      );
    }
    this.uploadBoneTextures();
  }

  updateUnifiedWorkBufferParams() {
    const gsplat = this.entity.gsplat;
    if (!gsplat) return;

    // Defensive guard: if the gsplat component has lost its host app (a
    // previous app was destroyed but one of its characters is still ticking
    // on the next app's update loop), skip the param write. Same
    // currentApplication-global-bleed the `app` constructor argument exists
    // to avoid; `Armature` still resolves its app from the scene, so the
    // hole is not fully closed. Avoid the crash and rely on the dying scene
    // to detach its update listeners.
    const scope = gsplat?.system?.app?.graphicsDevice?.scope;
    if (!scope) return;

    gsplat.setParameter('transformPalette', this.transformPalette.texture);
    gsplat.setParameter('splatTintTex', this.tintTexture);
    gsplat.setParameter('splatGradeTex', this.gradeTexture);
    if (this.boneIndicesTexture && this.boneWeightsTexture) {
      gsplat.setParameter('boneIndices', this.boneIndicesTexture);
      gsplat.setParameter('boneWeights', this.boneWeightsTexture);
    }
    if (this.groupIdsTexture && this.variantMaskTexture) {
      gsplat.setParameter('splatGroupIds', this.groupIdsTexture);
      gsplat.setParameter('splatVariantMask', this.variantMaskTexture);
    }
    if (this._revealEnabled) {
      if (this.revealDistanceTexture) {
        gsplat.setParameter('splatRevealDistanceTex', this.revealDistanceTexture);
      }
      gsplat.setParameter('uRevealBand', this._revealBand);
      gsplat.setParameter('uRevealSketch', this._revealSketch);
      gsplat.setParameter('uRevealTint', this._revealTint);
    }
  }

  /**
   * Set the per-instance tint. `intensity` is the blend factor (0 = leave
   * splat colour untouched, 1 = fully replace with `color`). `color`
   * defaults to white so the no-arg / single-arg form behaves like the
   * legacy "white flash" channel - call sites that only pass intensity
   * keep their old visual.
   *
   * Generic effect channel - use for hit flash (any colour), invuln
   * blink, freeze, etc. The shader does
   * `mix(splatRgb, tint.rgb, tint.a)` per fragment.
   */
  setTint(
    intensity: number,
    color: { r: number; g: number; b: number } = WHITE_TINT,
  ): void {
    const data = this.tintTexture.lock() as Float32Array;
    data[0] = color.r;
    data[1] = color.g;
    data[2] = color.b;
    data[3] = intensity;
    this.tintTexture.unlock();
  }

  /** Multiply every splat's alpha by `opacity` (0..1); 1, the default, leaves it. */
  setOpacity(opacity: number): void {
    const data = this.tintTexture.lock() as Float32Array;
    data[4] = Math.min(1, Math.max(0, opacity));
    this.tintTexture.unlock();
  }

  /**
   * Set the color-grade applied after lighting + tint. `contrast` and
   * `saturation` are multipliers where 1 = identity (so the no-op state leaves
   * the splat unchanged). Generic post-grade channel - drive it for mood/FX.
   */
  setGrade(contrast: number, saturation: number): void {
    const data = this.gradeTexture.lock() as Float32Array;
    data[0] = contrast;
    data[1] = saturation;
    this.gradeTexture.unlock();
  }

  /**
   * Reveal amount in [0, 1]. At 1 (the default) the splat renders unchanged.
   * Below 1 a bright front walks from feet to head, with sparse dots just
   * ahead of it. Zero is invisible. One texel write; no re-sort or rebuild.
   * `inverse` keeps the area ahead of the front for outgoing transitions.
   *
   * The first call below 1 (or with `inverse`) opts the splat in: it bakes
   * the per-splat distances through the linked {@link Armature} and
   * recompiles the work-buffer shader, which can cost a frame on a large
   * character. Call {@link Armature.prepareReveal} after loading to pay that
   * up front. A splat that is never revealed pays nothing.
   */
  setReveal(amount: number, inverse = false): void {
    if (!this._revealEnabled && (amount < 1 || inverse)) {
      this.linkedArmature?.prepareReveal?.();
      this._enableReveal();
    }
    const data = this.gradeTexture.lock() as Float32Array;
    data[2] = Math.min(1, Math.max(0, amount));
    data[3] = inverse ? 1 : 0;
    this.gradeTexture.unlock();
  }

  /**
   * The reveal's bright band at `front` (0 below the feet, 1 past the head)
   * over a splat that stays fully drawn: nothing hides and no sketch dots.
   * `strength` (0-1) scales the band; 0 is the same as `setReveal(1)`.
   * Replaces any reveal in progress. Opts in like {@link setReveal}.
   */
  setRevealPulse(front: number, strength = 1): void {
    const s = Math.min(1, Math.max(0, strength));
    if (s <= 0) { this.setReveal(1); return; }
    if (!this._revealEnabled) {
      this.linkedArmature?.prepareReveal?.();
      this._enableReveal();
    }
    const data = this.gradeTexture.lock() as Float32Array;
    data[2] = Math.min(1, Math.max(0, front));
    data[3] = 2 + s;
    this.gradeTexture.unlock();
  }

  /**
   * Change how the reveal looks. Unset fields keep their current value; the
   * starting look is {@link DEFAULT_REVEAL_LOOK}. Cheap; no recompile.
   */
  setRevealLook(look: RevealLook): void {
    packRevealLook(look, this._revealBand, this._revealSketch, this._revealTint);
    if (this._revealEnabled) this.updateUnifiedWorkBufferParams();
  }

  /** Whether the reveal has been opted into - see {@link setReveal}. */
  get revealEnabled(): boolean {
    return this._revealEnabled;
  }

  /** Whether {@link bakeReveal} has run for this splat. */
  get revealBaked(): boolean {
    return this._revealBaked;
  }

  /** Compile the reveal in and allocate its per-splat distances. Once. */
  private _enableReveal(): void {
    if (this._revealEnabled) return;
    this._revealEnabled = true;
    if (this.splatWeights) {
      const resource = this.asset.resource as GSplatResource;
      const { x: width, y: height } = resource.textureDimensions;
      this.revealDistanceTexture = new Texture(this._device, {
        name: 'splatRevealDistance',
        width,
        height,
        format: PIXELFORMAT_R32F,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
      });
      // A missing bake stays hidden until the reveal completes.
      const d = this.revealDistanceTexture.lock() as Float32Array;
      d.fill(1);
      this.revealDistanceTexture.unlock();
    }
    this._installWorkBufferModifier();
    this.updateUnifiedWorkBufferParams();
  }

  /**
   * Bake the per-splat reveal distances against `skeleton`, opting the splat
   * into the reveal. Called by {@link Armature.prepareReveal}.
   *
   * @param boneRemap - Splat bone index to armature bone, `-1` when unmapped,
   * or `null` when the splat's bones are the armature's.
   */
  bakeReveal(skeleton: RevealSkeleton, boneRemap: ArrayLike<number> | null): void {
    this._enableReveal();
    this._revealBaked = true;
    if (!this.splatWeights || !this.revealDistanceTexture) return;
    const x = this.splatData.getProp('x') as Float32Array | null;
    const y = this.splatData.getProp('y') as Float32Array | null;
    const z = this.splatData.getProp('z') as Float32Array | null;
    if (!x || !y || !z) return;
    const { indices, weights } = this.splatWeights;
    const out = this.revealDistanceTexture.lock() as Float32Array;
    bakeRevealDistances(out, { x, y, z, indices, weights, numSplats: this.numSplats }, skeleton, boneRemap);
    this.revealDistanceTexture.unlock();
    this.updateUnifiedWorkBufferParams();
  }

  /**
   * Opt this splat into the variant-mask system. Uploads per-splat
   * `groupIds` to a GPU texture, allocates the variant mask, and recompiles
   * the work-buffer shader with `USE_VARIANT_MASK` enabled. Until this is
   * called, the splat pays no GPU memory and no per-pixel mask-sample cost.
   *
   * The meaning of each group ID is opaque to the splat - callers decide
   * the semantics. See `DamageVariant` for the body-part scheme used by
   * humanoid characters.
   *
   * @param groupIds - Per-splat group, length must equal {@link numSplats}.
   * @param numGroups - Width of the variant mask (max group ID + 1). The
   *   mask starts all-ones so the visual state is unchanged until
   *   {@link setVariantMask} runs.
   */
  setSplatGroups(groupIds: Uint8Array, numGroups: number): void {
    if (groupIds.length !== this.numSplats) {
      throw new Error(
        `Splat.setSplatGroups: groupIds length ${groupIds.length} != numSplats ${this.numSplats}`,
      );
    }
    if (numGroups < 1) throw new Error('Splat.setSplatGroups: numGroups must be ≥1');

    this.groupIds = groupIds;

    // Allocate the per-splat group ID texture sized to match the existing
    // splat data textures (so `splat.uv` works without extra dim hand-off).
    if (!this.groupIdsTexture) {
      const resource = this.asset.resource as GSplatResource;
      const { x: width, y: height } = resource.textureDimensions;
      this.groupIdsTexture = new Texture(this._device, {
        name: 'splatGroupIds',
        width,
        height,
        format: PIXELFORMAT_R32F,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
      });
    }
    const gidData = this.groupIdsTexture.lock() as Float32Array;
    for (let i = 0; i < this.numSplats; i++) gidData[i] = groupIds[i];
    this.groupIdsTexture.unlock();

    // Allocate / resize the variant mask. Default all-ones means "show
    // every group" - visually identical to a non-variant splat until the
    // caller pushes a real mask via setVariantMask.
    if (!this.variantMaskTexture || this.variantMaskTexture.width !== numGroups) {
      this.variantMaskTexture?.destroy();
      this.variantMaskTexture = new Texture(this._device, {
        name: 'splatVariantMask',
        width: numGroups,
        height: 1,
        format: PIXELFORMAT_R32F,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE,
      });
      this.variantMask = new Float32Array(numGroups);
    }
    this.variantMask!.fill(1);
    const maskData = this.variantMaskTexture.lock() as Float32Array;
    maskData.set(this.variantMask!);
    this.variantMaskTexture.unlock();

    // Recompile the shader once with USE_VARIANT_MASK defined, then push
    // the new uniforms.
    if (!this._variantMaskEnabled) {
      this._variantMaskEnabled = true;
      this._installWorkBufferModifier();
    }
    this.updateUnifiedWorkBufferParams();
  }

  /**
   * Replace the per-group visibility mask. Each entry is ≥0.5 to render
   * splats in that group, <0.5 to collapse them (scale → 0 in the work-
   * buffer shader). No-op until {@link setSplatGroups} has been called.
   */
  setVariantMask(mask: ArrayLike<number>): void {
    if (!this.variantMaskTexture || !this.variantMask) return;
    const n = Math.min(this.variantMask.length, mask.length);
    for (let i = 0; i < n; i++) this.variantMask[i] = mask[i];
    const data = this.variantMaskTexture.lock() as Float32Array;
    data.set(this.variantMask);
    this.variantMaskTexture.unlock();
  }

  /**
   * Conservative "is this splat inside the camera frustum" test. Wraps the
   * current deformed AABB in its bounding sphere in world space and runs
   * a plane-test against the camera's frustum. Used by {@link Armature.update}
   * to skip CPU bone-blend work for off-screen characters - otherwise a
   * 100-character scene does 100× the per-frame CPU splat position blend
   * regardless of how many characters the camera can actually see.
   */
  isInFrustum(frustum: { containsSphere: (s: { center: Vec3; radius: number }) => number }): boolean {
    // _deformedAabb is local splat space; updatePositions refreshes it every
    // posed frame (skinned centers, or the looser per-bone bound). Before the first updatePositions
    // call it's a zero box - fall back to localBound (rest pose) so
    // characters don't get culled away before their first animation tick.
    const aabb = (this._deformedAabb.halfExtents.x > 0 ||
                  this._deformedAabb.halfExtents.y > 0 ||
                  this._deformedAabb.halfExtents.z > 0)
      ? this._deformedAabb
      : this.localBound;
    this._worldAabb.setFromTransformedAabb(aabb, this.entity.getWorldTransform());
    this._worldSphere.center = this._worldAabb.center;
    this._worldSphere.radius = this._worldAabb.halfExtents.length();
    return frustum.containsSphere(this._worldSphere) > 0;
  }

  /**
   * World-space AABB of the splat: the deformed (post-skinning) bounds once an
   * animation has ticked, else the rest-pose bounds, transformed by the
   * entity's world matrix. Returns a fresh {@link BoundingBox} (`center` +
   * `halfExtents`). Used by tools (e.g. the sprite baker) for framing/grounding.
   */
  getWorldAabb(): BoundingBox {
    this._skinCenters();
    const local = (this._deformedAabb.halfExtents.x > 0 ||
                   this._deformedAabb.halfExtents.y > 0 ||
                   this._deformedAabb.halfExtents.z > 0)
      ? this._deformedAabb
      : this.localBound;
    const out = new BoundingBox();
    out.setFromTransformedAabb(local, this.entity.getWorldTransform());
    return out;
  }

  // Scratch for getWorldMinY - kept separate from _worldAabb so a ground-Y
  // query can't clobber an in-flight frustum test (both run per frame).
  private _groundAabb = new BoundingBox();
  // Reused Y histogram for getGroundWorldY (robust ground estimate).
  private _groundHist = new Int32Array(256);

  /**
   * World-space Y of the splat's lowest point: the deformed (post-skinning)
   * AABB bottom once an animation has ticked, else the rest-pose AABB bottom.
   * Not noise-robust - a single stray/debris splat below the feet drags this
   * arbitrarily low. Prefer {@link getGroundWorldY} for a ground-snap
   * estimate; this is its fallback for non-skinned splats or before centers
   * exist.
   */
  getWorldMinY(): number {
    this._skinCenters();
    const aabb = (this._deformedAabb.halfExtents.x > 0 ||
                  this._deformedAabb.halfExtents.y > 0 ||
                  this._deformedAabb.halfExtents.z > 0)
      ? this._deformedAabb
      : this.localBound;
    this._groundAabb.setFromTransformedAabb(aabb, this.entity.getWorldTransform());
    return this._groundAabb.center.y - this._groundAabb.halfExtents.y;
  }

  /**
   * Noise-robust world-space ground Y: the height below which only `quantile`
   * of the splat centers sit. Unlike {@link getWorldMinY} (the absolute lowest
   * splat), this ignores reconstruction outliers - stray/debris splats that
   * float below a character's feet - which otherwise drag a naive "lowest
   * point" arbitrarily far down and defeat a ground-snap.
   *
   * Reads the live deformed centers ({@link posedCenters}, in the splat
   * entity's local space) and histograms their Y,
   * then returns the low-quantile boundary plus the entity's world Y offset.
   * Character splats are yaw-only/unscaled so a Y-axis rotation preserves Y -
   * adding the world translation Y is exact. Falls back to {@link getWorldMinY}
   * for non-skinned splats or before centers exist.
   *
   * O(numSplats), two passes - cheap enough for an editor's brief measurement
   * window. Not used by the per-frame render path.
   */
  getGroundWorldY(quantile = 0.005): number {
    const centers = this.asset.resource ? this.posedCenters() : undefined;
    const n = this.numSplats;
    if (!centers || n === 0 || !this.splatWeights) return this.getWorldMinY();

    // Pass 1: raw Y range of the deformed centers.
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const y = centers[i * 3 + 1];
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    const worldOffsetY = this.entity.getWorldTransform().data[13];
    if (!(hi > lo)) return lo + worldOffsetY; // degenerate: all splats same Y

    // Pass 2: histogram Y, walk up from the bottom until `quantile` of splats
    // are accounted for. That boundary is the robust floor.
    const BUCKETS = 256;
    const counts = this._groundHist;
    counts.fill(0);
    const scale = BUCKETS / (hi - lo);
    for (let i = 0; i < n; i++) {
      const y = centers[i * 3 + 1];
      let b = ((y - lo) * scale) | 0;
      if (b >= BUCKETS) b = BUCKETS - 1;
      if (b < 0) b = 0;
      counts[b]++;
    }
    const threshold = Math.max(1, Math.floor(n * quantile));
    let cum = 0;
    let boundary = lo;
    for (let b = 0; b < BUCKETS; b++) {
      cum += counts[b];
      if (cum >= threshold) { boundary = lo + (b + 1) / scale; break; }
    }
    return boundary + worldOffsetY;
  }

  /**
   * Pre-bake the per-splat rest position + top-4 bone influences into one
   * interleaved buffer for {@link updatePositions} to walk.
   *
   * Called ONCE, from the constructor. Nothing re-bakes it, so a caller that
   * mutates `splatWeights` after {@link privatizeBoneWeights} refreshes the
   * GPU textures via {@link reuploadBoneWeights} but leaves this CPU buffer
   * on the old influences - the rendered pose moves and the sort centers do
   * not.
   */
  private _bakeInfluences(): void {
    if (!this.splatWeights) return;
    const restX = this.splatData.getProp('x') as Float32Array | null;
    const restY = this.splatData.getProp('y') as Float32Array | null;
    const restZ = this.splatData.getProp('z') as Float32Array | null;
    if (!restX || !restY || !restZ) return;

    const { indices, weights } = this.splatWeights;
    // `srcStride` = bone influences per splat in the asset, laid out
    // per-splat-contiguous: [s0b0, s0b1, …, s1b0, …]. We pack the TOP 4 to
    // match the GPU's RGBA32F bone textures - using fewer makes the CPU sort
    // centers diverge from the rendered (top-4 skinned) positions and garbles
    // the WebGL CPU depth sort. Index source arrays with `srcStride`, NOT
    // `topK`: capping the multiplier below the real stride reads neighbouring
    // splats' influences (the bug this replaces).
    const srcStride = Math.max(1, Math.floor(indices.length / this.numSplats));
    const topK = Math.min(srcStride, 4);
    // Layout per splat: [x, y, z, w0,b0, w1,b1, w2,b2, w3,b3] - 11 floats.
    const STRIDE = 11;
    const buf = new Float32Array(this.numSplats * STRIDE);
    for (let i = 0, base = 0; i < this.numSplats; i++, base += STRIDE) {
      buf[base]     = restX[i];
      buf[base + 1] = restY[i];
      buf[base + 2] = restZ[i];
      const src = i * srcStride;
      for (let j = 0; j < topK; j++) {
        buf[base + 3 + j * 2] = weights[src + j];
        buf[base + 4 + j * 2] = indices[src + j];
      }
      // Unused influence slots stay 0 (Float32Array zero-init); weight 0 is
      // skipped in the hot loop.
    }
    this._cpuInfluences = buf;
    this._boneBoxes = bakeBoneBoxes(buf, this.numSplats);
  }

  /**
   * Take a new pose: fit the customAabb to it, then request a re-sort from the
   * PlayCanvas gsplat director.
   *
   * Called by {@link Armature.update} every frame when an animation is
   * active. The GPU shader skins the rendered splats and GPU sorts read them,
   * so the CPU sort centers are skinned only when a CPU (WebGL) sort will read
   * them this frame; otherwise the bounds come from per-bone boxes. The bounds
   * keep the sort-key range around the posed splats, else the sorter drops
   * those outside the rest-pose AABB. On a CPU-sorted layer bigger than
   * {@link SMALL_SORT_LAYER} the centers go to the worker, and the layer
   * re-sorts, only once the splat has drifted enough to matter.
   *
   * @param boneTransforms - One world-space matrix per bone, in the same
   * order as the armature's bone indices.
   */
  updatePositions(boneTransforms: Mat4[]) {
    if (!this._scene) return;
    if (!this.splatWeights || !boneTransforms.length) return;
    if (!this._cpuInfluences) return;
    this._poseBones = boneTransforms;

    const resource = this.asset.resource as GSplatResource;
    const centers = resource.centers;
    const gsplat = this.entity.gsplat;
    const placementId = gsplat ? placementOf(gsplat)?.id : undefined;
    const worldTransform = this.entity.getWorldTransform();

    // CPU-sorted managers holding this splat: small ones re-sort every posed
    // frame; big ones share one snapshot of the centers they were last given,
    // and `lastSorted` is this splat's world matrix at their last sort.
    // `moved`: the whole body moved far enough to re-sort a big layer now.
    const small: GSplatManager[] = [];
    const big: GSplatManager[] = [];
    const others: GSplatManager[] = [];
    let lastSorted: Mat4 | undefined;
    let moved = false;
    let cpuSorted = false;
    const director = this._scene.app.renderer?.gsplatDirector;
    for (const cameraData of director?.camerasMap?.values() ?? []) {
      for (const layerData of cameraData.layersMap?.values() ?? []) {
        for (const manager of [layerData.gsplatManager, layerData.gsplatManagerShadow]) {
          if (!manager) continue;
          if (!manager.cpuSorter) {
            others.push(manager);
            continue;
          }
          cpuSorted = true;
          patchCpuSort(manager);
          const isBig = (manager.world.getState(manager.world.lastWorldStateVersion)?.totalActiveSplats ?? 0) > SMALL_SORT_LAYER;
          let holds = false;
          for (const state of manager.world._worldStates.values()) {
            for (const info of state.splats) {
              if (info.placementId !== placementId) continue;
              holds = true;
              if (!isBig) continue;
              posedInfos.add(info);
              lastSorted = sortedWorlds.get(info) ?? lastSorted;
              if (movedFar(info, manager.cameraNode.getPosition())) moved = true;
            }
          }
          if (holds) (isBig ? big : small).push(manager);
        }
      }
    }

    // Big layer: when it re-sorts this frame anyway (camera, a body moved,
    // another character), it gets this pose too. Otherwise check at most every
    // POSE_SORT_INTERVAL_MS whether some center drifted more than SORT_DRIFT
    // of the camera distance, and re-sort for that at most as often per layer.
    let syncBig = false;
    let driftDue = false;
    const now = performance.now();
    if (big.length) {
      syncBig = moved || big.some((m) => m.sortNeeded || m.testCameraMovedForSort());
      driftDue = !syncBig && now - this._driftCheckAt >= POSE_SORT_INTERVAL_MS &&
        big.every((m) => now - (poseSortAt.get(m) ?? -Infinity) >= POSE_SORT_INTERVAL_MS);
    }
    // A CPU sorter copies `centers` once, when its world state first takes
    // this resource (PC updateCentersForSplats): keep them posed until then.
    const adding = cpuSorted && !small.length && !big.length;
    if (adding || small.length || syncBig || driftDue) this._skinCenters();
    else this._boundPose(boneTransforms);
    if (driftDue) {
      this._driftCheckAt = now;
      const scale = worldTransform.getScale(_sortScale).x;
      worldTransform.transformPoint(this._deformedAabb.center, _sortCenter);
      let near = Infinity;
      for (const m of big) near = Math.min(near, m.cameraNode.getPosition().distance(_sortCenter));
      const limit = SORT_DRIFT * Math.max(near, this._deformedAabb.halfExtents.length() * scale);
      syncBig = this._sortDrift(worldTransform, lastSorted) * scale > limit;
      if (syncBig) for (const m of big) poseSortAt.set(m, now);
    }
    if (syncBig) {
      (this._sortedCenters ??= new Float32Array(centers.length)).set(centers);
      this._sortedAabb.copy(this._deformedAabb);
    }

    // PC snapshots the AABB twice on its way to the sort worker, neither
    // of which tracks subsequent mutations:
    //   1. GSplatComponent.customAabb setter -> placement._aabb clones
    //      (gsplat-placement.js: `this._aabb = aabb?.clone() ?? null`).
    //   2. GSplatInfo constructor copies placement.aabb -> info.aabb
    //      once at world-state creation (gsplat-info.js).
    // sortCpu then reads info.aabb (gsplat-manager.js), which is
    // frozen at the rest pose. When bones deform splats past the rest
    // bounds, those splats land outside the sort-key quantization range
    // and the worker drops them: "N splats lost due to sortKey overflow".
    // Force-sync every live GSplatInfo for this placement each frame, with
    // bounds that also cover the older pose a big layer's worker may hold.
    const sortAabb = this._sortAabb;
    sortAabb.copy(this._deformedAabb);
    if (big.length && this._sortedCenters) sortAabb.add(this._sortedAabb);
    if (gsplat) gsplat.customAabb = sortAabb;
    for (const manager of [...others, ...small, ...big]) {
      manager.world._worldStates.forEach((state) => {
        for (const info of state.splats ?? []) {
          if (info.placementId === placementId) info.aabb.copy(sortAabb);
        }
      });
      // GPU sorts read the re-rendered work buffer: keep sorting every frame.
      if (!manager.cpuSorter) {
        manager.sortNeeded = true;
        continue;
      }
      if (!syncBig && big.includes(manager)) continue;
      // Re-upload centers directly to the manager's cpuSorter. We
      // deliberately DO NOT bump resource.centersVersion - the
      // world's placement state tracker watches centersVersion and would
      // recreate the world state (and rebuild the whole work buffer)
      // every frame.
      manager.cpuSorter.setCenters(resource.id, null);
      manager.cpuSorter.setCenters(resource.id, centers);
      manager.sortNeeded = true;
    }
  }

  /**
   * The CPU sort centers (`resource.centers`, splat-local) skinned to the
   * latest pose. Per frame only a CPU (WebGL) sort needs them, so anything
   * else reading them (picking, ground probes) goes through here.
   */
  posedCenters(): Float32Array {
    this._skinCenters();
    return (this.asset.resource as GSplatResource).centers;
  }

  /** Skin `centers` to the latest pose unless they already hold it, and take their exact bounds. */
  private _skinCenters(): void {
    const boneTransforms = this._poseBones;
    const packed = this._cpuInfluences;
    if (!boneTransforms || !packed) return;
    const resource = this.asset.resource as GSplatResource | null;
    if (!resource?.centers) return;
    const skinned = skinnedPoses.get(resource);
    if (skinned && sameBones(skinned.bones, boneTransforms)) {
      this._deformedAabb.setMinMax(skinned.min, skinned.max);
      return;
    }
    const centers = resource.centers;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    // CPU centers drive depth-sort only. We blend the TOP 4 bone influences
    // to match the GPU's top-4 skinning, so the CPU sort centers track the
    // rendered positions (required for a correct WebGL CPU depth sort).
    // Inline mat4×point: eliminates transformPoint dispatch, Vec3 alloc,
    // and property read/write churn on the hottest path in the engine.
    for (let i = 0, base = 0; i < this.numSplats; i++, base += 11) {
      const rx = packed[base];
      const ry = packed[base + 1];
      const rz = packed[base + 2];

      let outX = 0, outY = 0, outZ = 0, totalWeight = 0;

      for (let k = 0; k < 4; k++) {
        const w = packed[base + 3 + k * 2];
        if (w < 0.001) continue;
        const b = packed[base + 4 + k * 2] | 0;
        if (b >= boneTransforms.length) continue;
        const m = boneTransforms[b].data;
        outX += (rx * m[0] + ry * m[4] + rz * m[8]  + m[12]) * w;
        outY += (rx * m[1] + ry * m[5] + rz * m[9]  + m[13]) * w;
        outZ += (rx * m[2] + ry * m[6] + rz * m[10] + m[14]) * w;
        totalWeight += w;
      }

      let cx: number, cy: number, cz: number;
      if (totalWeight > 0.001) {
        const inv = 1 / totalWeight;
        cx = outX * inv;
        cy = outY * inv;
        cz = outZ * inv;
      } else {
        cx = rx;
        cy = ry;
        cz = rz;
      }

      const ci = i * 3;
      centers[ci]     = cx;
      centers[ci + 1] = cy;
      centers[ci + 2] = cz;

      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      if (cz < minZ) minZ = cz;
      if (cz > maxZ) maxZ = cz;
    }

    this._deformedAabbMin.set(minX, minY, minZ);
    this._deformedAabbMax.set(maxX, maxY, maxZ);
    this._deformedAabb.setMinMax(this._deformedAabbMin, this._deformedAabbMax);

    const record = skinned ?? { bones: new Float32Array(0), min: new Vec3(), max: new Vec3() };
    if (record.bones.length !== boneTransforms.length * 16) record.bones = new Float32Array(boneTransforms.length * 16);
    for (let b = 0; b < boneTransforms.length; b++) record.bones.set(boneTransforms[b].data, b * 16);
    record.min.copy(this._deformedAabbMin);
    record.max.copy(this._deformedAabbMax);
    skinnedPoses.set(resource, record);
  }

  /** Conservative bounds of the pose from per-bone boxes, O(bones): for frames no CPU sort reads centers. */
  private _boundPose(boneTransforms: Mat4[]): void {
    if (!this._boneBoxes) return;
    posedBound(this._boneBoxes, boneTransforms, _poseBound);
    this._deformedAabbMin.set(_poseBound[0], _poseBound[1], _poseBound[2]);
    this._deformedAabbMax.set(_poseBound[3], _poseBound[4], _poseBound[5]);
    this._deformedAabb.setMinMax(this._deformedAabbMin, this._deformedAabbMax);
  }

  /**
   * Largest world-space move of a center since a big layer last sorted it, in
   * this entity's local units: |c - inverse(world) * lastSorted * sorted|.
   * Pose and transform together, so a foot lock cancelling body sway is not
   * movement. Infinity before the first sort. Samples every 4th splat: limbs
   * move as many splats together, and the full pass is a frame spike on phones.
   */
  private _sortDrift(world: Mat4, lastSorted: Mat4 | undefined): number {
    const sorted = this._sortedCenters;
    if (!sorted || !lastSorted) return Infinity;
    const d = _sortDelta.copy(world).invert().mul(lastSorted).data;
    const centers = (this.asset.resource as GSplatResource).centers;
    let max2 = 0;
    for (let i = 0; i < centers.length; i += 12) {
      const sx = sorted[i], sy = sorted[i + 1], sz = sorted[i + 2];
      const dx = centers[i] - (sx * d[0] + sy * d[4] + sz * d[8] + d[12]);
      const dy = centers[i + 1] - (sx * d[1] + sy * d[5] + sz * d[9] + d[13]);
      const dz = centers[i + 2] - (sx * d[2] + sy * d[6] + sz * d[10] + d[14]);
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > max2) max2 = d2;
    }
    return Math.sqrt(max2);
  }

  /**
   * Force a splat re-sort without recomputing centers. Call after changing
   * the entity's transform so rendering reflects the new orientation
   * immediately instead of waiting for the next animation update.
   *
   * CPU-sorted (WebGL) layers are left alone: PC already re-sorts them on a
   * world-matrix change (see patchCpuSort), and callers that re-apply the same
   * transform every frame would otherwise force a full-layer sort each frame.
   */
  requestSort() {
    if (!this._scene) return;
    const director = this._scene.app.renderer?.gsplatDirector;
    if (!director?.camerasMap) return;
    director.camerasMap.forEach((cameraData) => {
      cameraData.layersMap?.forEach((layerData) => {
        for (const manager of [layerData.gsplatManager, layerData.gsplatManagerShadow]) {
          if (!manager || manager.cpuSorter) continue;
          manager.sortNeeded = true;
        }
      });
    });
  }

  /**
   * Toggle visible rendering of this splat. Sets BOTH `entity.enabled` and
   * the gsplat component's `enabled` flag - PC's unified gsplat manager
   * AND's them together when adding/removing the placement from layers, so
   * touching only one can leave a stale placement registered (particularly
   * for splats whose enabled state was flipped before the placement was
   * registered with the manager). Use this for render-LOD swaps where you
   * need the swap to actually take effect this frame.
   */
  setRenderingEnabled(enabled: boolean): void {
    this.entity.enabled = enabled;
    const gsplat = this.entity.gsplat;
    if (gsplat) gsplat.enabled = enabled;
  }

  /**
   * Route this splat's gsplat component to the given PC layer ids.
   *
   * Every layer owns its own unified {@link GSplatManager} and sort, and the
   * layers composite back-to-front as *whole passes* - a splat on a later
   * layer paints over everything on an earlier one, whatever its depth. So
   * a character that must be occluded by an environment (walk mode: standing
   * behind a table) has to share the environment's layer, where one global
   * sort interleaves its splats with the scene's. PC's `layers` setter
   * re-registers the placement with the new layer's manager on the spot.
   */
  setLayers(layerIds: number[]): void {
    const gsplat = this.entity.gsplat;
    if (!gsplat) return;
    gsplat.layers = [...layerIds];
    this.requestSort();
  }

  /**
   * Release all GPU resources (bone textures, transform palette, gsplat
   * entity) and remove the underlying asset from the PlayCanvas registry.
   *
   * Ordering matters: tearing down the entity *first* removes the
   * `GSplatComponent`, which unbinds these textures from PC's gsplat material
   * parameters so no future frame references them. We then defer the
   * texture-level `destroy()` past two `frameend` ticks so any in-flight
   * submit that already captured the textures has time to drain on the GPU
   * before we release them - without this, WebGPU validation warns
   * "Destroyed texture used in a submit" because Dawn walks the previous
   * frame's command buffer and finds the texture already destroyed.
   */
  destroy() {
    Splat._liveInstances.delete(this);

    const textures: Texture[] = [];

    if (this._boneTextureCacheKey) {
      // Shared bone textures - only destroy when the last referencing instance releases
      const boneTexCache = Splat._boneTextureCacheFor(this._device);
      const entry = boneTexCache.get(this._boneTextureCacheKey);
      if (entry && --entry.refCount === 0) {
        boneTexCache.delete(this._boneTextureCacheKey);
        textures.push(entry.boneIndicesTexture, entry.boneWeightsTexture);
      }
      this._boneTextureCacheKey = null;
    } else {
      if (this.boneIndicesTexture) textures.push(this.boneIndicesTexture);
      if (this.boneWeightsTexture) textures.push(this.boneWeightsTexture);
    }
    this.boneIndicesTexture = undefined;
    this.boneWeightsTexture = undefined;

    // groupIdsTexture / variantMaskTexture are always per-instance (lazy,
    // never cached), so they always get destroyed with the Splat.
    if (this.groupIdsTexture) textures.push(this.groupIdsTexture);
    if (this.variantMaskTexture) textures.push(this.variantMaskTexture);
    this.groupIdsTexture = undefined;
    this.variantMaskTexture = undefined;

    if (this.transformPalette?.texture) textures.push(this.transformPalette.texture);
    if (this.tintTexture) textures.push(this.tintTexture);
    if (this.gradeTexture) textures.push(this.gradeTexture);
    if (this.revealDistanceTexture) textures.push(this.revealDistanceTexture);
    this.revealDistanceTexture = undefined;

    const app = this._scene?.app;
    // PC's app.destroy sets `app.scene = null`. Any gsplat component still
    // hanging off that app whose `destroy()` runs afterward walks
    // `system.app.scene.layers` and NPEs on `scene` being null. The host
    // app is already in teardown, so layer membership is moot; the GPU
    // resources will be reaped by the upcoming graphicsDevice.destroy
    // regardless. Swallow the throw rather than let one stale-app splat
    // kill the run-end transition.
    try {
      this.entity.destroy();
    } catch { /* host scene already gone */ }
    if (this.ownsAsset) {
      this.asset.registry?.remove(this.asset);
      this.asset.unload();
    }

    if (app && textures.length > 0) {
      let framesLeft = 2;
      const onFrameEnd = () => {
        if (--framesLeft > 0) {
          app.once('frameend', onFrameEnd);
          return;
        }
        for (const t of textures) t.destroy();
      };
      app.once('frameend', onFrameEnd);
    } else {
      for (const t of textures) t.destroy();
    }
  }

  // ── Live-instance registries ───────────────────────────────────────────
  //
  // `_liveInstances` is the set of Splat instances currently active in any
  // scene. `_envGsplatComponents` is the set of environment gsplat
  // components, walked by `markEnvWorkBuffersDirty`.

  static _liveInstances = new Set<Splat>();
  static _envGsplatComponents = new Set<GSplatComponent>();

  /**
   * Drop every registry entry owned by `scene`, destroying the splats it
   * still holds. Called by {@link Scene.destroy}.
   *
   * Both registries above are process-global, but a page can outlive any one
   * scene (SPA navigation, a modal that remounts its canvas). Consumers tear
   * down with `scene.destroy()` alone and never see the individual `Splat`s
   * the loader made for them, so without this the sets keep growing across
   * mount/unmount cycles: every dead splat's textures and CPU-side weight
   * buffers stay reachable, the shared bone-texture entries never reach
   * refCount 0, and anything walking `_liveInstances` visits splats from
   * scenes that no longer exist.
   *
   * @internal
   */
  static releaseScene(scene: Scene): void {
    for (const splat of [...Splat._liveInstances]) {
      if (splat._scene !== scene) continue;
      // Never let one splat's teardown abort the scene's: the app is going
      // away regardless and its device.destroy() reclaims the GPU side.
      try { splat.destroy(); } catch { /* keep tearing down */ }
      Splat._liveInstances.delete(splat);
    }
    for (const gsplat of [...Splat._envGsplatComponents]) {
      if (gsplat?.system?.app === scene.app) Splat._envGsplatComponents.delete(gsplat);
    }
  }

  // Bone textures are identical for all instances of the same asset (same .bin URL).
  // One pair is allocated on first use and shared across all splats from that asset;
  // a refCount tracks live references so destruction is deferred until the last user
  // releases. Keyed by the asset URL with query string stripped (same logic as
  // _binBufferCache in asset-loader.ts so CDN token rotation doesn't fork the entry).
  //
  // The outer key is the GraphicsDevice, and it has to be: a Texture belongs to
  // exactly one device, so a URL-only cache hands the SECOND scene on a page
  // textures that were allocated on the FIRST scene's (by then destroyed) device.
  // Uploading into one throws `Cannot read properties of null (reading
  // 'activeTexture')` from deep inside PC's texture upload (the dead device's
  // `gl` is null) and the character never appears, which is what "the second
  // viewer renders black" actually was. WeakMap so a device's whole sub-cache
  // becomes collectable with the device itself.
  private static _sharedBoneTextureCache = new WeakMap<GraphicsDevice, Map<string, {
    boneIndicesTexture: Texture;
    boneWeightsTexture: Texture;
    refCount: number;
  }>>();

  /** Per-device slice of {@link _sharedBoneTextureCache}, created on first use. */
  private static _boneTextureCacheFor(device: GraphicsDevice) {
    let perDevice = Splat._sharedBoneTextureCache.get(device);
    if (!perDevice) {
      perDevice = new Map();
      Splat._sharedBoneTextureCache.set(device, perDevice);
    }
    return perDevice;
  }

  private static _assetCacheKey(asset: Asset): string | null {
    const url = (asset.file as { url?: string } | null)?.url;
    if (!url) return null;
    const q = url.indexOf('?');
    return q === -1 ? url : url.slice(0, q);
  }

  /**
   * Demand a work-buffer re-render for env splats only (regular +
   * LOD-streaming). Use after pushing env uniforms (clip bounds, camera
   * occlusion cull) - env splats are `WORKBUFFER_UPDATE_AUTO`, so uniform
   * pushes alone never re-render them.
   *
   * `only` restricts it to those registered env gsplat components - a
   * re-render costs the whole environment, so a caller that knows which ones
   * changed should not pay for the rest.
   */
  static markEnvWorkBuffersDirty(only?: ReadonlySet<unknown>): void {
    // ONCE bumps the root placement's dirty version; LOD-streaming children
    // read theirs from the root (PC 2.23 GSplatInfo._getDirtySource), so one
    // flag re-renders every active octree allocation too.
    for (const gsplat of Splat._envGsplatComponents) {
      if (only && !only.has(gsplat)) continue;
      gsplat.workBufferUpdate = 1; // WORKBUFFER_UPDATE_ONCE
    }
  }

}
