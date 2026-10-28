/**
 * PlayCanvas keeps the buffer `Texture.lock()` hands out in `_levels` after
 * `unlock()` has uploaded it, and reads it again only to re-upload after a
 * WebGL context loss. For a splat capture's textures that copy is 32-36 bytes
 * a splat (55 MB on the 1.8M-splat arena) that nothing else reads, so an
 * owner that can refill the texture on `devicerestored` drops it.
 */

import { GSplatResource } from 'playcanvas';
import type { GSplatData, GSplatResourceBase, Texture } from 'playcanvas';

/** A resource that uploads its stream textures again itself (`QuantizedSpzResource`). */
type Refillable = GSplatResourceBase & { refillStreams(): void };

/** Whether {@link rebuildStreams} can refill `resource` after a context loss. */
export function canRebuildStreams(resource: unknown): resource is GSplatResource | Refillable {
  return resource instanceof GSplatResource || typeof (resource as Partial<Refillable> | null)?.refillStreams === 'function';
}

type Levels = { _levels?: unknown[] | null; _needsUpload?: boolean };

/** Drop `texture`'s CPU copy, if its upload has already happened. */
export function dropCpuCopy(texture: Texture | null | undefined): void {
  const t = texture as unknown as Levels | null | undefined;
  // `unlock()` uploads synchronously on both backends and clears the flag; a
  // still-pending upload needs the data, so keep it.
  if (t?._levels && t._needsUpload === false) t._levels[0] = null;
}

/** Drop the CPU copies of a rebuildable resource's stream textures. False for
 *  any other (a streamed LOD octree, a SOG kept on the GPU). */
export function dropStreamCopies(resource: unknown): boolean {
  if (!canRebuildStreams(resource)) return false;
  resource.streams.textures.forEach((t) => dropCpuCopy(t));
  return true;
}

/** Refill a resource's stream textures and drop the copies again: PlayCanvas's
 *  own build from its `gsplatData`, or the resource's own refill, so the bytes
 *  match the load's. */
export function rebuildStreams(resource: GSplatResource | Refillable): void {
  if (resource instanceof GSplatResource) {
    const data = resource.gsplatData as GSplatData;
    resource.updateColorData(data);
    resource.updateTransformData(data);
    if (resource.shBands > 0) resource.updateSHData(data);
  } else {
    resource.refillStreams();
  }
  dropStreamCopies(resource);
}
