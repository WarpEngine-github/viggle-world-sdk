import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ViggleSceneClient, withoutBatch } from './client.js';
import { SceneApiError, SceneNetworkError, SceneTimeoutError, serializeError } from './errors.js';
import { anglesToPose, c2wToPose, fileToWorld, poseToAngles, poseToC2W, toC2W, yawPitchOf } from './pose.js';
import type { SceneTask } from './types.js';

interface Call { method: string; url: string; auth: string | null; body: unknown }

/** A fetch that answers from a script, one response per call, and records what it was asked. */
function scripted(responses: Array<[number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      auth: headers.get('Authorization'),
      body: raw instanceof FormData ? raw : raw ? JSON.parse(String(raw)) : void 0,
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(JSON.stringify(next[1]), { status: next[0] });
  };
  return { calls, fetchImpl };
}

function task(id: string, status: SceneTask['status'], extra: Partial<SceneTask> = {}): SceneTask {
  return { id, sessionId: 's1', operation: 'pano', status, createdAt: 1, completedAt: null, result: null, error: null, ...extra };
}

function ready(id: string, op: SceneTask['operation'], batchId: string | null, spz: string): SceneTask {
  return task(id, 'ready', {
    operation: op,
    completedAt: 2,
    result: {
      operation: op, sessionId: 's1', spz: { url: spz }, preview: null, panorama: null,
      outputBatch: batchId ? { batchId, createdAt: 1, kind: 'generated', views: [] } : null,
      referenceViewCount: 0, newViewCount: 1, seconds: {},
    },
  });
}

const poll = { intervalMs: 1, maxIntervalMs: 1 };
const KEY = 'sk-test';
/** Batch ids are lowercase UUIDs: the API (and the client) refuse anything else. */
const B0 = '00000000-0000-4000-8000-000000000000';
const B1 = '11111111-1111-4111-8111-111111111111';

test('generateScene: POST /v1/scenes/pano with the key, poll, one version', async () => {
  const { calls, fetchImpl } = scripted([
    [200, task('t1', 'processing')],
    [200, task('t1', 'processing')],
    [200, ready('t1', 'pano', B0, 'https://cdn/s0.spz?sig')],
  ]);
  const client = new ViggleSceneClient({ apiKey: KEY, fetch: fetchImpl });
  const seen: string[] = [];
  const scene = await client.generateScene(
    { sessionId: 's1', prompt: 'an office', quality: 'low' },
    { ...poll, onUpdate: (t) => seen.push(t.status) },
  );

  assert.equal(calls[0]!.url, 'https://apis.viggle.ai/v1/scenes/pano');
  assert.equal(calls[0]!.auth, 'Bearer sk-test');
  assert.deepEqual(calls[0]!.body, { sessionId: 's1', prompt: 'an office', quality: 'low' });
  assert.equal(calls[1]!.url, 'https://apis.viggle.ai/v1/scenes/t1');
  assert.deepEqual(seen, ['processing', 'processing', 'ready']);
  assert.equal(scene.sessionId, 's1');
  assert.deepEqual(scene.versions.map((v) => [v.batchIds, v.splatUrl]), [[[B0], 'https://cdn/s0.spz?sig']]);
});

test('a session id is minted when none is given', async () => {
  const { calls, fetchImpl } = scripted([[200, task('t', 'processing')]]);
  await new ViggleSceneClient({ fetch: fetchImpl }).createSceneTask({ prompt: 'x' });
  assert.match((calls[0]!.body as { sessionId: string }).sessionId, /^scene-[A-Za-z0-9_-]+$/);
  assert.equal(calls[0]!.auth, null);
});

test('a panorama file goes multipart, with the pose as a JSON field', async () => {
  const { calls, fetchImpl } = scripted([[200, task('t', 'processing', { operation: 'custom-pano' })]]);
  const client = new ViggleSceneClient({ apiKey: KEY, baseUrl: 'https://proxy.test/', fetch: fetchImpl });
  const file = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' });
  await client.createSceneFromPanoramaTask({ sessionId: 's1', panorama: file });

  assert.equal(calls[0]!.url, 'https://proxy.test/v1/scenes/custom-pano');
  const form = calls[0]!.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('sessionId'), 's1');
  assert.deepEqual(JSON.parse(String(form.get('panoramaC2w'))), [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  assert.ok(form.get('panorama') instanceof Blob);
});

test('a panorama URL goes JSON as panoramaUri', async () => {
  const { calls, fetchImpl } = scripted([[200, task('t', 'processing')]]);
  await new ViggleSceneClient({ fetch: fetchImpl }).createSceneTask({ sessionId: 's1', panorama: 'https://x/p.jpg' });
  assert.deepEqual(calls[0]!.body, { sessionId: 's1', panoramaUri: 'https://x/p.jpg' });
});

test('prompt and panorama together are refused before any request', async () => {
  const { calls, fetchImpl } = scripted([]);
  const client = new ViggleSceneClient({ fetch: fetchImpl });
  assert.throws(() => client.createSceneTask({ prompt: 'x', panorama: 'https://x/p.jpg' }), SceneApiError);
  assert.equal(calls.length, 0);
});

test('expandScene sends every batch and the pose as targetC2w, and appends the new batch', async () => {
  const { calls, fetchImpl } = scripted([
    [200, task('t2', 'processing', { operation: 'generate' })],
    [200, ready('t2', 'generate', B1, 'https://cdn/s1.spz')],
  ]);
  const client = new ViggleSceneClient({ apiKey: KEY, fetch: fetchImpl });
  const base = { sessionId: 's1', versions: [{ taskId: 't1', operation: 'pano' as const, batchIds: [B0], splatUrl: 'u0', createdAt: 1 }] };
  const pose = { position: [0, 0, -2] as [number, number, number], forward: [0, 0, 1] as [number, number, number] };
  const next = await client.expandScene(base, pose, { ...poll, fov: 60 });

  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(calls[0]!.url, 'https://apis.viggle.ai/v1/scenes/generate');
  assert.deepEqual(body.referenceBatchIds, [B0]);
  assert.equal(body.projection, 'perspective');
  assert.equal(body.fov, 60);
  assert.deepEqual(body.targetC2w, [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, -2], [0, 0, 0, 1]]);
  assert.deepEqual(next.versions.map((v) => v.batchIds), [[B0], [B0, B1]]);
  assert.deepEqual(next.versions[1]!.pose, pose);
  assert.equal(base.versions.length, 1, 'the input scene is not mutated');
});

test('rebuildScene without a batch posts the shortened list and adds no batch', async () => {
  const { calls, fetchImpl } = scripted([[200, ready('t3', 'reconstruct', null, 'https://cdn/s2.spz')]]);
  const client = new ViggleSceneClient({ fetch: fetchImpl });
  const scene = {
    sessionId: 's1',
    versions: [
      { taskId: 't1', operation: 'pano' as const, batchIds: [B0], splatUrl: 'u0', createdAt: 1 },
      { taskId: 't2', operation: 'generate' as const, batchIds: [B0, B1], splatUrl: 'u1', createdAt: 2 },
    ],
  };
  const next = await client.rebuildScene(scene, withoutBatch(scene, B1), poll);
  assert.equal(calls[0]!.url, 'https://apis.viggle.ai/v1/scenes/reconstruct');
  assert.deepEqual(calls[0]!.body, { sessionId: 's1', referenceBatchIds: [B0] });
  assert.deepEqual(next.versions[2]!.batchIds, [B0]);
  assert.equal(next.versions[2]!.splatUrl, 'https://cdn/s2.spz');
});

test('a refused request keeps the envelope: code, request id, running task', async () => {
  const { fetchImpl } = scripted([[409, { error: {
    code: 'SESSION_BUSY', message: 'this session already has a running task',
    details: { running_task_id: 'scn_a.s1' }, request_id: 'req-1', retryable: false,
  } }]]);
  const client = new ViggleSceneClient({ fetch: fetchImpl });
  const err = await client.reconstructTask({ sessionId: 's1', referenceBatchIds: [B0] }).catch((e) => e);
  assert.ok(err instanceof SceneApiError);
  assert.equal(err.status, 409);
  assert.equal(err.code, 'SESSION_BUSY');
  assert.equal(err.requestId, 'req-1');
  assert.equal(err.runningTaskId, 'scn_a.s1');
});

test('a failed task rejects with its error, status 0', async () => {
  const { fetchImpl } = scripted([[200, task('t', 'failed', {
    error: { code: 'PROCESSING_FAILED', message: 'model crashed', retryable: true },
  })]]);
  const err = await new ViggleSceneClient({ fetch: fetchImpl }).waitForTask('t', poll).catch((e) => e);
  assert.ok(err instanceof SceneApiError);
  assert.equal(err.status, 0);
  assert.equal(err.code, 'PROCESSING_FAILED');
  assert.equal(err.retryable, true);
  assert.equal(err.message, 'model crashed');
});

test('aborting stops the polling', async () => {
  const { fetchImpl } = scripted(Array.from({ length: 50 }, () => [200, task('t', 'processing')] as [number, unknown]));
  const ctl = new AbortController();
  const p = new ViggleSceneClient({ fetch: fetchImpl }).waitForTask('t', { intervalMs: 20, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 5);
  await assert.rejects(p, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
});

test('refreshScene re-signs every version from its task', async () => {
  const { fetchImpl } = scripted([
    [200, ready('t1', 'pano', B0, 'fresh0')],
    [400, { error: { code: 'INVALID_REQUEST', message: 'scene task not found' } }],
  ]);
  const scene = {
    sessionId: 's1',
    versions: [
      { taskId: 't1', operation: 'pano' as const, batchIds: [B0], splatUrl: 'old0', createdAt: 1 },
      { taskId: 't2', operation: 'generate' as const, batchIds: [B0, B1], splatUrl: 'old1', createdAt: 2 },
    ],
  };
  const next = await new ViggleSceneClient({ fetch: fetchImpl }).refreshScene(scene);
  assert.deepEqual(next.versions.map((v) => v.splatUrl), ['fresh0', 'old1']);
});

test('pose: the file frame is the world turned half about X', () => {
  assert.deepEqual(fileToWorld([1, 2, 3]), [1, -2, -3]);
  const { yaw, pitch } = yawPitchOf(fileToWorld([0, 0, 1]));
  assert.ok(Math.abs(yaw) < 1e-9 && Math.abs(pitch) < 1e-9);
  assert.ok(yawPitchOf(fileToWorld([0, -1, 0])).pitch > 89);
});

test('poseToC2W is level, right-handed, and round-trips through c2wToPose', () => {
  const pose = { position: [1, 2, 3] as [number, number, number], forward: [1, 0, 1] as [number, number, number] };
  const m = poseToC2W(pose);
  const right = [m[0]![0]!, m[1]![0]!, m[2]![0]!];
  const down = [m[0]![1]!, m[1]![1]!, m[2]![1]!];
  assert.ok(Math.abs(right[1]!) < 1e-12, 'no roll: right is horizontal');
  assert.ok(down[1]! > 0.99, 'down points down (+Y in the file frame)');
  const back = c2wToPose(m);
  assert.deepEqual(back.position, [1, 2, 3]);
  assert.ok(Math.abs(back.forward[0]! - Math.SQRT1_2) < 1e-9 && Math.abs(back.forward[2]! - Math.SQRT1_2) < 1e-9);
  // Straight up has no horizon: tipped one degree off, never NaN.
  const up = poseToC2W({ position: [0, 0, 0], forward: [0, -1, 0] });
  assert.ok(up.flat().every(Number.isFinite));
});

test('a poll that fails transiently is retried, not fatal', async () => {
  const { calls, fetchImpl } = scripted([
    [503, { error: { code: 'UNAVAILABLE', message: 'try again' } }],
    [429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }],
    [200, ready('t', 'pano', B0, 'u')],
  ]);
  const t = await new ViggleSceneClient({ fetch: fetchImpl }).waitForTask('t', poll);
  assert.equal(t.status, 'ready');
  assert.equal(calls.length, 3);
});

test('polling gives up after maxPollErrors transient failures in a row', async () => {
  const { fetchImpl } = scripted(Array.from({ length: 5 }, () => [502, {}] as [number, unknown]));
  const err = await new ViggleSceneClient({ fetch: fetchImpl })
    .waitForTask('t', { ...poll, maxPollErrors: 2 }).catch((e) => e);
  assert.ok(err instanceof SceneApiError);
  assert.equal(err.status, 502);
});

test('a 4xx on a poll is not retried', async () => {
  const { calls, fetchImpl } = scripted([[401, { error: { code: 'UNAUTHORIZED', message: 'bad key' } }]]);
  const err = await new ViggleSceneClient({ fetch: fetchImpl }).waitForTask('t', poll).catch((e) => e);
  assert.equal(err.status, 401);
  assert.equal(calls.length, 1);
});

test('an invalid sessionId is refused before any request', () => {
  const { calls, fetchImpl } = scripted([]);
  const client = new ViggleSceneClient({ fetch: fetchImpl });
  assert.throws(() => client.createSceneTask({ sessionId: 'has space', prompt: 'x' }), /sessionId/);
  assert.equal(calls.length, 0);
});

test('requests the API would refuse are refused locally, with its code and words', () => {
  const { calls, fetchImpl } = scripted([]);
  const client = new ViggleSceneClient({ fetch: fetchImpl });
  const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const refused = (fn: () => unknown, message: RegExp) => assert.throws(fn, (e: unknown) =>
    e instanceof SceneApiError && e.status === 400 && e.code === 'INVALID_REQUEST' && message.test(e.message));
  refused(() => client.createSceneTask({ prompt: '   ' }), /prompt must be 1-1000/);
  refused(() => client.createSceneTask({ prompt: 'a'.repeat(1001) }), /prompt must be 1-1000/);
  refused(() => client.createSceneTask({ prompt: 'x', quality: 'fast' as never }), /quality must be low, medium or high/);
  refused(() => client.createSceneTask({ prompt: 'x', referenceImages: ['ftp://a/b.jpg'] }), /referenceImages\[0\] must be an http\(s\) URL/);
  refused(() => client.createSceneTask({ prompt: 'x', referenceImages: Array(9).fill('https://a/b.jpg') }), /at most 8/);
  refused(() => client.createSceneTask({ prompt: 'x', spzOutputUrl: 'https://u:p@x/a' }), /spzOutputUrl/);
  refused(() => client.generateViewTask({ sessionId: 's', referenceBatchIds: ['AAAAAAAA-0000-4000-8000-000000000000'], pose: I }), /lowercase canonical UUIDs/);
  refused(() => client.generateViewTask({ sessionId: 's', referenceBatchIds: [B0, B0], pose: I }), /must not repeat/);
  refused(() => client.generateViewTask({ sessionId: 's', referenceBatchIds: [B0], pose: I, fov: 10 }), /fov must be a number from 20 to 140/);
  refused(() => client.generateViewTask({ sessionId: 's', referenceBatchIds: [B0], pose: I, seed: 1.5 }), /seed must be an integer/);
  refused(() => client.generateViewTask({ sessionId: 's', referenceBatchIds: [B0], pose: [[1, 0], [0, 1]] }), /targetC2w must be a 4x4/);
  refused(() => client.reconstructTask({ sessionId: 's', referenceBatchIds: [] }), /1-35 batch IDs/);
  refused(() => client.createSceneFromPanoramaTask({ panorama: 'https://x/p.jpg', pose: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 2]] }), /panoramaC2w/);
  assert.equal(calls.length, 0);
});

test('an expand past the 40-image ceiling is refused before a generation is spent', async () => {
  const { calls, fetchImpl } = scripted([]);
  const scene = { sessionId: 's1', versions: [{ taskId: 't1', operation: 'generate' as const, batchIds: [B0], splatUrl: 'u', viewCount: 40, createdAt: 1 }] };
  const pose = { position: [0, 0, 0] as [number, number, number], forward: [0, 0, 1] as [number, number, number] };
  await assert.rejects(new ViggleSceneClient({ fetch: fetchImpl }).expandScene(scene, pose), /at most 40 images/);
  assert.equal(calls.length, 0);
});

test('a version keeps its batch (views and cameras) and how many images built it', async () => {
  const { fetchImpl } = scripted([[200, ready('t1', 'pano', B0, 'https://cdn/s0.spz')]]);
  const scene = await new ViggleSceneClient({ fetch: fetchImpl }).generateScene({ prompt: 'x' }, poll);
  assert.equal(scene.versions[0]!.batch?.batchId, B0);
  assert.equal(scene.versions[0]!.viewCount, 1);
});

test('waitIfBusy waits out the running task, then submits again', async () => {
  const { calls, fetchImpl } = scripted([
    [409, { error: { code: 'CONFLICT', message: 'busy', details: { running_task_id: 'scn_other.s1' } } }],
    [200, task('scn_other.s1', 'failed', { error: { code: 'PROCESSING_FAILED', message: 'x' } })],
    [200, task('t2', 'processing', { operation: 'reconstruct' })],
    [200, ready('t2', 'reconstruct', null, 'https://cdn/s.spz')],
  ]);
  const scene = { sessionId: 's1', versions: [{ taskId: 't1', operation: 'pano' as const, batchIds: [B0], splatUrl: 'u', createdAt: 1 }] };
  const next = await new ViggleSceneClient({ fetch: fetchImpl }).rebuildScene(scene, void 0, { ...poll, waitIfBusy: true });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace('https://apis.viggle.ai', '')}`), [
    'POST /v1/scenes/reconstruct', 'GET /v1/scenes/scn_other.s1', 'POST /v1/scenes/reconstruct', 'GET /v1/scenes/t2',
  ]);
  assert.equal(next.versions.length, 2);
});

test('the request id falls back to the X-Request-Id header; shouldRetry goes by status', async () => {
  const fetchImpl: typeof fetch = async () => new Response('404 page not found', { status: 404, headers: { 'X-Request-Id': 'hdr-1' } });
  const err = await new ViggleSceneClient({ fetch: fetchImpl }).getTask('x').catch((e) => e);
  assert.equal(err.requestId, 'hdr-1');
  assert.equal(err.shouldRetry, false);
  assert.equal(new SceneApiError(409, void 0, '').shouldRetry, true);
  assert.equal(new SceneApiError(401, { code: 'UNAUTHENTICATED', message: 'x' }, '').isAuthError, true);
});

test('a task failed on a batch the API does not hold says so', async () => {
  const { fetchImpl } = scripted([[200, task('t', 'failed', { error: { code: 'INVALID_REQUEST', message: 'Cache rejected scene request' } })]]);
  const err = await new ViggleSceneClient({ fetch: fetchImpl }).waitForTask('t', poll).catch((e) => e);
  assert.match(err.message, /does not hold one of the scene's batches/);
  assert.equal(err.retryable, false);
});

// ── base64 images ───────────────────────────────────────────────────────────

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test('a data URL or a Base64Image goes up as a file, bytes intact', async () => {
  const { calls, fetchImpl } = scripted([[200, task('t', 'processing')], [200, task('t2', 'processing', { operation: 'custom-pano' })]]);
  const client = new ViggleSceneClient({ fetch: fetchImpl });
  await client.createSceneTask({ prompt: 'x', referenceImages: [`data:image/png;base64,${PNG_B64}`, { base64: PNG_B64, mimeType: 'image/png', name: 'ref.png' }] });
  const form = calls[0]!.body as FormData;
  const files = form.getAll('referenceImageFiles') as File[];
  assert.equal(files.length, 2);
  assert.equal(files[0]!.type, 'image/png');
  assert.equal(files[1]!.name, 'ref.png');
  assert.equal(Buffer.from(await files[0]!.arrayBuffer()).toString('base64'), PNG_B64);
  assert.equal(form.get('prompt'), 'x');

  await client.createSceneFromPanoramaTask({ panorama: { base64: PNG_B64, mimeType: 'image/png' } });
  assert.ok((calls[1]!.body as FormData).get('panorama') instanceof Blob);
});

test('bad base64 images are refused before any request', () => {
  const { calls, fetchImpl } = scripted([]);
  const client = new ViggleSceneClient({ fetch: fetchImpl });
  assert.throws(() => client.createSceneTask({ prompt: 'x', referenceImages: ['data:image/gif;base64,R0lGOD'] }), /JPEG, PNG or WebP/);
  assert.throws(() => client.createSceneTask({ prompt: 'x', referenceImages: [{ base64: '***', mimeType: 'image/png' }] }), /not valid base64/);
  assert.throws(() => client.createSceneTask({ prompt: 'x', referenceImages: ['https://a/b.jpg', `data:image/png;base64,${PNG_B64}`] }), /not a mix/);
  assert.equal(calls.length, 0);
});

// ── errors as JSON ──────────────────────────────────────────────────────────

test('errors serialize to JSON with what went wrong and no signed URLs', async () => {
  const { fetchImpl } = scripted([[200, ready('t', 'pano', B0, 'https://cdn/secret.spz?sig')]]);
  const failed = { ...(await new ViggleSceneClient({ fetch: fetchImpl }).getTask('t')), status: 'failed' as const, error: { code: 'PROCESSING_FAILED', message: 'boom', retryable: true, request_id: 'r1' } };
  const json = JSON.parse(JSON.stringify(new SceneApiError(0, failed.error, '', failed)));
  assert.deepEqual(json, {
    name: 'SceneApiError', message: 'boom', status: 0, code: 'PROCESSING_FAILED', requestId: 'r1', retryable: true, shouldRetry: true,
    remediation: { retryAfterMs: null }, details: {}, taskId: 't',
  });
  assert.ok(!JSON.stringify(json).includes('secret'));
  assert.deepEqual(serializeError(new SceneTimeoutError('t9')), { name: 'SceneTimeoutError', message: 'Timed out waiting for scene task t9.', taskId: 't9', shouldRetry: true });
  assert.equal(serializeError(new SceneNetworkError(new TypeError('fetch failed'))).cause, 'fetch failed');
  assert.deepEqual(serializeError('weird'), { name: 'Error', message: 'weird' });
});

// ── camera angles ───────────────────────────────────────────────────────────

/** A panorama's cube faces as the API returns them (read off apis.viggle.ai): [forward, right]. */
const FACES: Array<[string, number, number, number[], number[]]> = [
  ['front', 0, 0, [0, 0, 1], [1, 0, 0]],
  ['right', 90, 0, [1, 0, 0], [0, 0, -1]],
  ['back', 180, 0, [0, 0, -1], [-1, 0, 0]],
  ['left', -90, 0, [-1, 0, 0], [0, 0, 1]],
];

test('yaw/pitch: yaw 0/90/180/-90 are the front/right/back/left faces the API makes', () => {
  for (const [face, yaw, pitch, fwd, right] of FACES) {
    const m = toC2W({ yaw, pitch });
    const col = (j: number) => [m[0]![j]!, m[1]![j]!, m[2]![j]!].map((v) => Math.round(v * 1e6) / 1e6 || 0);
    assert.deepEqual(col(2), fwd, `${face} forward`);
    assert.deepEqual(col(0), right, `${face} right`);
  }
  // Up is -Y in the Y-down file.
  assert.ok(anglesToPose({ yaw: 0, pitch: 90 }).forward[1] < -0.999);
  assert.deepEqual(toC2W({ position: [1, 2, 3], yaw: 0 }).map((r) => r[3]), [1, 2, 3, 1]);
});

test('yaw/pitch round-trips through a pose, and is refused out of range', () => {
  for (const [yaw, pitch] of [[30, 10], [-135, -40], [180, 0], [0, 89]]) {
    const back = poseToAngles(anglesToPose({ position: [1, 0, 2], yaw, pitch }));
    assert.ok(Math.abs(back.yaw - yaw) < 1e-9 && Math.abs(back.pitch - pitch) < 1e-9, `${yaw},${pitch} -> ${back.yaw},${back.pitch}`);
  }
  assert.throws(() => anglesToPose({ yaw: 0, pitch: 95 }), RangeError);
});

test('expandScene takes angles, sends their matrix, and keeps them as a pose', async () => {
  const { calls, fetchImpl } = scripted([[200, task('t2', 'processing', { operation: 'generate' })], [200, ready('t2', 'generate', B1, 'u1')]]);
  const base = { sessionId: 's1', versions: [{ taskId: 't1', operation: 'pano' as const, batchIds: [B0], splatUrl: 'u0', createdAt: 1 }] };
  const next = await new ViggleSceneClient({ fetch: fetchImpl }).expandScene(base, { yaw: 90 }, poll);
  assert.deepEqual((calls[0]!.body as { targetC2w: number[][] }).targetC2w, JSON.parse(JSON.stringify(toC2W({ yaw: 90 }))));
  const pose = next.versions[1]!.pose!;
  assert.ok(Math.abs(pose.forward[0] - 1) < 1e-9);
});

test('fetchSplat re-signs an expired URL once and downloads the bytes', async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    seen.push(String(url));
    return String(url).includes('fresh') ? new Response('SPZ!') : new Response('expired', { status: 403 });
  }) as typeof fetch;
  try {
    const { calls, fetchImpl } = scripted([[200, ready('t1', 'pano', B0, 'https://cdn/fresh.spz')]]);
    const scene = { sessionId: 's1', versions: [{ taskId: 't1', operation: 'pano' as const, batchIds: [B0], splatUrl: 'https://cdn/old.spz', createdAt: 1 }] };
    const blob = await new ViggleSceneClient({ fetch: fetchImpl }).fetchSplat(scene);
    assert.equal(await blob.text(), 'SPZ!');
    assert.deepEqual(seen, ['https://cdn/old.spz', 'https://cdn/fresh.spz']);
    assert.equal(calls[0]!.url, 'https://apis.viggle.ai/v1/scenes/t1');
  } finally {
    globalThis.fetch = real;
  }
});

test('placementFromGround: the capture point stands captureHeight above the floor', async () => {
  const { placementFromGround } = await import('../walk/placement.js');
  assert.deepEqual(placementFromGround(0.15), { upright: undefined, scale: 10, floor: 0.15, start: [0, 0] });
  assert.deepEqual(placementFromGround(0.5, { upright: true, captureHeight: 1.6 }), { upright: true, scale: 3.2, floor: -0.5, start: [0, 0] });
  // Nothing found: a typical generated scene.
  assert.equal(placementFromGround(null).scale, 10);
});

test('isUprightFile: an .spz is +Y up, a .ply the API camera frame', async () => {
  const { isUprightFile } = await import('../walk/placement.js');
  assert.equal(isUprightFile('scene.spz'), true);
  assert.equal(isUprightFile('https://x/scene.SPZ?sig=1'), true);
  assert.equal(isUprightFile('room.ply'), false);
});
