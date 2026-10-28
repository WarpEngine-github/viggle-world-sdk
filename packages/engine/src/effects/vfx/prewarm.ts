import { Vec3 } from 'playcanvas';

import { JsonVfxPrefab } from './json-vfx-prefab';
import type { VfxDataFile } from './data-types';
import type { VfxStage } from './stage';

/**
 * Force first-draw of every effect in `dataFile` so the WebGL2 driver
 * compiles and links every VFX shader program before the user can see it.
 *
 * Without this, the first time an effect spawns during gameplay PlayCanvas
 * has to compile its GLSL on the spot. WebGPU does this asynchronously; on
 * WebGL2 the compile is synchronous and stalls the frame, which shows up as
 * a one-frame lighting flash on the gsplat background.
 *
 * Programs are cached on the GraphicsDevice's program library, so the
 * temporary instances created here can be torn down - prefabs the game
 * builds later still hit the device-level program cache.
 *
 * Spawn position is the world origin: that's where the camera looks, so the
 * entities are in-frustum and actually drawn (not culled, which would skip
 * the compile). Run it behind a loading-screen overlay so nobody sees them.
 */
export async function prewarmJsonVfxPrefabs(
  stage: VfxStage,
  dataFile: VfxDataFile,
  resolveUrl?: (path: string) => string,
): Promise<void> {
  const tmp: { instance: ReturnType<JsonVfxPrefab['create']> }[] = [];
  const origin = new Vec3(0, 0, 0);

  for (const [, data] of Object.entries(dataFile)) {
    try {
      const prefab = resolveUrl
        ? new JsonVfxPrefab(data, stage.registry, resolveUrl, stage.layerId)
        : stage.buildPrefab(data);
      const instance = prefab.create(stage.app, stage.contentRoot);
      instance.spawn(origin);
      tmp.push({ instance });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[VFX prewarm] failed to build prefab; skipping:', err);
    }
  }

  // Two animation frames so PlayCanvas runs at least one full render pass
  // (frame 1 may execute before the first post-spawn render is queued).
  await new Promise<void>(r => requestAnimationFrame(() => r()));
  await new Promise<void>(r => requestAnimationFrame(() => r()));

  for (const { instance } of tmp) {
    instance.reset();
    instance.dispose();
  }
}
