import { Entity, Quat, Vec3 } from 'playcanvas';
import type { Frustum, GraphNode, Mat4 } from 'playcanvas';

import {
  convertSkeletalAnimation,
  filterAnimationForArmature,
} from './anim/animation-conversion';
import { computeBindPoseTransforms } from './anim/bind-pose';
import type { Scene } from './scene';
import { AnimationPlayer } from './skeletal/animation-player';
import type { AnimEventCallback, AnimationProvider } from './skeletal/animation-player';
import type { BoneMask } from './skeletal/bone-mask';
import { computeBoneStretch } from './skeletal/bone-stretch';
import type { BoneScaleInput } from './skeletal/bone-stretch';
import { Pose } from './skeletal/pose';
import { Skeleton } from './skeletal/skeleton';
import { SplatSkinning } from './skeletal/splat-skinning';
import { buildSourceBoneRemap } from './splat/bone-binding';
import { buildRevealSkeleton } from './splat/reveal-bake';
import type { RevealSkeleton } from './splat/reveal-bake';
import type { Splat } from './splat/splat';
import type { ArmatureData } from './types';

/** "pelvis" on the bundled rigs; "Hips" on Mixamo-style ones, any prefix or separator. */
function isPelvisName(lower: string): boolean {
  return lower.includes('pelvis') || lower.replace(/^.*:/, '').replace(/^mixamorig/, '').replace(/[^a-z0-9]/g, '') === 'hips';
}

/**
 * Distance-based animation-LOD knobs. Used as the scene-wide preset
 * (`Scene.animLodPreset`) and as the per-armature override shape in
 * {@link Armature.setAnimationLod}.
 */
export interface AnimLodPreset {
  /** World-space distance (m) below which the armature animates full rate. */
  nearDist?: number;
  /** World-space distance (m) beyond which `farStride` applies. */
  farDist?: number;
  /** Frames-per-update between `nearDist` and `farDist`. 1 = every frame. */
  nearStride?: number;
  /** Frames-per-update beyond `farDist`. */
  farStride?: number;
}

/** Built-in fallback used by `setAnimationLod()` (no-arg) when the scene
 *  has no `animLodPreset`. Full rate ≤12 m, every-2nd ≤24 m, every-4th
 *  beyond. */
const DEFAULT_ANIM_LOD_PRESET: AnimLodPreset = {
  nearDist: 12,
  farDist: 24,
  nearStride: 2,
  farStride: 4,
};

/**
 * Pluggable override that drives the per-frame pose in place of
 * animation. The Armature has no knowledge of what's on the other end -
 * ragdoll physics, an IK solver, an AI behavior tree's pose output, a
 * network-replicated remote character - they all attach the same way.
 *
 * When `armature.poseProvider` is non-null, the Armature's animation
 * player is **not advanced** that frame; the provider has total control
 * of the pose. The Armature still owns the skinning pipeline (LOD,
 * frustum cull, world-transform composition, GPU palette upload), so a
 * provider only needs to fill `pose`.
 *
 * Implementations: {@link Ragdoll}.
 *
 * @group Characters & Animation
 */
export interface PoseProvider {
  /**
   * Fill `pose` (per-bone TRS in armature-local bone space) for this
   * frame. The Armature runs this between its LOD/frustum gate and the
   * `Skeleton.applyLocal` composition step. To restore animation,
   * detach by setting `armature.poseProvider = null`.
   */
  writePose(pose: Pose, armature: Armature, dt: number): void;

  /**
   * Optional teardown hook fired when the Armature is destroyed (or
   * when a new provider replaces this one). Use to release external
   * resources - e.g. ragdoll physics bodies.
   */
  onDetach?(): void;
}

/**
 * How the armature handles the pelvis X/Z motion extracted from the active
 * animation.
 *
 * - `'off'` - Pelvis X/Z is clamped to bind in bone space. The character
 *   looks "in-place" regardless of whether the underlying clip is
 *   locomotive. Entity is not touched by animation. **Default.**
 * - `'apply'` - Entity tracks pelvis as an absolute offset from a captured
 *   baseline: `entity.localPosition = baseline + (pelvis_pose − bind)` each
 *   frame. Switching `off → apply` captures the current entity position as
 *   the baseline; switching `apply → off` snaps the entity back to the
 *   baseline. Best for toggling-on/off demos and in-place looping animations
 *   (pelvis returns to bind at loop end → no teleport). Locomotive clips
 *   visibly snap at loop wrap; use `'extract'` for those.
 * - `'extract'` - Engine computes the per-frame pelvis Δ
 *   (`pelvis(t) − pelvis(t − dt)`) and accumulates it into an internal
 *   buffer; the caller reads it via {@link Armature.consumeRootMotionDelta}
 *   and feeds it to a motor / physics body / network layer. Unity-style
 *   `OnAnimatorMove` pattern. The engine does **not** write to the entity in
 *   this mode. Loop wraps and hard `play` calls suppress the resulting
 *   pelvis discontinuity so the next Δ is `0`.
 *
 * In every mode the pelvis bone itself is clamped to bind X/Z in bone space -
 * the motion lives on the entity (or in the consumed delta), never on the
 * bone.
 *
 * @group Characters & Animation
 */
export type RootMotionMode = 'off' | 'apply' | 'extract';

/**
 * Supplies a corrective pivot translation for one frame. Installed via
 * {@link Armature.rootOffsetProvider} and called once per {@link Armature.update}
 * with the current animation frame time, after the pose is evaluated and before
 * bone transforms are composed - so the offset lands in the same frame's bone
 * matrices with no lag.
 *
 * Return `null` for "no offset this frame". The returned vector is read
 * immediately and not retained, so returning a reused scratch object is fine.
 *
 * @group Characters & Animation
 */
export type RootOffsetProvider = (frameTime: number) => { x: number; y: number; z: number } | null;

/**
 * Refines the freshly-evaluated pose in place, once per {@link Armature.update}.
 *
 * Unlike {@link PoseProvider}, which REPLACES animation, a modifier runs on top
 * of it: the player has already written `pose`, overlay layers have already been
 * composed, and the modifier gets the last word before the rig-convention clamps
 * and the world-transform composition. Return nothing - edit `pose` in place.
 *
 * This is the hook for corrections that are a function of the animated pose
 * rather than a replacement for it: an additive limb offset, a loop-seam
 * dissolve, a look-at. `null` (the default) is no modifier and costs nothing.
 *
 * Deliberately NOT run by {@link Armature.probeBoneWorldPositions}: a probe
 * measures the clip, and a correction derived from a probe that already
 * contained it would feed back into itself.
 *
 * @group Characters & Animation
 */
export type PoseModifier = (pose: Pose, armature: Armature) => void;

/**
 * Composition root for one character: holds the PlayCanvas pivot entity and
 * wires together a {@link Skeleton}, an {@link AnimationPlayer}, a working
 * {@link Pose}, and a {@link SplatSkinning} unit.
 *
 * Thin facade - `playAnimation` / `crossfadeTo` / `stop` / `update` delegate
 * to the underlying modules. The rig-convention rules (pelvis X/Z clamp,
 * pelvis-Y lock, root-bone clamp, root-motion extraction) live here, because
 * they're a *character-setup* concern, not a pose-evaluation concern.
 *
 * Most users won't construct this directly - {@link Character.load} builds
 * one automatically. It's exported for custom pipelines that need direct
 * control over skeletal evaluation.
 *
 * @group Characters & Animation
 */
export class Armature {
  /** Pivot entity; all linked splats become children of this. */
  entity: Entity;
  /** Rig data (bone count, rest translations/rotations, parents). */
  armatureData: ArmatureData;
  /** Number of bones in the rig. */
  numBones: number;

  private readonly _skeleton: Skeleton;
  /**
   * Cap on how far one {@link update} may advance the clip, in seconds.
   * `Infinity` (the default) tracks the wall clock.
   *
   * PlayCanvas clamps a long frame to `app.maxDeltaTime` (100ms), which a
   * 30fps clip crosses three frames at once - a visible lurch. Cap it across
   * an expected stall, then restore: capping drifts behind real time, which a
   * loop hides but steady-state playback should not.
   */
  maxAnimDt = Infinity;

  /**
   * Corrective per-frame pivot translation, or `null` (the default) for none.
   * See {@link RootOffsetProvider}.
   *
   * The offset composes ON TOP of whatever {@link rootMotionMode} routing
   * produced and is measured from the base position {@link move} last set, so it
   * cannot ratchet: every frame writes an absolute position, never an increment.
   * `move` keeps owning the base placement; the provider only ever nudges.
   *
   * Used by callers that precompute a corrective root path from a clip - ground
   * snap and foot pinning being the obvious ones - and want it applied every
   * frame without fighting the base placement for ownership of the entity.
   */
  rootOffsetProvider: RootOffsetProvider | null = null;

  /**
   * Per-frame refinement of the animated pose, or `null` (the default) for
   * none. See {@link PoseModifier}.
   */
  poseModifier: PoseModifier | null = null;

  private readonly _currentPose: Pose;
  private readonly _snapshotPose: Pose;
  private readonly _worldTransforms: Mat4[] = [];
  // Probe scratch. Allocated on the first probe call, never before.
  private _probePose: Pose | null = null;
  // Set by prepareReveal; splats linked afterwards are baked as they link.
  private _revealPrepared = false;
  // Shared by every splat this armature drives; see _bakeReveal.
  private _revealSkeleton: RevealSkeleton | null = null;
  private readonly _probeTransforms: Mat4[] = [];

  private _scene: Scene | null = null;
  private _player: AnimationPlayer | null = null;
  private _skinning: SplatSkinning | null = null;
  private _provider: AnimationProvider | null = null;
  private readonly _layers = new Map<string, AnimationLayer>();
  private readonly _layerTmpQ = new Quat();
  private _drivenNodes: readonly GraphNode[] | null = null;
  private _evaluatedBones: readonly number[] | null = null;
  /** {@link _evaluatedBones} with ancestors, root and pelvis, parents first. */
  private _evaluatedOrder: Int32Array | null = null;
  private readonly _nodeTmpV = new Vec3();
  private readonly _nodeTmpQ = new Quat();

  /**
   * Optional override that drives the pose in place of animation.
   * Setting this to a non-null value skips animation evaluation; the
   * provider has full control of `_currentPose`. Setting back to `null`
   * resumes animation immediately. See {@link PoseProvider}.
   *
   * Replacing the provider (set non-null while another is attached)
   * fires the outgoing provider's `onDetach()` first.
   */
  get poseProvider(): PoseProvider | null { return this._poseProvider; }
  set poseProvider(p: PoseProvider | null) {
    if (p === this._poseProvider) return;
    const prev = this._poseProvider;
    this._poseProvider = p;
    try { prev?.onDetach?.(); } catch { /* keep going */ }
  }
  private _poseProvider: PoseProvider | null = null;

  // Rig-convention bone indices. `-2` = unresolved, `-1` = absent in rig.
  private _rootBoneIndex = -2;
  private _pelvisBoneIndex = -2;


  /**
   * When true, {@link update} advances the animation player (so timers,
   * crossfade, and event callbacks still fire) but skips pose evaluation
   * and the skinning push. The previous frame's pose stays on the GPU
   * palette and the splat keeps rendering at its last bone state.
   *
   * Use for dynamic animation LOD - e.g. when fps drops, set true on
   * every other (or every Nth) frame to halve the per-frame skeletal
   * cost. Cleared when fps recovers.
   */
  skipPose = false;

  /**
   * When true, {@link update} still pushes bone transforms to the GPU
   * palette (so items, hitboxes, and outlines tracking bones still move
   * correctly) but skips the CPU-side `splat.updatePositions(...)` call
   * that recomputes sort centers from the deformed mesh. The depth-sort
   * order lags one frame behind the visual pose.
   *
   * Use for alternate-frame throttling - `updatePositions` is the heavy
   * call (full center buffer re-upload to the sort worker), and most
   * frames don't visibly need a fresh sort.
   */
  skipPositions = false;

  /**
   * Update rate divider. `1` = pose evaluation runs on every {@link update}
   * call (default - matches the scene's `app.on('update', …)` cadence).
   * Set to N>1 to advance the animation player every call but only do the
   * heavy pose-eval + skinning push every Nth call.
   *
   * `dt` from skipped frames is accumulated and passed to the next
   * evaluated frame, so animation time stays correct - only the GPU
   * palette refresh rate drops.
   *
   * Typical use: set to `2` on background characters so the per-character
   * armature cost halves while the scene still ticks at 30 Hz.
   */
  updateInterval = 1;

  private _updateCounter = 0;
  private _updateAccumDt = 0;

  // Pelvis-lock state.
  private _lockPelvisY = false;

  // Root motion.
  private _rootMotionMode: RootMotionMode = 'off';
  // 'apply' mode: baseline entity position captured on off → apply.
  private _baseLocalPosition = new Vec3();
  // 'extract' mode: delta tracker for Unity-style per-frame Δ.
  private _lastPelvisPos = new Vec3();
  private _hasLastPelvis = false;
  private _rootMotionAccumDx = 0;
  private _rootMotionAccumDz = 0;
  // Scratch for the bone-space -> entity-space rotation of the pelvis offset.
  private readonly _rootMotionTmp = new Vec3();

  // ── Distance-based animation LOD ───────────────────────────────────
  // Throttle skinning updates by distance from the camera: near
  // characters update every frame, far ones every Nth. `tick(dt)` still
  // advances animation time every frame (so clip timing stays correct);
  // only the expensive pose-evaluate + skinning push is skipped on
  // throttled frames, freezing the rendered pose until the next update.
  //
  // OFF BY DEFAULT - distances start at Infinity so `_lodStride()` always
  // returns 1 (full rate). Opt in per-armature via `setAnimationLod()`
  // (no-arg form pulls the scene's `animLodPreset`), or set the scene
  // preset once and call `setAnimationLod()` on each character you want
  // throttled. Player / important characters: just never opt in.
  private _lodNearDist = Infinity;
  private _lodFarDist = Infinity;
  private _lodNearStride = 2; // frames-per-update between near and far
  private _lodFarStride = 4;  // frames-per-update beyond far
  private _lodFrameCounter = 0;

  // ── Distance-based SORT LOD ─────────────────────────────────────────
  // Complement to animation LOD. Throttles ONLY the CPU-side sort center
  // re-upload (`splat.updatePositions`, ~88% of per-character CPU at high
  // counts) by setting `skipPositions=true` on throttled frames. The GPU
  // palette still uploads, so the visible pose is correct - only the
  // depth-sort order lags one frame.
  //
  // Composes with anim LOD: on frames where anim LOD throttles, the whole
  // block returns and sort LOD is irrelevant. On frames where anim LOD
  // evaluates, sort LOD can still decide to skip the positions push.
  // Typical setup: tight bands so even mid-distance characters skip sort
  // most frames, while pose stays at full rate.
  //
  // OFF BY DEFAULT - opt in per-armature via `setSortLod()`.
  private _sortLodNearDist = Infinity;
  private _sortLodFarDist = Infinity;
  private _sortLodNearStride = 2;
  private _sortLodFarStride = 4;
  private _sortLodFrameCounter = 0;

  constructor(name: string, armatureData: ArmatureData) {
    this.armatureData = armatureData;
    this.numBones = armatureData.numBones;
    this.entity = new Entity(name);
    this._skeleton = new Skeleton(armatureData);
    this._currentPose = new Pose(this.numBones);
    this._snapshotPose = new Pose(this.numBones);
    this._currentPose.setToBind(this._skeleton.bindT, this._skeleton.bindR);
  }

  /**
   * Drive scene-graph nodes from this armature's pose: a skinned mesh's bones,
   * index-aligned with the rig and listed parents first. Each update writes the
   * bone world transforms onto them, and the armature evaluates whenever nodes
   * are attached - it otherwise poses only while a linked splat is in view.
   * `null` detaches.
   */
  driveNodes(nodes: readonly GraphNode[] | null): void {
    if (nodes && nodes.length !== this.numBones) {
      throw new Error(`[Armature] driveNodes: ${nodes.length} nodes for ${this.numBones} bones`);
    }
    this._drivenNodes = nodes;
    if (nodes) this._pushPose();
  }

  /**
   * Pose only these bones (with their ancestors, the root and the pelvis) on
   * each {@link update}; every other bone keeps its last bone matrix and
   * driven-node pose. For a reader of a few bones of a large rig. `null` (the
   * default) poses every bone.
   */
  evaluateOnly(bones: readonly number[] | null): void {
    this._evaluatedBones = bones;
    this._applyEvaluatedBones();
  }

  private _applyEvaluatedBones(): void {
    if (!this._player) return;
    const bones = this._evaluatedBones;
    let order: Int32Array | null = null;
    if (bones) {
      this._resolveRigIndices();
      const rig = [this._rootBoneIndex, this._pelvisBoneIndex].filter((i) => i >= 0);
      order = this._skeleton.subsetOrder([...bones, ...rig]);
    }
    this._evaluatedOrder = order;
    this._player.bones = order;
  }

  /** Splats currently being driven by this armature. */
  get linkedSplats(): Set<Splat> {
    if (this._skinning) return this._skinning.linkedSplats;
    return _EMPTY_SET;
  }

  /**
   * Detach the armature from its scene and destroy its pivot entity. Splats
   * still linked at the time of destroy are also destroyed so they stop
   * holding the gsplat component alive. The armature itself is not safe to
   * reuse after this call.
   *
   * Use {@link Character.destroy} instead if you have the owning
   * {@link Character} - it disposes both the armature and its primary splat.
   */
  destroy(): void {
    try { this._poseProvider?.onDetach?.(); } catch { /* keep tearing down */ }
    this._poseProvider = null;
    this._drivenNodes = null;
    if (this._skinning) {
      for (const splat of Array.from(this._skinning.linkedSplats)) {
        try { splat.destroy(); } catch { /* ignore cleanup errors */ }
      }
    }
    if (this.entity.parent) this.entity.parent.removeChild(this.entity);
    this.entity.destroy();
    this._scene = null;
    this._skinning = null;
    this._player = null;
    this._provider = null;
    this._layers.clear();
  }

  // ── Scene integration ───────────────────────────────────────────

  /**
   * Attach this armature to a scene. Required before playback. Adds the
   * armature pivot as a child of `scene.contentRoot` and wires up the
   * animation provider + splat skinning.
   */
  addToScene(scene: Scene): void {
    this._scene = scene;
    scene.contentRoot.addChild(this.entity);

    const provider: AnimationProvider = (name: string) => {
      let anim = scene.skeletalAnimationLibrary.get(name);
      if (!anim) return null;
      anim = filterAnimationForArmature(anim, this.numBones, scene.skeletonLibrary);
      scene.skeletalAnimationLibrary.set(name, anim);
      convertSkeletalAnimation(anim, scene.skeletonLibrary);
      return anim;
    };
    this._provider = provider;

    this._player = new AnimationPlayer({
      skeleton: this._skeleton,
      animationProvider: provider,
      snapshotPose: this._snapshotPose,
    });
    this._skinning = new SplatSkinning(this._skeleton, scene.skeletonLibrary);
    this._applyEvaluatedBones();

    this._pushPose();
  }

  /**
   * Register a {@link Splat} to be driven by this armature.
   *
   * Reparents the splat under the armature's pivot and pushes the current
   * bone transforms so the splat appears in the correct pose immediately.
   */
  linkSplat(splat: Splat): void {
    if (!this._skinning) return;
    this._skinning.link(splat);
    splat.linkedArmature = this;

    if (splat.entity.parent) {
      splat.entity.parent.removeChild(splat.entity);
    }
    this.entity.addChild(splat.entity);

    if (this._revealPrepared || splat.revealEnabled) this._bakeReveal(splat);
    this._pushPose();
  }

  /**
   * Opt every linked splat into the reveal ahead of time - see
   * {@link Splat.setReveal}. Bakes each splat's feet-to-head distances (about
   * 10 ms per 50k splats on a desktop) and recompiles its shader once, so
   * call it after loading rather than when the reveal starts. Splats linked
   * later are baked as they link.
   */
  prepareReveal(): void {
    this._revealPrepared = true;
    for (const splat of this.linkedSplats) this._bakeReveal(splat);
  }

  /**
   * {@link Splat.bakeReveal} for one splat. The distances depend
   * only on the skeleton, so they are derived once and shared - a character
   * links one splat per LOD plus any variants.
   */
  private _bakeReveal(splat: Splat): void {
    if (splat.revealBaked) return;
    const reveal = this._revealSkeleton ?? this._buildRevealSkeleton(splat);
    if (!reveal) return;
    this._revealSkeleton = reveal;
    const remap = buildSourceBoneRemap(splat, this._skeleton.numBones, this._scene?.skeletonLibrary);
    splat.bakeReveal(reveal, remap);
  }

  /** This rig's {@link buildRevealSkeleton}, from its bind pose. */
  private _buildRevealSkeleton(splat: Splat): RevealSkeleton | null {
    const sk = this._skeleton;
    const n = sk.numBones;
    if (n === 0) return null;
    const bind = computeBindPoseTransforms(n, sk.bindT, sk.bindR, sk.parents);
    const pos = new Float32Array(n * 3);
    const tmp = new Vec3();
    for (let i = 0; i < n; i++) {
      bind[i].getTranslation(tmp);
      pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z;
    }
    return buildRevealSkeleton(pos, sk.parents, this.rigBoneNames, splat.localBound.center);
  }

  /**
   * Stop driving the given splat. The splat is not destroyed; it just no
   * longer receives bone transform updates.
   */
  unlinkSplat(splat: Splat): void {
    this._skinning?.unlink(splat);
    if (splat.linkedArmature === this) {
      splat.linkedArmature = null;
    }
  }

  /**
   * Apply any combination of position, rotation, and scale to the armature
   * pivot. All linked splats are requested to re-sort.
   */
  move(position?: Vec3, rotation?: Quat, scale?: Vec3): void {
    if (position) {
      this._baseLocalPosition.copy(position);
      this.entity.setLocalPosition(position);
    }
    if (rotation) this.entity.setLocalRotation(rotation);
    if (scale) this.entity.setLocalScale(scale);
    this._skinning?.requestSortAll();
  }

  // ── Root motion ────────────────────────────────────────────────

  /**
   * How pelvis X/Z motion is routed each frame. See {@link RootMotionMode}.
   * Default `'off'`.
   *
   * Transitions are coordinated so toggling is well-behaved:
   *
   *   - `off → apply` captures the current entity position as the baseline.
   *     The entity then tracks `baseline + (pelvis − bind)` each frame.
   *   - `apply → off` (or `apply → extract`) snaps the entity back to the
   *     baseline so the apply-mode offset doesn't leak into the next mode.
   *     This is what prevents the toggle-ratchet bug.
   *   - `* → extract` resets the per-frame Δ tracker so the next Δ is `0`.
   */
  get rootMotionMode(): RootMotionMode { return this._rootMotionMode; }
  set rootMotionMode(m: RootMotionMode) {
    if (m === this._rootMotionMode) return;
    const prev = this._rootMotionMode;
    if (prev === 'apply') {
      this.entity.setLocalPosition(this._baseLocalPosition);
      this._skinning?.requestSortAll();
    }
    if (m === 'apply') {
      const p = this.entity.getLocalPosition();
      this._baseLocalPosition.set(p.x, p.y, p.z);
    }
    this._hasLastPelvis = false;
    this._rootMotionAccumDx = 0;
    this._rootMotionAccumDz = 0;
    this._rootMotionMode = m;
  }

  /**
   * Convenience boolean alias for {@link rootMotionMode}.
   * `true` ⇔ `'apply'`, `false` ⇔ `'off'`. To use `'extract'`, set
   * {@link rootMotionMode} directly.
   */
  get rootMotion(): boolean { return this._rootMotionMode === 'apply'; }
  set rootMotion(v: boolean) { this.rootMotionMode = v ? 'apply' : 'off'; }

  /**
   * The entity position root motion applies off - see {@link rootMotionMode}.
   * Set by {@link move}. Read-only; the vector is live.
   */
  get rootMotionBase(): Readonly<Vec3> { return this._baseLocalPosition; }

  /**
   * Return the pelvis X/Z delta accumulated since the previous call (or since
   * the armature was created / `rootMotionMode` was changed), and reset the
   * accumulator. The delta is in the entity's parent space - feed it directly
   * to a motor's velocity input or to a physics body.
   *
   * Returns `{ dx: 0, dz: 0 }` in `'off'` or `'apply'` modes. In `'apply'`
   * mode the delta has already been written to {@link entity}, so consumers
   * shouldn't read and re-apply it.
   */
  consumeRootMotionDelta(): { dx: number; dz: number } {
    const dx = this._rootMotionAccumDx;
    const dz = this._rootMotionAccumDz;
    this._rootMotionAccumDx = 0;
    this._rootMotionAccumDz = 0;
    return { dx, dz };
  }

  /**
   * When `true`, clamp the pelvis bone's Y translation to bind each frame.
   * Use for in-place idle / gesture captures where vertical bob would push
   * the character out of a tightly-framed thumbnail.
   */
  get lockPelvisY(): boolean { return this._lockPelvisY; }
  set lockPelvisY(v: boolean) { this._lockPelvisY = v; }

  // ── Playback accessors ─────────────────────────────────────────

  get isPlaying(): boolean { return this._player?.isPlaying ?? false; }
  get isFinished(): boolean { return this._player?.isFinished ?? false; }

  get paused(): boolean { return this._player?.paused ?? false; }
  set paused(v: boolean) { if (this._player) this._player.paused = v; }

  get animationTime(): number { return this._player?.animationTime ?? 0; }
  set animationTime(v: number) { if (this._player) this._player.animationTime = v; }

  get animationDuration(): number { return this._player?.animationDuration ?? 0; }

  /**
   * Crossfade progress in `[0, 1]`. `0` when no crossfade is active; `1`
   * once the active crossfade has fully blended into the target animation.
   */
  get crossfadeProgress(): number { return this._player?.crossfadeProgress ?? 0; }

  get frameRate(): number { return this._player?.frameRate ?? 30; }
  set frameRate(v: number) { if (this._player) this._player.frameRate = v; }

  /** Playback-speed multiplier (`1` = author speed). Scales how fast the
   *  active clip advances without touching its authored frame rate or
   *  crossfade timing. See {@link AnimationPlayer.playbackSpeed}. */
  get playbackSpeed(): number { return this._player?.playbackSpeed ?? 1; }
  set playbackSpeed(v: number) { if (this._player) this._player.playbackSpeed = v; }

  hasAnimation(animName: string): boolean {
    return !!this._scene?.skeletalAnimationLibrary.get(animName);
  }

  /**
   * Bone names from the attached scene's skeleton library, or an empty array
   * if the armature isn't bound yet. Consumers that need bone-name lookup
   * (bone-tracked colliders, attachments, debug overlays) read from here
   * instead of reaching into private armature state.
   */
  get boneNames(): readonly string[] {
    return this.armatureData.boneNames ?? this._scene?.skeletonLibrary?.boneNames ?? [];
  }

  /**
   * Bone names matching THIS armature's rig size. {@link boneNames} always
   * returns the 86-bone std-male list; the 441-bone facial rig has its own
   * name table (`boneNames441`). Name-keyed per-bone features (bone stretch,
   * body-part classification) must use this accessor or they silently
   * misclassify every bone on the large rig.
   */
  get rigBoneNames(): readonly string[] {
    if (this.armatureData.boneNames) return this.armatureData.boneNames;
    const lib = this._scene?.skeletonLibrary;
    if (this.numBones === 441 && lib?.boneNames441) return lib.boneNames441;
    return lib?.boneNames ?? [];
  }

  /** The scene this armature is attached to, or `null` if not yet attached. */
  get scene(): Scene | null { return this._scene; }

  /** The skeleton owned by this armature (rest pose, parents, bind data). */
  get skeleton(): Skeleton { return this._skeleton; }

  /**
   * Live reference to the per-bone world-transform array filled in by
   * the most recent {@link update}. Same Mat4 instances are reused
   * across frames - callers may hold the array reference and re-read,
   * or call {@link getBoneWorldMatrix} for a single bone. Empty until
   * the first update.
   */
  get boneWorldMatrices(): readonly Mat4[] { return this._worldTransforms; }

  /** Index of the pelvis bone (a Mixamo `Hips` counts), or -1 for none. */
  get pelvisBoneIndex(): number {
    // Resolved against the scene's skeleton library, so not before it has one.
    if (this._pelvisBoneIndex === -2 && this._scene) this._resolveRigIndices();
    return Math.max(-1, this._pelvisBoneIndex);
  }

  /**
   * Sample the world-space POSITION of selected bones at an explicit animation
   * frame time, writing `x, y, z` triples into `out` in the order the indices
   * were given. `out` must hold at least `boneIndices.length * 3` numbers; an
   * out-of-range index writes zeroes.
   *
   * This is the precompute probe. {@link Armature.update} is the wrong tool for
   * sweeping a clip: it advances time, it pushes to linked splats, and it bails
   * out before evaluating anything at all when the character is outside the
   * camera frustum - so an off-screen character cannot be measured through it.
   * This call skips culling and skinning entirely, leaves playback state
   * untouched (time, crossfade, event cursor), and can be run for every frame of
   * a clip back to back.
   *
   * The same rig-convention clamps the live path applies (pelvis X/Z to bind,
   * pelvis-Y lock, root-bone translation / scale clamp) are applied to the
   * probed pose, so sampled positions line up with rendered ones - the clip's
   * root ORIENTATION is preserved in both, so a sweep and the render agree on
   * which way the character faces. Root-motion ROUTING is deliberately
   * not run: probing must not move the entity or feed the extract accumulator.
   * {@link poseModifier} is not run either - see the note on that type.
   *
   * Positions include the pivot's current world transform, so they are in the
   * same world space {@link getBoneWorldMatrix} reports. The pelvis X/Z clamp
   * means what a sweep measures is the clip's IN-PLACE motion, whatever
   * {@link rootMotionMode} is doing to the entity live.
   *
   * Plain numbers cross the boundary on purpose: consumers can sweep a clip
   * without depending on PlayCanvas types.
   *
   * Returns `false` when the armature is not attached to a scene or no animation
   * is active.
   */
  probeBoneWorldPositions(
    frameTime: number,
    boneIndices: readonly number[],
    out: Float32Array | number[],
  ): boolean {
    if (!this._player) return false;
    this._resolveRigIndices();
    if (!this._probePose) this._probePose = new Pose(this.numBones);
    const pose = this._probePose;
    if (!this._player.evaluateAt(frameTime, pose)) return false;
    this._clampPoseToRigConventions(pose);
    this._skeleton.applyLocal(pose, this.entity.getWorldTransform(), this._probeTransforms);

    for (let i = 0; i < boneIndices.length; i++) {
      const bi = boneIndices[i];
      const m = bi >= 0 && bi < this.numBones ? this._probeTransforms[bi] : null;
      out[i * 3] = m ? m.data[12] : 0;
      out[i * 3 + 1] = m ? m.data[13] : 0;
      out[i * 3 + 2] = m ? m.data[14] : 0;
    }
    return true;
  }

  /**
   * Evaluate the active clip at an explicit frame time into `outPose`, with no
   * crossfade and no playback-state mutation. The pose-level counterpart of
   * {@link probeBoneWorldPositions}: parent-local TRS rather than world
   * positions, for callers that want to blend toward a sampled pose (a loop
   * seam) rather than measure one.
   *
   * The rig-convention clamps are applied, matching what the live path renders.
   * Returns `false` when no animation is active.
   */
  probePose(frameTime: number, outPose: Pose): boolean {
    if (!this._player) return false;
    this._resolveRigIndices();
    if (!this._player.evaluateAt(frameTime, outPose)) return false;
    this._clampPoseToRigConventions(outPose);
    return true;
  }

  /**
   * Snap any active crossfade to its terminal state (target pose fully
   * applied) on the next {@link Armature.update}. Useful when scrubbing
   * through animation frames for precompute, where the per-frame pose
   * needs to be the pure animation evaluation without crossfade blend.
   */
  endCrossfade(): void {
    this._player?.endCrossfade();
  }

  /**
   * Return the world-space transform of bone `boneIdx` as computed by the
   * most recent {@link Armature.update}. Returns a live reference into the
   * armature's internal array - callers must not mutate it; copy first if
   * you need to retain.
   *
   * Returns `null` if `boneIdx` is out of range, or if the bone transform
   * array has not been populated yet (no `update()` has run, or the armature
   * isn't attached to a scene).
   *
   * Used by per-bone attachments - bone-tracked colliders, weapon GLBs
   * mounted to a bone, particle emitters following a bone, etc.
   */
  getBoneWorldMatrix(boneIdx: number): Mat4 | null {
    if (boneIdx < 0 || boneIdx >= this.numBones) return null;
    return this._worldTransforms[boneIdx] ?? null;
  }

  /**
   * Name of the currently-playing animation, or `null` if no animation is
   * active. Mirrors {@link AnimationPlayer.currentAnimationName}.
   */
  get currentAnimationName(): string | null {
    return this._player?.currentAnimationName ?? null;
  }

  /**
   * Subscribe to frame-aligned {@link AnimationEvent}s on the currently-
   * playing animation. Events come from the active animation's
   * {@link Animation.events} array; the engine doesn't interpret `name` or
   * `payload` - games define their own vocabulary and route inside the
   * callback.
   *
   * Listeners are kept across animation switches; one subscription is enough
   * for the armature's lifetime. Returns an unsubscribe handle.
   */
  onAnimEvent(cb: AnimEventCallback): () => void {
    return this._player?.onAnimEvent(cb) ?? (() => {});
  }

  // ── Playback verbs ─────────────────────────────────────────────

  /**
   * Start playing an animation immediately (no crossfade). Restarts from
   * frame 0. Returns `false` if not registered, or if the armature isn't
   * attached to a scene yet.
   *
   * Passing `rootMotion: true` sets {@link rootMotionMode} to `'apply'`;
   * passing `false` sets it to `'off'`. For `'extract'`, set the mode
   * separately and pass `rootMotion: false` (or omit) here - the per-clip
   * flag is just a convenience shortcut for the common case.
   */
  playAnimation(animName: string, rootMotion = false, loop = true): boolean {
    if (!this._player) return false;
    this.rootMotion = rootMotion;
    this._hasLastPelvis = false; // hard switch - pelvis pose discontinuity
    return this._player.play(animName, { loop });
  }

  /**
   * Crossfade from the current pose to a new animation over `opts.duration`
   * seconds. Snapshots current bone poses, then blends toward the new
   * animation target. Pelvis motion stays continuous across the blend.
   *
   * `opts.rootMotion` is mapped to {@link rootMotionMode} the same way as
   * {@link playAnimation}.
   */
  crossfadeTo(
    animName: string,
    opts?: { duration?: number; rootMotion?: boolean; loop?: boolean; preserveTime?: boolean; continueSource?: boolean; easing?: 'linear' | 'smoothstep' },
  ): boolean {
    if (!this._player) return false;
    this.rootMotion = opts?.rootMotion ?? false;
    // Crossfade is a smooth pose blend - _hasLastPelvis stays valid, so the
    // pelvis delta on the first cross-fade frame is the small differential
    // between the snapshot pelvis and the (blended) target pelvis.
    return this._player.crossfadeTo(animName, this._currentPose, opts);
  }

  // ── Animation layers ───────────────────────────────────────────

  /**
   * Play `animName` on the named overlay layer, gated to `mask`'s bone set.
   * Layers compose on top of the base animation in {@link update} - for each
   * bone in the mask, the current pose is interpolated toward the overlay's
   * pose by the layer weight.
   *
   * Creates the layer lazily on first use (allocates a per-layer
   * {@link AnimationPlayer} sharing the same skeleton and animation provider
   * as the base). Subsequent calls reuse the same player.
   */
  playLayerAnimation(
    layerName: string,
    animName: string,
    mask: BoneMask,
    opts?: { loop?: boolean; crossfade?: number; weight?: number },
  ): boolean {
    if (!this._provider) return false;
    let layer = this._layers.get(layerName);
    if (!layer) {
      const snapshot = new Pose(this.numBones);
      snapshot.setToBind(this._skeleton.bindT, this._skeleton.bindR);
      const player = new AnimationPlayer({
        skeleton: this._skeleton,
        animationProvider: this._provider,
        snapshotPose: snapshot,
      });
      const pose = new Pose(this.numBones);
      pose.setToBind(this._skeleton.bindT, this._skeleton.bindR);
      layer = { player, mask: mask.boneIndices, pose, snapshot, weight: opts?.weight ?? 1 };
      this._layers.set(layerName, layer);
    } else {
      layer.mask = mask.boneIndices;
      if (opts?.weight !== undefined) layer.weight = opts.weight;
      layer.fadingOut = undefined;
    }
    const loop = opts?.loop ?? true;
    const xf = opts?.crossfade ?? 0;
    return xf > 0
      ? layer.player.crossfadeTo(animName, layer.pose, { duration: xf, loop })
      : layer.player.play(animName, { loop });
  }

  /** Set the overlay weight for a layer in `[0, 1]`. No-op if the layer doesn't exist. */
  setLayerWeight(layerName: string, weight: number): void {
    const l = this._layers.get(layerName);
    if (l) {
      l.weight = Math.max(0, Math.min(1, weight));
      l.fadingOut = undefined;
    }
  }

  /**
   * Pause or resume every active overlay layer. The base animation is
   * controlled separately via {@link paused}. Useful so a single play/pause
   * toggle in an editor or pause menu freezes the whole stack together.
   */
  setAllLayersPaused(paused: boolean): void {
    for (const layer of this._layers.values()) {
      layer.player.paused = paused;
    }
  }

  /**
   * Stop and remove the named layer. With `fadeDuration > 0`, ramps the
   * layer weight to zero over `fadeDuration` seconds before tearing down.
   */
  stopLayer(layerName: string, fadeDuration = 0): void {
    const l = this._layers.get(layerName);
    if (!l) return;
    if (fadeDuration <= 0) {
      this._layers.delete(layerName);
      return;
    }
    l.fadingOut = { from: l.weight, t: 0, duration: fadeDuration };
  }

  /** Stop with optional crossfade back to rest pose. */
  stop(fadeDuration = 0): void {
    if (!this._player) return;
    if (fadeDuration > 0 && this._player.isPlaying) {
      this._player.stop(this._currentPose, fadeDuration);
      return;
    }
    this._player.stop(this._currentPose, 0);
    this._currentPose.setToBind(this._skeleton.bindT, this._skeleton.bindR);
    this._hasLastPelvis = false; // hard stop - pelvis snaps to bind
    this._pushPose();
  }

  // ── Per-frame update ───────────────────────────────────────────

  /**
   * Advance animation time by `dt` seconds, evaluate pose, and push bone
   * transforms to linked splats. Wire this up to your scene's `update` event.
   */
  update(dt: number): void {
    if (!this._player || !this._skinning) return;

    // External pose-provider path: animation is fully replaced. The
    // provider writes the pose; the skinning pipeline (LOD's frustum
    // cull, applyLocal, push-transforms) is unchanged. Animation-LOD
    // strides and the player tick are bypassed - providers handle
    // their own throttling if they need to.
    if (this._poseProvider) {
      if (!this._drivenNodes && !this._skinning.anyVisible(this._cameraFrustum())) return;
      this._poseProvider.writePose(this._currentPose, this, dt);
      this._skeleton.applyLocal(
        this._currentPose,
        this.entity.getWorldTransform(),
        this._worldTransforms,
      );
      this._skinning.pushTransforms(
        this._worldTransforms,
        this.entity.getWorldTransform(),
        this.skipPositions,
      );
      this._writeDrivenNodes();
      return;
    }

    // Always advance animation time so clip timing / events stay correct
    // even on LOD-throttled frames.
    // Layers share the base clip's clock.
    const animDt = Math.min(dt, this.maxAnimDt);
    const { wrapped } = this._player.tick(animDt);
    if (wrapped) this._hasLastPelvis = false;

    // Four layered throttles, cheapest-first, each an early-out. Animation
    // time already advanced above, so every skip just freezes the rendered
    // pose at its last evaluated value - clip timing / events stay correct.
    //
    // 1. Manual escape hatch: caller-driven hard skip (fps-adaptive, etc).
    if (this.skipPose) return;

    // 2. Manual rate divider: do the heavy work every Nth call only.
    if (this.updateInterval > 1) {
      this._updateAccumDt += dt;
      if (++this._updateCounter < this.updateInterval) return;
      this._updateCounter = 0;
      this._updateAccumDt = 0;
    }

    // 3. Off-screen: skip skinning entirely (frustum gate). With root motion
    //    the pose places the body, so it is still evaluated and only the push
    //    is gated, below - else an off-screen body never walks into view.
    const gated = !this._drivenNodes;
    const placesBody = this._rootMotionMode !== 'off';
    if (gated && !placesBody && !this._skinning.anyVisible(this._cameraFrustum())) return;

    // 4. Distance LOD: throttle by camera distance (off by default; armature
    //    opts in via setAnimationLod). On throttled frames the pose stays
    //    frozen until the next due frame.
    this._lodFrameCounter++;
    const stride = this._lodStride();
    if (stride > 1 && this._lodFrameCounter % stride !== 0) return;

    this._resolveRigIndices();
    const order = this._evaluatedOrder;
    this._player.evaluate(this._currentPose);
    if (this._layers.size > 0) this._evaluateLayers(animDt);
    // Last word on the pose before the rig conventions clamp it and the
    // hierarchy is composed, so a modifier sees the fully blended animation and
    // cannot violate the pelvis / root clamps.
    if (this.poseModifier) this.poseModifier(this._currentPose, this);
    this._applyRigPostClamps();
    // Bone matrices stay current for attachments and pelvis reads; only the
    // per-splat push is worth skipping. Tested where root motion just put it.
    this._skeleton.applyLocal(this._currentPose, this.entity.getWorldTransform(), this._worldTransforms, order);
    if (gated && placesBody && !this._skinning.anyVisible(this._cameraFrustum())) return;

    // Reaching here means the pose is actually being pushed. Stamp the scene's
    // frame marker so pose-mirroring consumers (PixelartEffect's mask camera)
    // know a character moved this frame and a mask rebuild is warranted. On
    // throttled or off-screen frames we return early above and never stamp,
    // so the mask consumer can skip its rebuild entirely.
    if (this._scene) this._scene.characterPoseUpdatedFrame = this._scene.app.frame;

    // Sort LOD: independent of anim LOD, decides per-frame whether to skip
    // the expensive CPU sort re-upload. ORs with the manual `skipPositions`
    // flag so callers can hard-force a skip regardless of LOD bands.
    const skipPos = this.skipPositions || this._sortLodSkipThisFrame();
    this._skinning.pushTransforms(this._worldTransforms, this.entity.getWorldTransform(), skipPos);
    this._writeDrivenNodes(order);
  }

  // ── Internals ─────────────────────────────────────────────────

  /**
   * Resolve named rig conventions once skeleton library is available.
   * If `boneNames` is present, looks up "root" and any name containing
   * "pelvis" (or a Mixamo-style "Hips"); otherwise falls back to bone index 0
   * as root. The rig's own names win over the scene library's.
   */
  private _resolveRigIndices(): void {
    if (this._pelvisBoneIndex !== -2) return;
    this._rootBoneIndex = -1;
    this._pelvisBoneIndex = -1;
    const boneNames = this.armatureData.boneNames ?? this._scene?.skeletonLibrary?.boneNames;
    if (boneNames && boneNames.length > 0) {
      for (let i = 0; i < this.numBones; i++) {
        const name = boneNames[i]?.toLowerCase();
        if (!name) continue;
        if (name === 'root') this._rootBoneIndex = i;
        if (this._pelvisBoneIndex < 0 && isPelvisName(name)) this._pelvisBoneIndex = i;
      }
    } else {
      this._rootBoneIndex = 0;
    }
  }

  /**
   * Compose overlay layers onto `_currentPose`. Each layer ticks its own
   * player, evaluates a full pose into a scratch buffer, then per masked
   * bone interpolates the current pose toward the overlay by the layer
   * weight. Runs before `_applyRigPostClamps` so pelvis/root clamps stay
   * authoritative.
   */
  private _evaluateLayers(dt: number): void {
    const out = this._currentPose;
    const lp = out.positions, lr = out.rotations, ls = out.scales;
    const tmpQ = this._layerTmpQ;
    for (const [name, layer] of this._layers) {
      layer.player.tick(dt);
      layer.player.evaluate(layer.pose);

      if (layer.fadingOut) {
        layer.fadingOut.t += dt;
        const k = Math.min(1, layer.fadingOut.t / layer.fadingOut.duration);
        layer.weight = layer.fadingOut.from * (1 - k);
        if (k >= 1) { this._layers.delete(name); continue; }
      }
      const w = layer.weight;
      if (w <= 0) continue;

      const op = layer.pose.positions, or = layer.pose.rotations, os = layer.pose.scales;
      const mask = layer.mask;
      for (let i = 0; i < mask.length; i++) {
        const bi = mask[i];
        lp[bi].lerp(lp[bi], op[bi], w);
        tmpQ.copy(or[bi]);
        if (lr[bi].dot(tmpQ) < 0) tmpQ.mulScalar(-1);
        lr[bi].slerp(lr[bi], tmpQ, w);
        ls[bi].lerp(ls[bi], os[bi], w);
      }
    }
  }

  /**
   * Apply rig-convention rules to the freshly-evaluated pose:
   *   - root-motion routing - `'apply'` writes `baseline + (pelvis − bind)`
   *     to the entity; `'extract'` accumulates the per-frame pelvis Δ;
   *     `'off'` does nothing.
   *   - the {@link rootOffsetProvider} correction, composed on top of whatever
   *     routing produced.
   *   - pelvis X/Z clamp to bind in bone space (always - the motion lives on
   *     the entity / in the consumed delta, not on the bone).
   *   - pelvis-Y lock to bind (when {@link lockPelvisY} is set).
   *   - root-bone translation / scale clamp to bind.
   */
  private _applyRigPostClamps(): void {
    const bindT = this._skeleton.bindT;
    const pose = this._currentPose;
    const pelvisIdx = this._pelvisBoneIndex;
    const off = this.rootOffsetProvider
      ? this.rootOffsetProvider(this._player?.animationTime ?? 0)
      : null;

    if (pelvisIdx >= 0) {
      const pelvisPos = pose.positions[pelvisIdx];

      if (this._rootMotionMode === 'apply') {
        const base = this._baseLocalPosition;
        const o = this._pelvisOffsetToEntitySpace(
          pose,
          pelvisPos.x - bindT[pelvisIdx * 3],
          pelvisPos.z - bindT[pelvisIdx * 3 + 2],
        );
        const ox = o.x;
        const oz = o.z;
        if (off) {
          // Absolute write off the base every frame, so a per-frame offset can
          // never accumulate into itself.
          this.entity.setLocalPosition(base.x + ox + off.x, base.y + off.y, base.z + oz + off.z);
        } else {
          const cur = this.entity.getLocalPosition();
          this.entity.setLocalPosition(base.x + ox, cur.y, base.z + oz);
        }
      } else if (this._rootMotionMode === 'extract') {
        if (this._hasLastPelvis) {
          const d = this._pelvisOffsetToEntitySpace(
            pose,
            pelvisPos.x - this._lastPelvisPos.x,
            pelvisPos.z - this._lastPelvisPos.z,
          );
          this._rootMotionAccumDx += d.x;
          this._rootMotionAccumDz += d.z;
        }
        this._lastPelvisPos.copy(pelvisPos);
        this._hasLastPelvis = true;
      }
    }

    // 'off' / 'extract' leave the entity alone, so the offset is the only thing
    // writing it - still absolute, still off the base.
    if (off && this._rootMotionMode !== 'apply') {
      const base = this._baseLocalPosition;
      this.entity.setLocalPosition(base.x + off.x, base.y + off.y, base.z + off.z);
    }

    this._clampPoseToRigConventions(pose);
  }

  /**
   * Take a horizontal pelvis offset measured in BONE space and return it in the
   * entity's parent space, which is where {@link consumeRootMotionDelta} and the
   * `'apply'` entity write both promise to deliver it.
   *
   * The pelvis is a child of the root bone, so its parent-local X/Z live in the
   * root's frame, not the entity's. Those two frames coincide only while the
   * root's rotation is identity - which used to be guaranteed by the root clamp
   * resetting rotation, and is no longer: a clip whose root carries a yaw (every
   * MetaHuman GLB preset carries a constant 180°) now keeps it, so the offset has
   * to be rotated to stay in the frame the contract names. Rotating by identity
   * is a no-op, so clips whose root is identity - every `.anim` - route exactly
   * as before.
   *
   * Y is deliberately dropped on the way in: root motion is a ground-plane
   * concept here, and the caller only ever reads X/Z back out.
   *
   * Returns a reused scratch vector - read it immediately, do not retain.
   */
  private _pelvisOffsetToEntitySpace(pose: Pose, x: number, z: number): Vec3 {
    const out = this._rootMotionTmp.set(x, 0, z);
    const rootIdx = this._rootBoneIndex;
    if (rootIdx >= 0) pose.rotations[rootIdx].transformVector(out, out);
    return out;
  }

  /**
   * Pelvis X/Z (and optionally Y) plus root-bone clamps - the bone-space half of
   * the rig conventions, with no routing side effects. Shared by the live update
   * and by the probes, which must not move the entity.
   *
   * The root bone is pinned to its bind TRANSLATION and to unit scale, so a clip
   * cannot slide or resize the whole character behind the pelvis clamp's back:
   * root translation would move the character in world space without ever
   * showing up in the pelvis delta that root-motion routing measures, and the
   * "in-place" guarantee this method and the probes advertise would be a lie.
   *
   * Its ROTATION is deliberately left alone. A yaw on the root is orientation,
   * not motion - it is how a clip states which way the character faces, and it
   * is constant for the whole clip in every artifact we ship (all 57 MetaHuman
   * GLB presets carry exactly 180° about Y; every `.anim` carries identity).
   * Resetting it used to delete that statement and render preset clips facing
   * backwards. What the reset was really protecting - pelvis bone space and
   * entity space agreeing - is kept by {@link _pelvisOffsetToEntitySpace}
   * instead, which is the frame conversion the routing actually needed.
   */
  private _clampPoseToRigConventions(pose: Pose): void {
    const bindT = this._skeleton.bindT;
    const pelvisIdx = this._pelvisBoneIndex;
    const rootIdx = this._rootBoneIndex;

    if (pelvisIdx >= 0) {
      const pelvisPos = pose.positions[pelvisIdx];
      pelvisPos.x = bindT[pelvisIdx * 3];
      pelvisPos.z = bindT[pelvisIdx * 3 + 2];
      if (this._lockPelvisY) pelvisPos.y = bindT[pelvisIdx * 3 + 1];
    }

    if (rootIdx >= 0) {
      pose.positions[rootIdx].set(bindT[rootIdx * 3], bindT[rootIdx * 3 + 1], bindT[rootIdx * 3 + 2]);
      pose.scales[rootIdx].set(1, 1, 1);
    }
  }

  /**
   * Apply runtime bone scaling. Each entry scales a bone's flesh + segment in
   * its own frame - `{ along, width, thickness }` (each defaulting to `1`), or
   * a bare number for uniform scale. e.g. `{ thigh_l: { along: 1.3 }, calf_l:
   * { along: 1.3 } }` → a 1.3× longer left leg; `{ upperarm_l: { width: 1.4,
   * thickness: 1.4 } }` → a beefier arm. Bones not listed stay at `1`. Pass
   * `null` to clear. Works for any bone set (limbs, spine, …); see
   * {@link computeBoneStretch} for the model. Recompute only when factors
   * change - the result is applied every frame by the skeleton + skinning.
   */
  setBoneStretch(factors: Record<string, BoneScaleInput> | null): void {
    if (!factors) {
      this._skeleton.lengthScale = null;
      this._skinning?.setCovStretch(null);
      return;
    }
    const { lengthScale, covStretch, any } = computeBoneStretch(
      this._skeleton,
      this.rigBoneNames,
      factors,
    );
    this._skeleton.lengthScale = any ? lengthScale : null;
    this._skinning?.setCovStretch(any ? covStretch : null);
  }

  /** Push the current pose through skeleton + skinning. Called at link time. */
  private _pushPose(): void {
    if (!this._skinning) return;
    this._skeleton.applyLocal(this._currentPose, this.entity.getWorldTransform(), this._worldTransforms);
    this._skinning.pushTransforms(this._worldTransforms, this.entity.getWorldTransform());
    this._writeDrivenNodes();
  }

  /**
   * World transforms onto the driven nodes, parents first so each write reads
   * an already-placed parent. Rotation is taken scale-free; each node keeps its
   * own local scale.
   */
  private _writeDrivenNodes(bones?: Int32Array | null): void {
    const nodes = this._drivenNodes;
    if (!nodes) return;
    const count = bones ? bones.length : nodes.length;
    for (let k = 0; k < count; k++) {
      const i = bones ? bones[k] : k;
      const m = this._worldTransforms[i];
      nodes[i].setPosition(m.getTranslation(this._nodeTmpV));
      nodes[i].setRotation(this._nodeTmpQ.setFromMat4(m));
    }
  }

  private _cameraFrustum(): Frustum | undefined {
    const cam = this._scene?.cameraEntity?.camera as { frustum?: Frustum } | undefined;
    return cam?.frustum;
  }

  /**
   * Enable / configure distance-based animation LOD for THIS armature.
   * LOD is off by default (full rate); calling this is the opt-in.
   *
   * - **No args**: pull the scene's `animLodPreset` (set via
   *   `Scene.animLodPreset`). If the scene has no preset, fall back to a
   *   built-in default (full rate ≤12 m, every-2nd ≤24 m, every-4th
   *   beyond). Typical gameplay use: set the preset once, then call
   *   `armature.setAnimationLod()` on each throttle-able character.
   * - **Partial opts**: tweak individual knobs on top of current values.
   *
   * `nearDist` / `farDist` are world-space distances (m) from the camera;
   * `nearStride` / `farStride` are frames-per-update in the mid / far
   * bands. A stride of 1 means every frame.
   */
  setAnimationLod(opts?: {
    nearDist?: number;
    farDist?: number;
    nearStride?: number;
    farStride?: number;
  }): void {
    // No-arg form: seed from the scene preset (or the built-in fallback),
    // then continue so any explicit knobs below can still override.
    const resolved = opts ?? this._scene?.animLodPreset ?? DEFAULT_ANIM_LOD_PRESET;
    if (resolved.nearDist !== undefined) this._lodNearDist = resolved.nearDist;
    if (resolved.farDist !== undefined) this._lodFarDist = resolved.farDist;
    if (resolved.nearStride !== undefined) this._lodNearStride = Math.max(1, Math.floor(resolved.nearStride));
    if (resolved.farStride !== undefined) this._lodFarStride = Math.max(1, Math.floor(resolved.farStride));
  }

  /** Disable LOD throttling - every character animates at full rate
   *  regardless of distance (frustum cull still applies). */
  disableAnimationLod(): void {
    this._lodNearDist = Infinity;
    this._lodFarDist = Infinity;
  }

  /**
   * Enable / configure distance-based SORT LOD for THIS armature.
   *
   * Throttles only the CPU-side `splat.updatePositions` call (the dominant
   * cost - ~88% of per-character CPU at high counts) without freezing the
   * rendered pose. On throttled frames the GPU palette still uploads, so
   * animation looks correct; only the depth-sort order lags one frame.
   *
   * Composes with {@link setAnimationLod} - when anim LOD throttles a
   * frame, sort LOD is moot for that frame; when anim LOD evaluates, sort
   * LOD can independently decide to skip the positions push.
   *
   * Typical use: tighter near band than anim LOD (e.g. 5–10 m) so even
   * mid-distance characters skip the sort re-upload most frames.
   *
   * - **No args**: enable with a built-in default
   *   (nearDist=5, farDist=15, nearStride=2, farStride=4).
   * - **Partial opts**: tweak individual knobs on top of current values.
   */
  setSortLod(opts?: {
    nearDist?: number;
    farDist?: number;
    nearStride?: number;
    farStride?: number;
  }): void {
    const defaults = { nearDist: 5, farDist: 15, nearStride: 2, farStride: 4 };
    const resolved = opts ?? defaults;
    if (resolved.nearDist !== undefined) this._sortLodNearDist = resolved.nearDist;
    if (resolved.farDist !== undefined) this._sortLodFarDist = resolved.farDist;
    if (resolved.nearStride !== undefined) this._sortLodNearStride = Math.max(1, Math.floor(resolved.nearStride));
    if (resolved.farStride !== undefined) this._sortLodFarStride = Math.max(1, Math.floor(resolved.farStride));
  }

  /** Disable sort LOD - every character does the full updatePositions
   *  every frame (still gated by `skipPositions` and anim LOD). */
  disableSortLod(): void {
    this._sortLodNearDist = Infinity;
    this._sortLodFarDist = Infinity;
  }

  /** Frames-per-update for this armature this frame, based on camera
   *  distance. 1 = full rate. Returns 1 when no camera is available so
   *  we never freeze a character due to missing scene state. */
  private _lodStride(): number {
    const camEntity = this._scene?.cameraEntity;
    if (!camEntity) return 1;
    const camPos = camEntity.getPosition();
    // Entity world origin is a good-enough "where is this body" proxy for
    // a distance bucket - no need for the AABB center.
    const self = this.entity.getPosition();
    const dx = self.x - camPos.x;
    const dy = self.y - camPos.y;
    const dz = self.z - camPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq >= this._lodFarDist * this._lodFarDist) return this._lodFarStride;
    if (distSq >= this._lodNearDist * this._lodNearDist) return this._lodNearStride;
    return 1;
  }

  /** True when sort LOD says "skip the CPU positions re-upload this frame".
   *  Uses the same camera-distance bands shape as anim LOD, but a separate
   *  counter so the two strides don't lock-step. */
  private _sortLodSkipThisFrame(): boolean {
    const camEntity = this._scene?.cameraEntity;
    if (!camEntity) return false;
    const camPos = camEntity.getPosition();
    const self = this.entity.getPosition();
    const dx = self.x - camPos.x;
    const dy = self.y - camPos.y;
    const dz = self.z - camPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    let stride = 1;
    if (distSq >= this._sortLodFarDist * this._sortLodFarDist) stride = this._sortLodFarStride;
    else if (distSq >= this._sortLodNearDist * this._sortLodNearDist) stride = this._sortLodNearStride;
    if (stride <= 1) return false;
    this._sortLodFrameCounter++;
    return this._sortLodFrameCounter % stride !== 0;
  }
}

const _EMPTY_SET: Set<Splat> = new Set();

interface AnimationLayer {
  player: AnimationPlayer;
  mask: Int32Array;
  pose: Pose;
  snapshot: Pose;
  weight: number;
  fadingOut?: { from: number; t: number; duration: number };
}
