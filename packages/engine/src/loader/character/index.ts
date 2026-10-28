/**
 * Character-bundle reader: the dispatch table and the public entry point.
 *
 * ONE top-level branch, and legacy behind one door:
 *
 *     magic == VIGGCHAR  ->  look `version` up in VERSION_HANDLERS
 *     otherwise          ->  legacy/
 *
 * That is the whole structure, and it is the point of it: adding version N+1
 * costs one module under `vN/` and one line in the table below, and removing a
 * version costs deleting exactly those two things. If a change to support a new
 * version has to touch an existing handler, the decomposition is not real.
 * (Character-bundle format spec, "Reader architecture", R1-R5.)
 *
 * The only bytes read before dispatch are the 16 container bytes. Nothing here
 * sniffs the payload, peeks at the header, tries a parse, or consults the
 * filename, the extension, the URL or the MIME type - the `.vsplat` extension
 * is advisory and says nothing this reader may act on.
 */

import { CharacterBundleError } from './types';
import type { DecodeResult, VersionHandler } from './types';
import { decodeLegacyBundle } from './legacy';
import { decodeV1 } from './v1/decode';

/**
 * The format tag, compared as 8 bytes and never decoded as an integer.
 *
 * Loading it as one or two integers would make the comparison depend on byte
 * order, and a magic whose numeric spelling differs per platform is a magic
 * that fails on one of them.
 */
const VIGGCHAR_MAGIC = new Uint8Array([0x56, 0x49, 0x47, 0x47, 0x43, 0x48, 0x41, 0x52]); // 'VIGGCHAR'

/** Bytes of container: `magic` (8) + `version` (4) + `totalLength` (4). */
const CONTAINER_BYTES = 16;

/**
 * The dispatch table: payload version -> the one handler that decodes it.
 *
 * A SET of versions, not a range. There is no ordering relation here - a
 * higher version is not "newer and probably compatible", it is unknown, and
 * unknown is a hard failure.
 */
const VERSION_HANDLERS: ReadonlyMap<number, VersionHandler> = new Map([
  [1, decodeV1],
]);

/** True when the first 8 bytes are exactly `VIGGCHAR`. */
function hasViggcharMagic(file: ArrayBuffer): boolean {
  if (file.byteLength < VIGGCHAR_MAGIC.length) return false;
  const bytes = new Uint8Array(file, 0, VIGGCHAR_MAGIC.length);
  for (let i = 0; i < VIGGCHAR_MAGIC.length; i++) {
    if (bytes[i] !== VIGGCHAR_MAGIC[i]) return false;
  }
  return true;
}

/**
 * Read a character bundle of any container this reader implements.
 *
 * @param file - the whole file as a read-only byte buffer.
 * @returns the decoded bundle in the version-independent output type, plus the
 * buffers a worker may transfer rather than copy. A caller cannot tell from the
 * result which handler ran.
 * @throws {CharacterBundleError} carrying the spec's error category.
 */
async function parseCharacterBundle(file: ArrayBuffer): Promise<DecodeResult> {
  // Not our file. A caller may reasonably try another format - which is why
  // this is the one branch that leaves, rather than rejecting outright.
  if (!hasViggcharMagic(file)) {
    return await decodeLegacyBundle(file);
  }

  if (file.byteLength < CONTAINER_BYTES) {
    throw new CharacterBundleError(
      'Truncated',
      `file is ${file.byteLength} B, shorter than the ${CONTAINER_BYTES} B container`,
    );
  }

  const view = new DataView(file);
  const version = view.getUint32(8, true);
  const handler = VERSION_HANDLERS.get(version);
  if (!handler) {
    // No fallback, no "probably compatible", no speculative parse, no partial
    // decode. The supported set is reported so the caller knows what to do.
    throw new CharacterBundleError(
      'UnknownVersion',
      `file declares version ${version}; this reader implements ` +
        `${[...VERSION_HANDLERS.keys()].sort((a, b) => a - b).join(', ')}`,
    );
  }

  // Carried rather than taken from the transport: a truncated download or a
  // clipped upload otherwise arrives with an intact header and a short last
  // block, and surfaces as a broken character instead of an error. Trailing
  // bytes beyond it are ignored, so the container can be embedded in a larger
  // stream.
  const totalLength = view.getUint32(12, true);
  if (totalLength < CONTAINER_BYTES) {
    throw new CharacterBundleError(
      'Truncated',
      `header declares totalLength ${totalLength} B, below the ${CONTAINER_BYTES} B container`,
    );
  }
  if (file.byteLength < totalLength) {
    throw new CharacterBundleError(
      'Truncated',
      `header declares totalLength ${totalLength} B, but the file is ${file.byteLength} B`,
    );
  }

  return await handler(file, CONTAINER_BYTES, totalLength - CONTAINER_BYTES);
}

export { parseCharacterBundle, CharacterBundleError };
export type { DecodeResult };
