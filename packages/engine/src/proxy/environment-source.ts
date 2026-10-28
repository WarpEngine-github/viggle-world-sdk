/**
 * Environment -> {@link ProxyMeshInput}.
 *
 * An {@link Environment} is not a `Splat`: it wraps a PlayCanvas `Asset`
 * directly, and that asset is one of two very different things.
 *
 * - **A monolithic capture** (`Environment.load`: `.spz`, `.ply`, `.sog`). The
 *   asset's resource keeps its CPU-side columns - `GSplatData` for a PLY (an
 *   `.spz` arrives as one), or a compressed / SOG container that decompresses
 *   to it. One read, no network.
 * - **A streaming LOD octree** (`Environment.loadLodBundle`). The resource is a
 *   manifest; the gaussians live in per-level chunk files that PlayCanvas
 *   streams in and out by camera distance, and its streaming loader keeps no
 *   CPU copy of them (`minimalMemory`). So the proxy fetches ONE level's files
 *   itself, decompresses them, keeps the centres and alphas, and lets the
 *   assets go again.
 *
 * Positions come out in the environment entity's LOCAL space - the proxy is
 * parented to that entity, so the bundle's RDF->Y-up flip and any authored
 * transform apply to it exactly as they apply to the splats. No skinning.
 *
 * Internal. `SplatRelight` is the consumer.
 */

import { Asset } from 'playcanvas';
import type { GSplatData, Mat4 } from 'playcanvas';

import type { Environment } from '../loader/environment';

import { denseEnough, lodSlices, resolveLodLevel } from './environment-input';
import type { LodSlice, OctreeLike } from './environment-input';
import type { ProxyMeshInput } from './voxelizer';
import { alphaFromLogits } from './voxelizer';

/** What {@link proxyInputFromEnvironment} read, and from where. */
export interface EnvironmentProxySource {
  input: ProxyMeshInput;
  /** LOD level read, `null` for a monolithic capture. `0` is the finest. */
  lodLevel: number | null;
  /** Levels the bundle has; `1` for a monolithic capture. */
  lodLevels: number;
  /** Milliseconds from the call to the input being ready, fetches included. */
  loadMs: number;
}

/**
 * The largest axis scale of a local-to-world matrix - what turns a voxel size
 * in world metres into the local units the proxy is built in.
 */
export function maxAxisScale(localToWorld: Mat4): number {
  const d = localToWorld.data;
  const sx = Math.hypot(d[0], d[1], d[2]);
  const sy = Math.hypot(d[4], d[5], d[6]);
  const sz = Math.hypot(d[8], d[9], d[10]);
  return Math.max(sx, sy, sz, 1e-6);
}

/** Which LOD level to read, and what `auto` judges density at. */
export interface EnvironmentLodRequest {
  /**
   * `0` is the finest level, `'coarsest'` the last. `'auto'` reads the
   * coarsest level and steps finer until it is dense enough for the voxel
   * size - see `AUTO_LOD_SPLATS_PER_VOXEL`. Each step reads twice-ish as many
   * splats as the last, so `auto` costs at most about twice the read of the
   * level it settles on.
   */
  lod: number | 'coarsest' | 'auto';
  /** Voxel edge in the environment's LOCAL units. Only `auto` reads it. */
  voxelSize: number;
  /** Only `auto` reads it. */
  opacityThreshold: number;
}

/**
 * Read an environment's splat centres and alphas.
 *
 * `request` only matters for an LOD bundle; a monolithic capture has one set
 * of splats.
 *
 * @throws when the asset carries no readable splat data.
 */
export async function proxyInputFromEnvironment(
  env: Environment,
  request: EnvironmentLodRequest,
): Promise<EnvironmentProxySource> {
  const t0 = performance.now();
  const resource = env.asset.resource as {
    octree?: OctreeLike | null;
    gsplatData?: unknown;
  } | null;

  const octree = resource?.octree;
  if (octree) {
    let level = resolveLodLevel(request.lod, octree.lodLevels);
    let input = await readLodLevel(env, octree, level);
    if (request.lod === 'auto') {
      while (level > 0 && !denseEnough(input, request.voxelSize, request.opacityThreshold)) {
        level--;
        input = await readLodLevel(env, octree, level);
      }
    }
    return { input, lodLevel: level, lodLevels: octree.lodLevels, loadMs: performance.now() - t0 };
  }

  const data = await readableData(resource?.gsplatData);
  if (!data) {
    throw new Error(`[proxyInputFromEnvironment] ${env.entity.name}: the asset carries no CPU-side splat data`);
  }
  return { input: inputFromData(data, 0, data.numSplats), lodLevel: null, lodLevels: 1, loadMs: performance.now() - t0 };
}

/**
 * `GSplatData` as-is; a compressed or SOG container decompressed to it. `null`
 * for anything else.
 */
async function readableData(data: unknown): Promise<GSplatData | null> {
  const d = data as {
    getProp?: (name: string) => unknown;
    decompress?: () => GSplatData | Promise<GSplatData>;
  } | null | undefined;
  if (!d) return null;
  if (typeof d.getProp === 'function' && d.getProp('x')) return d as unknown as GSplatData;
  if (typeof d.decompress === 'function') return await d.decompress();
  return null;
}

function inputFromData(data: GSplatData, offset: number, count: number): ProxyMeshInput {
  const positions = new Float32Array(count * 3);
  const opacities = new Float32Array(count);
  appendFromData(data, offset, count, positions, opacities, 0);
  return { positions, opacities };
}

/** Copy `count` splats starting at `offset` into the output arrays at `at`. */
function appendFromData(
  data: GSplatData,
  offset: number,
  count: number,
  positions: Float32Array,
  opacities: Float32Array,
  at: number,
): void {
  const x = data.getProp('x') as Float32Array;
  const y = data.getProp('y') as Float32Array;
  const z = data.getProp('z') as Float32Array;
  const logits = data.getProp('opacity') as Float32Array | null;
  const end = Math.min(offset + count, data.numSplats);
  for (let i = offset, w = at; i < end; i++, w++) {
    positions[w * 3] = x[i];
    positions[w * 3 + 1] = y[i];
    positions[w * 3 + 2] = z[i];
  }
  if (logits) {
    // Same reason as `proxyInputFromSplat`: the column is a LOGIT.
    opacities.set(alphaFromLogits(logits.subarray(offset, end)), at);
  } else {
    opacities.fill(1, at, at + (end - offset));
  }
}

/**
 * Fetch one LOD level's chunk files as throwaway decompressed assets, copy each
 * node's slice out, and unload them. The streaming loader's own copies are not
 * usable: it loads with `minimalMemory`, which frees the source textures the
 * decompressor reads back.
 */
async function readLodLevel(env: Environment, octree: OctreeLike, level: number): Promise<ProxyMeshInput> {
  const slices = lodSlices(octree, level);
  let total = 0;
  for (const s of slices) total += s.count;
  const positions = new Float32Array(total * 3);
  const opacities = new Float32Array(total);

  const byFile = new Map<number, { slice: LodSlice; at: number }[]>();
  let at = 0;
  for (const slice of slices) {
    let list = byFile.get(slice.fileIndex);
    if (!list) { list = []; byFile.set(slice.fileIndex, list); }
    list.push({ slice, at });
    at += slice.count;
  }

  const registry = env.asset.registry;
  if (!registry) throw new Error('[proxyInputFromEnvironment] environment asset has no registry');

  await Promise.all([...byFile].map(async ([fileIndex, list]) => {
    const url = octree.files[fileIndex].url;
    // A URL of its own, for the chunk AND its textures. PlayCanvas's resource
    // loader caches by URL, so asking for a chunk the streaming loader already
    // holds hands back ITS resource - built with `minimalMemory`, the source
    // textures already freed - and decompressing that throws.
    // `mapUrl` is how the SOG parser resolves texture names; PlayCanvas's
    // typings for the options bag do not list it.
    const options: { crossOrigin?: 'anonymous'; mapUrl: (filename: string) => string } = {
      mapUrl: (filename: string) => uncached(new URL(filename, new URL(url, location.href)).toString()),
    };
    const asset = new Asset(`relight-proxy:${url}`, 'gsplat', { url: uncached(url) }, { decompress: true }, options);
    registry.add(asset);
    try {
      await new Promise<void>((resolve, reject) => {
        asset.once('load', () => resolve());
        asset.once('error', (err: unknown) => reject(new Error(`[proxyInputFromEnvironment] ${url}: ${String(err)}`)));
        registry.load(asset);
      });
      const data = await readableData((asset.resource as { gsplatData?: unknown } | null)?.gsplatData);
      if (!data) throw new Error(`[proxyInputFromEnvironment] ${url}: no splat data after decompress`);
      for (const { slice, at: w } of list) {
        appendFromData(data, slice.offset, slice.count, positions, opacities, w);
      }
    } finally {
      registry.remove(asset);
      asset.unload();
    }
  }));

  return { positions, opacities };
}

/** `url` with a marker query, so no loader cache entry can match it. */
function uncached(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}relight-proxy`;
}
