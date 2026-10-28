import { fetchAsset } from './asset-fetch';

/** The Cache Storage bucket the asset cache keeps its files in. */
export const ASSET_CACHE_NAME = 'viggle-asset-cache';
const MAX_TTL_MS = 60 * 60 * 1000;
const EXPIRES_HEADER = 'X-Viggle-Cache-Expires';

// Extensions that must never be persisted (bypass all caching). Empty now that
// `.ply` character/map splats are cached like `.spz` - kept as the hook for any
// future no-store asset type.
const NO_STORE_EXTENSIONS = new Set<string>([]);

// Extensions whose assets share one cache entry across rotating CDN URLs (e.g.
// Cloudflare query-string cache busters): for these, a signed URL's query
// string is dropped from the cache key, so the same bytes re-signed under a
// fresh token still hit. Anything else is cached under its full URL including
// query string.
const PATH_NORMALIZED_EXTENSIONS = new Set([
  '.anim',
  '.bin',
  '.glb',
  '.gltf',
  '.jpg',
  '.jpeg',
  '.mp3',
  '.ogg',
  '.opus',
  '.ply',
  '.png',
  '.spz',
  // VIGGCHAR v1 character bundles. Without this a signed `.vsplat` URL is
  // keyed on its rotating token, so the Cache API never hits AND (see the
  // store gate below) the bytes are never persisted at all - every reload
  // re-downloads a multi-MB character.
  '.vsplat',
  '.webp',
]);

let cachePromise: Promise<Cache | null> | null = null;

// Expiry stamp per cache key, filled by `indexAssetCache`. Once it is loaded,
// a key missing from it is known to be uncached, so `cachedFetch` can start
// the download at once: the Cache API lookup needs the main thread to answer,
// and a viewer opening keeps it busy for 100 ms or more.
let cacheIndex: Map<string, number> | null = null;
let buildingIndex: Map<string, number> | null = null;

function indexKey(key: string): string {
  try {
    return new URL(key, globalThis.location?.href).href;
  } catch {
    return key;
  }
}

function noteStored(key: string, expiry: number): void {
  cacheIndex?.set(indexKey(key), expiry);
  buildingIndex?.set(indexKey(key), expiry);
}

function noteDeleted(key: string): void {
  cacheIndex?.delete(indexKey(key));
  buildingIndex?.delete(indexKey(key));
}

function knownUncached(key: string): boolean {
  if (!cacheIndex) return false;
  const expiry = cacheIndex.get(indexKey(key));
  return !expiry || Date.now() >= expiry;
}

function getCache(): Promise<Cache | null> {
  if (!cachePromise) {
    cachePromise = (typeof caches !== 'undefined')
      ? caches.open(ASSET_CACHE_NAME).catch(() => null)
      : Promise.resolve(null);
  }
  return cachePromise;
}

function getPathname(url: string): string {
  return (() => {
    try {
      return new URL(url, globalThis.location?.href).pathname;
    } catch {
      return url.split(/[?#]/, 1)[0] ?? url;
    }
  })().toLowerCase();
}

function hasExtension(url: string, extensions: Set<string>): boolean {
  const pathname = getPathname(url);
  for (const ext of extensions) {
    if (pathname.endsWith(ext)) return true;
  }
  return false;
}

function isNoStoreAsset(url: string): boolean {
  return hasExtension(url, NO_STORE_EXTENSIONS);
}

/** Detect signed CDN URLs that rotate tokens (Cloudflare ?verify=, AWS S3 ?X-Amz-, Google Cloud CDN ?Signature=). */
function hasSignedQueryParams(url: string): boolean {
  const q = url.indexOf('?');
  if (q === -1) return false;
  const query = url.slice(q + 1).toLowerCase();
  return query.includes('verify=') || query.includes('x-amz-')
    || (query.includes('keyname=') && query.includes('signature='));
}

function cacheKeyFor(url: string): string {
  const pathname = getPathname(url);
  // Only strip query params for signed CDN URLs with rotating tokens
  const isSignedUrl = hasSignedQueryParams(url);
  const normalize = isSignedUrl && hasExtension(pathname, PATH_NORMALIZED_EXTENSIONS);
  if (normalize && typeof globalThis.location !== 'undefined') {
    return new URL(`/__viggle_asset_cache__${pathname}`, globalThis.location.href).href;
  }
  return url;
}

function stripCacheControlHeaders(init?: RequestInit): Headers {
  const headers = new Headers(init?.headers);
  headers.delete('If-None-Match');
  headers.delete('If-Modified-Since');
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  return headers;
}

/**
 * Absolute ms timestamp when a freshly-fetched response should expire.
 * Honors positive `Cache-Control: max-age=N` and `Expires:` values from the
 * server, capped at 1 hour. Returns 0 only for `no-store` (the server
 * explicitly forbids persisting the bytes anywhere) - never persisted.
 *
 * `no-cache` is deliberately NOT treated the same as `no-store`: per HTTP
 * semantics it means "store this, but revalidate with the server before
 * reusing it", not "don't store it". This loader is an app-owned asset
 * byte-cache, not an HTTP-spec-compliant shared cache, and every asset it
 * handles is immutable (a given URL's bytes never change), so revalidation
 * has no purpose here - the default 1-hour TTL is safe to apply instead of
 * refusing to cache at all. This matters in practice: dev servers (e.g.
 * Vite's static middleware) commonly send `Cache-Control: no-cache` on
 * every asset, which - before this fix - meant a cache-presence check could
 * never return true and any "reload finer detail once cached" flow was
 * permanently a no-op in local dev, regardless of how many times the same
 * URL was fetched.
 *
 * CDN asset URLs sometimes send `private,max-age=0`; those are also safe to
 * keep in our app-owned Cache API store for the default TTL, and already
 * fall through to it below (ageMs=0 skips the max-age branch).
 */
function computeExpiryMs(res: Response): number {
  const cc = res.headers.get('cache-control') ?? '';
  const lower = cc.toLowerCase();
  if (lower.includes('no-store')) return 0;

  const maxAgeMatch = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cc);
  if (maxAgeMatch) {
    const ageMs = Number(maxAgeMatch[1]) * 1000;
    if (ageMs > 0) return Date.now() + Math.min(ageMs, MAX_TTL_MS);
  }

  const expires = res.headers.get('expires');
  if (expires) {
    const t = Date.parse(expires);
    if (Number.isFinite(t)) {
      const ttl = t - Date.now();
      if (ttl <= 0) return 0;
      return Date.now() + Math.min(ttl, MAX_TTL_MS);
    }
  }

  return Date.now() + MAX_TTL_MS;
}

/** A buffered response, re-issuable: a `Response` body reads once, and these
 *  bytes are handed to the store, to the caller that asked for them, and to
 *  anyone who joined the download late. */
type Reissue = () => Response;

async function stampWithExpiry(res: Response, expiry: number): Promise<Reissue> {
  const headers = new Headers(res.headers);
  headers.set(EXPIRES_HEADER, String(expiry));
  const body = await res.arrayBuffer();
  return () => new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Downloads whose bytes have not reached the store yet, keyed as the store is.
 *
 * WHY: an asset is sometimes asked for BEFORE the code that decodes it asks.
 * The scene viewer starts a capture downloading the moment a scene is picked
 * (`useEnvironmentSlot`), before the engine has been built to ask for it.
 * Without this the second ask would miss - `cache.put` cannot land until the
 * whole body has been buffered, which on a cold 8.6 MB capture is over a
 * second - and start a SECOND download of the same file. Signed CDN URLs
 * carry `private,max-age=0`, so the browser's own HTTP cache would not save
 * it either.
 *
 * Not a general request cache: an entry lives only from the moment the
 * request goes out until the store has the bytes, after which `cache.match`
 * answers. The first caller's own `Response` is left streaming, untouched;
 * only a joiner is handed the buffered copy. That buffer is the one
 * `stampWithExpiry` has to make for the store anyway, so sharing it costs no
 * extra read of the body.
 *
 * An entry REJECTS when the response turns out not to be storable (not ok, or
 * `no-store`), which is a joiner's signal to go and ask for itself rather than
 * inherit a failure it cannot see into.
 */
const inflight = new Map<string, Promise<{ reissue: Reissue; expiry: number }>>();

/** Start a download and publish it for anyone who asks for the same object
 *  while it is still coming down. Returns the first caller's own response. */
function shareDownload(cacheKey: string, started: Promise<Response>): Promise<Response> {
  const buffering = started.then(async (res) => {
    const expiry = res.ok ? computeExpiryMs(res) : 0;
    if (expiry <= 0) throw new Error('[bin-cache] response is not storable');
    // Cloned while the body is still untouched. This callback is registered
    // before the first caller awaits the same promise, so it runs first.
    return { reissue: await stampWithExpiry(res.clone(), expiry), expiry };
  });
  inflight.set(cacheKey, buffering);
  // Nothing to share and nothing to store: drop the entry rather than leave a
  // rejected promise every later ask has to catch.
  buffering.catch(() => forgetShared(cacheKey, buffering));
  return started;
}

/** Store lookups under way. Until the index can answer for a key, a second ask
 *  in this window would miss too and start its own download; it waits instead,
 *  then joins the one the miss starts. */
const looking = new Map<string, Promise<unknown>>();

function forgetShared(cacheKey: string, entry: Promise<unknown>): void {
  if (inflight.get(cacheKey) === entry) inflight.delete(cacheKey);
}

/** Write a shared download's bytes to the store, then stop sharing them. */
function storeShared(cache: Cache | null, cacheKey: string): void {
  const entry = inflight.get(cacheKey);
  if (!entry) return;
  // No store to hand them to (no Cache API): the sharing window closes with
  // this call instead of with the write, so the buffer is not held for the
  // life of the page.
  if (!cache) {
    forgetShared(cacheKey, entry);
    return;
  }
  entry
    .then(({ reissue, expiry }) =>
      cache.put(cacheKey, reissue()).then(() => noteStored(cacheKey, expiry)))
    .catch(() => {})
    .finally(() => forgetShared(cacheKey, entry));
}

function expiryOf(cached: Response): number {
  return Number(cached.headers.get(EXPIRES_HEADER) ?? 0);
}

function isExpired(cached: Response): boolean {
  const stamp = expiryOf(cached);
  if (!stamp) return true;
  return Date.now() >= stamp;
}

/**
 * Fetch through a persistent Cache API layer with a 1-hour TTL.
 *   - Assets with cacheable extensions (.bin, .vsplat, .anim, .ply, …) →
 *     cached in Cache API
 *   - Signed URLs (?verify=, ?X-Amz-, ?Signature=) → query stripped for cache key
 *   - No-store assets → never persisted. `NO_STORE_EXTENSIONS` is empty
 *     today, so nothing takes this branch; see its declaration.
 * Server `Cache-Control: max-age` and `Expires` headers are honored as a cap
 * when they provide a positive TTL.
 * On network error, a stale cached copy is returned in preference to throwing.
 * After {@link indexAssetCache}, an asset known to be uncached skips the
 * lookup and its download starts synchronously.
 */
async function cachedFetch(url: string, init?: RequestInit): Promise<Response> {
  // No-store assets bypass all caching
  if (isNoStoreAsset(url)) {
    return fetchAsset(url, {
      ...init,
      cache: 'no-store',
      headers: stripCacheControlHeaders(init),
    });
  }

  // Only cache assets with known cacheable extensions
  if (!hasExtension(url, PATH_NORMALIZED_EXTENSIONS)) {
    return fetchAsset(url, init);
  }

  // Cache API with query-stripped key for signed URLs, full URL otherwise
  const cacheKey = cacheKeyFor(url);

  // Already coming down for someone else - take their bytes rather than ask
  // the network for the same object twice. Checked synchronously, before any
  // await, so two asks in the same turn share too. See `inflight`.
  const joined = inflight.get(cacheKey);
  if (joined) {
    try {
      return (await joined).reissue();
    } catch {
      // Not storable, so there are no bytes to inherit: ask for ourselves.
    }
  }

  const early = knownUncached(cacheKey) ? shareDownload(cacheKey, fetchAsset(url, init)) : null;
  const cache = await getCache();

  if (!cache) {
    if (early) storeShared(null, cacheKey);
    return early ?? fetchAsset(url, init);
  }

  let cached: Response | undefined;
  // Lets a waiting ask go once this one's hit or download is known.
  let release = () => {};
  if (!early) {
    // After the await above, so an ask from the same turn sees the first one's.
    const lookup = looking.get(cacheKey);
    if (lookup) {
      await lookup;
      return cachedFetch(url, init);
    }
    let done!: () => void;
    const settled = new Promise<void>((resolve) => { done = resolve; });
    looking.set(cacheKey, settled);
    release = () => {
      if (looking.get(cacheKey) === settled) looking.delete(cacheKey);
      done();
    };
    try {
      cached = await cache.match(cacheKey);
    } catch (err) {
      release();
      throw err;
    }
  }
  if (cached && !isExpired(cached)) {
    release();
    return cached;
  }

  let res: Response;
  try {
    const download = early ?? shareDownload(cacheKey, fetchAsset(url, init));
    release();
    res = await download;
  } catch (err) {
    const stale = cached ?? await cache.match(cacheKey);
    if (stale) return stale;
    throw err;
  }

  if (res.ok) {
    if (computeExpiryMs(res) > 0) {
      storeShared(cache, cacheKey);
    } else if (cached) {
      cache.delete(cacheKey).catch(() => {});
      noteDeleted(cacheKey);
    }
  }
  return res;
}

let indexing: Promise<number> | null = null;

/**
 * Delete expired entries and index the rest, so {@link cachedFetch} can start
 * an uncached download without waiting on a Cache API lookup. Call once when
 * the page is idle, before the first load; later calls share the first run.
 * Resolves to the number of entries removed.
 */
function indexAssetCache(): Promise<number> {
  if (!indexing) {
    indexing = (async () => {
      const cache = await getCache();
      if (!cache) return 0;
      const index = new Map<string, number>();
      buildingIndex = index;
      let removed = 0;
      try {
        await Promise.all((await cache.keys()).map(async (req) => {
          const res = await cache.match(req);
          if (!res) return;
          if (isExpired(res)) {
            if (await cache.delete(req)) removed++;
          } else if (!index.has(req.url)) {
            index.set(req.url, expiryOf(res));
          }
        }));
        cacheIndex = index;
      } finally {
        buildingIndex = null;
      }
      return removed;
    })().catch(() => 0);
  }
  return indexing;
}

export { cacheKeyFor, cachedFetch, indexAssetCache };
