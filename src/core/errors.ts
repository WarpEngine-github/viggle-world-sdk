import type { SceneApiErrorBody, SceneTask } from './types.js';

/**
 * The codes seen from the API. A refusal may carry others; `code` is typed
 * open so a new one is still read.
 *
 * | `INVALID_REQUEST`   | 400 at submit; or a task that failed because the request could not be met (not retryable) |
 * | `UNAUTHENTICATED`   | 401: no key, or a bad / expired one |
 * | `PROCESSING_FAILED` | a task whose work failed - retryable by the API's own word |
 */
export type SceneErrorCode = 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'PROCESSING_FAILED' | (string & {});

/**
 * A refusal from the Scene API, or a task that failed. One class for both,
 * because the API sends one envelope for both.
 */
export class SceneApiError extends Error {
  /** HTTP status of a refused request; 0 for a task that failed after it was accepted. */
  readonly status: number;
  readonly code: SceneErrorCode;
  /** Quote this to Viggle support. From the envelope, or the `X-Request-Id` header. */
  readonly requestId?: string;
  /**
   * The API's own word on whether retrying could succeed. Trust it for a
   * failed TASK; for an HTTP refusal it is misleading (a 409 says false and
   * waiting is exactly right) - use `shouldRetry`.
   */
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;
  /** The API's advice: `action` is `none` or `retry`. */
  readonly remediation: { action?: string; retryAfterMs?: number | null };
  /** Set when this is a failed task. */
  readonly task?: SceneTask;

  constructor(status: number, body: Partial<SceneApiErrorBody> | undefined, fallback: string, task?: SceneTask, requestId?: string) {
    super(body?.message || fallback);
    this.name = 'SceneApiError';
    this.status = status;
    this.code = body?.code ?? (status ? `HTTP_${status}` : 'TASK_FAILED');
    this.requestId = body?.request_id || requestId || void 0;
    this.retryable = body?.retryable ?? false;
    this.details = body?.details ?? {};
    this.remediation = { action: body?.remediation?.action, retryAfterMs: body?.remediation?.retry_after_ms ?? null };
    this.task = task;
  }

  /** 409: the session already has a task running. Its id, when the API names it. */
  get runningTaskId(): string | undefined {
    const id = this.details.running_task_id;
    return typeof id === 'string' ? id : void 0;
  }

  /** 401 / 403: the key is missing, wrong, expired or not allowed. */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403 || this.code === 'UNAUTHENTICATED';
  }

  /** The session is busy with another task (409). Wait for `runningTaskId`, then submit again. */
  get isSessionBusy(): boolean {
    return this.status === 409;
  }

  /**
   * Whether the same call could succeed later. A failed task: the API's own
   * `retryable`. A refusal: by status - 409 (busy), 429 and 5xx are worth
   * another go, any other 4xx is not.
   */
  get shouldRetry(): boolean {
    if (this.status === 0) return this.retryable;
    return this.status === 409 || this.status === 429 || this.status >= 500;
  }

  /** What `JSON.stringify` writes: every field that says what went wrong, and none of the task's signed URLs. */
  toJSON(): SerializedSceneError {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      requestId: this.requestId,
      retryable: this.retryable,
      shouldRetry: this.shouldRetry,
      remediation: this.remediation,
      details: this.details,
      taskId: this.task?.id,
    };
  }
}

/**
 * Any SDK error as plain JSON - for a log line, a response body or a tool
 * result. `name` tells the kinds apart; the rest is only what that kind has.
 */
export interface SerializedSceneError {
  name: 'SceneApiError' | 'SceneNetworkError' | 'SceneTimeoutError' | 'AbortError' | (string & {});
  message: string;
  status?: number;
  code?: SceneErrorCode;
  requestId?: string;
  retryable?: boolean;
  shouldRetry?: boolean;
  remediation?: { action?: string; retryAfterMs?: number | null };
  details?: Record<string, unknown>;
  /** The failed task (`SceneApiError`), or the one still running (`SceneTimeoutError`). */
  taskId?: string;
  /** Why the network failed, as text. */
  cause?: string;
}

/** The request never got an answer: offline, DNS, CORS, a dropped connection. */
export class SceneNetworkError extends Error {
  constructor(cause: unknown) {
    super('The Viggle Scene API could not be reached.', { cause });
    this.name = 'SceneNetworkError';
  }

  toJSON(): SerializedSceneError {
    const c = this.cause;
    return { name: this.name, message: this.message, shouldRetry: true, cause: c instanceof Error ? c.message : c === void 0 ? void 0 : String(c) };
  }
}

/** `waitForTask` ran past its `timeoutMs`. The task itself is still running. */
export class SceneTimeoutError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Timed out waiting for scene task ${taskId}.`);
    this.name = 'SceneTimeoutError';
    this.taskId = taskId;
  }

  /** The task is still running: wait on `taskId` again to get its result. */
  toJSON(): SerializedSceneError {
    return { name: this.name, message: this.message, taskId: this.taskId, shouldRetry: true };
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Any thrown value as plain JSON: an SDK error as its `toJSON`, anything else as name and message. */
export function serializeError(err: unknown): SerializedSceneError {
  if (err instanceof SceneApiError || err instanceof SceneNetworkError || err instanceof SceneTimeoutError) return err.toJSON();
  if (err instanceof Error || isAbortError(err)) return { name: (err as Error).name, message: (err as Error).message };
  return { name: 'Error', message: String(err) };
}
