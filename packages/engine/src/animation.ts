import { convertSkeletalAnimation } from './anim/animation-conversion';
import { CONSTANT_TRANSLATION_EPS, parseArmatureGlbAnimation } from './loader/animation/animation-glb';
import { cachedFetch } from './loader/shared/bin-cache';
import type { Scene } from './scene';

/**
 * A frame-aligned event attached to an {@link Animation}. Events are fired by
 * {@link AnimationPlayer} as `animTime` crosses each `frame`, dispatched
 * through {@link Armature.onAnimEvent} / {@link Character.onAnimEvent}.
 *
 * The engine treats `name` and `payload` as opaque - games define their own
 * vocabulary (e.g. `'footstep'`, `'hit-impact'`, `'screen-shake'`) and route
 * via the listener.
 *
 * @group Characters & Animation
 */
export interface AnimationEvent {
  /** Frame index (integer, `0 .. numFrames-1`). */
  frame: number;
  /** Game-defined event name. */
  name: string;
  /** Optional game-defined payload, opaque to the engine. */
  payload?: unknown;
}

/**
 * One bone's keys inside a {@link SkeletalStore}, ascending by frame. Flat
 * arrays because a clip can hold ~135k keys. Read-only: cached copies of a
 * clip share them.
 * @internal
 */
export interface SkeletalKeyframeEntry {
  /** Frame per key. `length` is the key count. */
  frames: Float32Array;
  /** `[x,y,z]` per key. */
  positions: Float32Array;
  /** `[x,y,z,w]` per key. */
  rotations: Float32Array;
  /** `[x,y,z]` per key. */
  scales: Float32Array;
}

/**
 * Per-bone keys of an {@link Animation}: read from a GLB, or converted from
 * `.anim` matrices by {@link convertSkeletalAnimation}. Playback reads these,
 * not `data`.
 *
 * @internal
 */
export interface SkeletalStore {
  keyframes: Map<number, SkeletalKeyframeEntry>;
  manualBones: Set<number>;
  source: string;
}

/** Private converted source; never registered or used as a playback-cache key. */
type ConvertedSource = Pick<Animation,
  'numFrames' | 'numBones' | 'keyframeFrames' | 'translationMask' | 'events' | 'skeletalStore'>;

/**
 * Expand Float16 (IEEE 754 half-precision) stored as Uint16 into Float32.
 */
function float16ToFloat32(u16: Uint16Array): Float32Array {
  const out = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i];
    const sign = (h >>> 15) & 0x1;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;

    let val: number;
    if (exp === 0) {
      val = mant === 0 ? 0 : 5.960464477539063e-8 * mant;
    } else if (exp === 31) {
      val = mant === 0 ? Infinity : NaN;
    } else {
      val = Math.pow(2, exp - 15) * (1 + mant / 1024);
    }
    out[i] = sign ? -val : val;
  }
  return out;
}

/**
 * Element offset of the translation inside one packed column-major 4x4 bone
 * matrix: the layout `convertSkeletalAnimation` reads back with
 * `Mat4.getTranslation`, which is `data[12..14]`.
 */
const MATRIX_TRANSLATION = 12;

/**
 * Derive {@link Animation.translationMask} from decoded `.anim` matrices.
 *
 * Same question the armature-GLB reader asks of its translation channels, asked
 * of the same quantity in its other storage form: does this bone's translation
 * *move* over the clip? A track that holds still is not motion, it is the source
 * rig stating its own bone length, and the target character's rest must win.
 *
 * A `.anim` frame carries a full local matrix per bone, so every bone always has
 * a translation and the "channel absent" half of the GLB test has no analogue
 * here, so constancy is the whole test. On our own clips it lands on the pelvis
 * alone for a body rig, and on the pelvis plus the translation-driven face for a
 * facial rig, without naming a single bone.
 *
 * Sparse clips are scanned on `keyframeFrames` only, matching the frames
 * `convertSkeletalAnimation` converts; the gaps between keyframes hold nothing
 * anyone reads.
 *
 * Degenerate clips fall out of the same rule rather than being special-cased: a
 * single-frame clip, or one where nothing translates at all, has no evidence of
 * motion anywhere, so every bone reads as a rest declaration and the whole mask
 * is `0`. The pose still plays, and every bone length comes from the character.
 * Returns `undefined` when every bone genuinely translates, which is the "drive
 * them all" the mask's absence has always meant.
 */
function deriveTranslationMask(
  data: Float32Array,
  numFrames: number,
  numBones: number,
  keyframeFrames?: number[],
): Uint8Array | undefined {
  const frames = keyframeFrames?.length
    ? keyframeFrames.filter((f) => f >= 0 && f < numFrames)
    : Array.from({ length: numFrames }, (_, i) => i);
  if (numBones === 0 || frames.length === 0) return undefined;
  // A pre-converted clip carries its poses in `skeletalStore` and an EMPTY data
  // array (`filterAnimationForArmature`). Reading it would compare `undefined`s,
  // every comparison would be false, and the clip would come back "nothing
  // translates" - freezing every bone at rest. No data means no evidence, which
  // is `undefined`, not an all-rest mask.
  if (data.length === 0) return undefined;

  const mask = new Uint8Array(numBones);
  let restBones = 0;
  for (let bone = 0; bone < numBones; bone++) {
    const first = (frames[0] * numBones + bone) * 16 + MATRIX_TRANSLATION;
    const x = data[first];
    const y = data[first + 1];
    const z = data[first + 2];
    let varies = false;
    for (let i = 1; i < frames.length; i++) {
      const o = (frames[i] * numBones + bone) * 16 + MATRIX_TRANSLATION;
      if (Math.abs(data[o] - x) > CONSTANT_TRANSLATION_EPS
        || Math.abs(data[o + 1] - y) > CONSTANT_TRANSLATION_EPS
        || Math.abs(data[o + 2] - z) > CONSTANT_TRANSLATION_EPS) {
        varies = true;
        break;
      }
    }
    if (varies) mask[bone] = 1;
    else restBones++;
  }
  return restBones === 0 ? undefined : mask;
}

/**
 * Parsed skeletal animation data.
 *
 * An `Animation` is the deserialized form of one clip, whatever it was
 * authored as: per-bone position, rotation and scale keys. Once loaded onto a
 * scene under a name, characters can play it via
 * {@link Character.playAnimation} / {@link Character.crossfadeTo}.
 *
 * The primary entry point is {@link Animation.loadGlb}, which fetches a
 * MetaHuman GLB, parses and registers it in one call. For custom fetch
 * pipelines, use {@link Animation.fromGlb} on an already-fetched
 * `ArrayBuffer`, then {@link Animation#register} to attach it to the scene.
 * The `.anim` container is still read, by {@link Animation.load} and
 * {@link Animation.parse}.
 *
 * @group Characters & Animation
 */
export class Animation {
  /** Column-major bone matrices (translation at `[12..14]`, the layout
   *  PlayCanvas's `Mat4.data` uses), length `numFrames * numBones * 16`.
   *  Empty for a GLB clip and once registered. */
  data: Float32Array;
  /** Number of animation frames. */
  numFrames: number;
  /** Number of bones per frame. */
  numBones: number;
  /** Optional sparse keyframe indices. If present, frames between keyframes are interpolated. */
  keyframeFrames?: number[];
  /**
   * Per bone: `1` if this clip drives the bone's translation, `0` if the bone
   * must keep the armature's own rest translation.
   *
   * A constant translation track is not motion - it is the source rig's bone
   * length. Applied to a character whose skeleton differs, it silently replaces
   * that character's bone lengths mid-clip while the bind pose keeps the
   * originals, which compresses the skin. Both readers are built with that in
   * mind and set a `0` for every bone whose translation holds still, judged from
   * the decoded data: {@link Animation.fromGlb} per channel, {@link Animation.parse}
   * across the per-frame matrices. `undefined` means every bone genuinely
   * translates, and every bone drives its own translation.
   *
   * Set once, at parse time, and never mutated afterwards. Playback caches
   * keyframes per `Animation` object, so a mask that could change would go stale
   * inside them. `filterAnimationForArmature` remaps rather than edits, onto a
   * new `Animation` that is its own cache key.
   *
   * Consumed by `buildArmatureKeyframes`, which zeroes the position delta for
   * masked bones so `fromRestRelative` yields `pose.position = restPosition`.
   */
  translationMask?: Uint8Array;
  /**
   * Frame-aligned events fired as `animTime` advances. Set by
   * {@link Animation.parse} from the `.anim` header's optional `events` array,
   * or assigned directly by game code before {@link Animation.register}.
   */
  events?: AnimationEvent[];
  /** @internal Set by convertSkeletalAnimation on first registration. */
  skeletalConverted = false;
  /** @internal Per-bone keyframe cache produced by convertSkeletalAnimation. */
  skeletalStore?: SkeletalStore;
  /** @internal Per-target-bone-count cache of `filterAnimationForArmature` outputs. */
  filteredForBones?: Map<number, Animation>;

  constructor(data: Float32Array, numFrames: number, numBones: number, keyframeFrames?: number[]) {
    this.data = data;
    this.numFrames = numFrames;
    this.numBones = numBones;
    this.keyframeFrames = keyframeFrames;
    // Derived HERE, not at each call site, so "an Animation knows which bones it
    // actually drives" holds by construction. It was previously set only by
    // `parse` and `fromGlb`, which left the `.bin`-embedded clip built in
    // `Character._buildFromLoadResult` with no mask at all - under
    // `restSource: 'bundled'` that clip silently reimposed the canonical bone
    // lengths on a character whose bind is its own.
    //
    // Callers that know better still override on the next line: `fromGlb` has
    // the real glTF channel list (a channel that is absent differs from one
    // whose keys happen to be equal), and `filterAnimationForArmature` remaps
    // the source mask through its bone mapping. Both assign unconditionally, so
    // this pass is at worst redundant for them, never wrong.
    this.translationMask = deriveTranslationMask(data, numFrames, numBones, keyframeFrames);
  }

  /**
   * Parse an in-memory `.anim` buffer.
   *
   * Accepts both v2 (float32) and v3 (float16) data encodings. Use this when
   * fetching through a custom pipeline; pair with {@link Animation#register}
   * to make the result playable. Otherwise prefer {@link Animation.load}, the
   * fetching wrapper around this one. For a MetaHuman GLB, the current
   * container, the pair is {@link Animation.fromGlb} / {@link Animation.loadGlb}.
   *
   * Also derives {@link Animation#translationMask} from the decoded matrices, so
   * bones whose translation never moves keep the *target* character's bone
   * lengths instead of the source rig's.
   *
   * @throws If the header is missing, malformed, or not of type `skeletal_animation`.
   */
  static parse(buffer: ArrayBuffer): Animation {
    const view = new DataView(buffer);
    const headerLength = view.getUint32(0, true);

    if (headerLength > 10000 || headerLength > buffer.byteLength - 4) {
      throw new Error(`Invalid animation file: header length ${headerLength} out of range`);
    }

    const headerBytes = new Uint8Array(buffer, 4, headerLength);
    const headerJson = new TextDecoder().decode(headerBytes);

    let header: {
      type?: string;
      version?: number;
      numFrames: number;
      numBones: number;
      dataType?: string;
      keyframeFrames?: number[];
      events?: AnimationEvent[];
    };
    try {
      header = JSON.parse(headerJson);
    } catch {
      throw new Error('Invalid animation file: header is not valid JSON');
    }

    if (header.type !== 'skeletal_animation') {
      throw new Error(`Invalid animation type: '${header.type}'`);
    }

    const dataOffset = 4 + headerLength;
    const dataLength = buffer.byteLength - dataOffset;
    if (dataLength <= 0) throw new Error('Animation file has no data');

    const dataBytes = new Uint8Array(buffer, dataOffset, dataLength);
    const alignedBuffer = new ArrayBuffer(dataLength);
    new Uint8Array(alignedBuffer).set(dataBytes);

    let animData: Float32Array;
    if (header.dataType === 'float16') {
      animData = float16ToFloat32(new Uint16Array(alignedBuffer));
    } else {
      animData = new Float32Array(alignedBuffer);
    }

    // The constructor derives `translationMask` from exactly these arguments.
    const anim = new Animation(animData, header.numFrames, header.numBones, header.keyframeFrames);
    if (Array.isArray(header.events) && header.events.length > 0) {
      anim.events = header.events;
    }
    return anim;
  }

  /**
   * Parse an in-memory *MetaHuman GLB* - a glTF 2.0 binary holding a bone
   * hierarchy and one animation clip, carrying no real geometry (as produced
   * by the offline MetaHuman GLB exporter).
   *
   * Reads the clip's parent-local TRS into the same per-bone keys a `.anim`
   * is converted to, so both play identically. `data` stays empty.
   *
   * `animationName` selects a clip by name when the GLB holds more than one;
   * omitted, the first clip is used. Pair with {@link Animation#register} to
   * make the result playable, or use {@link Animation.loadGlb}.
   *
   * @throws If the container is not GLB 2.0, or the clip does not supply a
   * translation and a rotation channel for every bone on one shared timeline.
   */
  static fromGlb(buffer: ArrayBuffer, animationName?: string): Animation {
    const parsed = parseArmatureGlbAnimation(buffer, animationName);
    if (Math.abs(parsed.frameRate - 30) > 0.5) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Animation] GLB "${parsed.animationName}" is authored at ${parsed.frameRate.toFixed(2)} fps; ` +
        'playback is frame-indexed and defaults to 30 - set `armature.frameRate` to match.',
      );
    }
    const animation = new Animation(new Float32Array(0), parsed.numFrames, parsed.numBones);
    animation.translationMask = parsed.translationMask;
    animation.skeletalStore = { keyframes: parsed.keyframes, manualBones: new Set(), source: 'imported' };
    animation.skeletalConverted = true;
    return animation;
  }

  /**
   * Fetch, parse, and register a `.anim` file on the scene under `name`.
   * Loaded keys are shared read-only; metadata and registration
   * are local to the returned Animation. Use `parse` for editable source poses.
   *
   * After this resolves, characters can play it via
   * `character.playAnimation(name)` / `character.crossfadeTo(name)`.
   *
   * @throws If the network request fails or the file is not a valid animation.
   * @example
   * ```ts
   * await Animation.load(scene, '/assets/idle.anim', 'idle');
   * character.playAnimation('idle', { loop: true });
   * ```
   */
  static async load(scene: Scene, url: string, name: string): Promise<Animation> {
    const animation = await Animation._loadConverted(url, 'anim');
    animation.register(scene, name);
    return animation;
  }

  /**
   * Fetch, parse, and register a MetaHuman GLB on the scene under `name`.
   * The GLB counterpart of {@link Animation.load}.
   * Like `load`, returns a local wrapper over shared read-only keys.
   * Use `fromGlb` directly when an unshared copy is needed.
   *
   * `animationName` selects a clip inside the GLB by name; omitted, the first
   * clip is used. After this resolves, characters can play it via
   * `character.playAnimation(name)` / `character.crossfadeTo(name)` - the
   * source format is invisible from that point on.
   *
   * @throws If the network request fails or the GLB is not a valid armature clip.
   * @example
   * ```ts
   * await Animation.loadGlb(scene, '/assets/metahuman_full.glb', 'walk');
   * character.playAnimation('walk', { loop: true });
   * ```
   */
  static async loadGlb(
    scene: Scene,
    url: string,
    name: string,
    animationName?: string,
  ): Promise<Animation> {
    const animation = await Animation._loadConverted(url, 'glb', animationName);
    animation.register(scene, name);
    return animation;
  }

  /** Start downloading now; a later `load` of the same URL reuses the bytes. */
  static prefetch(url: string): void {
    Animation._fetchBuffer(url).catch(() => {});
  }

  private static readonly _convertedLimit = 8;
  private static _convertedCache = new Map<string, ConvertedSource>();
  private static _convertedLoading = new Map<string, Promise<ConvertedSource>>();

  private static async _loadConverted(
    url: string,
    format: 'anim' | 'glb',
    animationName?: string,
  ): Promise<Animation> {
    // Same immutable-asset identity contract as the byte cache: query strings
    // carry rotating signatures, not content versions. Include the clip selector
    // and reader explicitly; scene registration names are intentionally absent.
    const key = JSON.stringify([format, url.split('?')[0], animationName ?? null]);
    let source = Animation._convertedCache.get(key);
    if (source) {
      Animation._convertedCache.delete(key);
      Animation._convertedCache.set(key, source);
    } else {
      let pending = Animation._convertedLoading.get(key);
      if (!pending) {
        pending = (async () => {
          const buffer = await Animation._fetchBuffer(url);
          const parsed = format === 'glb'
            ? Animation.fromGlb(buffer, animationName)
            : Animation.parse(buffer);
          convertSkeletalAnimation(parsed);
          // Every wrapper below shares these entries, so freeze them against
          // swapped arrays (typed-array contents can't be frozen). Maps, masks
          // and events are copied per wrapper.
          for (const entry of parsed.skeletalStore?.keyframes.values() ?? []) Object.freeze(entry);
          const converted: ConvertedSource = {
            numFrames: parsed.numFrames,
            numBones: parsed.numBones,
            keyframeFrames: parsed.keyframeFrames,
            translationMask: parsed.translationMask,
            events: parsed.events,
            skeletalStore: parsed.skeletalStore,
          };
          Animation._convertedCache.set(key, converted);
          if (Animation._convertedCache.size > Animation._convertedLimit) {
            const oldest = Animation._convertedCache.keys().next().value!;
            Animation._convertedCache.delete(oldest);
          }
          return converted;
        })().finally(() => Animation._convertedLoading.delete(key));
        Animation._convertedLoading.set(key, pending);
      }
      source = await pending;
    }

    // A fresh wrapper keeps filtering and the WeakMap playback cache local to
    // the caller's lifetime. In particular, the LRU never retains rest-relative
    // keyframes belonging to characters from previously destroyed scenes.
    const animation = new Animation(new Float32Array(0), source.numFrames, source.numBones);
    animation.keyframeFrames = source.keyframeFrames?.slice();
    animation.translationMask = source.translationMask?.slice();
    animation.events = source.events ? structuredClone(source.events) : undefined;
    animation.skeletalConverted = true;
    if (source.skeletalStore) {
      animation.skeletalStore = {
        keyframes: new Map(source.skeletalStore.keyframes),
        manualBones: new Set(source.skeletalStore.manualBones),
        source: source.skeletalStore.source,
      };
    }
    return animation;
  }

  /**
   * Process-wide ArrayBuffer cache for .anim URLs. Each `Scene` still
   * gets its own `Animation` wrapper; converted source data is shared by the
   * bounded cache above. Avoids re-downloading the same
   * idle/walk clips every time the app swaps one scene for another.
   */
  private static _bufferCache = new Map<string, ArrayBuffer>();
  private static _bufferLoading = new Map<string, Promise<ArrayBuffer>>();

  private static async _fetchBuffer(url: string): Promise<ArrayBuffer> {
    // Strip query for in-memory cache key (signed CDN URLs rotate tokens)
    const key = url.indexOf('?') === -1 ? url : url.slice(0, url.indexOf('?'));

    const cached = Animation._bufferCache.get(key);
    if (cached) return cached;
    const inflight = Animation._bufferLoading.get(key);
    if (inflight) return inflight;

    // Use cachedFetch for persistent caching (Cache API), then store in-memory
    const promise = cachedFetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to fetch animation: ${res.statusText}`);
      const buf = await res.arrayBuffer();
      Animation._bufferCache.set(key, buf);
      return buf;
    }).finally(() => {
      Animation._bufferLoading.delete(key);
    });
    Animation._bufferLoading.set(key, promise);
    return promise;
  }

  /**
   * Convert the animation data against the scene's skeleton library and
   * register it under `name` so characters can play it.
   *
   * Must be called before {@link Character.playAnimation} / {@link Character.crossfadeTo}
   * reference this animation.
   */
  register(scene: Scene, name: string): void {
    convertSkeletalAnimation(this, scene.skeletonLibrary);
    scene.skeletalAnimationLibrary.set(name, this);
  }
}
