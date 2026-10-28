import { Quat, Vec3 } from 'playcanvas';

import { buildArmatureKeyframes } from '../anim/keyframe-splines';
import type { ArmatureKeyframeEntry } from '../anim/keyframe-splines';
import { fromRestRelative } from '../anim/rest-relative';
import type { BonePose } from '../anim/rest-relative';
import type { Animation, AnimationEvent } from '../animation';

import { Pose } from './pose';
import type { Skeleton } from './skeleton';

type KeyframeEntry = ArmatureKeyframeEntry | null;

// Global shared keyframe cache. buildArmatureKeyframes is pure and deterministic
// for a given (filtered Animation object, numBones, loop, REST POSE) tuple - all
// enemies on the same rig playing the same animation produce identical output, so
// we allocate once and share the arrays across every AnimationPlayer.
// WeakMap on the Animation object means entries are GC'd automatically when
// the animation is removed from the scene library.
//
// The rest pose is part of the key because the keyframes it builds are
// REST-RELATIVE (`toRestRelative`): a bone's stored delta is measured against
// the rest that was current at build time. Two characters can now disagree on
// that rest - `LoadCharacterOptions.restSource: 'bundled'` swaps in the
// per-character joints - so keying on bone count alone would hand a character
// deltas encoded against somebody else's rest, and `fromRestRelative` would
// decode them into a pose that is neither rig's. Identity, not contents: rest
// arrays are built once per armature and never mutated in place.
const _sharedKeyframeCache = new WeakMap<Animation, Map<string, Array<KeyframeEntry | null>>>();

// Stable per-object id, so the cache key can name a rest pose or bone list
// without hashing its arrays on every play() call.
let _nextObjectId = 0;
const _objectIds = new WeakMap<object, number>();
function objectId(obj: object | null | undefined): number {
  if (!obj) return -1;
  let id = _objectIds.get(obj);
  if (id === undefined) {
    id = _nextObjectId++;
    _objectIds.set(obj, id);
  }
  return id;
}

/**
 * Resolves an animation by name and returns an already-filtered/converted
 * {@link Animation}, or `null` if not registered. Lets {@link AnimationPlayer}
 * stay free of `Scene` and `SkeletonLibrary`.
 *
 * @group Characters & Animation
 */
export type AnimationProvider = (name: string) => Animation | null;

/**
 * Options for {@link AnimationPlayer.crossfadeTo}.
 *
 * @group Characters & Animation
 */
export interface CrossfadeOptions {
  /** Blend duration in seconds. Defaults to `defaultCrossfadeDuration`. */
  duration?: number;
  /** Loop the target animation. Default `true`. */
  loop?: boolean;
  /**
   * Preserve the current animation's normalized phase
   * (`animTime / numFrames`) when crossfading. Useful for "style change"
   * crossfades where the new looping animation should start at the same
   * cycle position as the outgoing one (e.g. switching idle variants
   * mid-cycle without a snap). Default `false` - new anim starts at
   * frame 0.
   */
  preserveTime?: boolean;
  /** Keep the outgoing clip moving during the blend. Interrupted blends use the visible pose. */
  continueSource?: boolean;
  /** Ease the blend weight at both ends. Default is linear for existing callers. */
  easing?: 'linear' | 'smoothstep';
}

/**
 * Callback fired when {@link AnimationPlayer.tick} crosses a frame that has
 * one or more {@link AnimationEvent}s on the active animation.
 *
 * @group Characters & Animation
 */
export type AnimEventCallback = (event: AnimationEvent) => void;

/**
 * Skeletal animation state machine. Owns playback state (current animation,
 * time, loop flag, crossfade window) and writes the per-bone target pose into
 * a caller-owned {@link Pose} each `update`.
 *
 * Knows nothing about splats, entities, or bone names. Output is a raw
 * crossfaded pose; rig-convention clamps (pelvis X/Z lock, root-bone clamp,
 * root-motion extraction onto the armature entity) are the
 * {@link Armature} facade's job.
 *
 * @group Characters & Animation
 */
export class AnimationPlayer {
  /** Default crossfade duration when {@link CrossfadeOptions.duration} is omitted. */
  defaultCrossfadeDuration = 0.08;
  /** Frame rate used to convert `dt` (seconds) to frame time. Default `30`. */
  frameRate = 30;
  /**
   * Playback-speed multiplier applied to `dt` in {@link tick}. `1` = author
   * speed, `2` = double speed, `0.5` = half. Unlike {@link frameRate} this
   * scales only how fast time advances - the clip's authored frame rate (and
   * thus event-frame mapping) is unchanged. Lets a game tie a locomotion
   * clip's speed to the entity's actual movement speed. Crossfade blending is
   * deliberately NOT sped up (it runs on real `dt`), so style swaps stay
   * smooth regardless of playback speed.
   */
  playbackSpeed = 1;

  private readonly _skeleton: Skeleton;
  private readonly _provider: AnimationProvider;

  private _active = false;
  private _animName: string | null = null;
  private _animData: Animation | null = null;
  private _keyframes: Array<KeyframeEntry | null> = [];
  private _keyframesReady = false;
  private _animTime = 0;
  private _loop = true;
  private _paused = false;
  private _blendToRest = false;

  private _crossfadeTime = 0;
  private _crossfadeDuration = 0;
  private readonly _snapshot: Pose;
  private _outgoing: AnimationPlayer | null = null;
  private _easing: 'linear' | 'smoothstep' = 'linear';

  private _lastTickFrame = -1;
  private readonly _eventListeners = new Set<AnimEventCallback>();

  // Per-instance cache removed - keyframes are now shared globally via
  // _sharedKeyframeCache; see _prepareKeyframes.

  // Scratch
  private readonly _tmpPos = new Vec3();
  private readonly _tmpRot = new Quat();
  private readonly _tmpScale = new Vec3();
  private readonly _tmpSlerpRot = new Quat();
  // The key on the low side of the current segment, boxed for `Quat.slerp`.
  private readonly _tmpKeyRot = new Quat();
  private readonly _tmpToRot = new Quat();
  private readonly _restIn: BonePose = { position: new Vec3(), rotation: new Quat(), scale: new Vec3() };
  private readonly _restOut: BonePose = { position: new Vec3(), rotation: new Quat(), scale: new Vec3() };
  private readonly _splineValues: number[] = [];
  private _bones: Int32Array | null = null;

  constructor(opts: { skeleton: Skeleton; animationProvider: AnimationProvider; snapshotPose: Pose }) {
    this._skeleton = opts.skeleton;
    this._provider = opts.animationProvider;
    this._snapshot = opts.snapshotPose;
  }

  // ── State accessors ───────────────────────────────────────────────

  /**
   * The bones {@link evaluate} writes, or `null` (the default) for all. Clips
   * convert keyframes for these bones only; the rest keep their last pose.
   */
  set bones(v: Int32Array | null) {
    this._bones = v;
    if (this._active && !this._blendToRest && this._animName) {
      const kf = this._prepareKeyframes(this._animName, this._loop);
      if (kf) this._keyframes = kf;
    }
  }

  get isPlaying(): boolean {
    return this._active;
  }

  get isFinished(): boolean {
    if (!this._active || !this._animData || this._loop || this._blendToRest) return false;
    const nf = this._animData.numFrames;
    return nf > 0 && this._animTime >= nf - 0.01;
  }

  get paused(): boolean {
    return this._paused;
  }
  set paused(v: boolean) {
    this._paused = v;
  }

  get animationTime(): number {
    return this._animTime;
  }
  set animationTime(v: number) {
    this._animTime = v;
    if (this._animData) {
      const nf = this._animData.numFrames;
      if (nf > 0) {
        if (this._loop) {
          while (this._animTime >= nf) this._animTime -= nf;
          while (this._animTime < 0) this._animTime += nf;
        } else {
          this._animTime = Math.max(0, Math.min(this._animTime, nf - 0.001));
        }
      }
    }
  }

  get animationDuration(): number {
    return this._animData?.numFrames ?? 0;
  }

  /**
   * Crossfade alpha in `[0, 1]`. `0` when no crossfade is active or one just
   * started; `1` when the in-progress crossfade has reached its terminal
   * blend. Useful for games that want to gate logic on "the rig has fully
   * committed to the new pose" without reaching into player internals.
   */
  get crossfadeProgress(): number {
    if (this._crossfadeDuration <= 0) return 0;
    return Math.min(1, this._crossfadeTime / this._crossfadeDuration);
  }

  /**
   * Name of the currently-playing animation, or `null` if no animation is
   * active (after {@link AnimationPlayer.stop} with `fadeDuration: 0`, or
   * before the first {@link AnimationPlayer.play}).
   */
  get currentAnimationName(): string | null {
    return this._animName;
  }

  // ── Event dispatch ────────────────────────────────────────────────

  /**
   * Subscribe to frame-aligned {@link AnimationEvent}s on the currently-
   * playing animation. The callback fires once per crossed frame, after the
   * `tick` advances `animTime`.
   *
   * @returns an unsubscribe handle.
   */
  onAnimEvent(cb: AnimEventCallback): () => void {
    this._eventListeners.add(cb);
    return () => { this._eventListeners.delete(cb); };
  }

  private _dispatchEventsForFrameTransition(prevFrame: number, curFrame: number, wrapped: boolean, nf: number): void {
    if (this._eventListeners.size === 0) return;
    const events = this._animData?.events;
    if (!events || events.length === 0) return;
    if (curFrame === prevFrame) return;

    if (wrapped) {
      // Looping anim wrapped: fire events from prevFrame+1..nf-1, then 0..curFrame.
      for (const e of events) if (e.frame > prevFrame && e.frame < nf) this._fireEvent(e);
      for (const e of events) if (e.frame >= 0 && e.frame <= curFrame) this._fireEvent(e);
    } else if (curFrame > prevFrame) {
      // Normal forward step.
      for (const e of events) if (e.frame > prevFrame && e.frame <= curFrame) this._fireEvent(e);
    }
  }

  private _fireEvent(e: AnimationEvent): void {
    for (const cb of this._eventListeners) {
      try { cb(e); } catch (err) {
        // Don't let one listener's throw stop the rest.
        // eslint-disable-next-line no-console
        console.error('[AnimationPlayer] event listener threw:', err);
      }
    }
  }

  // ── Playback verbs ────────────────────────────────────────────────

  /**
   * Start an animation immediately (no crossfade). Restarts from frame 0.
   * Returns `false` if `name` isn't resolvable through the provider.
   */
  play(name: string, opts?: { loop?: boolean }): boolean {
    const loop = opts?.loop ?? true;

    if (this._active && !this._blendToRest && this._animName === name && this._loop === loop) {
      return true;
    }

    const kf = this._prepareKeyframes(name, loop);
    if (!kf) return false;

    this._outgoing = null;
    this._activate(name, kf, loop, 0);
    this._crossfadeTime = 0;
    this._crossfadeDuration = 0;
    return true;
  }

  /**
   * Crossfade from `currentPose` to `name` over `opts.duration` seconds. The
   * current pose is captured into the internal snapshot - caller can keep
   * mutating `currentPose` after the call returns.
   */
  crossfadeTo(name: string, currentPose: Pose, opts?: CrossfadeOptions): boolean {
    const duration = opts?.duration ?? this.defaultCrossfadeDuration;
    const loop = opts?.loop ?? true;
    const preserveTime = opts?.preserveTime ?? false;

    if (this._active && !this._blendToRest && this._animName === name && this._loop === loop) {
      return true;
    }

    const kf = this._prepareKeyframes(name, loop);
    if (!kf) return false;

    let startTime = 0;
    if (preserveTime && this._active && !this._blendToRest && this._animData && this._loop) {
      const prevNf = this._animData.numFrames;
      const newAnim = this._provider(name);
      if (prevNf > 0 && newAnim && newAnim.numFrames > 0) {
        const phase = (this._animTime % prevNf) / prevNf;
        startTime = phase * newAnim.numFrames;
      }
    }

    // Only continue an unblended source. On interruption, capture the actual
    // displayed mixture so an obsolete source can never pop back into view.
    const source = opts?.continueSource && this._active && !this._blendToRest
      && this._animName && this._crossfadeTime >= this._crossfadeDuration
      ? new AnimationPlayer({ skeleton: this._skeleton, animationProvider: this._provider,
        snapshotPose: new Pose(this._skeleton.numBones) }) : null;
    if (source && this._animName) {
      source._activate(this._animName, this._keyframes, this._loop, this._animTime);
      source.frameRate = this.frameRate;
      source.playbackSpeed = this.playbackSpeed;
      source.paused = this.paused;
      source._bones = this._bones;
    }
    this._outgoing = source;
    this._easing = opts?.easing ?? 'linear';
    this._snapshot.copyFrom(currentPose);
    this._crossfadeTime = 0;
    this._crossfadeDuration = duration;
    this._activate(name, kf, loop, startTime);
    return true;
  }

  /**
   * Evaluate the active animation at an explicit `frameTime` into `outPose`,
   * with no crossfade blending, and leave every scrap of playback state exactly
   * as it was - current time, crossfade window, loop flag, event cursor.
   *
   * This is the read-only probe a caller needs to sweep a clip for precompute
   * (foot heights, root paths, a loop-start pose) while it keeps playing.
   * {@link AnimationPlayer.evaluate} cannot serve: it reads the live time and
   * folds in whatever blend is in flight.
   *
   * Returns `false` when nothing is active or keyframes are not ready.
   */
  evaluateAt(frameTime: number, outPose: Pose): boolean {
    if (!this._active || this._blendToRest || !this._keyframesReady) return false;

    const savedTime = this._animTime;
    this._animTime = frameTime;

    const numBones = this._skeleton.numBones;
    const bindT = this._skeleton.bindT;
    const bindR = this._skeleton.bindR;
    const lp = outPose.positions;
    const lr = outPose.rotations;
    const ls = outPose.scales;

    for (let bi = 0; bi < numBones; bi++) {
      this._evalTargetPose(bi, bindT, bindR, lp[bi], lr[bi], ls[bi]);
    }

    this._animTime = savedTime;
    return true;
  }

  /**
   * Snap any active crossfade to its terminal state (alpha = 1, target pose
   * fully applied) on the next {@link AnimationPlayer.evaluate}. No-op if no
   * crossfade is active. Useful when a game scrubs through animation frames
   * for precompute and wants per-frame poses without the blend artefacts of
   * a still-in-progress crossfade.
   */
  endCrossfade(): void {
    if (this._crossfadeDuration > 0) {
      this._crossfadeTime = this._crossfadeDuration;
    }
  }

  /**
   * Stop playback. With `fadeDuration > 0`, snapshots `currentPose` and
   * crossfades back to bind over `fadeDuration` seconds. With `0`, deactivates
   * immediately (the caller is expected to reset the pose to bind).
   */
  stop(currentPose: Pose, fadeDuration = 0): void {
    this._outgoing = null;
    this._easing = 'linear';
    if (fadeDuration > 0 && this._active) {
      this._snapshot.copyFrom(currentPose);
      this._crossfadeTime = 0;
      this._crossfadeDuration = fadeDuration;
      this._blendToRest = true;
      return;
    }
    this._deactivate();
  }

  // ── Per-frame update ──────────────────────────────────────────────

  /**
   * Advance animation time by `dt` seconds. Always cheap - call every frame
   * even for off-screen characters so they resume at the correct frame when
   * the camera pans back. Does **not** write to any `Pose`.
   *
   * Returns `wrapped: true` if `animTime` rolled past the end of a looping
   * animation on this tick. The facade uses that signal to suppress the
   * end-to-start pelvis discontinuity when extracting root motion.
   */
  tick(dt: number): { wrapped: boolean } {
    let wrapped = false;
    if (this._active && !this._paused && !this._blendToRest && this._animData && this._keyframesReady) {
      const prevFrame = this._lastTickFrame;
      this._animTime += dt * this.frameRate * this.playbackSpeed;
      const nf = this._animData.numFrames;
      if (nf > 0) {
        if (this._loop) {
          while (this._animTime >= nf) {
            this._animTime -= nf;
            wrapped = true;
          }
        } else if (this._animTime >= nf) {
          this._animTime = nf - 0.001;
        }
      }
      const curFrame = Math.floor(this._animTime);
      this._dispatchEventsForFrameTransition(prevFrame, curFrame, wrapped, nf);
      this._lastTickFrame = curFrame;
    }
    this._outgoing?.tick(dt);
    this._crossfadeTime += dt;
    return { wrapped };
  }

  /**
   * Evaluate the current pose at the current `animTime` into `outPose`,
   * applying the crossfade blend with the internal snapshot if one is active.
   *
   * Returns `blendToRestComplete: true` once on the tick a previously-
   * scheduled `stop(_, fade > 0)` reaches alpha 1 - the facade uses that to
   * snap pose to bind and reset rootMotion baseline.
   *
   * Skip this call when the character is off-screen; `tick` keeps time
   * advancing in the meantime, so the next on-screen frame evaluates straight
   * to the correct pose with no visible pop. Only {@link bones} are written.
   */
  evaluate(outPose: Pose): { blendToRestComplete: boolean } {
    const progress = this._crossfadeDuration > 0
      ? Math.min(1, this._crossfadeTime / this._crossfadeDuration)
      : 1;
    const alpha = this._easing === 'smoothstep' ? progress * progress * (3 - 2 * progress) : progress;
    const inCrossfade = progress < 1;
    if (inCrossfade) this._outgoing?.evaluate(this._snapshot);
    else this._outgoing = null;

    const numBones = this._skeleton.numBones;
    const bindT = this._skeleton.bindT;
    const bindR = this._skeleton.bindR;
    const lp = outPose.positions;
    const lr = outPose.rotations;
    const ls = outPose.scales;
    const fp = this._snapshot.positions;
    const fr = this._snapshot.rotations;
    const fs = this._snapshot.scales;
    const tPos = this._tmpPos;
    const tRot = this._tmpRot;
    const tScale = this._tmpScale;
    const toRot = this._tmpToRot;

    const bones = this._bones;
    const count = bones ? bones.length : numBones;
    if (inCrossfade) {
      for (let k = 0; k < count; k++) {
        const bi = bones ? bones[k] : k;
        this._evalTargetPose(bi, bindT, bindR, tPos, tRot, tScale);
        lp[bi].lerp(fp[bi], tPos, alpha);
        toRot.copy(tRot);
        if (fr[bi].dot(toRot) < 0) toRot.mulScalar(-1);
        lr[bi].slerp(fr[bi], toRot, alpha);
        ls[bi].lerp(fs[bi], tScale, alpha);
      }
    } else {
      for (let k = 0; k < count; k++) {
        const bi = bones ? bones[k] : k;
        this._evalTargetPose(bi, bindT, bindR, lp[bi], lr[bi], ls[bi]);
      }
    }

    const blendToRestComplete = this._blendToRest && alpha >= 1;
    if (blendToRestComplete) this._deactivate();
    return { blendToRestComplete };
  }

  // ── Internals ────────────────────────────────────────────────────

  private _activate(name: string, kf: KeyframeEntry[], loop: boolean, startTime = 0): void {
    this._active = true;
    this._blendToRest = false;
    this._animName = name;
    this._animData = this._provider(name);
    this._keyframes = kf;
    this._keyframesReady = true;
    this._animTime = startTime;
    this._loop = loop;
    // Frame transition tracking restarts at the activation frame so the first
    // tick after activation doesn't fire all events from frame 0 in one go.
    this._lastTickFrame = Math.floor(startTime);
  }

  private _deactivate(): void {
    this._outgoing = null;
    this._active = false;
    this._blendToRest = false;
    this._animName = null;
    this._animData = null;
    this._keyframesReady = false;
    this._animTime = 0;
    this._lastTickFrame = -1;
  }

  private _prepareKeyframes(name: string, loop: boolean): Array<KeyframeEntry | null> | null {
    const animData = this._provider(name);
    if (!animData) {
      // eslint-disable-next-line no-console
      console.warn(`[AnimationPlayer] Animation "${name}" not found`);
      return null;
    }
    const store = animData.skeletalStore;
    if (!store) {
      // eslint-disable-next-line no-console
      console.warn(`[AnimationPlayer] Animation "${name}" has no keyframes`);
      return null;
    }

    // Global cache: all players on the same filtered Animation object + same
    // bone count produce identical buildArmatureKeyframes output, so one build
    // is shared across every enemy of the same rig type.
    const bonesKey = this._bones ? `:${objectId(this._bones)}` : '';
    const innerKey = `${this._skeleton.numBones}:${loop ? 1 : 0}:${objectId(this._skeleton.restPose)}${bonesKey}`;
    let perAnim = _sharedKeyframeCache.get(animData);
    if (!perAnim) {
      perAnim = new Map();
      _sharedKeyframeCache.set(animData, perAnim);
    }
    let kf = perAnim.get(innerKey);
    if (!kf) {
      // `translationMask` needs no place in `innerKey`: the cache is keyed by
      // the Animation object itself, and an Animation's mask is set once at
      // parse time and never mutated, so one object can never present two
      // different masks. `filterAnimationForArmature` produces a *new*
      // Animation with its own remapped mask, which is a different cache key.
      kf = buildArmatureKeyframes(
        store.keyframes,
        animData.numFrames,
        this._skeleton.numBones,
        this._skeleton.restPose,
        loop,
        animData.translationMask,
        this._bones,
      );
      perAnim.set(innerKey, kf);
    }
    return kf;
  }

  private _evalTargetPose(
    boneIdx: number,
    bindT: Float32Array,
    bindR: Float32Array,
    outPos: Vec3,
    outRot: Quat,
    outScale: Vec3,
  ): void {
    if (!this._active || !this._keyframesReady || this._blendToRest) {
      outPos.set(bindT[boneIdx * 3], bindT[boneIdx * 3 + 1], bindT[boneIdx * 3 + 2]);
      outRot.set(bindR[boneIdx * 4], bindR[boneIdx * 4 + 1], bindR[boneIdx * 4 + 2], bindR[boneIdx * 4 + 3]);
      outScale.set(1, 1, 1);
      return;
    }

    const entry = this._keyframes[boneIdx];
    const numKeys = entry ? entry.frames.length : 0;
    if (entry && numKeys > 1) {
      this._evaluateSpline(entry, this._animTime, outPos, outRot, outScale);
      this._applyFromRest(boneIdx, outPos, outRot, outScale, outPos, outRot, outScale);
    } else if (entry && numKeys === 1) {
      // Constant bone: its one key IS the pose, so decode it in place.
      outPos.set(entry.positions[0], entry.positions[1], entry.positions[2]);
      outRot.set(entry.rotations[0], entry.rotations[1], entry.rotations[2], entry.rotations[3]);
      outScale.set(entry.scales[0], entry.scales[1], entry.scales[2]);
      this._applyFromRest(boneIdx, outPos, outRot, outScale, outPos, outRot, outScale);
    } else {
      outPos.set(bindT[boneIdx * 3], bindT[boneIdx * 3 + 1], bindT[boneIdx * 3 + 2]);
      outRot.set(bindR[boneIdx * 4], bindR[boneIdx * 4 + 1], bindR[boneIdx * 4 + 2], bindR[boneIdx * 4 + 3]);
      outScale.set(1, 1, 1);
    }
  }

  private _evaluateSpline(
    entry: NonNullable<KeyframeEntry>,
    frameTime: number,
    outPos: Vec3,
    outRot: Quat,
    outScale: Vec3,
  ): void {
    const { frames, positions, rotations, scales } = entry;

    let low = 0;
    let high = frames.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (frames[mid] === frameTime) {
        const m3 = mid * 3;
        const m4 = mid * 4;
        outPos.set(positions[m3], positions[m3 + 1], positions[m3 + 2]);
        outRot.set(rotations[m4], rotations[m4 + 1], rotations[m4 + 2], rotations[m4 + 3]);
        outScale.set(scales[m3], scales[m3 + 1], scales[m3 + 2]);
        return;
      }
      if (frames[mid] < frameTime) low = mid + 1;
      else high = mid - 1;
    }

    const i1 = Math.min(Math.max(low, 1), frames.length - 1);
    const i0 = i1 - 1;
    const a3 = i0 * 3;
    const a4 = i0 * 4;
    const b3 = i1 * 3;
    const b4 = i1 * 4;
    const span = Math.max(1e-5, frames[i1] - frames[i0]);
    const t = Math.min(Math.max((frameTime - frames[i0]) / span, 0), 1);

    const q0 = this._tmpKeyRot;
    q0.set(rotations[a4], rotations[a4 + 1], rotations[a4 + 2], rotations[a4 + 3]);
    const sr = this._tmpSlerpRot;
    sr.set(rotations[b4], rotations[b4 + 1], rotations[b4 + 2], rotations[b4 + 3]);
    if (q0.dot(sr) < 0) sr.mulScalar(-1);
    outRot.slerp(q0, sr, t);

    if (entry.spline) {
      // i0 indexes the same keyframe in the spline's times array (plus any
      // ghost-entry offset for looping splines). Skip the spline's own segment
      // search - we already found the segment above.
      entry.spline.evaluateSegment(i0 + entry.spline.keyframeOffset, t, this._splineValues);
      const v = this._splineValues;
      const cl = (val: number, a: number, b: number) =>
        Math.min(Math.max(val, Math.min(a, b)), Math.max(a, b));
      outPos.set(
        cl(v[0], positions[a3], positions[b3]),
        cl(v[1], positions[a3 + 1], positions[b3 + 1]),
        cl(v[2], positions[a3 + 2], positions[b3 + 2]),
      );
      outScale.set(
        cl(v[7], scales[a3], scales[b3]),
        cl(v[8], scales[a3 + 1], scales[b3 + 1]),
        cl(v[9], scales[a3 + 2], scales[b3 + 2]),
      );
      return;
    }
    outPos.set(
      positions[a3] + (positions[b3] - positions[a3]) * t,
      positions[a3 + 1] + (positions[b3 + 1] - positions[a3 + 1]) * t,
      positions[a3 + 2] + (positions[b3 + 2] - positions[a3 + 2]) * t,
    );
    outScale.set(
      scales[a3] + (scales[b3] - scales[a3]) * t,
      scales[a3 + 1] + (scales[b3 + 1] - scales[a3 + 1]) * t,
      scales[a3 + 2] + (scales[b3 + 2] - scales[a3 + 2]) * t,
    );
  }

  private _applyFromRest(
    boneIdx: number,
    srcPos: Vec3, srcRot: Quat, srcScale: Vec3,
    outPos: Vec3, outRot: Quat, outScale: Vec3,
  ): void {
    this._restIn.position = srcPos;
    this._restIn.rotation = srcRot;
    this._restIn.scale = srcScale;
    this._restOut.position = outPos;
    this._restOut.rotation = outRot;
    this._restOut.scale = outScale;
    fromRestRelative(boneIdx, this._restIn, this._skeleton.restPose, this._restOut);
  }
}
