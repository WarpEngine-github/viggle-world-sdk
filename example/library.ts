import type { WalkPlacement } from '@viggle/scene-sdk/explorer';
import type { SunLight } from '@viggle/scene-sdk/lighting';

/**
 * The example's own storage, in this browser only - the stand-in for what a
 * real app keeps on its server.
 *
 * SCENES ARE KEPT AS BYTES (IndexedDB), not as the API's signed URLs: those
 * last about three hours, and a scene sent to Edit should still open next week.
 * WHAT IS PUBLISHED is one small JSON record (localStorage): the scene, how it
 * is placed, the character, the light, the action. Showcase reads it.
 */

export interface LibraryScene {
  id: string;
  name: string;
  /** Where it came from: generated in Studio, or a file dropped into Edit. */
  source: 'studio' | 'upload';
  /** With its extension: the loader reads the format off it. */
  filename: string;
  /** The file is stored +Y up (most tools); generated scenes are +Y down. */
  upright: boolean;
  createdAt: number;
  blob: Blob;
}

/** A scene by where it lives: one of the built-in gallery rooms, or one in the library. */
export type SceneRef = { kind: 'gallery'; index: number } | { kind: 'library'; id: string };

export interface Published {
  scene: SceneRef;
  title: string;
  placement: WalkPlacement;
  character: { url: string; name: string };
  light: SunLight | null;
  /** Played when the page opens: once, or on a loop. */
  action: { url: string; name: string; loop: boolean } | null;
  publishedAt: number;
}

const DB = 'viggle-scene-sdk-example';
const STORE = 'scenes';
const PUBLISHED = 'viggle-scene-sdk-example:published';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function addScene(scene: Omit<LibraryScene, 'id' | 'createdAt'>): Promise<LibraryScene> {
  const entry: LibraryScene = { ...scene, id: crypto.randomUUID(), createdAt: Date.now() };
  await run('readwrite', (s) => s.put(entry));
  return entry;
}

export async function listScenes(): Promise<LibraryScene[]> {
  const all = await run<LibraryScene[]>('readonly', (s) => s.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export function getScene(id: string): Promise<LibraryScene | undefined> {
  return run<LibraryScene | undefined>('readonly', (s) => s.get(id));
}

export function deleteScene(id: string): Promise<undefined> {
  return run('readwrite', (s) => s.delete(id));
}

export function publish(config: Omit<Published, 'publishedAt'>): void {
  localStorage.setItem(PUBLISHED, JSON.stringify({ ...config, publishedAt: Date.now() }));
}

export function readPublished(): Published | null {
  try {
    const raw = localStorage.getItem(PUBLISHED);
    return raw ? (JSON.parse(raw) as Published) : null;
  } catch {
    return null;
  }
}

/** Save a blob as a file the browser downloads. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
