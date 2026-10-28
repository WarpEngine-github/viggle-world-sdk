import { SceneApiError } from './errors.js';
import type { C2W } from './types.js';

/**
 * The API's own validation, run before a request is sent. Every rule here was
 * read off a 400 from `apis.viggle.ai` (2026-10-27), and its message is the
 * API's, so a local refusal reads the same as a remote one. A rule is never
 * stricter than the API's: what passes here is what the API would take.
 *
 * Refusing locally matters most where the API would NOT refuse at submit but
 * fail the task later - past the image ceiling, a generation is spent first.
 */

/** `[A-Za-z0-9_-]{1,128}`. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Batch ids are lowercase canonical UUIDs. */
export const BATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LIMITS = {
  promptChars: 1000,
  referenceImages: 8,
  /** Batches in one `referenceBatchIds`. */
  referenceBatches: 35,
  /** Images one reconstruction may be built from, reference plus new. */
  imagesPerScene: 40,
  fov: [20, 140] as const,
  seed: [0, 4294967295] as const,
} as const;

export function invalid(message: string): SceneApiError {
  return new SceneApiError(400, { code: 'INVALID_REQUEST', message }, message);
}

export function checkSessionId(id: string): string {
  if (!SESSION_ID_RE.test(id)) throw invalid('sessionId must be 1-128 ASCII letters, digits, underscores or hyphens');
  return id;
}

export function checkPrompt(prompt: string): void {
  const n = [...prompt].length;
  if (!prompt.trim() || n > LIMITS.promptChars) throw invalid(`prompt must be 1-${LIMITS.promptChars} characters`);
}

export function checkQuality(q: unknown): void {
  if (q !== void 0 && q !== 'low' && q !== 'medium' && q !== 'high') throw invalid('quality must be low, medium or high');
}

/** An http(s) URL with no `user:pass@`: what the API fetches from or writes to. */
export function checkUrl(url: string, field: string): void {
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch { /* refused below */ }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) {
    throw invalid(`${field} must be an http(s) URL without credentials`);
  }
}

export function checkC2W(m: C2W, field: string): void {
  const ok = Array.isArray(m) && m.length === 4
    && m.every((row) => Array.isArray(row) && row.length === 4 && row.every((v) => typeof v === 'number' && Number.isFinite(v)))
    && m[3]![0] === 0 && m[3]![1] === 0 && m[3]![2] === 0 && m[3]![3] === 1;
  if (!ok) throw invalid(`${field} must be a 4x4 matrix of numbers whose last row is [0,0,0,1]`);
}

export function checkBatchIds(ids: readonly string[]): void {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > LIMITS.referenceBatches) {
    throw invalid(`referenceBatchIds must list 1-${LIMITS.referenceBatches} batch IDs`);
  }
  if (!ids.every((id) => typeof id === 'string' && BATCH_ID_RE.test(id))) throw invalid('referenceBatchIds must be lowercase canonical UUIDs');
  if (new Set(ids).size !== ids.length) throw invalid('referenceBatchIds must not repeat a batch');
}

export function checkView(v: { fov?: number | null; seed?: number; projection?: string }): void {
  const [fMin, fMax] = LIMITS.fov;
  if (v.fov != null && !(typeof v.fov === 'number' && v.fov >= fMin && v.fov <= fMax)) throw invalid(`fov must be a number from ${fMin} to ${fMax}`);
  const [sMin, sMax] = LIMITS.seed;
  if (v.seed !== void 0 && !(Number.isInteger(v.seed) && v.seed >= sMin && v.seed <= sMax)) throw invalid(`seed must be an integer from ${sMin} to ${sMax}`);
  if (v.projection !== void 0 && v.projection !== 'perspective' && v.projection !== 'pano') throw invalid('projection must be perspective or pano');
}

/** Images a generate adds: one perspective view, or a panorama's six faces. */
export function viewsAdded(projection: string | undefined): number {
  return projection === 'pano' ? 6 : 1;
}
