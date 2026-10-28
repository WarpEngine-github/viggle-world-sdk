/**
 * opacity-scan.ts
 *
 * CPU-only opacity scan of a Gaussian-splat file. Parses the gaussians on the
 * CPU (no GPU upload, no scene attachment) and reports the opacity
 * floor/ceiling. Used by the map editor to read a map's prune level straight
 * from the original `.spz`/`.ply` - including LOD maps, whose streamed chunks
 * don't keep CPU-side opacity around.
 *
 * Both readers return alpha in LOGIT space (`spz-read.ts` applies invSigmoid,
 * and a `.ply` carries the raw 3DGS `opacity` field), so sigmoid maps it back
 * to [0,1] - matching the prune tool's threshold space.
 */

import { loadPly } from 'spz-js';

import { readSpz } from './spz-read';

import type { AssetSource } from '../shared/asset-source';
import { createReadSource } from '../shared/asset-source';

export interface SplatOpacityStats {
  /** Gaussian count in the file. */
  count: number;
  /** Lowest opacity present, post-sigmoid [0,1]. ≈ the prune threshold. */
  minOpacity: number;
  /** Highest opacity present, post-sigmoid [0,1]. */
  maxOpacity: number;
}

/**
 * Fetch + parse a splat file and return its opacity floor/ceiling. Handles
 * `.spz` and uncompressed `.ply`; returns null for unsupported extensions
 * (compressed.ply / SOG) or an empty cloud.
 */
/**
 * Fetch + parse a splat file and return its gaussian centers as a flat
 * `[x0,y0,z0, x1,y1,z1, …]` Float32Array in the file's native frame. Handles
 * `.spz` and uncompressed `.ply`; null for unsupported extensions. Used by the
 * map editor to count gaussians inside a bake box for LOD maps (whose streamed
 * chunks keep no CPU positions).
 */
export async function loadSplatPositions(source: AssetSource): Promise<Float32Array | null> {
  const name = (source.filename ?? source.url ?? '').toLowerCase().split(/[?#]/, 1)[0];
  const buf = await (await createReadSource(source)).arrayBuffer();
  if (name.endsWith('.spz')) {
    return (await readSpz(new Uint8Array(buf))).positions;
  }
  if (name.endsWith('.ply') && !name.endsWith('.compressed.ply')) {
    const body = new Response(buf).body;
    return body ? ((await loadPly(body))?.positions ?? null) : null;
  }
  return null;
}

export async function scanSplatOpacity(source: AssetSource): Promise<SplatOpacityStats | null> {
  const name = (source.filename ?? source.url ?? '').toLowerCase().split(/[?#]/, 1)[0];
  const buf = await (await createReadSource(source)).arrayBuffer();

  let alphas: Float32Array | null = null;
  if (name.endsWith('.spz')) {
    alphas = (await readSpz(new Uint8Array(buf))).alphas;
  } else if (name.endsWith('.ply') && !name.endsWith('.compressed.ply')) {
    const body = new Response(buf).body;
    if (body) alphas = (await loadPly(body))?.alphas ?? null;
  } else {
    return null;
  }
  if (!alphas || alphas.length === 0) return null;

  let minLogit = Infinity;
  let maxLogit = -Infinity;
  for (let i = 0; i < alphas.length; i++) {
    const v = alphas[i];
    if (v < minLogit) minLogit = v;
    if (v > maxLogit) maxLogit = v;
  }
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  return { count: alphas.length, minOpacity: sigmoid(minLogit), maxOpacity: sigmoid(maxLogit) };
}
