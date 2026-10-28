import type { AnimTrack, Asset, Color, ContainerResource, Entity, Material, Mesh } from 'playcanvas';
import {
  BLEND_NONE,
  BLEND_NORMAL,
  BoundingBox,
  GraphNode,
  INTERPOLATION_CUBIC,
  Mat4,
  MeshInstance,
  Quat,
  SEMANTIC_BLENDINDICES,
  SEMANTIC_BLENDWEIGHT,
  SHADERLANGUAGE_GLSL,
  SHADERLANGUAGE_WGSL,
  StandardMaterial,
  Vec3,
} from 'playcanvas';

import { Animation } from './animation';
import type { SkeletalKeyframeEntry } from './animation';
import { Armature } from './armature';
import { fetchBinBuffer } from './loader/shared/asset-loader';
import { MeshReveal, revealChunks } from './mesh-reveal';
import type { Scene } from './scene';
import { SceneDestroyedError } from './scene';
import type { RevealLook } from './splat/reveal-look';

/**
 * A rigged mesh character - a skinned glTF/GLB with its own skeleton - driven
 * by an engine {@link Armature}, so it plays, seeks, crossfades and takes the
 * same pose tools as a splat {@link Character}.
 *
 * The armature is built from the GLB's skeleton (its bones, names and rest) and
 * writes each frame's pose back onto the GLB's bones through
 * {@link Armature.driveNodes}. Motions authored on another skeleton are
 * retargeted once, at load, into an {@link Animation} keyed for this rig - see
 * {@link MeshCharacter.loadMotion}.
 *
 * The GLB skeleton's parent node (a Mixamo export's `Armature`) is split up:
 * its position goes to the armature's pivot entity, its rotation is folded
 * into the root bones, and its (uniform) scale into every bone translation.
 * Mixamo hangs a centimetre skeleton under a node rotated 90° to Z-up and
 * scaled 0.01; split this way, bone space is Y-up and in metres, as on a splat
 * rig, which is what the armature's pelvis and root-motion conventions assume.
 *
 * What it does not have, next to a splat Character: LOD levels. The reveal
 * sweep is the splat one redrawn on the mesh - see {@link setReveal}.
 *
 * @group Characters & Animation
 */
export class MeshCharacter {
  /** Drives the bones; its entity is the character's transform. */
  readonly armature: Armature;
  /** The instantiated GLB, under the armature's pivot. */
  readonly model: Entity;
  /**
   * The rest-pose bounds in the pivot's local space, unscaled - the same frame
   * as a splat's `localBound`.
   */
  readonly localBound: BoundingBox;

  private readonly _scene: Scene;
  private readonly _asset: Asset;
  private readonly _rig: Rig;
  private readonly _skin: SkinSurface[];
  /** The file as loaded, for {@link bakeToGlb}; null for a non-binary glTF. */
  private readonly _glb: ArrayBuffer | null;
  /** The GLB's own bone nodes, rig order, and the skeleton's parent node. */
  private readonly _bones: GraphNode[];
  private readonly _pivot: GraphNode;
  /** How far any vertex can sit from a bone it follows, at load scale. */
  private readonly _reach: number;
  private _posed: Float32Array | null = null;
  private _posedFrame = -1;
  private readonly _posedBox = new BoundingBox();
  /** Retargeted clips by url path, newest last; see {@link _bake}. */
  private readonly _clips = new Map<string, Promise<BakedClip>>();
  /** The model's materials with their own colours, for {@link setTint}. */
  private readonly _tintable: Tintable[];
  private _tint: { amount: number; color: RGB } = { amount: 0, color: { r: 1, g: 1, b: 1 } };
  private _overlay: OverlayCopy | null = null;
  /** Set by {@link setOpacity}; 1 draws the body unchanged. */
  private _opacity = 1;
  /** The body materials' own alpha cutoffs, once a fade has patched them. */
  private _fadeCutouts: Map<StandardMaterial, number> | null = null;
  /** Set by {@link prepareReveal}; null until the reveal is first used. */
  private _reveal: MeshReveal | null = null;
  private readonly _updateHandler: (dt: number) => void;
  private _destroyed = false;

  private constructor(scene: Scene, parts: {
    asset: Asset;
    glb: ArrayBuffer | null;
    model: Entity;
    armature: Armature;
    rig: Rig;
    bound: BoundingBox;
    reach: number;
    skin: SkinSurface[];
    bones: GraphNode[];
    pivot: GraphNode;
  }) {
    this._scene = scene;
    this._asset = parts.asset;
    this._glb = parts.glb;
    this.model = parts.model;
    this.armature = parts.armature;
    this._rig = parts.rig;
    this.localBound = parts.bound;
    this._reach = parts.reach;
    this._skin = parts.skin;
    this._bones = parts.bones;
    this._pivot = parts.pivot;
    const materials = new Set<StandardMaterial>();
    walk(this.model, (n) => {
      for (const mi of (n as Entity).render?.meshInstances ?? []) {
        if (mi.material instanceof StandardMaterial) materials.add(mi.material);
      }
    });
    this._tintable = [...materials].map(tintable);
    this._updateHandler = (dt: number) => this.armature.update(dt);
    scene.app.on('update', this._updateHandler);
  }

  get destroyed(): boolean { return this._destroyed; }

  /**
   * Start downloading a GLB - a character or a motion - so a later
   * {@link load} or {@link loadMotion} of the same url reuses the bytes.
   */
  static prefetch(url: string): void {
    if (!isGltfJson(url)) fetchBinBuffer(url).catch(() => {});
  }

  /**
   * Load a skinned glTF/GLB. The first skinned mesh's skeleton becomes the rig.
   *
   * @throws {SceneDestroyedError} If the scene is destroyed during the load.
   */
  static async load(scene: Scene, url: string): Promise<MeshCharacter> {
    // A GLB's bytes are kept, so an export can be written back onto them.
    const { asset, glb } = await loadSource(scene, url);
    if (scene.destroyed) {
      releaseAsset(scene, asset);
      throw new SceneDestroyedError('MeshCharacter.load');
    }
    const model = (asset.resource as ContainerResource).instantiateRenderEntity();
    try {
      const skinned: MeshInstance[] = [];
      walk(model, (n) => {
        for (const mi of (n as Entity).render?.meshInstances ?? []) {
          if (!mi.skinInstance) continue;
          skinned.push(mi);
          // The bounds a skinned instance culls by trail the pose a frame, and a
          // travelling clip leaves them behind entirely.
          mi.cull = false;
        }
      });
      const skinBones = new Set<GraphNode>(skinned.flatMap((mi) => mi.skinInstance!.bones));
      if (skinBones.size === 0) throw new Error(`[MeshCharacter] ${url} has no skinned mesh`);
      // Parents first, the order the armature composes in.
      const bones: GraphNode[] = [];
      walk(model, (n) => { if (skinBones.has(n)) bones.push(n); });

      const pivot = bones[0].parent!;
      const pivotPos = pivot.getPosition().clone();
      const pivotRot = pivot.getRotation().clone();
      const pivotScale = pivot.getScale().x;
      const skin = skinned.map(readSkinSurface);
      const { bound, reach } = restExtent(skin, pivotPos);

      const rig = buildRig(bones, pivotRot, pivotScale);
      const armature = new Armature('mesh-character', {
        numBones: rig.nodes.length,
        stdMaleParents: rig.parents,
        stdMaleRestTranslations: rig.restT,
        stdMaleRestRotations: rig.restR,
        boneNames: bones.map((b) => b.name),
      });
      armature.addToScene(scene);
      armature.entity.setLocalPosition(pivotPos);

      // The model goes under the pivot entity, with the pivot node reduced to the
      // folded rotation and scale, so every node keeps the world transform it
      // loaded with.
      armature.entity.addChild(model);
      for (let n: GraphNode | null = pivot.parent; n && n !== armature.entity; n = n.parent) {
        n.setLocalPosition(0, 0, 0);
        n.setLocalRotation(Quat.IDENTITY);
        n.setLocalScale(1, 1, 1);
      }
      pivot.setLocalPosition(0, 0, 0);
      pivot.setLocalRotation(pivotRot);
      pivot.setLocalScale(pivotScale, pivotScale, pivotScale);
      armature.driveNodes(bones);

      return new MeshCharacter(scene, {
        asset, glb, model, armature, rig, bound, reach, skin, bones, pivot,
      });
    } catch (err) {
      model.destroy();
      releaseAsset(scene, asset);
      throw err;
    }
  }

  /**
   * Retarget the first clip of a skinned GLB onto this character and register
   * it under `name`. The clip's own skeleton is matched to this one by bone
   * name (`mixamorig:LeftArm`, `mixamorigLeftArm` and `LeftArm` are one bone),
   * and each bone takes the source's world-space rotation away from ITS rest,
   * applied to this rig's rest - so the two rigs may differ in proportions,
   * bone axes, units and up axis. The hips keep the clip's travel, scaled by
   * the ratio of the two rest hip heights; every other bone keeps its own
   * length.
   *
   * The rests need not be the same pose: each limb's rest direction is first
   * swung onto the source's, so an A-pose source drives a T-pose rig.
   *
   * @returns The registered animation.
   */
  async loadMotion(url: string, name: string): Promise<Animation> {
    const baked = await this._bake(url);
    return this._register(baked.keyframes, baked.numFrames, name);
  }

  /**
   * Retarget a clip registered on the scene for the canonical splat skeleton -
   * a `.anim` or a MetaHuman GLB, loaded as a splat character loads it - onto
   * this character, under `name`. The source is posed by a canonical
   * {@link Armature}, so this rig follows the pose a splat shows, not a copy
   * of the motion exported for another skeleton. Retargeted as
   * {@link loadMotion} is, rest directions aligned.
   *
   * @returns The registered animation.
   */
  retargetSkeletal(sourceName: string, name: string): Animation {
    if (this._destroyed || this._scene.destroyed) throw new SceneDestroyedError('MeshCharacter.retargetSkeletal');
    const source = SkeletonSource.create(this._scene, sourceName);
    try {
      const baked = bakeRetarget(this._rig, source, CLIP_FPS);
      return this._register(baked.keyframes, baked.numFrames, name);
    } finally {
      source.destroy();
    }
  }

  /**
   * A motion pack as ONE continuous clip, registered under `name`: each clip
   * retargeted as {@link loadMotion} does, then chained so it starts where the
   * previous one left the character - same spot on the ground, same heading -
   * with a `crossfade`-second blend over each seam. Each clip keeps its own hip
   * height, so a crouch or a jump does not accumulate into the next.
   *
   * @returns The animation and each clip's span on its timeline, in seconds.
   *   Spans meet end to start; a seam's blend sits inside the later one.
   */
  async loadMotionPack(
    urls: readonly string[],
    name: string,
    opts?: { crossfade?: number },
  ): Promise<{ animation: Animation; segments: { start: number; end: number }[] }> {
    const clips = await Promise.all(urls.map((u) => this._bake(u)));
    const { keyframes, numFrames, startFrames } = chainClips(this._rig, clips, Math.max(1, Math.round((opts?.crossfade ?? 0.2) * CLIP_FPS)));
    const segments = startFrames.map((f, k) => ({
      start: f / CLIP_FPS,
      end: (k + 1 < startFrames.length ? startFrames[k + 1] : numFrames - 1) / CLIP_FPS,
    }));
    return { animation: this._register(keyframes, numFrames, name), segments };
  }

  /**
   * A clip retargeted onto this rig, kept for the last few urls (by path, as
   * the byte cache keys them): a replay - a loop toggle, a pack that comes back
   * round - skips the parse and the bake. Shared by every caller, so read-only.
   */
  private _bake(url: string): Promise<BakedClip> {
    const key = url.split('?')[0];
    let clip = this._clips.get(key);
    if (clip) {
      this._clips.delete(key);
    } else {
      const pending = this._bakeNow(url);
      pending.catch(() => { if (this._clips.get(key) === pending) this._clips.delete(key); });
      clip = pending;
    }
    this._clips.set(key, clip);
    if (this._clips.size > CLIP_CACHE_LIMIT) this._clips.delete(this._clips.keys().next().value!);
    return clip;
  }

  private async _bakeNow(url: string): Promise<BakedClip> {
    const { asset } = await loadSource(this._scene, url);
    try {
      if (this._destroyed || this._scene.destroyed) throw new SceneDestroyedError('MeshCharacter.loadMotion');
      const source = Source.from(asset);
      try {
        return bakeRetarget(this._rig, source, CLIP_FPS);
      } finally {
        source.destroy();
      }
    } finally {
      releaseAsset(this._scene, asset);
    }
  }

  private _register(keyframes: Map<number, SkeletalKeyframeEntry>, numFrames: number, name: string): Animation {
    const animation = new Animation(new Float32Array(0), numFrames, this._rig.nodes.length);
    animation.translationMask = Uint8Array.from(this._rig.nodes, (_, i) => (i === this._rig.hips ? 1 : 0));
    // Its own map over the shared, cached keys.
    animation.skeletalStore = { keyframes: new Map(keyframes), manualBones: new Set(), source: 'imported' };
    animation.skeletalConverted = true;
    animation.register(this._scene, name);
    return animation;
  }

  /** Start a registered animation with no crossfade. See {@link Character.playAnimation}. */
  playAnimation(animName: string, opts?: { loop?: boolean; rootMotion?: boolean }): boolean {
    return this.armature.playAnimation(animName, opts?.rootMotion ?? false, opts?.loop ?? true);
  }

  /** Blend to a registered animation. See {@link Character.crossfadeTo}. */
  crossfadeTo(
    animName: string,
    opts?: { duration?: number; loop?: boolean; rootMotion?: boolean; preserveTime?: boolean },
  ): boolean {
    return this.armature.crossfadeTo(animName, opts);
  }

  /** Stop playback, blending back to rest over `fadeDuration` seconds. */
  stop(fadeDuration = 0): void {
    this.armature.stop(fadeDuration);
  }

  /** Playback-speed multiplier for the active clip. See {@link Character.playbackSpeed}. */
  get playbackSpeed(): number { return this.armature.playbackSpeed; }
  set playbackSpeed(v: number) { this.armature.playbackSpeed = v; }

  /** Position in the active clip, in frames. Set it to seek. */
  get animationTime(): number { return this.armature.animationTime; }
  set animationTime(v: number) { this.armature.animationTime = v; }

  /** The character's rotation, in Euler degrees. */
  setRotation(xDeg: number, yDeg: number, zDeg: number): void {
    this.armature.entity.setLocalEulerAngles(xDeg, yDeg, zDeg);
  }

  /** The character's scale. Uniform is the only kind the rig supports. */
  setScale(x: number, y: number, z: number): void {
    this.armature.entity.setLocalScale(x, y, z);
  }

  /**
   * Reveal amount in [0, 1], as {@link Character.setReveal}: at 1 the model
   * draws unchanged, below it a bright front walks the skeleton from feet to
   * head with sketch dots ahead, and 0 is invisible. `inverse` keeps the area
   * ahead of the front, for an outgoing character.
   *
   * The first call below 1 (or with `inverse`) opts in - see
   * {@link prepareReveal}.
   */
  setReveal(amount: number, inverse = false): void {
    const a = Math.min(1, Math.max(0, amount));
    if (!this._reveal && (a < 1 || inverse)) this.prepareReveal();
    if (this._reveal) {
      this._reveal.state[0] = a;
      this._reveal.state[1] = inverse ? 1 : 0;
      this._reveal.state[3] = 0;
    }
    // Opted in, the shader hides it: drawn while hidden, its shaders compile
    // before the sweep's first frame rather than on it.
    this.model.enabled = !!this._reveal || a > 0;
    this._overlay?.sync();
  }

  /** As {@link Character.setRevealPulse}: the band at `front` over a fully drawn model. */
  setRevealPulse(front: number, strength = 1): void {
    const s = Math.min(1, Math.max(0, strength));
    if (s <= 0) { this.setReveal(1); return; }
    this.prepareReveal();
    if (!this._reveal) return;
    this._reveal.state[0] = Math.min(1, Math.max(0, front));
    this._reveal.state[3] = s;
  }

  /** Change how the reveal looks; unset fields keep their value. Opts in. */
  setRevealLook(look: RevealLook): void {
    this.prepareReveal();
    this._reveal?.setLook(look);
  }

  /**
   * Pay the reveal's one-time setup now: bake each vertex's distance along
   * the skeleton and patch the materials, which recompiles them. Once.
   */
  prepareReveal(): void {
    if (this._reveal || this._destroyed) return;
    const reveal = new MeshReveal(
      this._scene.app.graphicsDevice, this._skin, this._bones, this._rig.parents, this._rig.hips,
    );
    this._reveal = reveal;
    for (const { material } of this._tintable) revealChunks(material);
    const patched = new Set<Material>(this._tintable.map((t) => t.material));
    walk(this.model, (n) => {
      for (const mi of (n as Entity).render?.meshInstances ?? []) {
        if (mi.material && patched.has(mi.material)) reveal.bind(mi);
      }
    });
    this._overlay?.reveal(reveal);
  }

  /**
   * Mix the shaded colour toward `color` by `intensity` (0 leaves it), as a
   * splat's tint does: the diffuse scales down as the emissive takes the
   * colour. Reaches the see-through copy too, so the two never disagree.
   */
  setTint(intensity: number, color: RGB = { r: 1, g: 1, b: 1 }): void {
    this._tint = { amount: Math.min(1, Math.max(0, intensity)), color: { ...color } };
    for (const t of this._tintable) applyTint(t, this._tint);
    for (const t of this._overlay?.tintable ?? []) applyTint(t, this._tint);
  }

  /**
   * Fade the body to `opacity` (0..1) with an ordered dither, so it stays an
   * opaque, depth-sorted surface instead of a blended one. The see-through
   * copy fades with it.
   */
  setOpacity(opacity: number): void {
    const next = Math.min(1, Math.max(0, opacity));
    if (next === this._opacity) return;
    this._opacity = next;
    if (!this._fadeCutouts) {
      this._fadeCutouts = new Map();
      for (const { material } of this._tintable) {
        alphaChunks(material);
        this._fadeCutouts.set(material, material.alphaTest);
      }
    }
    for (const [material, cutout] of this._fadeCutouts) {
      material.setParameter('uScreendoor', 0);
      material.setParameter('uFade', next);
      // The alpha test is where the dither discards, so it is on while fading.
      material.alphaTest = next < 1 ? Math.max(cutout, 1e-4) : cutout;
      material.update();
    }
  }

  /**
   * A see-through copy of the body on `layerId`, a layer drawn after the
   * scene's splats. It tests against depth and writes none, and splats write
   * no depth either, so the depth it meets is the body's own: the copy shows
   * the body's nearest surface over any splat in front of it, but never the
   * far side of the body through the near. Over the uncovered body it repaints
   * the same colours, so it only shows where something hides the body.
   *
   * `look` is read every frame: `screendoor` keeps the splat overlay's 2×2
   * blocks of every 4×4 pixels, `ghost` blends at `alpha`. One copy per
   * character; adding again replaces it.
   */
  addOverlay(layerId: number, look: () => MeshOverlayLook): MeshOverlay {
    this.removeOverlay();
    const layer = this._scene.app.scene.layers.getLayerById(layerId);
    if (!layer) throw new Error(`[MeshCharacter] no layer ${layerId}`);
    const copies = new Map<Material, Tintable & { cutout: number }>();
    const instances: MeshInstance[] = [];
    const sources: MeshInstance[] = [];
    walk(this.model, (n) => {
      for (const src of (n as Entity).render?.meshInstances ?? []) {
        const own = this._tintable.find((t) => t.material === src.material);
        if (!own) continue;
        let twin = copies.get(own.material);
        if (!twin) {
          const material = own.material.clone();
          material.depthWrite = false;
          // The same surface drawn twice: nudged toward the eye so it passes.
          material.depthBias = -1;
          material.slopeDepthBias = -1;
          alphaChunks(material);
          twin = { ...own, material, cutout: material.alphaTest };
          copies.set(own.material, twin);
        }
        // The skin is picked up by sync: the body has none while it is disabled.
        const mi = new MeshInstance(src.mesh!, twin.material, src.node);
        mi.cull = false;
        mi.castShadow = false;
        instances.push(mi);
        sources.push(src);
      }
    });
    layer.addMeshInstances(instances);

    let enabled = true;
    let last: (MeshOverlayLook & { fade: number }) | null = null;
    const tintableCopies = [...copies.values()];
    const restyle = () => {
      const next = { ...look(), fade: this._opacity };
      if (last && next.mode === last.mode && next.alpha === last.alpha && next.fade === last.fade) return;
      last = next;
      const ghost = next.mode === 'ghost';
      for (const { material, cutout } of tintableCopies) {
        material.blendType = ghost ? BLEND_NORMAL : BLEND_NONE;
        material.opacity = ghost ? next.alpha : 1;
        // On for the screen door too, as for the fade.
        material.alphaTest = ghost && next.fade >= 1 ? cutout : Math.max(cutout, 1e-4);
        material.setParameter('uScreendoor', ghost ? 0 : 1);
        material.setParameter('uFade', next.fade);
        material.update();
      }
    };
    // Must run after anything that enables or disables the model: PlayCanvas
    // drops the body's skins on disable and makes new ones on enable. Unskinned,
    // the copy draws the raw bind-pose mesh at the file's own scale.
    const sync = () => {
      instances.forEach((mi, i) => {
        const skin = sources[i].skinInstance;
        if (mi.skinInstance !== skin) mi.skinInstance = skin;
        mi.visible = enabled && this.model.enabled && !!skin;
      });
    };
    for (const t of tintableCopies) applyTint(t, this._tint);
    restyle();
    sync();
    this._scene.app.on('prerender', restyle);

    const remove = () => {
      if (this._overlay !== copy) return;
      this._overlay = null;
      this._scene.app.off('prerender', restyle);
      layer.removeMeshInstances(instances);
      for (const mi of instances) {
        // The skin is the body's; destroying it with the copy breaks the body.
        mi.skinInstance = null;
        mi.destroy();
      }
      for (const { material } of tintableCopies) material.destroy();
    };
    const reveal = (r: MeshReveal) => {
      for (const { material } of tintableCopies) revealChunks(material);
      for (const mi of instances) r.bind(mi);
    };
    if (this._reveal) reveal(this._reveal);
    const copy: OverlayCopy = { tintable: tintableCopies, sync, reveal, remove };
    this._overlay = copy;
    return {
      setRenderingEnabled: (on: boolean) => {
        enabled = on;
        sync();
      },
    };
  }

  /** Take the see-through copy off, if there is one. */
  removeOverlay(): void {
    this._overlay?.remove();
  }

  /**
   * The playing clip as it is on screen - every pose tool, placement and root
   * motion included - written onto this character's own GLB as its animation,
   * over `start`..`end` seconds (the whole clip by default), re-based to 0.
   *
   * The file is the loaded one with an `animations` entry put in its place:
   * same nodes, names, units, mesh and skin, so it opens wherever the source
   * did. Each bone is keyed in its own parent's frame; the skeleton's parent
   * node carries the character's placement and travel. The viewer's display
   * scale is taken back out, so the character exports at its own size.
   *
   * Steps the armature through the range and puts it back where it was.
   */
  async bakeToGlb(opts?: { start?: number; end?: number; name?: string; fps?: number }): Promise<Blob> {
    if (!this._glb) throw new Error('[MeshCharacter] only a binary GLB can be baked');
    const arm = this.armature;
    const rate = arm.frameRate;
    const duration = arm.animationDuration / rate;
    const start = Math.min(Math.max(opts?.start ?? 0, 0), duration);
    const end = Math.min(Math.max(opts?.end ?? duration, start), duration);
    const fps = opts?.fps ?? 30;
    const count = Math.round((end - start) * fps) + 1;

    const doc = readGlb(this._glb);
    const nodeOf = glbNodeIndex(doc.json, this._bones);
    const ancestorsInv = glbWorldOf(doc.json, nodeOf.pivotParent).invert();

    const times = new Float32Array(count);
    const boneT = this._bones.map(() => new Float32Array(count * 3));
    const boneR = this._bones.map(() => new Float32Array(count * 4));
    const pivotT = new Float32Array(count * 3);
    const pivotR = new Float32Array(count * 4);
    const pivotS = new Float32Array(count * 3);

    const savedTime = arm.animationTime;
    const savedPaused = arm.paused;
    arm.paused = true;
    const place = new Mat4();
    const pivotLocal = new Mat4();
    const out = new Mat4();
    try {
      for (let f = 0; f < count; f++) {
        const t = Math.min(start + f / fps, end);
        times[f] = t - start;
        arm.animationTime = t * rate;
        arm.update(0);
        this._bones.forEach((b, i) => {
          const p = b.getLocalPosition();
          const q = b.getLocalRotation();
          boneT[i].set([p.x, p.y, p.z], f * 3);
          boneR[i].set([q.x, q.y, q.z, q.w], f * 4);
        });
        // The pivot entity, less its display scale, times the pivot node's own
        // local (the folded rotation and unit scale), back under the file's
        // own ancestors of that node.
        const e = arm.entity;
        const k = e.getLocalScale().x || 1;
        const ep = e.getLocalPosition();
        place.setTRS(_pos.set(ep.x / k, ep.y / k, ep.z / k), e.getLocalRotation(), Vec3.ONE);
        pivotLocal.setTRS(this._pivot.getLocalPosition(), this._pivot.getLocalRotation(), this._pivot.getLocalScale());
        out.mul2(ancestorsInv, place).mul(pivotLocal);
        out.getTranslation(_pos);
        _rot.setFromMat4(out);
        out.getScale(_v);
        pivotT.set([_pos.x, _pos.y, _pos.z], f * 3);
        pivotR.set([_rot.x, _rot.y, _rot.z, _rot.w], f * 4);
        pivotS.set([_v.x, _v.y, _v.z], f * 3);
      }
    } finally {
      arm.animationTime = savedTime;
      arm.paused = savedPaused;
      arm.update(0);
    }

    // The skeleton parent's scale is folded into the skeleton: Blender (for FBX)
    // applies a scaled parent to every translation key and collapses the body.
    const unit = foldSkeletonScale(doc, nodeOf.pivot);
    if (unit !== 1) {
      for (const t of boneT) for (let i = 0; i < t.length; i++) t[i] *= unit;
      for (let i = 0; i < pivotS.length; i++) pivotS[i] /= unit;
    }

    // Channels that only restate the rest are left out: Blender (for FBX) reads
    // a constant translation key on every bone as a collapse onto the hips.
    const channels: GlbChannel[] = [];
    const add = (node: number, path: GlbChannel['path'], values: Float32Array) => {
      if (!restatesRest(doc.json, node, path, values)) channels.push({ node, path, values });
    };
    this._bones.forEach((_, i) => {
      add(nodeOf.bones[i], 'translation', boneT[i]);
      add(nodeOf.bones[i], 'rotation', continuous(boneR[i]));
    });
    add(nodeOf.pivot, 'translation', pivotT);
    add(nodeOf.pivot, 'rotation', continuous(pivotR));
    add(nodeOf.pivot, 'scale', pivotS);
    return new Blob([writeGlbWithAnimation(doc, opts?.name ?? 'Motion', times, channels)], { type: 'model/gltf-binary' });
  }

  /**
   * A world-space box the posed skin is inside: the bones' box grown by the
   * skin's reach. A few dozen bones, so cheap enough to rule a pick out before
   * paying for {@link posedVertices}. Without `out`, one box is reused.
   */
  posedBound(out = this._posedBox): BoundingBox {
    const min = _v.set(Infinity, Infinity, Infinity);
    const max = _pos.set(-Infinity, -Infinity, -Infinity);
    for (const bone of this._bones) {
      const p = bone.getPosition();
      min.set(Math.min(min.x, p.x), Math.min(min.y, p.y), Math.min(min.z, p.z));
      max.set(Math.max(max.x, p.x), Math.max(max.y, p.y), Math.max(max.z, p.z));
    }
    const r = this._reach * this.armature.entity.getLocalScale().x;
    out.setMinMax(min.subScalar(r), max.addScalar(r));
    return out;
  }

  /**
   * The posed skin in world space: xyz per vertex, every skinned mesh back to
   * back. Skinned on the CPU from the live bones, at most once per frame - the
   * GPU's copy cannot be read back. For picking: cheap at the vertex counts a
   * character carries, too dear to run per frame for its own sake.
   */
  posedVertices(): Float32Array {
    const frame = this._scene.app.frame;
    if (this._posed && this._posedFrame === frame) return this._posed;
    const total = this._skin.reduce((n, s) => n + s.vertexCount, 0);
    if (!this._posed || this._posed.length !== total * 3) this._posed = new Float32Array(total * 3);
    let base = 0;
    for (const surface of this._skin) {
      skinVertices(surface, this._posed, base);
      base += surface.vertexCount * 3;
    }
    this._posedFrame = frame;
    return this._posed;
  }

  /**
   * Where a world-space ray first meets the posed skin: the distance along
   * `dir` (taken as unit length), or null for a miss.
   */
  raycast(origin: Vec3Like, dir: Vec3Like): number | null {
    const pts = this.posedVertices();
    let best = Infinity;
    let base = 0;
    for (const surface of this._skin) {
      const t = rayTriangles(origin, dir, pts, base, surface.indices);
      if (t !== null && t < best) best = t;
      base += surface.vertexCount;
    }
    return best < Infinity ? best : null;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._scene.app.off('update', this._updateHandler);
    this.removeOverlay();
    this.armature.destroy();
    this._reveal?.destroy();
    releaseAsset(this._scene, this._asset);
  }
}

/* ------------------------------------------------------------------ */
/*  Loading                                                            */
/* ------------------------------------------------------------------ */

interface RGB { r: number; g: number; b: number }

/** How a {@link MeshCharacter.addOverlay} copy draws. */
export interface MeshOverlayLook {
  mode: 'screendoor' | 'ghost';
  /** The ghost's opacity. */
  alpha: number;
}

/** The see-through copy, as its owner holds it. */
export interface MeshOverlay {
  setRenderingEnabled(on: boolean): void;
}

interface OverlayCopy {
  tintable: Tintable[];
  /** Match the copy's visibility to the model's. */
  sync(): void;
  /** Draw the copy with the body's reveal. */
  reveal(reveal: MeshReveal): void;
  remove(): void;
}

/** A material and the colours it loaded with. */
interface Tintable {
  material: StandardMaterial;
  diffuse: Color;
  emissive: Color;
}

/**
 * The alpha test, extended: after the material's own cutoff, `uScreendoor` 1
 * keeps the splat overlay's 2×2 block of every 4×4 pixels, and `uFade` below
 * 1 keeps that fraction of pixels by a 4×4 ordered dither. Screen space, and
 * only run while the material's alpha test is on.
 */
function alphaChunks(material: StandardMaterial): void {
  material.getShaderChunks(SHADERLANGUAGE_GLSL).set('alphaTestPS', `
uniform float alpha_ref;
uniform float uScreendoor;
uniform float uFade;
float bayer2(vec2 p) { return 2.0 * abs(p.x - p.y) + p.y; }
void alphaTest(float a) {
    if (a < alpha_ref) discard;
    vec2 px = floor(gl_FragCoord.xy);
    vec2 cell = floor(px * 0.5);
    if (uScreendoor > 0.5 && (mod(cell.x, 2.0) > 0.5 || mod(cell.y, 2.0) > 0.5)) discard;
    if (uFade < 1.0) {
        vec2 q = mod(px, 4.0);
        float b = 4.0 * bayer2(mod(q, 2.0)) + bayer2(floor(q * 0.5));
        if ((b + 0.5) / 16.0 >= uFade) discard;
    }
}
`);
  material.getShaderChunks(SHADERLANGUAGE_WGSL).set('alphaTestPS', `
uniform alpha_ref: f32;
uniform uScreendoor: f32;
uniform uFade: f32;
fn bayer2(p: vec2f) -> f32 { return 2.0 * abs(p.x - p.y) + p.y; }
fn alphaTest(a: f32) {
    if (a < uniform.alpha_ref) { discard; }
    let px = floor(pcPosition.xy);
    let cell = floor(px * 0.5);
    if (uniform.uScreendoor > 0.5 && ((cell.x % 2.0) > 0.5 || (cell.y % 2.0) > 0.5)) { discard; }
    if (uniform.uFade < 1.0) {
        let q = px % vec2f(4.0);
        let b = 4.0 * bayer2(q % vec2f(2.0)) + bayer2(floor(q * 0.5));
        if ((b + 0.5) / 16.0 >= uniform.uFade) { discard; }
    }
}
`);
  material.shaderChunksVersion = '2.23';
}

function tintable(material: StandardMaterial): Tintable {
  return { material, diffuse: material.diffuse.clone(), emissive: material.emissive.clone() };
}

function applyTint({ material, diffuse, emissive }: Tintable, tint: { amount: number; color: RGB }): void {
  const a = tint.amount;
  material.diffuse.set(diffuse.r * (1 - a), diffuse.g * (1 - a), diffuse.b * (1 - a));
  material.emissive.set(
    emissive.r + (tint.color.r - emissive.r) * a,
    emissive.g + (tint.color.g - emissive.g) * a,
    emissive.b + (tint.color.b - emissive.b) * a,
  );
  material.update();
}

/** Clips {@link MeshCharacter} keeps retargeted, per character. */
const CLIP_CACHE_LIMIT = 8;
/** Clips are keyed at the armature's default playback rate; playback is frame-indexed. */
const CLIP_FPS = 30;

const isGltfJson = (url: string) => /\.gltf(?:[?#]|$)/i.test(url);

/**
 * A container and, for a GLB, its bytes - fetched through the engine's byte
 * cache, so a prefetch is reused, and parsed by PlayCanvas from a blob url. A
 * .gltf loads from its own url, with its resources alongside it.
 */
async function loadSource(scene: Scene, url: string): Promise<{ asset: Asset; glb: ArrayBuffer | null }> {
  if (isGltfJson(url)) return { asset: await loadContainer(scene, url), glb: null };
  const glb = await fetchBinBuffer(url);
  const blobUrl = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  try {
    return { asset: await loadContainer(scene, blobUrl), glb };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function loadContainer(scene: Scene, url: string): Promise<Asset> {
  return new Promise((resolve, reject) => {
    // The container handler picks its parser from the extension and falls back
    // to GLB, which is what a blob or extensionless signed url needs.
    scene.app.assets.loadFromUrl(url, 'container', (err: string | null, asset?: Asset) => {
      if (err || !asset) reject(new Error(`[MeshCharacter] ${err ?? `failed to load ${url}`}`));
      else resolve(asset);
    });
  });
}

function releaseAsset(scene: Scene, asset: Asset): void {
  scene.app.assets.remove(asset);
  asset.unload();
}

function walk(node: GraphNode, fn: (n: GraphNode) => void): void {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

/** `mixamorig:LeftArm`, `mixamorigLeftArm` and `LeftArm` are one bone. */
function boneKey(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1).replace(/^mixamorig/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The skin at rest, skinned on the CPU: its bounds, in the pivot entity's
 * local frame (world less the pivot's position), and its reach - the farthest
 * any vertex sits from a bone it follows. Bones move rigidly, so a posed
 * vertex stays within that reach of its bones' posed positions.
 */
function restExtent(skin: SkinSurface[], pivotPos: Vec3): { bound: BoundingBox; reach: number } {
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  let reach2 = 0;
  for (const s of skin) {
    const pts = new Float32Array(s.vertexCount * 3);
    skinVertices(s, pts, 0);
    const at = s.bones.map((b) => b.getPosition());
    for (let v = 0; v < s.vertexCount; v++) {
      const x = pts[v * 3], y = pts[v * 3 + 1], z = pts[v * 3 + 2];
      min.set(Math.min(min.x, x), Math.min(min.y, y), Math.min(min.z, z));
      max.set(Math.max(max.x, x), Math.max(max.y, y), Math.max(max.z, z));
      for (let k = 0; k < 4; k++) {
        if (s.weights[v * 4 + k] <= 0) continue;
        const b = at[s.joints[v * 4 + k]];
        reach2 = Math.max(reach2, (x - b.x) ** 2 + (y - b.y) ** 2 + (z - b.z) ** 2);
      }
    }
  }
  const bound = new BoundingBox();
  if (min.x <= max.x) bound.setMinMax(min.sub(pivotPos), max.sub(pivotPos));
  return { bound, reach: Math.sqrt(reach2) };
}

/* ------------------------------------------------------------------ */
/*  Picking                                                            */
/* ------------------------------------------------------------------ */

interface Vec3Like { x: number; y: number; z: number }

/** One skinned mesh, read back once at load for CPU skinning. */
interface SkinSurface {
  mesh: Mesh;
  bones: GraphNode[];
  inverseBindPose: Mat4[];
  vertexCount: number;
  /** xyz per vertex, bind space. */
  positions: Float32Array;
  /** Four bone slots and four weights per vertex. */
  joints: Float32Array;
  weights: Float32Array;
  /** Triangle list into this mesh's vertices. */
  indices: Uint32Array;
}

function readSkinSurface(mi: MeshInstance): SkinSurface {
  const mesh = mi.mesh!;
  const vertexCount = mesh.vertexBuffer.numVertices;
  const positions = new Float32Array(vertexCount * 3);
  const joints = new Float32Array(vertexCount * 4);
  const weights = new Float32Array(vertexCount * 4);
  mesh.getPositions(positions);
  mesh.getVertexStream(SEMANTIC_BLENDINDICES, joints);
  mesh.getVertexStream(SEMANTIC_BLENDWEIGHT, weights);
  const prim = mesh.primitive[0];
  const all = new Uint32Array(mesh.indexBuffer[0]?.numIndices ?? 0);
  mesh.getIndices(all);
  const indices = all.length ? all.subarray(prim.base, prim.base + prim.count) : new Uint32Array(0);
  const skin = mi.skinInstance!;
  return { mesh, bones: skin.bones, inverseBindPose: skin.skin.inverseBindPose, vertexCount, positions, joints, weights, indices };
}

const _palette: Mat4[] = [];

function skinVertices(s: SkinSurface, out: Float32Array, offset: number): void {
  for (let j = 0; j < s.bones.length; j++) {
    (_palette[j] ??= new Mat4()).mul2(s.bones[j].getWorldTransform(), s.inverseBindPose[j]);
  }
  const { positions: p, joints, weights } = s;
  for (let v = 0; v < s.vertexCount; v++) {
    const px = p[v * 3], py = p[v * 3 + 1], pz = p[v * 3 + 2];
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k];
      if (w <= 0) continue;
      const m = _palette[joints[v * 4 + k]].data;
      x += w * (m[0] * px + m[4] * py + m[8] * pz + m[12]);
      y += w * (m[1] * px + m[5] * py + m[9] * pz + m[13]);
      z += w * (m[2] * px + m[6] * py + m[10] * pz + m[14]);
    }
    out[offset + v * 3] = x;
    out[offset + v * 3 + 1] = y;
    out[offset + v * 3 + 2] = z;
  }
}

/** Nearest front-or-back-facing hit of the ray on the triangles (Möller–Trumbore), or null. */
function rayTriangles(o: Vec3Like, d: Vec3Like, pts: Float32Array, base: number, indices: Uint32Array): number | null {
  let best = Infinity;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = (base + indices[i]) * 3, b = (base + indices[i + 1]) * 3, c = (base + indices[i + 2]) * 3;
    const e1x = pts[b] - pts[a], e1y = pts[b + 1] - pts[a + 1], e1z = pts[b + 2] - pts[a + 2];
    const e2x = pts[c] - pts[a], e2y = pts[c + 1] - pts[a + 1], e2z = pts[c + 2] - pts[a + 2];
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = o.x - pts[a], ty = o.y - pts[a + 1], tz = o.z - pts[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d.x * qx + d.y * qy + d.z * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 0 && t < best) best = t;
  }
  return best < Infinity ? best : null;
}

/* ------------------------------------------------------------------ */
/*  Retargeting                                                        */
/* ------------------------------------------------------------------ */

/**
 * The character's skeleton as detached nodes in the armature's own frame (root
 * bones folded, translations in metres): what a clip is retargeted onto. Kept
 * apart from the GLB's bones so a bake never reads or disturbs the live pose,
 * and never depends on where the character stands.
 */
interface Rig {
  nodes: GraphNode[];
  parents: Int32Array;
  restT: Float32Array;
  restR: Float32Array;
  /** Rest world rotation per bone, in the rig frame. */
  restWorld: Quat[];
  /** Index of the hips, or -1. */
  hips: number;
  restHipY: number;
}

export function buildRig(bones: GraphNode[], fold: Quat, unit: number): Rig {
  const n = bones.length;
  const index = new Map(bones.map((b, i) => [b, i]));
  const frame = new GraphNode('rig');
  const nodes: GraphNode[] = [];
  const parents = new Int32Array(n);
  const restT = new Float32Array(n * 3);
  const restR = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const bone = bones[i];
    const pi = bone.parent ? index.get(bone.parent) ?? -1 : -1;
    parents[i] = pi;
    const p = bone.getLocalPosition().clone().mulScalar(unit);
    const q = bone.getLocalRotation().clone();
    if (pi < 0) {
      fold.transformVector(p, p);
      q.mul2(fold, q);
    }
    const node = new GraphNode(bone.name);
    node.setLocalPosition(p);
    node.setLocalRotation(q);
    (pi < 0 ? frame : nodes[pi]).addChild(node);
    nodes.push(node);
    restT.set([p.x, p.y, p.z], i * 3);
    restR.set([q.x, q.y, q.z, q.w], i * 4);
  }
  const hips = nodes.findIndex((nd) => boneKey(nd.name) === 'hips');
  return {
    nodes,
    parents,
    restT,
    restR,
    restWorld: nodes.map((nd) => nd.getRotation().clone()),
    hips,
    restHipY: hips >= 0 ? nodes[hips].getPosition().y : 1,
  };
}

interface Channel {
  node: GraphNode;
  rotation: boolean;
  times: ArrayLike<number>;
  values: ArrayLike<number>;
  comps: number;
  /** Cubic splines store in-tangent, value, out-tangent per key. */
  stride: number;
  offset: number;
}

/** A posable source skeleton, its bones keyed by {@link boneKey}. */
interface PoseSource {
  /** Seconds to the last pose. */
  readonly duration: number;
  readonly byKey: Map<string, GraphNode>;
  /** Pose at `t` seconds: each keyed node's world transform is the bone's. */
  poseAt(t: number): void;
  destroy(): void;
}

/** Canonical splat bone -> the {@link boneKey} of its Mixamo counterpart. */
const CANONICAL_KEYS: Record<string, string> = (() => {
  const keys: Record<string, string> = {
    pelvis: 'hips', spine_01: 'spine', spine_03: 'spine1', spine_05: 'spine2', neck_01: 'neck', head: 'head',
  };
  for (const [s, side] of [['l', 'left'], ['r', 'right']] as const) {
    Object.assign(keys, {
      [`clavicle_${s}`]: `${side}shoulder`, [`upperarm_${s}`]: `${side}arm`, [`lowerarm_${s}`]: `${side}forearm`,
      [`hand_${s}`]: `${side}hand`, [`thigh_${s}`]: `${side}upleg`, [`calf_${s}`]: `${side}leg`,
      [`foot_${s}`]: `${side}foot`, [`ball_${s}`]: `${side}toebase`,
    });
    for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
      for (let n = 1; n <= 3; n++) keys[`${finger}_0${n}_${s}`] = `${side}hand${finger}${n}`;
    }
  }
  return keys;
})();

/**
 * A clip on the canonical splat skeleton, posed by an engine {@link Armature}
 * exactly as a splat character's is - root motion applied, so the pelvis
 * carries the travel - onto detached nodes, one per bone.
 */
export class SkeletonSource implements PoseSource {
  readonly duration: number;
  readonly byKey = new Map<string, GraphNode>();
  private readonly _arm: Armature;

  private constructor(arm: Armature, nodes: GraphNode[], names: readonly string[]) {
    this._arm = arm;
    names.forEach((n, i) => {
      const k = CANONICAL_KEYS[n];
      if (k) this.byKey.set(k, nodes[i]);
    });
    // The last frame's time: `animationDuration` counts frames, so the bake
    // would otherwise sample one past the end and repeat the last.
    this.duration = Math.max(0, arm.animationDuration - 1) / arm.frameRate;
  }

  static create(scene: Scene, animName: string): SkeletonSource {
    const lib = scene.skeletonLibrary;
    // The rig the clip was authored for, as a splat plays it: 441 bones for a
    // MetaHuman clip (its rest faces another way than the 86-bone one's).
    const full = scene.skeletalAnimationLibrary.get(animName)?.numBones === lib.parents441?.length;
    const names = full ? lib.boneNames441 : lib.boneNames;
    const parents = full ? lib.parents441 : lib.stdMaleParents;
    const restT = full ? lib.restTranslations441 : lib.stdMaleRestTranslations;
    const restR = full ? lib.restRotations441 : lib.stdMaleRestRotations;
    if (!names || !parents || !restT || !restR) {
      throw new Error('[MeshCharacter] the scene has no canonical skeleton');
    }
    const arm = new Armature('retarget-source', {
      numBones: names.length,
      stdMaleParents: parents,
      stdMaleRestTranslations: restT,
      stdMaleRestRotations: restR,
      boneNames: names,
    });
    try {
      arm.addToScene(scene);
      const nodes = names.map((n) => new GraphNode(n));
      // Driving nodes writes the rest onto them, which the bake reads first;
      // playing writes nothing until the first pose.
      arm.driveNodes(nodes);
      // The bake reads only the keyed bones, a fraction of a full rig.
      arm.evaluateOnly(names.flatMap((n, i) => (CANONICAL_KEYS[n] ? [i] : [])));
      if (!arm.playAnimation(animName, true, false)) throw new Error(`[MeshCharacter] no animation ${animName}`);
      arm.paused = true;
      return new SkeletonSource(arm, nodes, names);
    } catch (err) {
      arm.destroy();
      throw err;
    }
  }

  poseAt(t: number): void {
    const arm = this._arm;
    arm.animationTime = Math.min(t * arm.frameRate, Math.max(0, arm.animationDuration - 1));
    arm.update(0);
  }

  destroy(): void {
    this._arm.destroy();
  }
}

/** A clip and the skeleton it was authored on, detached: only its transforms are read. */
class Source implements PoseSource {
  readonly root: Entity;
  readonly duration: number;
  readonly channels: Channel[] = [];
  readonly byKey = new Map<string, GraphNode>();

  private constructor(root: Entity, track: AnimTrack) {
    this.root = root;
    this.duration = track.duration;
    for (const curve of track.curves) {
      const path = curve.paths[0] as unknown as { entityPath: string[]; propertyPath: string[] };
      const prop = path.propertyPath[0];
      if (prop !== 'localRotation' && prop !== 'localPosition') continue;
      const node = root.findByName(path.entityPath[path.entityPath.length - 1]);
      if (!node) continue;
      const out = track.outputs[curve.output];
      const cubic = curve.interpolation === INTERPOLATION_CUBIC;
      this.channels.push({
        node,
        rotation: prop === 'localRotation',
        times: track.inputs[curve.input].data,
        values: out.data,
        comps: out.components,
        stride: cubic ? out.components * 3 : out.components,
        offset: cubic ? out.components : 0,
      });
    }
    walk(root, (nd) => {
      const k = boneKey(nd.name);
      if (!this.byKey.has(k)) this.byKey.set(k, nd);
    });
  }

  static from(asset: Asset): Source {
    const res = asset.resource as ContainerResource & { animations: Asset[] };
    const track = res.animations[0]?.resource as AnimTrack | undefined;
    if (!track) throw new Error('[MeshCharacter] the motion GLB has no animation');
    const root = res.instantiateRenderEntity();
    root.enabled = false;
    return new Source(root, track);
  }

  /** Pose the source skeleton at `t` seconds. */
  poseAt(t: number): void {
    for (const ch of this.channels) {
      sample(ch, t, _buf);
      if (ch.rotation) ch.node.setLocalRotation(_q.set(_buf[0], _buf[1], _buf[2], _buf[3]).normalize());
      else ch.node.setLocalPosition(_buf[0], _buf[1], _buf[2]);
    }
  }

  destroy(): void {
    this.root.destroy();
  }
}

const _q = new Quat();
const _v = new Vec3();
const _buf = [0, 0, 0, 0];

function sample(ch: Channel, t: number, out: number[]): void {
  const { times, values, comps, stride, offset } = ch;
  const n = times.length;
  let lo = 0;
  let hi = n - 1;
  if (t >= times[hi]) lo = hi;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
  }
  const j = Math.min(lo + 1, n - 1);
  const span = times[j] - times[lo];
  const f = span > 0 ? Math.min(Math.max((t - times[lo]) / span, 0), 1) : 0;
  const a = lo * stride + offset;
  const b = j * stride + offset;
  // Quaternions take the short way round, then renormalise (nlerp).
  let sign = 1;
  if (ch.rotation) {
    let dot = 0;
    for (let k = 0; k < 4; k++) dot += values[a + k] * values[b + k];
    if (dot < 0) sign = -1;
  }
  for (let k = 0; k < comps; k++) out[k] = values[a + k] + (values[b + k] * sign - values[a + k]) * f;
}

/**
 * For each frame: pose the source, then per paired bone, parents first,
 * `targetWorld = sourceWorld · sourceRestWorld⁻¹ · targetRestWorld` - the
 * source's rotation away from its rest, in world space, applied to the
 * target's rest. Read back as the rig's local transforms.
 */
export function bakeRetarget(rig: Rig, source: PoseSource, fps: number) {
  const pairs: { i: number; source: GraphNode; srcRestInv: Quat; align: Quat }[] = [];
  rig.nodes.forEach((node, i) => {
    const src = source.byKey.get(boneKey(node.name));
    if (src) pairs.push({ i, source: src, srcRestInv: src.getRotation().clone().invert(), align: new Quat() });
  });
  // Turn the rig's rest to the source rest's heading (the canonical skeleton
  // rests facing -X); a per-bone swing alone would leave that as limb twist.
  const heading = restHeading(rig, source);
  // Then swing each bone's rest direction, toward its main paired child, onto
  // the source's, so differing rests (A-pose vs T-pose) still agree. A bone
  // with no paired child (fingertip, toe) takes its parent's correction; rig
  // order is parents first, so that is already final.
  const paired = new Map(pairs.map((p) => [p.i, p]));
  for (const p of pairs) {
    const child = primaryChild(rig, p.i, paired);
    if (child >= 0) {
      const from = _a.copy(rig.nodes[child].getPosition()).sub(rig.nodes[p.i].getPosition());
      heading.transformVector(from, from);
      const to = _b.copy(paired.get(child)!.source.getPosition()).sub(p.source.getPosition());
      swingBetween(from, to, p.align);
      p.align.mul(heading);
    } else {
      p.align.copy(paired.get(rig.parents[p.i])?.align ?? heading);
    }
  }
  const srcHips = source.byKey.get('hips') ?? null;
  const srcRestHipY = srcHips?.getPosition().y ?? 1;
  const groundRatio = Math.abs(srcRestHipY) > 1e-6 ? rig.restHipY / srcRestHipY : 1;

  const n = rig.nodes.length;
  const numFrames = Math.max(2, Math.round(source.duration * fps) + 1);
  const frames = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) frames[f] = f;
  const keyframes = new Map<number, SkeletalKeyframeEntry>();
  for (let i = 0; i < n; i++) {
    keyframes.set(i, {
      frames,
      positions: new Float32Array(numFrames * 3),
      rotations: new Float32Array(numFrames * 4),
      scales: new Float32Array(numFrames * 3).fill(1),
    });
  }

  for (let f = 0; f < numFrames; f++) {
    source.poseAt(Math.min(f / fps, source.duration));
    for (const { i, source: src, srcRestInv, align } of pairs) {
      _q.mul2(src.getRotation(), srcRestInv).mul(align).mul(rig.restWorld[i]);
      rig.nodes[i].setRotation(_q);
    }
    if (srcHips && rig.hips >= 0) {
      // World IS the source's own frame: it is detached, and its root may be the
      // GLB's rotated armature node itself, so that node's transform belongs in.
      _v.copy(srcHips.getPosition()).mulScalar(groundRatio);
      rig.nodes[rig.hips].setPosition(_v);
    }
    for (let i = 0; i < n; i++) {
      const { positions, rotations } = keyframes.get(i)!;
      const p = rig.nodes[i].getLocalPosition();
      const q = rig.nodes[i].getLocalRotation();
      positions[f * 3] = p.x; positions[f * 3 + 1] = p.y; positions[f * 3 + 2] = p.z;
      rotations[f * 4] = q.x; rotations[f * 4 + 1] = q.y; rotations[f * 4 + 2] = q.z; rotations[f * 4 + 3] = q.w;
    }
  }

  // Back to rest, for the next clip.
  rig.nodes.forEach((node, i) => {
    node.setLocalPosition(rig.restT[i * 3], rig.restT[i * 3 + 1], rig.restT[i * 3 + 2]);
    node.setLocalRotation(rig.restR[i * 4], rig.restR[i * 4 + 1], rig.restR[i * 4 + 2], rig.restR[i * 4 + 3]);
  });
  return { keyframes, numFrames };
}

/**
 * The yaw turning the rig's rest to face the way the source's rest does,
 * measured across the hips (left thigh less right) and snapped to a quarter
 * turn: rigs differ in heading by whole axes, and a rest's own few degrees of
 * asymmetry are not a heading.
 */
function restHeading(rig: Rig, source: PoseSource): Quat {
  const out = new Quat();
  const li = rig.nodes.findIndex((n) => boneKey(n.name) === 'leftupleg');
  const ri = rig.nodes.findIndex((n) => boneKey(n.name) === 'rightupleg');
  const sl = source.byKey.get('leftupleg');
  const sr = source.byKey.get('rightupleg');
  if (li < 0 || ri < 0 || !sl || !sr) return out;
  const t = _a.copy(rig.nodes[li].getPosition()).sub(rig.nodes[ri].getPosition());
  const s = _b.copy(sl.getPosition()).sub(sr.getPosition());
  const turn = Math.atan2(t.z, t.x) - Math.atan2(s.z, s.x);
  const snapped = Math.round(turn / (Math.PI / 2)) * 90;
  return out.setFromEulerAngles(0, snapped, 0);
}

/**
 * The paired child a bone points at: the spine's continuation over a hip or
 * a shoulder, the middle finger over the rest of a hand, else the first.
 */
function primaryChild(rig: Rig, i: number, paired: Map<number, unknown>): number {
  let best = -1;
  let rank = -1;
  for (let c = 0; c < rig.parents.length; c++) {
    if (rig.parents[c] !== i || !paired.has(c)) continue;
    const k = boneKey(rig.nodes[c].name);
    const r = /^(spine|neck|head)/.test(k) ? 2 : k.includes('middle') ? 1 : 0;
    if (r > rank) { rank = r; best = c; }
  }
  return best;
}

const _a = new Vec3();
const _b = new Vec3();

/** The shortest rotation taking direction `from` to `to`, into `out`. */
function swingBetween(from: Vec3, to: Vec3, out: Quat): void {
  from.normalize();
  to.normalize();
  const d = from.dot(to);
  if (!(from.lengthSq() > 0.5 && to.lengthSq() > 0.5) || d > 0.999999) {
    out.set(0, 0, 0, 1);
    return;
  }
  if (d < -0.999999) {
    // Opposite: half a turn about any axis square to `from`.
    const axis = Math.abs(from.x) < 0.9 ? new Vec3(1, 0, 0) : new Vec3(0, 1, 0);
    axis.cross(axis, from).normalize();
    out.set(axis.x, axis.y, axis.z, 0);
    return;
  }
  const c = new Vec3().cross(from, to);
  out.set(c.x, c.y, c.z, 1 + d).normalize();
}

interface BakedClip {
  keyframes: Map<number, SkeletalKeyframeEntry>;
  numFrames: number;
}

const _m1 = new Mat4();
const _m2 = new Mat4();
const _pos = new Vec3();
const _rot = new Quat();

/** Rotation about world Y taking `from` to `to`, measured on their yaw. */
function yawBetween(from: Quat, to: Quat): number {
  const d = new Quat().copy(from).invert();
  d.mul2(to, d);
  let a = 2 * Math.atan2(d.y, d.w);
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Chain baked clips into one timeline. Clip k is turned about Y and moved on
 * the ground so its hips, on its first frame, stand where clip k-1's hips stand
 * on the frame the seam begins, facing the same way; the `fade` frames after
 * that are blended. Placement acts on the hips through their parent's rest
 * frame (identity when they are the root), so any bone above them is honoured.
 */
function chainClips(rig: Rig, clips: BakedClip[], fade: number) {
  const n = rig.nodes.length;
  const h = rig.hips;
  // The hips' parent rest frame in the rig: what a hips key is local to.
  const parentRest = new Mat4();
  const pi = h >= 0 ? rig.parents[h] : -1;
  if (pi >= 0) parentRest.copy(rig.nodes[pi].getWorldTransform());
  const parentInv = parentRest.clone().invert();

  const startFrames: number[] = [0];
  const overlap: number[] = [0];
  for (let k = 1; k < clips.length; k++) {
    const ov = Math.min(fade, clips[k - 1].numFrames - 1, clips[k].numFrames - 1);
    overlap.push(ov);
    startFrames.push(startFrames[k - 1] + clips[k - 1].numFrames - 1 - ov);
  }
  const numFrames = startFrames[clips.length - 1] + clips[clips.length - 1].numFrames;
  const frames = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) frames[f] = f;
  const out = new Map<number, SkeletalKeyframeEntry>();
  for (let i = 0; i < n; i++) {
    out.set(i, {
      frames,
      positions: new Float32Array(numFrames * 3),
      rotations: new Float32Array(numFrames * 4),
      scales: new Float32Array(numFrames * 3).fill(1),
    });
  }
  const written = new Uint8Array(numFrames);

  /** The hips' transform in the rig frame at `frame` of a key set. */
  const hipsAt = (keys: Map<number, SkeletalKeyframeEntry>, frame: number, pos: Vec3, rot: Quat) => {
    const k = keys.get(h)!;
    _m1.setTRS(
      _pos.set(k.positions[frame * 3], k.positions[frame * 3 + 1], k.positions[frame * 3 + 2]),
      _rot.set(k.rotations[frame * 4], k.rotations[frame * 4 + 1], k.rotations[frame * 4 + 2], k.rotations[frame * 4 + 3]),
      Vec3.ONE,
    );
    _m2.mul2(parentRest, _m1);
    _m2.getTranslation(pos);
    rot.setFromMat4(_m2);
  };

  const posE = new Vec3(), posS = new Vec3(), step = new Vec3();
  const rotE = new Quat(), rotS = new Quat();
  const place = new Mat4();
  const yawQ = new Quat();

  for (let c = 0; c < clips.length; c++) {
    let keys = clips[c].keyframes;
    if (c > 0 && h >= 0) {
      const handoff = startFrames[c];
      // The outgoing pose at the seam's first frame is already in `out`, placed.
      hipsAt(out, handoff, posE, rotE);
      hipsAt(keys, 0, posS, rotS);
      const yaw = yawBetween(rotS, rotE);
      yawQ.setFromAxisAngle(Vec3.UP, (yaw * 180) / Math.PI);
      yawQ.transformVector(step.set(posS.x, 0, posS.z), step);
      place.setTRS(new Vec3(posE.x - step.x, 0, posE.z - step.z), yawQ, Vec3.ONE);
      // Hips keys: local -> rig frame, placed, -> local again. On a copy: the
      // clip is cached, and shared.
      const shared = keys.get(h)!;
      const k = { ...shared, positions: shared.positions.slice(), rotations: shared.rotations.slice() };
      keys = new Map(keys).set(h, k);
      for (let f = 0; f < clips[c].numFrames; f++) {
        _m1.setTRS(
          _pos.set(k.positions[f * 3], k.positions[f * 3 + 1], k.positions[f * 3 + 2]),
          _rot.set(k.rotations[f * 4], k.rotations[f * 4 + 1], k.rotations[f * 4 + 2], k.rotations[f * 4 + 3]),
          Vec3.ONE,
        );
        _m2.mul2(parentRest, _m1);
        _m1.mul2(place, _m2);
        _m2.mul2(parentInv, _m1);
        _m2.getTranslation(_pos);
        _rot.setFromMat4(_m2);
        k.positions.set([_pos.x, _pos.y, _pos.z], f * 3);
        k.rotations.set([_rot.x, _rot.y, _rot.z, _rot.w], f * 4);
      }
    }

    const ov = overlap[c];
    for (let f = 0; f < clips[c].numFrames; f++) {
      const slot = startFrames[c] + f;
      const w = written[slot] ? (ov > 0 ? smoothstep(f / ov) : 1) : 1;
      for (let i = 0; i < n; i++) {
        const src = keys.get(i)!;
        const dst = out.get(i)!;
        for (let a = 0; a < 3; a++) {
          dst.positions[slot * 3 + a] += (src.positions[f * 3 + a] - dst.positions[slot * 3 + a]) * w;
          dst.scales[slot * 3 + a] += (src.scales[f * 3 + a] - dst.scales[slot * 3 + a]) * w;
        }
        // Short-way nlerp: blend weights here are smooth and frames dense.
        let dot = 0;
        for (let a = 0; a < 4; a++) dot += dst.rotations[slot * 4 + a] * src.rotations[f * 4 + a];
        const sign = dot < 0 ? -1 : 1;
        let len = 0;
        for (let a = 0; a < 4; a++) {
          const v = dst.rotations[slot * 4 + a] + (src.rotations[f * 4 + a] * sign - dst.rotations[slot * 4 + a]) * w;
          dst.rotations[slot * 4 + a] = v;
          len += v * v;
        }
        len = Math.sqrt(len) || 1;
        for (let a = 0; a < 4; a++) dst.rotations[slot * 4 + a] /= len;
      }
      written[slot] = 1;
    }
  }
  return { keyframes: out, numFrames, startFrames };
}

/* ------------------------------------------------------------------ */
/*  GLB export                                                         */
/* ------------------------------------------------------------------ */

interface GltfNode {
  name?: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
}

interface GltfJson {
  nodes?: GltfNode[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  buffers?: { byteLength: number; uri?: string }[];
  bufferViews?: object[];
  accessors?: object[];
  animations?: object[];
  [key: string]: unknown;
}

interface GlbDoc {
  json: GltfJson;
  bin: Uint8Array;
}

interface GlbChannel {
  node: number;
  path: 'translation' | 'rotation' | 'scale';
  values: Float32Array;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function readGlb(buffer: ArrayBuffer): GlbDoc {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('[MeshCharacter] not a GLB');
  let offset = 12;
  let json: GltfJson | null = null;
  let bin = new Uint8Array(0);
  while (offset + 8 <= buffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const body = new Uint8Array(buffer, offset + 8, length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson;
    else if (type === CHUNK_BIN) bin = body;
    offset += 8 + length;
  }
  if (!json) throw new Error('[MeshCharacter] GLB has no JSON chunk');
  return { json, bin };
}

/** Each bone's node index in the file, and the skeleton parent's, by name through the skins. */
function glbNodeIndex(json: GltfJson, bones: GraphNode[]) {
  const nodes = json.nodes ?? [];
  const byName = new Map<string, number>();
  for (const skin of json.skins ?? []) {
    for (const j of skin.joints) {
      const name = nodes[j]?.name;
      if (name !== undefined && !byName.has(name)) byName.set(name, j);
    }
  }
  const boneIdx = bones.map((b) => {
    const i = byName.get(b.name);
    if (i === undefined) throw new Error(`[MeshCharacter] bone ${b.name} is not a joint in the file`);
    return i;
  });
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  const pivotIdx = parentOf.get(boneIdx[0]);
  if (pivotIdx === undefined) {
    throw new Error('[MeshCharacter] the skeleton has no parent node to carry the placement');
  }
  return { bones: boneIdx, pivot: pivotIdx, pivotParent: parentOf.get(pivotIdx) ?? -1 };
}

/** A node's world transform from the file's own TRS/matrix chain; identity for -1. */
function glbWorldOf(json: GltfJson, index: number): Mat4 {
  const nodes = json.nodes ?? [];
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  const world = new Mat4();
  const local = new Mat4();
  for (let i = index; i >= 0; i = parentOf.get(i) ?? -1) {
    const n = nodes[i];
    if (n.matrix) local.set(n.matrix);
    else {
      const t = n.translation ?? [0, 0, 0];
      const r = n.rotation ?? [0, 0, 0, 1];
      const sc = n.scale ?? [1, 1, 1];
      local.setTRS(new Vec3(t[0], t[1], t[2]), new Quat(r[0], r[1], r[2], r[3]), new Vec3(sc[0], sc[1], sc[2]));
    }
    world.mul2(local, world);
  }
  return world;
}

/**
 * Take a uniform scale off the skeleton's parent node and fold it into what
 * hangs from it, leaving the skinned result unchanged; returns the factor (1
 * when there was nothing to fold). Joint translations scale by it, a non-joint
 * hung off the skeleton takes it in its own translation and scale, and every
 * inverse bind matrix is premultiplied by it - a joint's world loses exactly
 * that scale, and its inverse bind gains it back. Mutates `doc`.
 */
function foldSkeletonScale(doc: GlbDoc, pivot: number): number {
  const json = doc.json;
  const nodes = json.nodes ?? [];
  const p = nodes[pivot];
  const sc = p?.scale;
  if (!p || p.matrix || !sc) return 1;
  const k = sc[0];
  if (Math.abs(k - 1) < 1e-6 || Math.abs(sc[1] - k) > 1e-6 * k || Math.abs(sc[2] - k) > 1e-6 * k) return 1;
  p.scale = [1, 1, 1];

  const joints = new Set((json.skins ?? []).flatMap((skin) => skin.joints));
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parentOf.set(c, i)));
  nodes.forEach((n, i) => {
    const parent = parentOf.get(i);
    if (parent === undefined || (parent !== pivot && !joints.has(parent))) return;
    if (n.matrix) {
      const m = n.matrix.slice();
      for (let a = 12; a < 15; a++) m[a] *= k;
      if (!joints.has(i)) for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) m[col * 4 + row] *= k;
      n.matrix = m;
      return;
    }
    if (n.translation) n.translation = n.translation.map((v) => v * k);
    if (!joints.has(i)) n.scale = (n.scale ?? [1, 1, 1]).map((v) => v * k);
  });

  doc.bin = doc.bin.slice();
  const accessors = (json.accessors ?? []) as { bufferView?: number; byteOffset?: number; count: number }[];
  const views = (json.bufferViews ?? []) as { byteOffset?: number; byteStride?: number }[];
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices === undefined) continue;
    const acc = accessors[skin.inverseBindMatrices];
    if (acc?.bufferView === undefined) continue;
    const view = views[acc.bufferView];
    const base = doc.bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = view.byteStride ?? 64;
    const data = new DataView(doc.bin.buffer);
    for (let m = 0; m < acc.count; m++) {
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 3; row++) {
          const at = base + m * stride + (col * 4 + row) * 4;
          data.setFloat32(at, data.getFloat32(at, true) * k, true);
        }
      }
    }
  }
  return k;
}

/** Whether every key of `values` equals the node's rest value for `path`, within float noise. */
function restatesRest(json: GltfJson, index: number, path: GlbChannel['path'], values: Float32Array): boolean {
  const node = json.nodes?.[index];
  if (!node || node.matrix) return false;
  const rest = path === 'translation'
    ? node.translation ?? [0, 0, 0]
    : path === 'rotation'
      ? node.rotation ?? [0, 0, 0, 1]
      : node.scale ?? [1, 1, 1];
  const n = rest.length;
  const scale = Math.max(1e-6, ...rest.map(Math.abs));
  for (let f = 0; f < values.length; f += n) {
    // A quaternion and its negation are one rotation.
    let same = true;
    let flipped = path === 'rotation';
    for (let a = 0; a < n; a++) {
      if (Math.abs(values[f + a] - rest[a]) > 1e-4 * scale) same = false;
      if (Math.abs(values[f + a] + rest[a]) > 1e-4 * scale) flipped = false;
    }
    if (!same && !flipped) return false;
  }
  return true;
}

/** Flip quaternions onto one hemisphere so linear interpolation takes the short way. */
function continuous(q: Float32Array): Float32Array {
  for (let f = 4; f < q.length; f += 4) {
    const dot = q[f] * q[f - 4] + q[f + 1] * q[f - 3] + q[f + 2] * q[f - 2] + q[f + 3] * q[f - 1];
    if (dot < 0) for (let a = 0; a < 4; a++) q[f + a] = -q[f + a];
  }
  return q;
}

/** The document with `animations` replaced by one clip, its data appended to the binary chunk. */
function writeGlbWithAnimation(doc: GlbDoc, name: string, times: Float32Array, channels: GlbChannel[]): ArrayBuffer {
  const json: GltfJson = structuredClone(doc.json);
  json.buffers ??= [];
  if (!json.buffers.length) json.buffers.push({ byteLength: 0 });
  json.bufferViews ??= [];
  json.accessors ??= [];

  const align = (n: number) => (n + 3) & ~3;
  const parts: Uint8Array[] = [];
  let binLength = align(doc.bin.byteLength);
  const addAccessor = (data: Float32Array, type: string, count: number, minMax?: [number, number]) => {
    json.bufferViews!.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength });
    json.accessors!.push({
      bufferView: json.bufferViews!.length - 1,
      componentType: 5126,
      count,
      type,
      ...(minMax ? { min: [minMax[0]], max: [minMax[1]] } : {}),
    });
    parts.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    binLength = align(binLength + data.byteLength);
    return json.accessors!.length - 1;
  };

  const input = addAccessor(times, 'SCALAR', times.length, [times[0], times[times.length - 1]]);
  const samplers: object[] = [];
  const animChannels: object[] = [];
  for (const ch of channels) {
    const type = ch.path === 'rotation' ? 'VEC4' : 'VEC3';
    const output = addAccessor(ch.values, type, times.length);
    samplers.push({ input, output, interpolation: 'LINEAR' });
    animChannels.push({ sampler: samplers.length - 1, target: { node: ch.node, path: ch.path } });
  }
  json.animations = [{ name, samplers, channels: animChannels }];
  json.buffers[0] = { ...json.buffers[0], byteLength: binLength };

  const bin = new Uint8Array(binLength);
  bin.set(doc.bin, 0);
  let at = align(doc.bin.byteLength);
  for (const part of parts) {
    bin.set(part, at);
    at = align(at + part.byteLength);
  }
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = align(jsonBytes.byteLength) - jsonBytes.byteLength;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.byteLength + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
  const out = new ArrayBuffer(total);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  bytes.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.byteLength;
  view.setUint32(binAt, bin.byteLength, true);
  view.setUint32(binAt + 4, CHUNK_BIN, true);
  bytes.set(bin, binAt + 8);
  return out;
}
