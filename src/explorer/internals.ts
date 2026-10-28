import type { Character, Environment, Scene } from '@viggle/splat-engine';

import type { SceneTransform } from '../walk/placement.js';

/**
 * What a module beside the explorer (the lighting) needs of a loaded
 * explorer. Kept off the public class, so its declarations never name an
 * engine type.
 */
export interface ExplorerInternals {
  scene: Scene;
  /** The loaded place and walker, null between loads. */
  loaded: { environment: Environment; character: Character; transform: SceneTransform; height: number } | null;
  /** Runs once when the current load is replaced or the explorer is destroyed. */
  onUnload(cb: () => void): () => void;
  /** Runs after `setCharacter` puts a new body in, with the old one (about to be destroyed). */
  onCharacterChange(cb: (previous: Character) => void): () => void;
}

export const INTERNALS = new WeakMap<object, ExplorerInternals>();

export function internalsOf(explorer: object): ExplorerInternals {
  const found = INTERNALS.get(explorer);
  if (!found) throw new Error('Expected a SceneExplorer from @viggle/scene-sdk/explorer');
  return found;
}
