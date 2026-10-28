/**
 * The one interface every character-bundle version handler satisfies, and the
 * one error type they all fail with.
 *
 * This module is version-agnostic on purpose and holds no knowledge of any
 * particular version: it is the boundary that lets `index.ts` treat `v1/` and
 * `legacy/` as interchangeable, and the reason adding version N+1 costs exactly
 * one module and one registry entry
 * (character-bundle format spec, R2/R3).
 */

/**
 * Error categories, from the spec's `Errors` table.
 *
 * A caller distinguishes "not our file" (`WrongMagic`) from "our file, broken"
 * (everything else) without parsing a message string.
 */
type BundleErrorCategory =
  | 'WrongMagic'
  | 'UnknownVersion'
  | 'Truncated'
  | 'MalformedHeader'
  | 'UnalignedPayload'
  | 'MissingField'
  | 'UnexpectedField'
  | 'BadFieldValue'
  | 'BlockSizeMismatch'
  | 'InconsistentHeader';

/**
 * A rejection carrying its category.
 *
 * The category travels over the worker boundary alongside the message, so the
 * main thread can tell a foreign file from a corrupt one without re-reading the
 * bytes. The message names the offending block or field and reports the value
 * found next to the value expected.
 */
class CharacterBundleError extends Error {
  readonly category: BundleErrorCategory;

  constructor(category: BundleErrorCategory, message: string) {
    super(`[${category}] ${message}`);
    this.name = 'CharacterBundleError';
    this.category = category;
  }
}

/** The 14 Float32 attribute arrays the GPU pipeline consumes, one per column. */
interface SplatAttributes {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  scale_0: Float32Array;
  scale_1: Float32Array;
  scale_2: Float32Array;
  /** Quaternion `w`. The engine wants `wxyz`, whatever order the file stores. */
  rot_0: Float32Array;
  rot_1: Float32Array;
  rot_2: Float32Array;
  rot_3: Float32Array;
  f_dc_0: Float32Array;
  f_dc_1: Float32Array;
  f_dc_2: Float32Array;
  /** The LOGIT, not the alpha. */
  opacity: Float32Array;
}

/**
 * The version-independent decode output. Every handler returns this shape and a
 * caller cannot tell from it which handler ran.
 *
 * Three of these fields exist because the answer differs per version and the
 * QUESTION does not, so asking it downstream would put a per-version branch
 * outside the handlers - the one thing R2 forbids:
 *
 * - `rigBoneCount` - the legacy containers spell the rig's size three
 *   different ways across two magics; version 1 has no header key for it at all
 *   and derives it from `blocks.joints.count`.
 * - `corrected` - the legacy containers carry a correction receipt, in either
 *   of two spellings, and files exist both with and without it. Version 1 needs
 *   no receipt: the version itself means corrected, and the spec forbids a
 *   reader from looking for a signal.
 * - `bundledRestIsPerCharacter` - whether `jointsArray` is this character's own
 *   vetted rest pose, i.e. whether a consumer may pose the splats against it
 *   instead of against the shared canonical tables.
 */
interface DecodedBundle {
  /** The version's own header, verbatim. Diagnostics; nothing dispatches on it. */
  header: unknown;
  numSplats: number;
  splats: SplatAttributes;
  /** `numSplats * K` global rig indices, or `null` when unskinned. */
  boneIndices: Uint16Array | null;
  /** `numSplats * K` weights, matching `boneIndices`, or `null`. */
  boneWeights: Float32Array | null;
  animationArray: Float32Array | null;
  animNumFrames: number;
  animNumBones: number;
  /** Flat `[x,y,z] * rigBoneCount` rest translations, or `null` when no rig. */
  jointsArray: Float32Array | null;
  /** Bones in the rig this bundle poses. `0` when it carries no rig. */
  rigBoneCount: number;
  /** Whether the geometric corrections are baked into the splats and joints. */
  corrected: boolean;
  /**
   * Whether `jointsArray` is this character's OWN rest pose, vetted against the
   * gaussians it ships with - i.e. whether posing the splats from it (rather
   * than from the shared canonical rest tables) is correct.
   *
   * A separate question from `corrected`, and deliberately not derived from it.
   * `corrected` answers "did the correction pipeline run", which some legacy
   * files answer yes to and others no, from the same generation of writer;
   * this one answers "is the joints block authoritative", which is a property
   * of the CONTAINER:
   *
   * - version 1 - yes, by definition. The joint canonicalisation, the ankle
   *   pitch bake and the ground shift are all baked into the gaussians AND
   *   into this block, so the two agree and nothing else does.
   * - legacy    - no. Those joints were written for diagnostics, were never
   *   vetted as a posing rest, and the shipped characters render today against
   *   the canonical tables.
   *
   * Read by `Character`'s ground-convention shim, which must be able to tell
   * a v1 bundle from a legacy one WITHOUT keying on `corrected` - some legacy
   * bundles carry a receipt, and moving those would move already-shipped
   * characters. See `Character.bakedGroundShiftY`.
   */
  bundledRestIsPerCharacter: boolean;
}

/**
 * What a handler hands back: the bundle, plus the buffers the worker may
 * transfer instead of copying.
 */
interface DecodeResult {
  result: DecodedBundle;
  transferables: ArrayBuffer[];
}

/**
 * One payload version's reader.
 *
 * Given the whole file, the offset its payload begins at, and how long that
 * payload is. A handler is total over its own version, never learns that
 * another version exists, and never re-checks the magic or the version - the
 * dispatcher owns both.
 */
type VersionHandler = (
  file: ArrayBuffer,
  payloadOffset: number,
  payloadLength: number,
) => Promise<DecodeResult>;

export { CharacterBundleError };
export type {
  BundleErrorCategory,
  DecodeResult,
  DecodedBundle,
  SplatAttributes,
  VersionHandler,
};
