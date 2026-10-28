import type { Asset } from 'playcanvas';

import type { ArmatureData, SplatWeights } from '../../types';

/**
 * Side-channel data attached to PlayCanvas `Asset` instances by
 * {@link loadBinaryAsset}. Held in a `WeakMap` so the lifecycle tracks the
 * asset and dropping the asset reclaims this data automatically.
 *
 * Kept off the public exports - both writers (loader/asset-loader.ts) and
 * readers (splat/splat.ts) go through {@link getAssetExtras} /
 * {@link setAssetExtras} so the keys are typed in one place.
 */
export interface AssetExtras {
  splatWeights?: SplatWeights;
  animationData?: { data: Float32Array; numFrames: number; numBones: number; keyframeFrames?: number[] };
  /**
   * Bone count the splat was authored against. Pulled from either the
   * `.bin` header or the parsed `ArmatureData`. Used by {@link Splat} for
   * rig-compatibility checks before binding to an armature.
   */
  splatSourceBoneCount?: ArmatureData['numBones'];
}

const ASSET_EXTRAS = new WeakMap<Asset, AssetExtras>();

export function setAssetExtras(asset: Asset, extras: AssetExtras): void {
  ASSET_EXTRAS.set(asset, extras);
}

export function getAssetExtras(asset: Asset): AssetExtras | undefined {
  return ASSET_EXTRAS.get(asset);
}
