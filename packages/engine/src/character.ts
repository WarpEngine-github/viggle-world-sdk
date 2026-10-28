import { Vec3 } from 'playcanvas';

import { Animation } from './animation';
import { Armature } from './armature';
import { warmCharacterDecoder } from './loader/character/binary-gsplat';
import {
  fetchBinBuffer,
  loadBinaryAsset,
  loadBinaryAssetFromBytes,
  loadVsplatAsset,
  loadVsplatAssetFromBytes,
} from './loader/shared/asset-loader';
import type { LoadResult } from './loader/shared/asset-loader';
import type { Scene } from './scene';
import { SceneDestroyedError } from './scene';
import type { AnimEventCallback } from './skeletal/animation-player';
import { makeRegionMask } from './skeletal/bone-mask';
import type { BodyRegion, BoneMask } from './skeletal/bone-mask';
import { Splat } from './splat/splat';
import type { RevealLook } from './splat/reveal-look';

/**
 * Options for {@link Character.load}.
 *
 * @group Characters & Animation
 */
export interface LoadCharacterOptions {
  /**
   * Name used for the armature and any embedded animation registered on the
   * scene. Defaults to the file basename (stripped of extension).
   */
  name?: string;
  /** Initial position, `y` at GROUND CONTACT - same convention as
   *  {@link Character.setPosition}. Defaults to the origin. */
  position?: { x: number; y: number; z: number };
  /**
   * Which rest translations pose the rig.
   *
   * - `'auto'` (default) - `'bundled'` for a bundle carrying a correction
   *   receipt, `'builtin'` for one without. Apps should pass nothing: the
   *   discriminator lives in the file, so the decision belongs here rather than
   *   in each consuming app, where the copies would otherwise drift apart.
   * - `'builtin'` - the canonical std-male tables from the skeleton library.
   *   Every character is posed on one shared skeleton.
   * - `'bundled'` - the per-character `joints` array for BODY bones, canonical
   *   for `FACIAL_*` ones and for toes. See `keepsCanonicalRest` for the
   *   measurements behind both exclusions.
   *
   * The explicit values exist for the comparison scenes, which show one
   * character both ways on purpose.
   *
   * The body tables disagree, and not subtly: on a sample character 81 of 86
   * body bones differ by more than 1 mm, worst 36 mm at `foot_r`, with the
   * canonical limbs uniformly SHORTER (thigh -14.7 mm, calf -36.4 mm). That
   * leaves the canonical knee ~36 mm high and the canonical foot floating
   * ~72 mm off the ground on a character whose own skeleton reaches it.
   *
   * At rest the choice is invisible - skinning cancels `worldPose · inverseBind`
   * to identity either way. It only shows once a joint ROTATES, because the
   * rotation happens about the chosen pivot: a splat at the true knee swung
   * about a centre 36 mm away lands ~51 mm off through a 90° bend.
   *
   * Clips are authored on the canonical rig - their body translations match
   * `REST_TRANSLATIONS_441` to 0.0007 mm - which USED to make a canonical bind
   * the only one that agreed with the pose, and `'bundled'` a diagnostic.
   * That is no longer so: a bone whose translation never changes across a clip
   * is now read as a rest declaration and left to the character
   * (`Animation`'s `translationMask`, derived for `.anim`, GLB and the
   * `.bin`-embedded clip alike). Playback is effectively rotation-only for
   * every bone the clip does not actually translate - 341 of 342 on the body
   * rig, 829 of 1185 on the full one - so `'bundled'` now inherits the
   * character's own lengths instead of having them overwritten.
   *
   * Bundles carry translations only, never rotations, so `'bundled'` yields
   * per-character bone LENGTHS with canonical joint ORIENTATIONS - a hybrid.
   * Falls back to `'builtin'` when the bundle has no joints (older files) or
   * the array length disagrees with the bone count.
   */
  restSource?: 'auto' | 'builtin' | 'bundled';
}

/**
 * High-level facade around an {@link Armature} + one or more {@link Splat}s
 * loaded from a character bundle, of any container the reader implements.
 * Construct via {@link Character.load} - the constructor is only used
 * internally.
 *
 * Exposes transform setters (which automatically trigger splat re-sorts) and
 * simple playback verbs ({@link Character.playAnimation}, {@link Character.crossfadeTo},
 * {@link Character.stop}) that delegate to the underlying armature.
 *
 * @group Characters & Animation
 */
/**
 * Bones whose per-character rest translation is NOT trustworthy, so `'bundled'`
 * keeps the canonical value for them. Both groups were picked on measurement
 * across four generated characters, not by anatomy.
 *
 * `FACIAL_*` - 160-181 mm from canonical at worst, against a face only ~200 mm
 * tall, and clips are authored on the canonical rig, so a per-character facial
 * bind fights the pose (143 mm of displacement measured; 0 mm at rest).
 *
 * `*toe_*` - error relative to BONE LENGTH is what shows here, and absolute
 * numbers hide it. Toes run a median 35% and up to 323% of their own length
 * (`indextoe_01_l`: 17 mm long, displaced 54.8 mm), against a median 14% and
 * max 56% for the rest of the body.
 *
 * Finger tips are the next candidates on the same measure - `index_03_l` 56%,
 * `middle_03_l` 47%, `ring_03_l` 44% - an order of magnitude better than the
 * worst toes but well above the body median. Left in deliberately; revisit if
 * hands are seen to distort.
 */
function keepsCanonicalRest(name: string | undefined): boolean {
  if (!name) return false;
  return name.startsWith('FACIAL_') || name.includes('toe_');
}

export class Character {
  /** Render-LOD level pyramid - when more than one entry, only one is
   *  enabled at a time (the active level). `splats[0]` is always the
   *  highest-fidelity (L0). Single-LOD characters have `splats.length === 1`. */
  public splats: Splat[];

  /**
   * The currently-rendered splat. For single-bin characters this is
   * always `splats[0]`; for multi-LOD characters it tracks the active
   * render-LOD level and flips with `setRenderLod` / `setRenderLevel`.
   *
   * Safe for read-only queries (`.numSplats`, `.entity`, `.isInFrustum`,
   * etc.). For **state mutations** that should persist across LOD swaps
   * (tint, sort, visibility) prefer the Character-level helpers
   * ({@link setTint}, {@link requestSort}) - writing to a single splat
   * here only affects whichever level is active right now and the change
   * vanishes when the active level swaps.
   */
  get splat(): Splat {
    return this.splats[this._activeLevel];
  }

  // Render LOD configuration.
  private _renderLodEnabled = false;
  private _renderLodNearDist = Infinity;
  private _renderLodFarDist = Infinity;
  private _activeLevel = 0;

  // Linked splats that live OUTSIDE the LOD pyramid - added via
  // {@link addVariantSplat} and managed by higher-level systems (e.g. the
  // DamageVariant preset). They share the armature, animate every frame,
  // and stay enabled by default. Character ownership covers lifecycle
  // (destroy / setActive) but not visibility - that's the variant system's
  // job, via per-splat variant masks.
  private _variantSplats: Splat[] = [];

  /** Layer ids applied by {@link setLayers}; null = PC default (World). */
  private _layerIds: number[] | null = null;

  /** See-through copies from {@link addOverlaySplat}. Own their layers, so
   *  {@link setLayers} leaves them alone; lifecycle is the character's. */
  private _overlaySplats: Splat[] = [];

  /** Set by {@link setOpacity}; a later overlay copy starts at it. */
  private _opacity = 1;

  /** Whether this character is live (ticking + rendering). Toggled by
   *  {@link setActive} for object pooling - a deactivated character keeps all
   *  its GPU resources (splats, textures, compiled shaders) but stops
   *  updating and rendering, so it can be reactivated at a new position with
   *  none of the ~tens-of-ms `new Splat` setup cost. */
  private _active = true;

  /** Set by {@link destroy}. Async loaders that resolve afterwards (LOD
   *  upgrades, variant splats) check this so they don't re-add splats that
   *  nothing owns or ticks anymore - without it, a character destroyed while
   *  a finer LOD is still downloading leaks that splat into the scene as a
   *  frozen, orphaned figure. */
  private _destroyed = false;

  /** True once {@link destroy} has run. Progressive-load choreography
   *  (coarse-first upgrade loops) should stop streaming when this flips. */
  get destroyed(): boolean {
    return this._destroyed;
  }

  // ─── TEMPORARY: `VIGGCHAR` v1 → legacy ground-convention shim ──────────────
  //
  // DELETE THIS WHOLE BLOCK - the field, the two converters, and the one line
  // in `_buildFromLoadResult` that fills it - when `.bin` retires. The shift is
  // then always 0, every method here is the identity, and removing them cannot
  // move anything.
  //
  // WHY IT EXISTS. The two character containers disagree about where a
  // character's feet sit relative to its model origin:
  //
  //   legacy `.bin`  feet 7-21 cm BELOW the origin. No ground pass ever ran;
  //                  they bind wherever the rig put them, and (measured across
  //                  the 13 assets shipped in this container) they disagree with
  //                  EACH OTHER by up to 14 cm.
  //   VIGGCHAR v1    feet ON the origin. The bake lifts the splats until the
  //                  lowest visible gaussian (alpha >= 0.02) lands on y = 0 and
  //                  records that lift in the root joint row - per character,
  //                  not a constant (0.0432 .. 0.16207 m on real assets).
  //
  // Game code universally assumes "model origin == ground contact". That is
  // true for legacy - the canonical rest root row is exactly [0,0,0], which
  // `loader/skeleton/ground-convention.test.ts` pins - and false for v1, so a
  // `.vsplat` character rendered its whole bake shift too high and floated.
  //
  // WHAT IT IS NOT. This is a DE-correction, not a fix: it puts v1 back onto
  // legacy's (wrong, but shipped) convention so that nothing already on screen
  // moves. Normalising ground contact for real - measuring the lowest splat per
  // character at runtime - would move every legacy character and is a separate,
  // product-level call. Do not turn this into that.
  private _bakedGroundShiftY = 0;

  /**
   * The ground shift a `VIGGCHAR` v1 bake folded into this character, in
   * metres. `0` for legacy `.bin` bundles and for anything without one.
   *
   * Diagnostics and ground-snap tooling only. {@link setPosition},
   * {@link getPosition} and {@link Character.load}'s `position` option already
   * apply it, so game code should not need to read this - and code that
   * measures ground contact empirically (a {@link getLowestWorldY} probe) must
   * NOT apply it, because such a probe observes the shift's result already and
   * would double-correct.
   */
  get bakedGroundShiftY(): number {
    return this._bakedGroundShiftY;
  }

  /**
   * Convert a ground-contact Y - the convention {@link setPosition} takes -
   * into the raw Y to write on `armature.entity`.
   *
   * For hot paths that must bypass {@link setPosition} and write the entity
   * directly (a per-frame sync with a pooled `Vec3`, say). Everything else
   * should use {@link setPosition} and never see this.
   */
  groundToEntityY(groundY: number): number {
    return groundY - this._bakedGroundShiftY;
  }

  /**
   * Exact inverse of {@link groundToEntityY}: a raw `armature.entity` Y back
   * into the ground-contact convention.
   *
   * Read positions back through this (or through {@link getPosition}) so that a
   * read/modify/write round-trip - a motor integrating velocity, a tween
   * sampling its own start value - can never apply the shift twice.
   */
  entityToGroundY(entityY: number): number {
    return entityY + this._bakedGroundShiftY;
  }
  // ─── end temporary shim ───────────────────────────────────────────────────

  private _updateHandler!: (dt: number) => void;

  /** Skeleton + animation controller. */
  armature: Armature;
  private _scene: Scene;

  // Fields are declared and assigned explicitly rather than via TypeScript
  // parameter properties: this file is consumed as raw TS by apps that build
  // with `erasableSyntaxOnly`, which rejects parameter properties outright.
  constructor(
    armature: Armature,
    splats: Splat[],
    scene: Scene,
  ) {
    this.armature = armature;
    this._scene = scene;
    if (splats.length === 0) throw new Error('Character: at least one Splat required');
    this.splats = splats;
    // Render-LOD characters start with only L0 visible; the rest are
    // pre-disabled so updatePositions never runs on them at startup. Use
    // `setRenderingEnabled` not raw `entity.enabled` - see the helper's
    // docstring for why both flags must be toggled together.
    splats[0].setRenderingEnabled(true);
    for (let i = 1; i < splats.length; i++) splats[i].setRenderingEnabled(false);
  }

  /**
   * Load a character bundle and add it to the scene.
   *
   * The bundle's bone count selects the rig: 441 bones = full body + facial
   * rig, otherwise the 86-bone standard-male body rig. If the bundle contains
   * an embedded animation, it is registered on the scene under
   * {@link LoadCharacterOptions.name} (or the file basename).
   *
   * @param scene - Target scene. Must have `skeletonLibrary` loaded.
   * @param urlOrUrls - One bundle URL, or an array of LOD levels for the same
   *   character, finest first. Every level shares the armature and animation
   *   from the FIRST entry; see {@link setRenderLod} for how a level is picked
   *   at runtime and {@link addLodLevel} for adding one later.
   * @param opts - See {@link LoadCharacterOptions}.
   * @returns A fully-wired character whose armature drives the splat every frame.
   *
   * @example
   * ```ts
   * const character = await Character.load(scene, '/assets/hero.vsplat');
   * character.playAnimation('idle', { loop: true });
   * ```
   */
  static async load(
    scene: Scene,
    urlOrUrls: string | string[],
    opts?: LoadCharacterOptions,
  ): Promise<Character> {
    const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
    if (urls.length === 0) throw new Error('Character.load: urls is empty');
    const results = await Promise.all(urls.map(u => loadBinaryAsset(scene.app, u)));
    const defaultName = urls[0].split('/').pop()?.replace(/\.\w+$/, '') ?? 'character';
    return Character._buildFromLoadResult(scene, results, defaultName, opts);
  }

  /**
   * Start downloading a character bundle now; a later {@link Character.load}
   * of the same URL reuses the bytes. Also spins up the decode worker so its
   * startup overlaps the download instead of following it.
   */
  static prefetch(url: string): void {
    warmCharacterDecoder();
    fetchBinBuffer(url).catch(() => {});
  }

  /**
   * Load a `.bin` character bundle from in-memory bytes.
   *
   * Same shape as {@link Character.load} but consumes bytes directly. Use for
   * runtime-generated content (an offline generation pipeline's output, hot
   * swaps, tests) where there is no fetchable URL.
   *
   * @param scene - Target scene. Must have `skeletonLibrary` loaded.
   * @param bytes - Raw `.bin` bundle bytes.
   * @param opts - See {@link LoadCharacterOptions}. `opts.name` is required for
   *   anim registration since there is no URL basename to fall back on.
   * @returns A fully-wired character whose armature drives the splat every frame.
   *
   * @example
   * ```ts
   * const character = await Character.loadFromBytes(scene, generatedBundle, { name: 'hero' });
   * character.playAnimation('idle', { loop: true });
   * ```
   */
  static async loadFromBytes(
    scene: Scene,
    bytes: Uint8Array,
    opts?: LoadCharacterOptions,
  ): Promise<Character> {
    const result = await loadBinaryAssetFromBytes(scene.app, bytes);
    return Character._buildFromLoadResult(scene, [result], 'character', opts);
  }

  /**
   * Load a `.vsplat` bundle.
   *
   * The extension is advisory: the bytes go to the same magic-dispatching
   * reader {@link Character.load} uses, so a `.vsplat` may be a `VIGGCHAR`
   * version 1 bundle or one of the legacy planar containers. None of those
   * carries an animation chunk, so the character comes up in its rest pose;
   * register clips separately with {@link Animation.loadGlb} if you need motion.
   *
   * Differs from {@link Character.load} only in skipping the in-memory
   * `ArrayBuffer` cache - see `loader/shared/asset-loader.ts`.
   *
   * @param scene - Target scene. Must have `skeletonLibrary` loaded.
   * @param source - URL, or raw `.vsplat` bytes.
   * @param opts - See {@link LoadCharacterOptions}.
   */
  static async loadVsplat(
    scene: Scene,
    source: string | Uint8Array,
    opts?: LoadCharacterOptions,
  ): Promise<Character> {
    const result = typeof source === 'string'
      ? await loadVsplatAsset(scene.app, source)
      : await loadVsplatAssetFromBytes(scene.app, source);
    const defaultName = typeof source === 'string'
      ? source.split('/').pop()?.replace(/\.\w+$/, '') ?? 'character'
      : 'character';
    return Character._buildFromLoadResult(scene, [result], defaultName, opts);
  }

  private static _buildFromLoadResult(
    scene: Scene,
    results: LoadResult[],
    defaultName: string,
    opts?: LoadCharacterOptions,
  ): Character {
    // The funnel for `load`, `loadFromBytes` and `loadVsplat` alike, and the
    // first thing after their awaits that touches the GPU - `linkSplat` below
    // uploads the bone palette. If the scene was torn down while the bytes were
    // in flight, stop here: past this point the failure is a null-dereference
    // inside a texture upload, which reads as a corrupt asset rather than a
    // cancelled load. A caller's own post-await guard cannot cover this,
    // because the throw would happen before its `await` ever returns.
    if (scene.destroyed) {
      throw new SceneDestroyedError('Character.load');
    }

    const library = scene.skeletonLibrary;
    if (!library?.stdMaleRestTranslations || !library.stdMaleRestRotations || !library.stdMaleParents) {
      throw new Error('Skeleton library not loaded on scene');
    }

    // Armature + animation come from results[0] - the LOD pyramid shares
    // one skeleton across all levels; additional results contribute only
    // their splat data. Skeleton / animation in tail bins are duplicates
    // of L0 and are intentionally ignored.
    const primary = results[0];

    if (primary.animationData) {
      const animation = new Animation(
        primary.animationData.data,
        primary.animationData.numFrames,
        primary.animationData.numBones,
        primary.animationData.keyframeFrames,
      );
      animation.register(scene, opts?.name ?? defaultName);
    }

    // Pick armature rig to match bin bone count. 441 = full body+facial rig;
    // anything else defaults to std male 86-bone body rig.
    const binBoneCount = primary.armatureData?.numBones;
    const use441 = binBoneCount === 441 && library.parents441 && library.restTranslations441 && library.restRotations441;
    const builtinRest = use441 ? library.restTranslations441! : library.stdMaleRestTranslations;

    // `restSource: 'bundled'` takes the per-character `joints` for BODY bones and
    // keeps the canonical rest for the bones `keepsCanonicalRest` names - FACIAL_*
    // and toes. Only translations move - bundles carry no rotations - and only
    // when the array is present and sized to the rig, so older bundles silently
    // keep today's behaviour.
    //
    // The face is excluded deliberately, on measurement. Per-character facial
    // joints are unreliable: across four characters they run 160–181 mm from
    // canonical at worst against a ~200 mm-tall face, while the body stays a
    // plausible 45–60 mm. And clips are authored on the canonical rig, so a
    // facial clip poses in canonical space while a per-character bind sits
    // elsewhere - measured at 143 mm of facial displacement, 7x more than with
    // facial channels removed, and exactly 0 mm at rest.
    //
    // Body joints are kept because they ARE trustworthy and are what a future
    // rotation-only animation path would need.
    const bundledJoints = primary.armatureData?.joints;
    const boneNames = use441 ? library.boneNames441 : library.boneNames;

    // `'auto'` (the default) resolves per bundle, which is the whole point: one
    // build has to render corrected characters on their own rig AND leave every
    // character made before corrections exactly as it renders today. A bundle
    // that was corrected had the ankle and the ground shift baked into its
    // splats and into joint 0; only `'bundled'` reads that root shift back, so
    // posing such a character from the shared tables moves the skin and leaves
    // the skeleton behind. A bundle that was NOT corrected has joints that no
    // pipeline ever vetted, so it keeps the canonical tables.
    const restSource = opts?.restSource ?? 'auto';
    const wantsBundled = restSource === 'auto'
      ? primary.armatureData?.corrected === true
      : restSource === 'bundled';
    const canBundle =
      wantsBundled &&
      bundledJoints instanceof Float32Array &&
      bundledJoints.length === builtinRest.length;

    let restTranslations = builtinRest;
    if (canBundle) {
      const joints = bundledJoints as Float32Array;
      const merged = new Float32Array(builtinRest);
      const n = merged.length / 3;
      for (let b = 0; b < n; b++) {
        // No names (unknown rig) => trust the bundle for every bone; the 86-bone
        // rig has no facial bones and its toes are named the same way anyway.
        if (keepsCanonicalRest(boneNames?.[b])) continue;
        merged[b * 3] = joints[b * 3];
        merged[b * 3 + 1] = joints[b * 3 + 1];
        merged[b * 3 + 2] = joints[b * 3 + 2];
      }
      restTranslations = merged;
    }

    const armature = use441
      ? new Armature(opts?.name ?? defaultName, {
          numBones: 441,
          stdMaleRestTranslations: restTranslations,
          stdMaleRestRotations: library.restRotations441,
          stdMaleParents: library.parents441,
        })
      : new Armature(opts?.name ?? defaultName, {
          numBones: library.stdMaleRestTranslations.length / 3,
          stdMaleRestTranslations: restTranslations,
          stdMaleRestRotations: library.stdMaleRestRotations,
          stdMaleParents: library.stdMaleParents,
        });
    armature.addToScene(scene);

    // One Splat per LOD level. All link to the same armature → all get the
    // same per-frame bone palette upload. SplatSkinning.pushTransforms
    // skips disabled splats, so hidden LODs pay no CPU.
    const splats: Splat[] = results.map((r) => {
      const s = new Splat(r.asset, new Vec3(0, 0, 0), scene.app);
      s.addToScene(scene);
      armature.linkSplat(s);
      return s;
    });

    // Row 0 of a v1 joints block IS the baked ground shift: the lift is added
    // to the root, because shifting the root moves every bone below it, so no
    // other row carries any of it. The decoder has already de-interleaved the
    // component-major file block into row-major `[x,y,z]` triples, so index 1
    // is the root row's Y. (Verified on real assets: x and z are exactly 0.)
    //
    // Gated on the CONTAINER via `restIsPerCharacter`, never on the
    // `armatureData.corrected` receipt - some legacy bundles carry that receipt
    // and keying on it would move characters that already render correctly.
    // Taken from the bundle whenever it is v1, independent of which rest table
    // the merge above chose: the shift lives in the GEOMETRY, so it applies
    // even when the canonical rest was kept. See the shim block on the class.
    const bakedGroundShiftY =
      primary.armatureData?.restIsPerCharacter === true && bundledJoints instanceof Float32Array
        ? bundledJoints[1]
        : 0;

    if (opts?.position) {
      // `position.y` is ground contact, the same convention `setPosition` takes
      // - spelled out here rather than deferred, because the Character that
      // owns the conversion does not exist yet.
      armature.move(new Vec3(
        opts.position.x,
        opts.position.y - bakedGroundShiftY,
        opts.position.z,
      ));
    }

    const character = new Character(armature, splats, scene);
    character._bakedGroundShiftY = bakedGroundShiftY;
    character._wireUpdate();
    return character;
  }

  /** Build + register the per-frame update handler. Called once at
   *  construction; kept separate so the handler can close over `this`. */
  private _wireUpdate(): void {
    this._updateHandler = (dt: number) => {
      if (this._renderLodEnabled && this.splats.length > 1) {
        const next = this._pickRenderLevel();
        if (next !== this._activeLevel) {
          this.splats[this._activeLevel].setRenderingEnabled(false);
          this.splats[next].setRenderingEnabled(true);
          this._activeLevel = next;
        }
      }
      this.armature.update(dt);
    };
    this._scene.app.on('update', this._updateHandler);
  }

  /** Pick the render-LOD level for this frame based on camera distance.
   *  near band → L0; far band → last; in between → intermediate level. */
  private _pickRenderLevel(): number {
    const N = this.splats.length;
    if (N < 2) return 0;
    const cam = this._scene.cameraEntity;
    if (!cam) return this._activeLevel;
    const camPos = cam.getPosition();
    const self = this.armature.entity.getPosition();
    const dx = self.x - camPos.x;
    const dy = self.y - camPos.y;
    const dz = self.z - camPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    const near = this._renderLodNearDist;
    const far = this._renderLodFarDist;
    if (distSq < near * near) return 0;
    if (distSq >= far * far) return N - 1;
    // Divide [near, far] into (N-1) equal sub-bands; band i renders L(i+1).
    const dist = Math.sqrt(distSq);
    const bands = N - 1;
    const t = (dist - near) / (far - near);
    return 1 + Math.min(bands - 1, Math.floor(t * bands));
  }

  /**
   * Enable distance-based render LOD. Per frame, the character switches
   * between the loaded LOD splats (`splats[0..N-1]`, from finest to
   * coarsest). Near the camera → L0 (full); beyond `farDist` → last level;
   * in between → intermediate levels split evenly across the band.
   *
   * Composes with {@link Armature.setAnimationLod} / {@link Armature.setSortLod}:
   * render LOD throws away splats at distance, the other two throttle
   * animation / sort work - stack all three for maximum CPU savings.
   *
   * No-op if only one LOD level was loaded.
   *
   * @example
   * ```ts
   * const c = await Character.load(scene, ['hero.l0.vsplat', 'hero.l1.vsplat', 'hero.l2.vsplat']);
   * c.setRenderLod({ nearDist: 8, farDist: 20 });
   * ```
   */
  setRenderLod(opts: { nearDist: number; farDist: number }): void {
    if (this.splats.length < 2) return;
    this._renderLodNearDist = opts.nearDist;
    this._renderLodFarDist = opts.farDist;
    this._renderLodEnabled = true;
  }

  /** Disable render LOD - pins the character to the highest-fidelity level
   *  (L0). Other loaded LOD splats remain in memory but are not rendered. */
  disableRenderLod(): void {
    this._renderLodEnabled = false;
    if (this._activeLevel !== 0) {
      this.splats[this._activeLevel].setRenderingEnabled(false);
      this.splats[0].setRenderingEnabled(true);
      this._activeLevel = 0;
    }
  }

  /** Force a specific render-LOD level, bypassing distance bands. Useful
   *  for debugging / A-B comparisons in the profiling scene. */
  setRenderLevel(level: number): void {
    const N = this.splats.length;
    if (N < 2) return;
    const clamped = Math.max(0, Math.min(N - 1, Math.floor(level)));
    if (clamped === this._activeLevel) return;
    this.splats[this._activeLevel].setRenderingEnabled(false);
    this.splats[clamped].setRenderingEnabled(true);
    this._activeLevel = clamped;
  }

  /** Number of LOD levels loaded for this character (>=1). */
  get renderLodLevels(): number {
    return this.splats.length;
  }

  /** Active render-LOD level (0 = highest fidelity). */
  get activeRenderLevel(): number {
    return this._activeLevel;
  }

  /**
   * Tint every LOD splat. Fans out to `splats[*]` so the tint persists
   * across render-LOD swaps - writing to a single splat (e.g. the legacy
   * `c.splat.setTint(...)`) only affects that level, and the tint
   * "vanishes" the next time `setRenderLod` swaps the visible level.
   *
   * Same signature as {@link Splat.setTint}.
   */
  setTint(
    intensity: number,
    color?: { r: number; g: number; b: number },
  ): void {
    for (const s of this.splats) {
      if (color) s.setTint(intensity, color);
      else s.setTint(intensity);
    }
  }

  /**
   * Opacity in [0, 1] for every LOD level, variant and overlay splat - see
   * {@link Splat.setOpacity}. 1, the default, draws the character unchanged.
   */
  setOpacity(opacity: number): void {
    this._opacity = opacity;
    for (const s of this.splats) s.setOpacity(opacity);
    for (const s of this._variantSplats) s.setOpacity(opacity);
    for (const s of this._overlaySplats) s.setOpacity(opacity);
  }

  /**
   * Reveal amount in [0, 1] for every LOD level, variant and overlay splat - see
   * {@link Splat.setReveal}. 0 hides the character entirely (without
   * touching entity enabled state, so no placement recompile), 1 renders it
   * unchanged. `inverse` keeps the area ahead of the moving front instead,
   * which is useful when handing off between two characters.
   */
  setReveal(amount: number, inverse = false): void {
    for (const s of this.splats) s.setReveal(amount, inverse);
    for (const s of this._variantSplats) s.setReveal(amount, inverse);
    for (const s of this._overlaySplats) s.setReveal(amount, inverse);
  }

  /** {@link Splat.setRevealPulse} for every LOD level, variant and overlay splat. */
  setRevealPulse(front: number, strength = 1): void {
    for (const s of this.splats) s.setRevealPulse(front, strength);
    for (const s of this._variantSplats) s.setRevealPulse(front, strength);
    for (const s of this._overlaySplats) s.setRevealPulse(front, strength);
  }

  /** {@link Splat.setRevealLook} for every LOD level, variant and overlay splat. */
  setRevealLook(look: RevealLook): void {
    for (const s of this.splats) s.setRevealLook(look);
    for (const s of this._variantSplats) s.setRevealLook(look);
    for (const s of this._overlaySplats) s.setRevealLook(look);
  }

  /**
   * Pay the reveal's one-time setup now instead of on its first frame - see
   * {@link Armature.prepareReveal}.
   */
  prepareReveal(): void {
    this.armature.prepareReveal();
  }

  /**
   * Re-sort every LOD splat. Cheap when called on inactive splats (no GPU
   * sort runs there), and necessary for the active one to reflect a fresh
   * transform on the next frame. Fans out so a swap to a previously-
   * inactive LOD doesn't render with a stale sort order.
   */
  requestSort(): void {
    for (const s of this.splats) s.requestSort();
  }

  /**
   * Put every LOD and variant splat on the given PC layers (see
   * {@link Splat.setLayers}). Remembered so variants attached later land on
   * the same layers. Pass `[scene.envLayerId]` to let an environment occlude
   * the character; PC's World layer id restores the default.
   */
  setLayers(layerIds: number[]): void {
    this._layerIds = [...layerIds];
    for (const s of this.splats) s.setLayers(this._layerIds);
    for (const s of this._variantSplats) s.setLayers(this._layerIds);
  }

  /**
   * Add a second cloud of the active LOD, sharing this armature (so it
   * animates in lockstep) but routed to `layerIds` - typically
   * `scene.overlayLayerId`, which paints over everything. With the body
   * itself on the environment's layer (occluded by real objects), this copy
   * is what shows through obstacles; give its layer a see-through style via
   * `applyOverlaySplatStyle`. Synchronous: reuses the loaded asset.
   */
  addOverlaySplat(layerIds: number[]): Splat {
    const source = this.splats[this._activeLevel] ?? this.splats[0];
    const splat = new Splat(source.asset, new Vec3(0, 0, 0), this._scene.app);
    // It is the BODY's asset, shared so the two animate in lockstep. This copy
    // must never unload it - see Splat.ownsAsset.
    splat.ownsAsset = false;
    splat.addToScene(this._scene);
    this.armature.linkSplat(splat);
    splat.setLayers(layerIds);
    splat.setRenderingEnabled(this._active);
    if (this._opacity !== 1) splat.setOpacity(this._opacity);
    this._overlaySplats.push(splat);
    return splat;
  }

  /** Read-only view of the overlay copies from {@link addOverlaySplat}. */
  get overlaySplats(): readonly Splat[] {
    return this._overlaySplats;
  }

  /**
   * Take one overlay copy back off, the inverse of {@link addOverlaySplat}.
   *
   * It exists so a caller can stop compositing a character against an
   * environment WITHOUT reloading the character. Adding an overlay was already
   * synchronous and in place; removing one was not possible at all, so the only
   * way back was to destroy the body and load it again - a reload of the one
   * thing on screen that had not changed.
   *
   * A splat that is not one of this character's overlays is ignored.
   */
  removeOverlaySplat(splat: Splat): void {
    const i = this._overlaySplats.indexOf(splat);
    if (i < 0) return;
    this._overlaySplats.splice(i, 1);
    this.armature.unlinkSplat(splat);
    splat.destroy();
  }

  /**
   * World-space Y of the character's lowest point, using
   * {@link Splat.getGroundWorldY}'s noise-robust low-quantile estimate across
   * every enabled splat (the active render-LOD level, plus any variant splats
   * that are currently visible). Returns `null` if no splat is enabled (e.g.
   * mid-load). Ground-snap tooling only - the per-frame render path doesn't
   * use it.
   *
   * This is a MEASUREMENT of where the character actually renders, so it
   * already includes {@link bakedGroundShiftY}. A caller that snaps to ground
   * from this number must not also apply that shift, or it corrects twice.
   */
  getLowestWorldY(quantile = 0.005): number | null {
    let min = Infinity;
    for (const s of this.splats) {
      if (!s.entity.enabled) continue;
      const y = s.getGroundWorldY(quantile);
      if (y < min) min = y;
    }
    return min === Infinity ? null : min;
  }

  /**
   * Async primitive: load one more LOD level from `url` and link it to this
   * character's armature, leaving it disabled (not rendered) until the caller
   * explicitly picks it via {@link setRenderLevel}.
   *
   * Lets game code compose its own LOD-loading policy on top of an existing
   * Character without the engine deciding when to swap. Typical pattern is
   * progressive: load the smallest LOD via {@link Character.load} for instant
   * first-frame, then background-load finer levels with `addLodLevel` and
   * `setRenderLevel(splats.length - 1)` each time one arrives.
   *
   * Skeleton + animation are shared with the existing armature - any joints
   * / animation data inside the additional `.bin` is intentionally ignored
   * (it must match the original; only the splat + bone-weights chunks are
   * consumed). The newly loaded `Splat` is pushed onto `this.splats` and
   * starts in the disabled state.
   *
   * @param url - URL of another `.bin` (any LOD level of the same character).
   * @returns Resolves once the splat is fully loaded, linked, and GPU-uploaded.
   *
   * @example
   * ```ts
   * // Progressive: start at L2 (smallest), upgrade as finer levels arrive.
   * const c = await Character.load(scene, urls[2], opts);
   * (async () => {
   *   await c.addLodLevel(urls[1]);
   *   c.setRenderLevel(c.splats.length - 1);
   *   await c.addLodLevel(urls[0]);
   *   c.setRenderLevel(c.splats.length - 1);
   * })();
   * ```
   */
  async addLodLevel(url: string): Promise<void> {
    const result = await loadBinaryAsset(this._scene.app, url);
    // Destroyed while the level was downloading (e.g. a rapid character swap)
    // - adding the splat now would orphan it in the scene with nothing
    // ticking or owning it. Drop the bytes instead.
    if (this._destroyed) return;
    const splat = new Splat(result.asset, new Vec3(0, 0, 0), this._scene.app);
    splat.addToScene(this._scene);
    this.armature.linkSplat(splat);
    splat.setRenderingEnabled(false);
    if (this._layerIds) splat.setLayers(this._layerIds);
    this.splats.push(splat);
  }

  /**
   * Load an additional splat cloud, link it to this character's armature,
   * and leave it ENABLED so it renders alongside the LOD pyramid. Returns
   * the newly-created {@link Splat} so higher-level systems can drive it
   * directly (typically via {@link Splat.setSplatGroups} +
   * {@link Splat.setVariantMask}).
   *
   * Use case: damage / outfit / state variants where two skinned clouds
   * share one skeleton and per-region visibility masks decide which
   * gaussians each cloud contributes. See the `DamageVariant` preset for
   * the body-part scheme built on top of this primitive.
   *
   * The variant splat's lifecycle is owned by this Character - it is
   * destroyed in {@link destroy} and enabled/disabled by {@link setActive}.
   * Call {@link removeVariantSplat} to retire one early.
   *
   * @param url - URL of a `.bin` rigged to the same skeleton as this
   *   character. The skeleton/animation chunks (if present) are ignored.
   */
  async addVariantSplat(url: string): Promise<Splat> {
    const result = await loadBinaryAsset(this._scene.app, url);
    // Same guard as addLodLevel: a variant landing after destroy() would be
    // an unowned orphan. Reject so the awaiting caller's flow (itself tied
    // to the destroyed character) fails loudly instead of leaking.
    if (this._destroyed) {
      throw new Error('Character destroyed while variant splat was loading');
    }
    const splat = new Splat(result.asset, new Vec3(0, 0, 0), this._scene.app);
    splat.addToScene(this._scene);
    this.armature.linkSplat(splat);
    splat.setRenderingEnabled(true);
    if (this._layerIds) splat.setLayers(this._layerIds);
    this._variantSplats.push(splat);
    return splat;
  }

  /** Remove and destroy a splat previously added via {@link addVariantSplat}.
   *  No-op if `splat` was not from this character. */
  removeVariantSplat(splat: Splat): void {
    const idx = this._variantSplats.indexOf(splat);
    if (idx < 0) return;
    this._variantSplats.splice(idx, 1);
    this.armature.unlinkSplat(splat);
    splat.destroy();
  }

  /** Read-only view of currently-attached variant splats (in insertion order). */
  get variantSplats(): readonly Splat[] {
    return this._variantSplats;
  }

  /**
   * Set the character's position, with `y` measured at GROUND CONTACT: pass the
   * floor height and the feet land on it, whichever container the character
   * came from. Triggers a splat re-sort.
   *
   * `y` goes through {@link groundToEntityY} on the way to the entity. That is
   * the identity for every legacy `.bin` character, so this is byte-identical
   * to the historical "y is the model origin" behaviour for everything already
   * shipped; only `VIGGCHAR` v1 bundles move. Read the position back with
   * {@link getPosition}, never with `armature.entity.getLocalPosition()`, or a
   * round-trip will double-apply the shift.
   */
  setPosition(x: number, y: number, z: number) {
    this.armature.move(new Vec3(x, this.groundToEntityY(y), z));
  }

  /**
   * The character's current position in the armature entity's parent space, in
   * the same convention {@link setPosition} takes (`y` at ground contact).
   *
   * The exact inverse of {@link setPosition}: reading a position and writing it
   * straight back is a no-op. That is the property to preserve - it is what
   * lets a caller integrate velocity, tween, or clamp against a position it
   * read without the ground shim compounding once per frame.
   *
   * Returns a fresh {@link Vec3}; the entity's own vector is not exposed.
   */
  getPosition(): Vec3 {
    const p = this.armature.entity.getLocalPosition();
    return new Vec3(p.x, this.entityToGroundY(p.y), p.z);
  }

  /** Set the character's rotation in Euler degrees. Triggers a splat re-sort. */
  setRotation(xDeg: number, yDeg: number, zDeg: number) {
    this.armature.entity.setLocalEulerAngles(xDeg, yDeg, zDeg);
    this.requestSort();
  }

  /** Set non-uniform scale. Triggers a splat re-sort. */
  setScale(x: number, y: number, z: number) {
    this.armature.entity.setLocalScale(x, y, z);
    this.requestSort();
  }

  /**
   * Immediately start a registered animation (no crossfade).
   *
   * The animation must have been registered on the scene via
   * {@link Animation.register} or embedded in the `.bin` bundle.
   *
   * @param animName - Animation name in `scene.skeletalAnimationLibrary`.
   * @param opts.loop - Loop playback. Default `true`.
   * @param opts.rootMotion - Drive the armature position from the pelvis X/Z channel. Default `false`.
   * @returns `true` if the animation was found and started; `false` otherwise.
   */
  playAnimation(animName: string, opts?: { loop?: boolean; rootMotion?: boolean }): boolean {
    return this.armature.playAnimation(
      animName,
      opts?.rootMotion ?? false,
      opts?.loop ?? true,
    );
  }

  /**
   * Smoothly blend from the current pose to a new animation.
   *
   * Snapshots the current bone poses and interpolates toward the new
   * animation over `duration` seconds. Safe to call mid-crossfade - always
   * starts from wherever bones actually are.
   *
   * @param animName - Animation name in `scene.skeletalAnimationLibrary`.
   * @param opts.duration - Crossfade length in seconds. Default `0.08`.
   * @param opts.loop - Loop the target animation. Default `true`.
   * @param opts.rootMotion - Drive the armature position from the pelvis X/Z channel. Default `false`.
   * @returns `true` if the animation was found and the blend started; `false` otherwise.
   */
  crossfadeTo(
    animName: string,
    opts?: { duration?: number; loop?: boolean; rootMotion?: boolean; preserveTime?: boolean; continueSource?: boolean; easing?: 'linear' | 'smoothstep' },
  ): boolean {
    return this.armature.crossfadeTo(animName, opts);
  }

  /**
   * Play `animName` on the named overlay layer, restricted to a bone mask.
   * Layers compose over the base animation each frame - masked bones blend
   * toward the overlay by `opts.weight` (defaults to `1`).
   *
   * Pass `opts.region: 'upperBody' | 'lowerBody'` to use the built-in masks
   * (canonical 86-bone rig), or `opts.mask` directly to supply your own.
   *
   * Typical use: `character.playAnimation('walk_loop'); character.playLayer('aim', 'aim_rifle', { region: 'upperBody' });`
   */
  playLayer(
    layerName: string,
    animName: string,
    opts?: {
      region?: BodyRegion;
      mask?: BoneMask;
      loop?: boolean;
      crossfade?: number;
      weight?: number;
    },
  ): boolean {
    let mask = opts?.mask;
    if (!mask && opts?.region) mask = makeRegionMask(opts.region, this.armature.boneNames);
    if (!mask) return false;
    return this.armature.playLayerAnimation(layerName, animName, mask, opts);
  }

  /** Set the overlay weight (0..1) on a layer. */
  setLayerWeight(layerName: string, weight: number): void {
    this.armature.setLayerWeight(layerName, weight);
  }

  /** Stop and tear down a layer; ramps weight to zero over `fadeDuration` if > 0. */
  stopLayer(layerName: string, fadeDuration = 0): void {
    this.armature.stopLayer(layerName, fadeDuration);
  }

  /** Pause or resume every active overlay layer at once. */
  setAllLayersPaused(paused: boolean): void {
    this.armature.setAllLayersPaused(paused);
  }

  /**
   * Name of the currently-playing animation, or `null` if no animation is
   * active. Mirrors {@link Armature.currentAnimationName}.
   */
  get currentAnimationName(): string | null {
    return this.armature.currentAnimationName;
  }

  /** `true` if an animation is currently active. */
  get isPlaying(): boolean {
    return this.armature.isPlaying;
  }

  /**
   * Playback-speed multiplier for the active clip (`1` = author speed, `2` =
   * double speed). Scales only how fast animation time advances, not the
   * authored frame rate or crossfade timing. Mirrors
   * {@link Armature.playbackSpeed}. Use it to tie a locomotion clip's speed
   * to the entity's movement speed.
   */
  get playbackSpeed(): number {
    return this.armature.playbackSpeed;
  }

  /** Position in the base clip, in frames (30 fps by convention). Set it to
   *  seek - e.g. to a clip's touchdown frame when the physics lands. */
  get animationTime(): number {
    return this.armature.animationTime;
  }
  set animationTime(v: number) {
    this.armature.animationTime = v;
  }
  set playbackSpeed(v: number) {
    this.armature.playbackSpeed = v;
  }

  /**
   * `true` when a non-looping animation has reached its last frame and is no
   * longer advancing.
   */
  get isFinished(): boolean {
    return this.armature.isFinished;
  }

  /**
   * Subscribe to frame-aligned animation events fired as `animTime` advances.
   * The active animation's {@link Animation.events} array is the source; the
   * engine doesn't interpret `name` or `payload` - games define their own
   * vocabulary and route inside the callback.
   *
   * Listeners persist across animation switches. Returns an unsubscribe handle.
   *
   * @example
   * ```ts
   * character.onAnimEvent((e) => {
   *   if (e.name === 'footstep') playFootstepSfx(e.payload);
   * });
   * ```
   */
  onAnimEvent(cb: AnimEventCallback): () => void {
    return this.armature.onAnimEvent(cb);
  }

  /**
   * Stop playback.
   *
   * With `fadeDuration = 0` (the default), snaps immediately to the rest
   * pose. A positive value crossfades back to rest over that many seconds.
   */
  stop(fadeDuration = 0) {
    this.armature.stop(fadeDuration);
  }

  /**
   * Read and reset the pelvis X/Z delta the animation produced since the
   * last call. Only meaningful when
   * {@link Armature.rootMotionMode | armature.rootMotionMode} is `'extract'`;
   * returns `{0, 0}` otherwise.
   *
   * Typical use: a motor / character controller reads this each tick and
   * feeds it into its own velocity integration, so animation root motion
   * composes cleanly with physics, networking, or input.
   *
   * ```ts
   * scene.app.on('update', (dt) => {
   *   const { dx, dz } = character.consumeRootMotionDelta();
   *   motor.setMoveVelocity(dx / dt, dz / dt);
   *   motor.update(dt);
   * });
   * ```
   */
  consumeRootMotionDelta(): { dx: number; dz: number } {
    return this.armature.consumeRootMotionDelta();
  }

  /** True while the character is ticking + rendering (see {@link setActive}). */
  get active(): boolean { return this._active; }

  /**
   * Activate / deactivate this character WITHOUT releasing GPU resources -
   * the basis for object pooling. Deactivating detaches the per-frame update
   * handler and disables every splat entity + the armature entity, so the
   * character stops animating and rendering but keeps all its splats,
   * textures and compiled shaders alive. Reactivating re-attaches the update
   * handler and re-enables the armature; render-LOD then re-picks which splat
   * shows on the next frame (so we only force the current level visible to
   * cover the LOD-disabled case).
   *
   * Reactivate is the cheap path that skips the entire `new Splat` setup cost
   * (texture creation + bone upload + shader compile, ~tens of ms per
   * character) that a fresh {@link load} pays. Callers reposition via
   * `armature.move(...)` and restart animation via `playAnimation(...)` after
   * reactivating.
   *
   * Idempotent.
   */
  setActive(on: boolean): void {
    if (on === this._active) return;
    this._active = on;
    if (on) {
      this.armature.entity.enabled = true;
      // Show the current LOD level; render-LOD (if enabled) re-evaluates and
      // fixes this on the next update. With LOD off, splats.length === 1 and
      // this is the only one.
      this.splats[this._activeLevel]?.setRenderingEnabled(true);
      for (const s of this._variantSplats) s.setRenderingEnabled(true);
      for (const s of this._overlaySplats) s.setRenderingEnabled(true);
      this._scene.app.on('update', this._updateHandler);
    } else {
      this._scene.app.off('update', this._updateHandler);
      for (const s of this.splats) s.setRenderingEnabled(false);
      for (const s of this._variantSplats) s.setRenderingEnabled(false);
      for (const s of this._overlaySplats) s.setRenderingEnabled(false);
      this.armature.entity.enabled = false;
    }
  }

  /**
   * Detach the per-frame playback tick without touching rendering/GPU
   * resources (unlike {@link setActive}). For hosts that drive the armature's
   * clock themselves and apply their own per-frame pose edits, the auto-tick
   * would re-evaluate and overwrite those edits. Idempotent.
   */
  detachAutoUpdate(): void {
    this._scene.app.off('update', this._updateHandler);
  }

  /**
   * Release all GPU/CPU resources: removes the scene update handler, unlinks
   * the splat from the armature, destroys both, and removes the armature
   * entity from the scene graph.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._scene.app.off('update', this._updateHandler);
    for (const s of this.splats) {
      this.armature.unlinkSplat(s);
      s.destroy();
    }
    for (const s of this._variantSplats) {
      this.armature.unlinkSplat(s);
      s.destroy();
    }
    this._variantSplats.length = 0;
    for (const s of this._overlaySplats) {
      this.armature.unlinkSplat(s);
      s.destroy();
    }
    this._overlaySplats.length = 0;
    this.armature.entity.destroy();
  }
}
