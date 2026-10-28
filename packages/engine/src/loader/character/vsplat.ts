import { loadBinaryGsplat } from './binary-gsplat';
import type { AssetSource } from '../shared/asset-source';
import type { BinaryGsplatResult } from '../../types';

/**
 * `.vsplat` reader - EXPERIMENTAL, prototype only.
 *
 * `.vsplat` (magic `VSPLAT01`) is the pre-release prototype of the planar
 * layout that shipped as `VFCHARB2`. It is now READ BY THE SHIPPING LOADER:
 * {@link loadBinaryGsplat} sniffs the magic and routes both planar magics into
 * the same decoder, so this is a one-line delegate.
 *
 * Kept rather than retired because the offline `.vsplat` LOD/quantisation A/B
 * rig (an out-of-tree baker plus its comparison scene) still bakes and
 * compares files under the prototype magic, and because routing them through
 * the production decoder means the A/B measures the code that ships instead of
 * a copy of it. The only thing this entry point still buys over calling
 * {@link loadBinaryGsplat} directly is that `loadVsplatAsset` skips the
 * in-memory `ArrayBuffer` cache, so a repeat load measures a fresh decode -
 * see there.
 */
const loadVsplat = async (assetSource: AssetSource): Promise<BinaryGsplatResult> =>
  loadBinaryGsplat(assetSource);

export { loadVsplat };
