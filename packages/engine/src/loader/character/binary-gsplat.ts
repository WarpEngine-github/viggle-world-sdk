import { GSplatData } from 'playcanvas';

import type { AssetSource } from '../shared/asset-source';
import type { DecodedBundle } from './types';
import { createReadSource } from '../shared/asset-source';
import type { ArmatureData, BinaryGsplatResult } from '../../types';

interface RawAnimationData {
  data: Float32Array;
  numFrames: number;
  numBones: number;
  keyframeFrames?: number[];
}

// Parsing runs on one Web Worker shared by every load, so the spawn and module
// eval are paid once per page rather than per character. Requests carry an id
// and replies are routed on it. The worker is dropped only after it faults.
type Pending = { resolve: (v: DecodedBundle) => void; reject: (e: unknown) => void };

let sharedWorker: Worker | null = null;
let nextRequestId = 0;
const pending = new Map<number, Pending>();

function spawnWorker(): Worker {
  // Two readers, two spellings. This is the source spelling; `build.mjs`
  // rewrites it for the published build.
  //
  // A bundler pointed at `engine/src` (a consumer vendoring this source tree
  // rather than the package) resolves this URL as a literal path and does NOT
  // substitute extensions the way it would for an import, so against the
  // source tree the only spelling that resolves is the real filename - `.ts`.
  //
  // The tarball contains no `.ts` and emits this string verbatim, so shipped
  // unchanged it would 404 on a file that only ever existed in our source
  // tree and every character load would fail. `build.mjs` swaps the
  // extension for that build alone, and fails the build if this literal ever
  // stops matching. What lands in `dist/index.js` is the canonical idiom
  // beside a real `dist/binary-gsplat-worker.js`, which Vite and webpack 5
  // both re-emit as the consumer's own worker chunk.
  //
  // Written inline on purpose: `new Worker(new URL(<literal>, import.meta.url))`
  // is a syntactic pattern to those bundlers, not an expression they
  // evaluate. Hoist the URL into a variable and neither one emits a worker.
  const worker = new Worker(
    new URL('./binary-gsplat-worker.ts', import.meta.url),
    { type: 'module', name: 'binary-gsplat' },
  );
  worker.onmessage = (e: MessageEvent) => {
    const entry = pending.get(e.data.id);
    if (!entry) return;
    pending.delete(e.data.id);
    if (e.data.ok) {
      entry.resolve(e.data);
    } else {
      // The reader's error category rides along, so a caller can tell "not a
      // character bundle" from "a character bundle, broken" without matching
      // on the message text.
      const err = new Error(e.data.error) as Error & { category?: string };
      if (e.data.category) err.category = e.data.category;
      entry.reject(err);
    }
  };
  worker.onerror = (err) => {
    // Fail everything in flight; the next load spawns a fresh worker.
    worker.terminate();
    if (sharedWorker === worker) sharedWorker = null;
    // An `ErrorEvent` is not an `Error`: rejecting with it raw gives callers
    // `[object Event]` and no `.message`. It also arrives for two very
    // different reasons, and the one worth naming is the load failure - the
    // worker ships as its own file beside the bundle, and a build that
    // relocates the library without re-emitting it leaves this URL pointing
    // at nothing. Vite's dev-time dependency pre-bundling does exactly that;
    // `optimizeDeps.exclude` is the one-line fix and is the first thing to
    // check when this fires.
    const detail = typeof err === 'string' ? err : (err as ErrorEvent)?.message;
    const failure = new Error(
      `Character-decode worker failed to start${detail ? `: ${detail}` : ''}. ` +
      'The worker is a separate file shipped next to the engine bundle; if your ' +
      'bundler moved the bundle without re-emitting it, the URL no longer resolves. ' +
      "For Vite dev servers add optimizeDeps: { exclude: ['@viggle/splat-engine'] }.",
    );
    const failed = [...pending.values()];
    pending.clear();
    failed.forEach((p) => p.reject(failure));
  };
  return worker;
}

function parseInWorker(buffer: ArrayBuffer): Promise<DecodedBundle> {
  return new Promise((resolve, reject) => {
    if (!sharedWorker) sharedWorker = spawnWorker();
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    sharedWorker.postMessage({ id, buffer }, [buffer]);
  });
}

/** Spawn the decode worker early so its startup overlaps the bundle download. */
export function warmCharacterDecoder(): void {
  if (!sharedWorker) sharedWorker = spawnWorker();
}

/**
 * Load a character bundle, of any container this engine reads.
 *
 * The worker hands the bytes to `loader/character`, which takes ONE branch on
 * the 8-byte magic: `VIGGCHAR` looks its payload version up in a table, and
 * anything else goes to the legacy readers (`VFCHARB1` interleaved, `VFCHARB2`
 * planar). Bundles of every generation are served from the same URLs, with no
 * out-of-band type information, so the container can only be identified from
 * the bytes.
 *
 * Everything below this line is layout-blind and version-blind: every reader
 * returns the same Float32 attribute arrays and the same resolved answers about
 * the rig, so nothing here can tell which one ran.
 */
const loadBinaryGsplat = async (
  assetSource: AssetSource,
): Promise<BinaryGsplatResult> => {
  const source = await createReadSource(assetSource);
  const bundleBuffer = await source.arrayBuffer();

  const parsed = await parseInWorker(bundleBuffer);

  const { header, numSplats, splats } = parsed;

  const gsplatData = new GSplatData([
    {
      name: 'vertex',
      count: numSplats,
      properties: [
        { type: 'float', name: 'x', storage: splats.x as Float32Array, byteSize: 4 },
        { type: 'float', name: 'y', storage: splats.y as Float32Array, byteSize: 4 },
        { type: 'float', name: 'z', storage: splats.z as Float32Array, byteSize: 4 },
        { type: 'float', name: 'opacity', storage: splats.opacity as Float32Array, byteSize: 4 },
        { type: 'float', name: 'rot_0', storage: splats.rot_0 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'rot_1', storage: splats.rot_1 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'rot_2', storage: splats.rot_2 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'rot_3', storage: splats.rot_3 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'f_dc_0', storage: splats.f_dc_0 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'f_dc_1', storage: splats.f_dc_1 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'f_dc_2', storage: splats.f_dc_2 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'scale_0', storage: splats.scale_0 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'scale_1', storage: splats.scale_1 as Float32Array, byteSize: 4 },
        { type: 'float', name: 'scale_2', storage: splats.scale_2 as Float32Array, byteSize: 4 },
      ],
    },
  ]);

  let armatureData: ArmatureData | undefined;
  let animationData: RawAnimationData | undefined;
  const boneIndices = parsed.boneIndices as Uint16Array | null;
  const boneWeights = parsed.boneWeights as Float32Array | null;

  if (parsed.animationArray && parsed.animNumFrames > 0 && parsed.animNumBones > 0) {
    animationData = {
      data: parsed.animationArray as Float32Array,
      numFrames: parsed.animNumFrames as number,
      numBones: parsed.animNumBones as number,
    };
  }

  // Both answers come from the reader, already resolved. Asking the header
  // here would mean a branch per container generation living outside the
  // decoders: the legacy bundles spell the rig size three ways and carry a
  // correction receipt in either of two spellings, while a `VIGGCHAR` version 1
  // header has no key for either - the version means corrected, and the rig
  // size is the joints block's row count.
  if (parsed.rigBoneCount > 0) {
    armatureData = { numBones: parsed.rigBoneCount as number };
    if (parsed.jointsArray) {
      armatureData.joints = parsed.jointsArray as Float32Array;
      armatureData.corrected = parsed.corrected as boolean;
      armatureData.restIsPerCharacter = parsed.bundledRestIsPerCharacter as boolean;
    }
  }

  return {
    gsplatData,
    armatureData,
    animationData,
    header,
    splatWeights:
      boneIndices && boneWeights
        ? { indices: boneIndices, weights: boneWeights }
        : undefined,
  };
};

export { loadBinaryGsplat };
