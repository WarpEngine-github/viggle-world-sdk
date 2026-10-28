import type { ExpandOptions, WaitOptions } from '../core/client.js';
import type { CameraInput, CreateSceneFromPanoramaInput, CreateSceneInput, ViggleScene } from '../core/types.js';
import { useViggleSceneClient } from './context.js';
import { useJob } from './useJob.js';

type PollOptions = Pick<WaitOptions, 'intervalMs' | 'maxIntervalMs' | 'timeoutMs' | 'maxPollErrors' | 'waitIfBusy'>;

/**
 * INITIAL GENERATION (创建场景 / 从自定义全景图创建场景).
 *
 * ```tsx
 * const gen = useSceneGeneration({ onGenerated: setScene });
 * gen.generate({ prompt: 'a sunlit open-plan office' });
 * gen.generateFromPanorama({ panorama: file });
 * // gen.phase, gen.busy, gen.startedAt, gen.result, gen.error
 * ```
 */
export function useSceneGeneration(options?: PollOptions & { onGenerated?: (scene: ViggleScene) => void }) {
  const client = useViggleSceneClient();
  const job = useJob(async (hooks, input: { prompt: CreateSceneInput } | { panorama: CreateSceneFromPanoramaInput }) => {
    const scene = 'prompt' in input
      ? await client.generateScene(input.prompt, { ...options, ...hooks })
      : await client.generateSceneFromPanorama(input.panorama, { ...options, ...hooks });
    if (!hooks.signal.aborted) options?.onGenerated?.(scene);
    return scene;
  });
  return {
    ...job,
    generate: (input: CreateSceneInput) => job.start({ prompt: input }),
    generateFromPanorama: (input: CreateSceneFromPanoramaInput) => job.start({ panorama: input }),
  };
}

/**
 * EXPAND (生成场景视图): fill a scene in where the camera stands and looks.
 *
 * ```tsx
 * const expand = useSceneExpand(scene, { onExpanded: setScene });
 * expand.expand(viewerRef.current!.getPose()!, { fov: viewerRef.current!.fov });
 * ```
 *
 * Resolves (and calls `onExpanded`) with the scene plus its new version.
 */
export function useSceneExpand(
  scene: ViggleScene | null | undefined,
  options?: PollOptions & { onExpanded?: (scene: ViggleScene) => void },
) {
  const client = useViggleSceneClient();
  const job = useJob(async (hooks, pose: CameraInput, expand?: Omit<ExpandOptions, keyof WaitOptions>) => {
    if (!scene) throw new Error('No scene to expand.');
    const next = await client.expandScene(scene, pose, { ...options, ...expand, ...hooks });
    if (!hooks.signal.aborted) options?.onExpanded?.(next);
    return next;
  });
  return { ...job, expand: job.start };
}

/**
 * REBUILD (重建场景): reconstruct from a batch list. Pass the current list
 * minus one batch (`withoutBatch`) to undo the view that batch added.
 */
export function useSceneRebuild(
  scene: ViggleScene | null | undefined,
  options?: PollOptions & { onRebuilt?: (scene: ViggleScene) => void },
) {
  const client = useViggleSceneClient();
  const job = useJob(async (hooks, batchIds?: string[]) => {
    if (!scene) throw new Error('No scene to rebuild.');
    const next = await client.rebuildScene(scene, batchIds, { ...options, ...hooks });
    if (!hooks.signal.aborted) options?.onRebuilt?.(next);
    return next;
  });
  return { ...job, rebuild: job.start };
}
