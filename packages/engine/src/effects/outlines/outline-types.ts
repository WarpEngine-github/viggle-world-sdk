import type { Color, Entity } from 'playcanvas';

/** @group Outlines */
export interface OutlineEffectOptions {
  /**
   * Outline colour. Default purple (0.6, 0.2, 1.0, 1.0). The alpha
   * channel is the blend strength for the composite over the scene -
   * 1.0 = fully opaque outline, 0.5 = half-blended.
   */
  color?: Color;
  /**
   * Outline thickness in screen pixels. The expand shader samples an
   * 8-tap ring of this radius around each pixel; any pixel whose ring
   * touches the silhouette becomes part of the outline. Constant
   * across resolution / zoom. Default 3.
   */
  thicknessPx?: number;
  /**
   * Main camera entity the mask camera mirrors. The mask camera is
   * parented to this one so world transforms stay locked; projection
   * params (fov / near / far / aspect / projection) are copied each
   * frame.
   */
  mainCamera: Entity;
}

/** @group Outlines */
export interface OutlineAddOptions {
  /**
   * Whether to recurse into the entity's descendants. Tagging a
   * character root with `recursive: true` pulls in every attached
   * weapon / accessory mesh. Default `true`.
   */
  recursive?: boolean;
}
