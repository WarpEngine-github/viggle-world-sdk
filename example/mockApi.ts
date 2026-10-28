import type { SceneOperation, SceneTask } from '@viggle/scene-sdk';

/**
 * A stand-in for `apis.viggle.ai/v1/scenes/*`, so the example runs with no
 * key: every task is ready on its third poll, and every result is the same
 * demo file. What the example exercises is the flow, not the model.
 */
export function createMockFetch(splatUrl: string): typeof fetch {
  const tasks = new Map<string, { polls: number; task: SceneTask; batch: string | null }>();
  const busy = new Set<string>();
  let n = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const refuse = (status: number, code: string, message: string) =>
    json(status, { error: { code, message, details: {}, request_id: `mock-${n}`, retryable: false } });

  return async (input, init) => {
    const path = new URL(String(input), location.href).pathname.replace(/^\/viggle-api/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body instanceof FormData
      ? Object.fromEntries(init.body.entries())
      : init?.body ? JSON.parse(String(init.body)) : {};
    console.info('[mock api]', method, path, body);

    const op = path.match(/^\/v1\/scenes\/(pano|custom-pano|generate|reconstruct)$/)?.[1] as SceneOperation | undefined;
    if (method === 'POST' && op) {
      const sessionId = String(body.sessionId ?? '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
        return refuse(400, 'INVALID_REQUEST', 'sessionId must be 1-128 ASCII letters, digits, underscores or hyphens');
      }
      if (busy.has(sessionId)) return refuse(409, 'SESSION_BUSY', 'this session already has a running task');
      busy.add(sessionId);
      const id = `scn_mock${++n}.${sessionId}`;
      const task: SceneTask = { id, sessionId, operation: op, status: 'processing', createdAt: Date.now(), completedAt: null, result: null, error: null };
      tasks.set(id, { polls: 0, task, batch: op === 'reconstruct' ? null : crypto.randomUUID() });
      return json(200, task);
    }

    const get = path.match(/^\/v1\/scenes\/(.+)$/);
    if (method === 'GET' && get) {
      const entry = tasks.get(decodeURIComponent(get[1]!));
      if (!entry) return refuse(400, 'INVALID_REQUEST', 'scene task not found');
      entry.polls++;
      if (entry.polls < 3) return json(200, entry.task);
      busy.delete(entry.task.sessionId);
      const op = entry.task.operation;
      return json(200, {
        ...entry.task,
        status: 'ready',
        completedAt: Date.now(),
        result: {
          operation: op,
          sessionId: entry.task.sessionId,
          outputBatch: entry.batch ? { batchId: entry.batch, createdAt: Date.now(), kind: op === 'generate' ? 'generated' : 'initial', views: [] } : null,
          spz: { url: splatUrl },
          preview: null,
          panorama: null,
          referenceViewCount: 0,
          newViewCount: op === 'generate' ? 1 : op === 'reconstruct' ? 0 : 6,
          seconds: {},
        },
      } satisfies SceneTask);
    }
    return refuse(404, 'NOT_FOUND', 'not found');
  };
}
