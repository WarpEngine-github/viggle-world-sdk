import type { AppBase, Asset } from 'playcanvas';
import { Asset as PcAsset, GSplatResource } from 'playcanvas';

import { setAssetExtras } from './asset-extras';
import { loadBinaryGsplat } from '../character/binary-gsplat';
import { cachedFetch } from './bin-cache';
import { loadGsplat } from '../environment/gsplat';
import { createSpzResource, loadSpzGsplatData } from '../environment/spz';
import { loadVsplat } from '../character/vsplat';
import type { AssetSource } from './asset-source';
import type { ArmatureData, SplatWeights } from '../../types';

interface RawAnimationData {
  data: Float32Array;
  numFrames: number;
  numBones: number;
  keyframeFrames?: number[];
}

export interface LoadResult {
  asset: Asset;
  splatWeights?: SplatWeights;
  animationData?: RawAnimationData;
  armatureData?: ArmatureData;
}

function buildLoadResult(
  app: AppBase,
  fname: string,
  url: string | undefined,
  binResult: Awaited<ReturnType<typeof loadBinaryGsplat>>,
): LoadResult {
  const asset = new PcAsset(fname, 'gsplat', url ? { url, filename: fname } : { filename: fname });
  app.assets.add(asset);
  asset.resource = new GSplatResource(app.graphicsDevice, binResult.gsplatData);
  asset.loaded = true;

  setAssetExtras(asset, {
    splatWeights: binResult.splatWeights,
    animationData: binResult.animationData,
    splatSourceBoneCount: (binResult.header as { numBones?: number } | null)?.numBones ?? binResult.armatureData?.numBones,
  });

  return {
    asset,
    splatWeights: binResult.splatWeights,
    animationData: binResult.animationData,
    armatureData: binResult.armatureData,
  };
}

/**
 * Process-wide ArrayBuffer cache for `.bin` bundle URLs. Saves a network
 * round-trip when the same character asset is loaded many times.
 *
 * What we DON'T cache:
 *  - parsed `BinaryGsplatResult` (its typed arrays are detached when
 *    handed to the worker, so a cached parse can't be reused)
 *  - GPU resources (`GSplatResource`, textures) - each character needs
 *    its own skin palette texture, so per-character upload is required
 *
 * The cache is unbounded and keyed by the URL's PATH (query string
 * stripped); for a typical game session this is fine (a handful of
 * distinct .bin paths). Concurrent loads for the same path share a single
 * in-flight fetch.
 *
 * Why strip the query: signed CDN URLs carry a short-lived `?verify=` /
 * `?X-Amz-...` token that the backend re-issues on every list fetch. The
 * underlying object is identical, only the token differs - so keying on
 * the full URL would miss the cache and re-download the same bytes every
 * time the token rotates (any navigation that triggers a fresh list fetch
 * will do it). The path (a content hash or stable id) is the real identity.
 */
const _binBufferCache = new Map<string, ArrayBuffer>();
const _binBufferLoading = new Map<string, Promise<ArrayBuffer>>();

/** Cache identity for a (possibly signed) asset URL: the URL without its
 *  query string, so a re-signed token doesn't fork the cache entry. Falls
 *  back to the raw URL if it can't be parsed (e.g. a bare relative path
 *  with no origin - still fine, just no query to strip in practice). */
function cacheKeyFor(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export async function fetchBinBuffer(url: string): Promise<ArrayBuffer> {
  const key = cacheKeyFor(url);

  // Check in-memory cache first (fastest)
  const cached = _binBufferCache.get(key);
  if (cached) return cached;

  const inflight = _binBufferLoading.get(key);
  if (inflight) return inflight;

  // Use cachedFetch for persistent caching (Cache API), then store in-memory
  const promise = cachedFetch(url).then(async (res) => {
    if (!res.ok) throw new Error(`[loadBinaryAsset] fetch failed (${res.status}): ${url}`);
    const buf = await res.arrayBuffer();
    _binBufferCache.set(key, buf);
    return buf;
  }).finally(() => {
    _binBufferLoading.delete(key);
  });
  _binBufferLoading.set(key, promise);
  return promise;
}

/**
 * Load a character bundle with embedded armature + animation.
 *
 * Reads every container the engine implements - `VIGGCHAR` version 1 as well
 * as the legacy `VFCHARB1` (interleaved), `VFCHARB2` (planar) and `VSPLAT01` -
 * told apart by the file's 8-byte magic inside the parser, never by extension.
 * `.bin` is only the usual filename.
 *
 * Reuses a cached ArrayBuffer when the same URL has been fetched before;
 * each call still produces its own PC asset + GPU resources, since the
 * gsplat work-buffer / skin palette / shader bindings are per-entity.
 */
export async function loadBinaryAsset(
  app: AppBase,
  url: string,
  filename?: string,
): Promise<LoadResult> {
  const fname = filename ?? url.split('/').pop() ?? 'character.bin';
  const buffer = await fetchBinBuffer(url);
  // The decoder transfers these bytes to the worker, detaching them, so the
  // cached buffer needs a throwaway copy. Wrapping it in a File copies too,
  // but via the blob store and back - same copy, an IPC round-trip slower.
  const bytes = buffer.slice(0);
  const result = await loadBinaryGsplat({ filename: fname, contents: bytes });
  return buildLoadResult(app, fname, url, result);
}

/**
 * Load a `.bin` character bundle from in-memory bytes.
 *
 * Same parsing path as {@link loadBinaryAsset} but without a network fetch.
 * Use when a game generates a character at runtime (an offline generation
 * pipeline's output handed over in memory) or hot-swaps a bundle without going
 * through the asset server.
 */
export async function loadBinaryAssetFromBytes(
  app: AppBase,
  bytes: Uint8Array,
  filename?: string,
): Promise<LoadResult> {
  const fname = filename ?? 'character.bin';
  // Copy so the transfer to the worker can't detach the caller's array.
  const copy = bytes.slice().buffer;
  const result = await loadBinaryGsplat({ filename: fname, contents: copy });
  return buildLoadResult(app, fname, undefined, result);
}

/**
 * Load a `.vsplat` character bundle.
 *
 * The extension is advisory and nothing here acts on it: the bytes go to the
 * same magic-dispatching reader {@link loadBinaryAsset} uses, so a `.vsplat`
 * may be a `VIGGCHAR` version 1 bundle or one of the legacy planar containers,
 * and the result is the same {@link LoadResult} either way.
 *
 * The one difference from {@link loadBinaryAsset} is that this path skips the
 * process-wide in-memory `ArrayBuffer` cache, so a repeat load measures a fresh
 * decode. The bytes are still persisted by the Cache API layer in `bin-cache`
 * (`.vsplat` is path-normalised there), so a reload does not re-download.
 */
export async function loadVsplatAsset(
  app: AppBase,
  url: string,
  filename?: string,
): Promise<LoadResult> {
  const fname = filename ?? url.split('/').pop() ?? 'character.vsplat';
  const result = await loadVsplat({ url, filename: fname });
  return buildLoadResult(app, fname, url, result);
}

/** In-memory variant of {@link loadVsplatAsset}. */
export async function loadVsplatAssetFromBytes(
  app: AppBase,
  bytes: Uint8Array,
  filename?: string,
): Promise<LoadResult> {
  const fname = filename ?? 'character.vsplat';
  const file = new File([bytes as BlobPart], fname, { type: 'application/octet-stream' });
  const result = await loadVsplat({ filename: fname, contents: file });
  return buildLoadResult(app, fname, undefined, result);
}

/**
 * Load a Gaussian-splat file as a PlayCanvas `gsplat` asset.
 *
 * Supports `.ply` (and the PlayCanvas-native `.compressed.ply`, `.sog`,
 * `.sogs` variants) through PlayCanvas's own handler, and `.spz` through
 * [`spz-js`](https://www.npmjs.com/package/spz-js) read straight into splat
 * data - no intermediate PLY, see `loader/environment/spz.ts`.
 *
 * Mount the returned asset on any entity with the built-in `gsplat`
 * component. Splats on one layer sort together (PlayCanvas's unified
 * rendering), so an environment and the characters sharing its layer
 * interleave correctly.
 *
 * @param app - The PlayCanvas application.
 * @param url - URL to fetch.
 * @param filename - Optional explicit filename. Used to pick the extension
 * when the URL has none (e.g. signed CDN URLs). Defaults to the basename
 * of `url`.
 *
 * @example
 * ```ts
 * const asset = await loadSplatAsset(scene.app, '/assets/room.spz');
 * const env = new Entity('environment');
 * env.addComponent('gsplat', { asset });
 * scene.contentRoot.addChild(env);
 * ```
 *
 * @group Splats
 */
export async function loadSplatAsset(
  app: AppBase,
  url: string,
  filename?: string,
): Promise<Asset> {
  const fname = filename ?? url.split('/').pop() ?? 'splat';
  const assetSource: AssetSource = { url, filename: fname };

  if (fname.toLowerCase().endsWith('.spz')) {
    const gsplatData = await loadSpzGsplatData(assetSource);
    // Already Morton-ordered, in the decode worker (`spz-decode.ts`).
    const asset = new PcAsset(fname, 'gsplat', { url, filename: fname });
    app.assets.add(asset);
    asset.resource = createSpzResource(app.graphicsDevice, gsplatData);
    asset.loaded = true;
    return asset;
  }

  return loadGsplat(app.assets, assetSource);
}
