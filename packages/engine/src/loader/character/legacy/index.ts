/**
 * The legacy door.
 *
 * Everything whose first 8 bytes are not `VIGGCHAR` arrives here, and nothing
 * else does. Behind it are the two container generations that shipped before
 * the format was respecified:
 *
 *   `VFCHARB1` -> interleaved per-splat records (v1 fp32, v2 fp16)
 *   `VFCHARB2` -> planar byte planes (v3; fp16 or q23 precision)
 *   `VSPLAT01` -> the pre-release prototype of the planar layout
 *
 * These readers are PERMANENT, not migration scaffolding. Files already in
 * storage keep their old magic forever - there is no backfill - so this module
 * is kept indefinitely and its decoders are moved, never improved. What it is
 * NOT is entangled: it is one branch of one top-level `if`, it imports nothing
 * from `../v1/`, and `../v1/` imports nothing from it.
 *
 * These containers spell `version` as one global lineage across two magics,
 * which is precisely the accretion `VIGGCHAR` exists to end. Nothing about that
 * lineage leaks past this file: the dispatcher upstream never reads it, and the
 * bundle handed back is the same version-independent shape `v1/` returns.
 */

import { CharacterBundleError } from '../types';
import type { DecodeResult, DecodedBundle } from '../types';
import { CHARACTER_BUNDLE_MAGIC, parseBinaryGsplat } from './interleaved-splat';
import { isPlanarMagic, parsePlanarSplats, readMagic } from './planar-splat';

/** The header keys the legacy rules below read; the rest is diagnostics. */
type LegacyHeader = {
  corrections?: unknown;
  ankleCorrection?: unknown;
  joints?: { count: number };
  skeleton?: { count: number };
} | null | undefined;

/**
 * Did this bundle go through the character-correction pipeline?
 *
 * A LEGACY question with a legacy answer. The old writers agree on the meaning
 * and disagree on the spelling, so both are accepted:
 *
 * - `corrections`      - the production encoder, which stamps this header ONLY
 *   when the corrections ran. That makes presence an exact test: with the
 *   corrections switched off the encoder is byte-identical to its
 *   pre-correction self, receipt included.
 * - `ankleCorrection`  - the offline authoring writer, which writes the ankle
 *   block at the top level and no `corrections` key at all.
 *
 * `groundOffset` and `visibleBounds` are deliberately NOT accepted: the writer
 * emits them unconditionally, so they say "written recently", not "corrected".
 *
 * Two spellings for one fact is exactly how a gate like this rots, and it is
 * why `VIGGCHAR` version 1 carries no receipt at all - the version means
 * corrected, so there is no question left to ask. Nothing here is shared with
 * that path; a receipt is a property of these containers only.
 */
function hasCorrectionReceipt(header: unknown): boolean {
  const h = header as LegacyHeader;
  return h?.corrections != null || h?.ankleCorrection != null;
}

/**
 * How many bones the rig this bundle poses has, by the legacy rules.
 *
 * Three header keys can answer, in a fixed order of trust, and `0` means the
 * bundle carries no rig. This is lifted verbatim out of `binary-gsplat.ts`,
 * where it used to run downstream of the worker on a header only these
 * containers produce; it belongs to them, so it moved in with them.
 */
function legacyRigBoneCount(header: unknown, animNumFrames: number, animNumBones: number): number {
  const h = header as LegacyHeader;
  if (!h?.joints && !h?.skeleton) return 0;
  let numBones = animNumFrames > 0 && animNumBones > 0 ? animNumBones : 0;
  if (numBones === 0 && h.skeleton) numBones = h.skeleton.count;
  if (numBones === 0 && h.joints) numBones = h.joints.count;
  return numBones > 0 ? numBones : 0;
}

/**
 * Decode a bundle in one of the pre-`VIGGCHAR` containers.
 *
 * The container is identified by SNIFFING THE 8-BYTE MAGIC and never by the
 * filename or a header key - both generations arrive through the same URLs,
 * with no out-of-band type information, so the bytes are the only honest
 * answer. Anything this door does not recognise throws with the magic it
 * actually found.
 */
async function decodeLegacyBundle(file: ArrayBuffer): Promise<DecodeResult> {
  if (file.byteLength < 12) {
    throw new CharacterBundleError(
      'WrongMagic',
      `character bundle is ${file.byteLength} B, too small to carry a magic`,
    );
  }
  const magic = readMagic(file);

  let decoded: Awaited<ReturnType<typeof parsePlanarSplats>> | ReturnType<typeof parseBinaryGsplat>;
  if (isPlanarMagic(magic)) {
    decoded = await parsePlanarSplats(file);
  } else if (magic === CHARACTER_BUNDLE_MAGIC) {
    decoded = parseBinaryGsplat(file);
  } else {
    throw new CharacterBundleError(
      'WrongMagic',
      `unrecognised character bundle magic '${magic}'`,
    );
  }

  const { result, transferables } = decoded;
  // The decoders above are untouched, so the two version-independent answers
  // are computed here from what they returned. Cast because the legacy planar
  // reader also carries `nativeFloat16` / `planeCompression` diagnostics on the
  // worker message, which predate this interface and are kept for the A/B rig.
  const bundle: DecodedBundle = {
    ...result,
    rigBoneCount: legacyRigBoneCount(result.header, result.animNumFrames, result.animNumBones),
    corrected: hasCorrectionReceipt(result.header),
    // Never. A legacy joints block is diagnostics: it was not vetted as a
    // posing rest, and every shipped legacy character renders against the
    // canonical tables. Independent of the receipt above on purpose.
    bundledRestIsPerCharacter: false,
  } as DecodedBundle;

  return { result: bundle, transferables };
}

export { decodeLegacyBundle };
