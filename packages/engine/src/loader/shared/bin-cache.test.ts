import assert from 'node:assert/strict';
import { it } from 'node:test';

import { setAssetFetch } from './asset-fetch.ts';
import { cachedFetch, indexAssetCache } from './bin-cache.ts';

const HOUR = 60 * 60 * 1000;
// A page origin, which `cacheKeyFor` needs before it will normalise a signed
// URL's rotating token out of the key. Without it node takes the branch that
// keys on the raw URL and the last case below cannot be written at all.
(globalThis as { location?: unknown }).location = { href: 'https://app.test/' };
const stored = new Map<string, Response>();
// A macrotask per call, like the real Cache API answering through the main thread.
const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 0));
(globalThis as { caches?: unknown }).caches = {
  open: () => later({
    keys: () => later([...stored.keys()].map((url) => new Request(url))),
    match: (key: string | Request) => later(stored.get(typeof key === 'string' ? key : key.url)?.clone()),
    put: async (key: string, res: Response) => { stored.set(key, res); },
    delete: async (key: string | Request) => stored.delete(typeof key === 'string' ? key : key.url),
  }),
};
stored.set('https://cdn.test/cached.vsplat', new Response('from cache', {
  headers: { 'X-Viggle-Cache-Expires': String(Date.now() + HOUR) },
}));
stored.set('https://cdn.test/expired.vsplat', new Response('old', {
  headers: { 'X-Viggle-Cache-Expires': String(Date.now() - 1) },
}));

const requested: string[] = [];
setAssetFetch(async (url) => {
  requested.push(url);
  return new Response('from network');
});

// Before the index loads (the gallery never builds one), two asks in the same
// lookup window must still come down once.
it('an ask during another ask\'s cache lookup joins its download', async () => {
  const first = cachedFetch('https://cdn.test/lookup.vsplat');
  const second = cachedFetch('https://cdn.test/lookup.vsplat');
  assert.equal(await (await first).text(), 'from network');
  assert.equal(await (await second).text(), 'from network');
  assert.deepEqual(requested, ['https://cdn.test/lookup.vsplat']);
  requested.length = 0;
});

it('indexing removes expired entries', async () => {
  assert.equal(await indexAssetCache(), 1);
  assert.equal(stored.has('https://cdn.test/expired.vsplat'), false);
});

it('an uncached asset is requested before any cache lookup', async () => {
  const pending = cachedFetch('https://cdn.test/new.vsplat');
  assert.deepEqual(requested, ['https://cdn.test/new.vsplat']);
  assert.equal(await (await pending).text(), 'from network');
});

it('an indexed asset is served from the cache', async () => {
  requested.length = 0;
  assert.equal(await (await cachedFetch('https://cdn.test/cached.vsplat')).text(), 'from cache');
  assert.deepEqual(requested, []);
});

it('a stored download is served from the cache next time', async () => {
  await cachedFetch('https://cdn.test/stored.vsplat');
  await later(null);
  requested.length = 0;
  assert.equal(await (await cachedFetch('https://cdn.test/stored.vsplat')).text(), 'from network');
  assert.deepEqual(requested, []);
});

// The scene viewer's prefetch depends on this: it asks for the capture while
// the panel is still sliding and the engine asks again afterwards, before the
// bytes can possibly have reached the store.
it('a second ask joins a download already in flight', async () => {
  requested.length = 0;
  const first = cachedFetch('https://cdn.test/inflight.vsplat');
  const second = cachedFetch('https://cdn.test/inflight.vsplat');
  assert.equal(await (await first).text(), 'from network');
  assert.equal(await (await second).text(), 'from network');
  assert.deepEqual(requested, ['https://cdn.test/inflight.vsplat']);
});

// A signed URL's token rotates, so two asks for the same object arrive under
// different query strings; the in-flight key has to normalise them the way the
// store's does, or the sharing silently stops working in production.
it('shares across a re-signed url for the same object', async () => {
  requested.length = 0;
  const base = 'https://cdn.test/signed.vsplat';
  const first = cachedFetch(`${base}?verify=aaa`);
  const second = cachedFetch(`${base}?verify=bbb`);
  assert.equal(await (await first).text(), 'from network');
  assert.equal(await (await second).text(), 'from network');
  assert.deepEqual(requested, [`${base}?verify=aaa`]);
});
