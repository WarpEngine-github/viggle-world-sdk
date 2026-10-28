import { SceneApiError, SceneNetworkError, SceneTimeoutError, isAbortError } from './errors.js';
import { toImage } from './image.js';
import { currentVersion, isC2W, toC2W, toPose } from './pose.js';
import {
  LIMITS, checkBatchIds, checkC2W, checkPrompt, checkQuality, checkSessionId, checkUrl, checkView, invalid, viewsAdded,
} from './validate.js';
import type {
  CameraInput,
  CreateSceneFromPanoramaInput,
  CreateSceneInput,
  GenerateViewInput,
  ReconstructInput,
  SceneApiErrorBody,
  SceneProjection,
  SceneTask,
  SceneVersion,
  ViggleScene,
} from './types.js';

type MaybePromise<T> = T | Promise<T>;

export const DEFAULT_BASE_URL = 'https://apis.viggle.ai';

export interface ViggleSceneClientOptions {
  /**
   * Your Viggle API key (`sk-...`), or a function returning it. Sent as
   * `Authorization: Bearer <key>`.
   *
   * A KEY IN A BROWSER BUNDLE IS A PUBLISHED KEY. In a web app, leave this
   * out and point `baseUrl` at your own server, which adds the header - see
   * the README. Pass it directly only from a server, a script, or local dev.
   */
  apiKey?: string | (() => MaybePromise<string | null | undefined>);
  /** Default `https://apis.viggle.ai`. Your proxy's URL when the key lives server-side. */
  baseUrl?: string;
  /** Extra headers on every request. */
  headers?: HeadersInit;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface WaitOptions extends RequestOptions {
  /** First poll delay. Default 2000 ms. */
  intervalMs?: number;
  /** Polls back off to this. Default 5000 ms. */
  maxIntervalMs?: number;
  /** Give up (the task keeps running) after this long. Default: never. */
  timeoutMs?: number;
  /**
   * Polls in a row that may fail on a network error, a 429 or a 5xx before
   * the wait gives up. A long task should not die of one dropped request.
   * Default 3.
   */
  maxPollErrors?: number;
  /** Called with the submitted task, then with every poll. */
  onUpdate?: (task: SceneTask) => void;
  /**
   * When the session already has a task running (409), wait for that task
   * to end and submit again, instead of failing. Scene-level methods only.
   * Default false.
   */
  waitIfBusy?: boolean;
}

export interface ExpandOptions extends WaitOptions {
  /** Field of view of the generated view, degrees (20-140). Match the viewer's for a seamless fill. */
  fov?: number;
  projection?: SceneProjection;
  seed?: number;
}

/**
 * The Viggle Scene API.
 *
 * Five endpoints, all of them TASKS: a submit answers at once with
 * `status: 'queued'` or `'processing'`, and the result is read by polling `getTask`.
 *
 * | 创建场景             | `createSceneTask`              | `generateScene`              |
 * | 从自定义全景图创建场景 | `createSceneFromPanoramaTask`  | `generateSceneFromPanorama`  |
 * | 生成场景视图          | `generateViewTask`             | `expandScene`                |
 * | 重建场景             | `reconstructTask`              | `rebuildScene`               |
 * | 查询场景任务          | `getTask` / `waitForTask`      |                              |
 *
 * The left column is the raw call; the right submits, waits, and returns the
 * `ViggleScene` with its new version appended.
 */
export class ViggleSceneClient {
  private readonly baseUrl: string;
  private readonly apiKey: ViggleSceneClientOptions['apiKey'];
  private readonly headers: HeadersInit | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ViggleSceneClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.headers = options.headers;
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  // ── The five endpoints ────────────────────────────────────────────────────

  /** 创建场景: from a prompt, reference images or both, or from a finished panorama. */
  createSceneTask(input: CreateSceneInput, opts?: RequestOptions): Promise<SceneTask> {
    const { referenceImages, panorama, ...rest } = input;
    const body = { ...rest, sessionId: checkSessionId(input.sessionId ?? newSessionId()) };
    if (panorama && (input.prompt !== void 0 || input.quality !== void 0 || referenceImages?.length)) {
      throw invalid('use panoramaUri or a panorama file, or prompt and/or referenceImages with quality, not both');
    }
    if (panorama === void 0) {
      if (input.prompt === void 0 && !referenceImages?.length) throw invalid('provide a prompt, referenceImages or a panorama');
      // Beside reference images a blank prompt is no prompt, as the API takes it.
      if (input.prompt !== void 0 && (!referenceImages?.length || input.prompt.trim())) checkPrompt(input.prompt);
      checkQuality(input.quality);
      if ((referenceImages?.length ?? 0) > LIMITS.referenceImages) {
        throw invalid(`referenceImages must be a list of at most ${LIMITS.referenceImages} URLs`);
      }
    }
    const images = {
      panorama: panorama === void 0 ? void 0 : toImage(panorama, 'panorama'),
      referenceImages: referenceImages?.map((r, i) => toImage(r, `referenceImages[${i}]`)),
    };
    if (input.spzOutputUrl !== void 0) checkUrl(input.spzOutputUrl, 'spzOutputUrl');
    return this.submit('/v1/scenes/pano', body, images, opts);
  }

  /** 从自定义全景图创建场景: a panorama placed at a pose. */
  createSceneFromPanoramaTask(input: CreateSceneFromPanoramaInput, opts?: RequestOptions): Promise<SceneTask> {
    const { panorama, pose, ...rest } = input;
    const body = { ...rest, sessionId: checkSessionId(input.sessionId ?? newSessionId()), panoramaC2w: toC2W(pose) };
    checkC2W(body.panoramaC2w, 'panoramaC2w');
    if (!panorama) throw invalid('provide panoramaUri or a panorama file');
    const image = toImage(panorama, 'panorama');
    if (input.spzOutputUrl !== void 0) checkUrl(input.spzOutputUrl, 'spzOutputUrl');
    return this.submit('/v1/scenes/custom-pano', body, { panorama: image }, opts);
  }

  /** 生成场景视图: generate the view a camera would see and rebuild the scene with it. */
  generateViewTask(input: GenerateViewInput, opts?: RequestOptions): Promise<SceneTask> {
    const { pose, ...rest } = input;
    const body = { ...rest, projection: input.projection ?? 'perspective', targetC2w: toC2W(pose) };
    if (body.projection === 'pano') delete body.fov;
    checkSessionId(body.sessionId);
    checkBatchIds(body.referenceBatchIds);
    checkC2W(body.targetC2w, 'targetC2w');
    checkView(body);
    if (body.spzOutputUrl !== void 0) checkUrl(body.spzOutputUrl, 'spzOutputUrl');
    return this.submit('/v1/scenes/generate', body, {}, opts);
  }

  /** 重建场景: rebuild from a batch list - drop a batch to undo the view it added. */
  reconstructTask(input: ReconstructInput, opts?: RequestOptions): Promise<SceneTask> {
    checkSessionId(input.sessionId);
    checkBatchIds(input.referenceBatchIds);
    if (input.spzOutputUrl !== void 0) checkUrl(input.spzOutputUrl, 'spzOutputUrl');
    return this.submit('/v1/scenes/reconstruct', { ...input }, {}, opts);
  }

  /** 查询场景任务. Signed URLs in the result are re-signed on every call. */
  getTask(taskId: string, opts?: RequestOptions): Promise<SceneTask> {
    return this.request<SceneTask>('GET', `/v1/scenes/${encodeURIComponent(taskId)}`, void 0, opts);
  }

  /**
   * Poll a task until it settles. Resolves with the `ready` task; rejects with
   * `SceneApiError` (status 0) when it failed or was cancelled. Aborting the
   * signal stops the polling, not the task.
   */
  async waitForTask(task: SceneTask | string, opts: WaitOptions = {}): Promise<SceneTask> {
    const { signal, onUpdate, timeoutMs } = opts;
    const maxInterval = opts.maxIntervalMs ?? 5000;
    let interval = opts.intervalMs ?? 2000;
    const deadline = timeoutMs === void 0 ? Infinity : Date.now() + timeoutMs;
    const maxErrors = opts.maxPollErrors ?? 3;
    let errors = 0;
    const poll = async (id: string): Promise<SceneTask | null> => {
      try {
        const t = await this.getTask(id, { signal });
        errors = 0;
        return t;
      } catch (err) {
        if (!isTransient(err) || ++errors > maxErrors) throw err;
        return null;
      }
    };
    const taskId = typeof task === 'string' ? task : task.id;
    let current = typeof task === 'string' ? await poll(task) : task;

    for (;;) {
      if (!current) {
        // A transient poll failure: wait and ask again.
        if (Date.now() + interval > deadline) throw new SceneTimeoutError(taskId);
        await sleep(interval, signal);
        interval = Math.min(Math.round(interval * 1.5), maxInterval);
        current = await poll(taskId);
        continue;
      }
      onUpdate?.(current);
      if (current.status === 'ready' && current.result) return current;
      if (current.status === 'failed' || current.status === 'cancelled') {
        throw new SceneApiError(0, explainFailure(current.error), `Scene task ${current.status}.`, current);
      }
      if (Date.now() + interval > deadline) throw new SceneTimeoutError(current.id);
      await sleep(interval, signal);
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
      current = await poll(current.id);
    }
  }

  // ── Scene-level: submit, wait, keep the history ───────────────────────────

  /** 创建场景, waited for. Resolves with a new scene of one version. */
  async generateScene(input: CreateSceneInput, opts?: WaitOptions): Promise<ViggleScene> {
    const task = await this.submitAndWait((o) => this.createSceneTask(input, o), opts);
    return { sessionId: task.sessionId, versions: [versionOf(task, [])] };
  }

  /** 从自定义全景图创建场景, waited for. */
  async generateSceneFromPanorama(input: CreateSceneFromPanoramaInput, opts?: WaitOptions): Promise<ViggleScene> {
    const task = await this.submitAndWait((o) => this.createSceneFromPanoramaTask(input, o), opts);
    return { sessionId: task.sessionId, versions: [versionOf(task, [])] };
  }

  /**
   * 生成场景视图, waited for: fill the scene in where `pose` stands and looks.
   * Resolves with `scene` plus the new version. `scene` itself is not changed.
   */
  async expandScene(scene: ViggleScene, pose: CameraInput, opts: ExpandOptions = {}): Promise<ViggleScene> {
    const head = requireHead(scene);
    // Past the image ceiling the API would run the generation and then fail it.
    const adding = viewsAdded(opts.projection);
    if (head.viewCount !== void 0 && head.viewCount + adding > LIMITS.imagesPerScene) {
      throw invalid(`a scene is built from at most ${LIMITS.imagesPerScene} images: this one has ${head.viewCount} and the view would add ${adding}`);
    }
    const task = await this.submitAndWait((o) => this.generateViewTask({
      sessionId: scene.sessionId,
      referenceBatchIds: head.batchIds,
      pose,
      projection: opts.projection,
      fov: opts.fov,
      seed: opts.seed,
    }, o), opts);
    const version = versionOf(task, head.batchIds);
    version.pose = isC2W(pose) ? null : toPose(pose);
    return { ...scene, versions: [...scene.versions, version] };
  }

  /**
   * 重建场景, waited for: rebuild from `batchIds` (default: the current list).
   * Shortening the list is undo - `withoutBatch` gives the list minus one view.
   */
  async rebuildScene(scene: ViggleScene, batchIds?: string[], opts?: WaitOptions): Promise<ViggleScene> {
    const ids = batchIds ?? requireHead(scene).batchIds;
    const task = await this.submitAndWait(
      (o) => this.reconstructTask({ sessionId: scene.sessionId, referenceBatchIds: ids }, o),
      opts,
    );
    return { ...scene, versions: [...scene.versions, versionOf(task, ids, false)] };
  }

  /**
   * Re-sign every version's URLs (they expire ~3 h after they were read).
   * A version whose task is past the API's retention keeps its old URLs.
   */
  async refreshScene(scene: ViggleScene, opts?: RequestOptions): Promise<ViggleScene> {
    const versions = await Promise.all(scene.versions.map(async (v) => {
      try {
        const task = await this.getTask(v.taskId, opts);
        const r = task.result;
        if (!r) return v;
        return {
          ...v,
          splatUrl: r.spz.url,
          previewUrl: r.preview?.url ?? v.previewUrl,
          panoramaUrl: r.panorama?.url ?? v.panoramaUrl,
          ...(v.batch !== void 0 && { batch: v.batch && r.outputBatch?.batchId === v.batch.batchId ? r.outputBatch : v.batch }),
        };
      } catch (err) {
        if (err instanceof SceneApiError) return v;
        throw err;
      }
    }));
    return { ...scene, versions };
  }

  /**
   * A version's splat file, as bytes - to save, to keep past the signed URL's
   * ~3 h, or to hand to another viewer. Default the current version. A URL
   * that has expired is re-signed once (`getTask`) and fetched again.
   * The file is an `.spz`.
   */
  async fetchSplat(scene: ViggleScene, versionIndex?: number, opts?: RequestOptions): Promise<Blob> {
    const i = versionIndex ?? scene.versions.length - 1;
    const version = scene.versions[i];
    if (!version) throw invalid(`scene has no version ${i}`);
    const get = async (url: string) => {
      try {
        return await globalThis.fetch(url, { signal: opts?.signal });
      } catch (err) {
        if (isAbortError(err)) throw err;
        throw new SceneNetworkError(err);
      }
    };
    let res = await get(version.splatUrl);
    if (!res.ok && (res.status === 400 || res.status === 401 || res.status === 403)) {
      const task = await this.getTask(version.taskId, opts);
      if (task.result) res = await get(task.result.spz.url);
    }
    if (!res.ok) throw new SceneApiError(res.status, void 0, `The splat could not be downloaded (${res.status}).`);
    return res.blob();
  }

  /** Submit and wait; on a busy session, with `waitIfBusy`, wait out the running task and submit once more. */
  private async submitAndWait(submit: (opts: RequestOptions) => Promise<SceneTask>, opts: WaitOptions = {}): Promise<SceneTask> {
    let task: SceneTask;
    try {
      task = await submit(opts);
    } catch (err) {
      const running = err instanceof SceneApiError && err.isSessionBusy ? err.runningTaskId : void 0;
      if (!opts.waitIfBusy || !running) throw err;
      // How the other task ends is not ours to report: only that it has.
      await this.waitForTask(running, { ...opts, onUpdate: void 0 }).catch((e) => {
        if (isAbortError(e) || e instanceof SceneTimeoutError) throw e;
      });
      task = await submit(opts);
    }
    return this.waitForTask(task, opts);
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /** JSON, or multipart when any image is a file. */
  private submit(
    path: string,
    body: Record<string, unknown>,
    images: { panorama?: string | Blob; referenceImages?: Array<string | Blob> },
    opts?: RequestOptions,
  ): Promise<SceneTask> {
    const refs = images.referenceImages ?? [];
    const hasFile = images.panorama instanceof Blob || refs.some((r) => r instanceof Blob);
    if (!hasFile) {
      const json = { ...body } as Record<string, unknown>;
      if (typeof images.panorama === 'string') json.panoramaUri = images.panorama;
      if (refs.length) json.referenceImages = refs;
      return this.request('POST', path, json, opts);
    }
    if (refs.some((r) => typeof r === 'string')) {
      throw invalid('referenceImages must be all http(s) URLs or all files (Blob, base64, data URL), not a mix');
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) {
      if (v === void 0) continue;
      form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    if (images.panorama instanceof Blob) form.append('panorama', images.panorama, fileName(images.panorama, 'panorama'));
    else if (typeof images.panorama === 'string') form.append('panoramaUri', images.panorama);
    refs.forEach((r, i) => form.append('referenceImageFiles', r as Blob, fileName(r as Blob, `reference-${i}`)));
    return this.request('POST', path, form, opts);
  }

  private async request<T>(method: string, path: string, body: unknown, opts?: RequestOptions): Promise<T> {
    const headers = new Headers(this.headers);
    const key = typeof this.apiKey === 'function' ? await this.apiKey() : this.apiKey;
    if (key) headers.set('Authorization', `Bearer ${key}`);
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body !== void 0 && !isForm) headers.set('Content-Type', 'application/json');

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === void 0 ? void 0 : isForm ? (body as FormData) : JSON.stringify(body),
        signal: opts?.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new SceneNetworkError(err);
    }

    const text = await res.text().catch(() => '');
    const parsed = parseJson(text);
    const requestId = res.headers.get('X-Request-Id') ?? void 0;
    if (!res.ok) {
      const envelope = (parsed as { error?: Partial<SceneApiErrorBody> } | undefined)?.error;
      throw new SceneApiError(res.status, envelope, `Scene API request failed (${res.status}).`, void 0, requestId);
    }
    if (parsed === void 0) throw new SceneApiError(res.status, void 0, 'The Scene API sent an unreadable answer.', void 0, requestId);
    return parsed as T;
  }
}

/** Shorthand for `new ViggleSceneClient(options)`. */
export function createViggleSceneClient(options?: ViggleSceneClientOptions): ViggleSceneClient {
  return new ViggleSceneClient(options);
}

/**
 * A task the API failed because it does not hold a batch it was sent - from
 * another host or account, or past retention. It says only "Cache rejected
 * scene request"; this says what that means.
 */
function explainFailure(error: SceneApiErrorBody | null): SceneApiErrorBody | undefined {
  if (!error) return void 0;
  if (error.code === 'INVALID_REQUEST' && /cache rejected/i.test(error.message)) {
    return { ...error, message: `The API does not hold one of the scene's batches (made on another host or account, or past retention): ${error.message}` };
  }
  return error;
}

/** Worth asking again: the request did not reach an answer, or the API was briefly unable to give one. */
function isTransient(err: unknown): boolean {
  if (err instanceof SceneNetworkError) return true;
  return err instanceof SceneApiError && (err.status === 429 || err.status >= 500);
}

export function newSessionId(prefix = 'scene'): string {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${uuid}`;
}

/** A scene's current batch list minus one batch: the input to rebuild without that view. */
export function withoutBatch(scene: ViggleScene, batchId: string): string[] {
  return requireHead(scene).batchIds.filter((id) => id !== batchId);
}

function versionOf(task: SceneTask, prevBatchIds: string[], append = true): SceneVersion {
  const r = task.result!;
  const added = append && r.outputBatch ? [r.outputBatch.batchId] : [];
  return {
    taskId: task.id,
    operation: task.operation,
    batchIds: [...prevBatchIds, ...added],
    splatUrl: r.spz.url,
    previewUrl: r.preview?.url ?? null,
    panoramaUrl: r.panorama?.url ?? null,
    pose: null,
    batch: append ? r.outputBatch : null,
    viewCount: r.referenceViewCount + r.newViewCount,
    createdAt: task.completedAt ?? Date.now(),
  };
}

function requireHead(scene: ViggleScene): SceneVersion {
  const head = currentVersion(scene);
  if (!head) throw new SceneApiError(400, void 0, 'This scene has no version yet.');
  return head;
}


function fileName(blob: Blob, fallback: string): string {
  const name = (blob as { name?: unknown }).name;
  if (typeof name === 'string' && name) return name;
  const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
  return `${fallback}.${ext}`;
}

function parseJson(text: string): unknown {
  if (!text) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
