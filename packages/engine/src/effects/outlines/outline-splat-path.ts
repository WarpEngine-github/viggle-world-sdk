import type { Entity } from 'playcanvas';

/**
 * Handle returned from `createSplatMarkClone`. Call `destroy()` on
 * untag to restore the gsplat's original `layers` array so the splat
 * stops rendering into the outline mask RT.
 */
export interface SplatCloneHandle {
  /** Put the mark layer back if the host rewrote the gsplat's layer list. */
  ensure: () => void;
  destroy: () => void;
}

/**
 * Register a gsplat entity with the outline mark layer.
 *
 * Earlier revisions tried to spawn a second gsplat component on a
 * clone entity - that path hit two blockers on PC 2.18:
 *   1. Unified gsplat manager packs every unified splat into one
 *      texture; two copies of a 63k-splat character overflowed the
 *      16384 texture cap.
 *   2. Non-unified path ran into an async sort-worker init crash
 *      (`gsplat-sorter.js:42 Uncaught (in promise)`) spawning a new
 *      GSplatInstance for the same asset - PC assumes one instance
 *      per asset at init time.
 *
 * Current approach: leave the existing gsplat component alone and
 * simply add the outline mark layer to its `layers` array. Now both
 * the main camera (its original layers) AND the mask camera (layers
 * = [markLayerId]) render the splat. The mask camera's output lands
 * in the mask RT with the splat's actual lit colour in RGB and its
 * Gaussian coverage in alpha.
 *
 * This "wastes" RGB - the mask is supposed to be flat white - but the
 * edge-expand shader only samples the `.a` channel. Alpha inside the
 * silhouette is ≈1 (accumulated from many overlapping Gaussians),
 * zero outside, which is exactly the silhouette signal we need.
 * Outline colour still comes from `uOutlineColor` in the expand pass,
 * not from the mask RGB. So the final outline is the user-configured
 * colour regardless.
 *
 * Cost: ~1 extra splat rasterize per tagged splat per frame (the
 * mask camera draws the same splat at a different RT). No extra
 * sort - PC's sorter is per-instance, and we reuse the existing
 * instance.
 *
 * Returns `null` if the entity has no gsplat component.
 */
export function createSplatMarkClone(
  markLayerId: number,
  srcEntity: Entity,
): SplatCloneHandle | null {
  const gsplat = srcEntity.gsplat;
  if (!gsplat) return null;

  const originalLayers: number[] = [...gsplat.layers];
  if (!originalLayers.includes(markLayerId)) {
    gsplat.layers = [...originalLayers, markLayerId];
  }

  // No bone binding sync needed - the SAME gsplat component is
  // rendering for both cameras, so its existing per-component
  // parameter scope is all that's required. If a future revision goes
  // back to a real second gsplat component, re-add a sync hook here
  // and call it from OutlineEffect._syncCameras.
  const destroy = () => {
    // Restore the original layers list. If the engine mutated the
    // array between add and destroy (a host can rebuild it on
    // shadow-system toggles), merge out just our layer id.
    gsplat.layers = gsplat.layers.filter((id) => id !== markLayerId);
  };
  // A host that moves the splat between layers (a character joining an
  // environment's layer, say) assigns a fresh list and drops ours with it;
  // the mask then renders nothing and the line is gone. Re-assert.
  const ensure = () => {
    if (!gsplat.layers.includes(markLayerId)) gsplat.layers = [...gsplat.layers, markLayerId];
  };

  return { destroy, ensure };
}
