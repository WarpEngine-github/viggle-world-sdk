import type { AssetRegistry } from 'playcanvas';
import { Asset, GSplatData, GSplatResource } from 'playcanvas';

import type { AssetSource } from '../shared/asset-source';
import { cacheKeyFor } from '../shared/bin-cache';

let assetId = 0;

// One download started ahead of the engine; a newer one replaces it.
let early: { key: string; response: Promise<Response>; abort: AbortController; holders: number } | null = null;

/**
 * Start downloading a `.sog` / `.ply` before the engine asks for it, so the
 * bytes come down while the viewer is still being built. `loadGsplat` takes it
 * if it asks for the same file next. Returns a release: once every caller has
 * released it and the engine hasn't taken it, it's cancelled and dropped.
 */
export function prefetchGsplat(url: string, { priority }: { priority?: RequestPriority } = {}): () => void {
  const key = cacheKeyFor(url);
  if (early?.key !== key) {
    // Replaced, nothing can take it any more.
    early?.abort.abort();
    const abort = new AbortController();
    // Read at once: an unread body stalls the download when its pipe fills. A blob,
    // not a buffer: the browser can keep a large one off the JS heap.
    const response = fetch(url, { priority, signal: abort.signal }).then(async (res) => {
      if (!res.ok) throw new Error(`Failed to fetch asset: ${res.status} ${res.statusText}`);
      const body = await res.blob();
      // PC's progress total; the fetched response's can be the compressed size.
      return new Response(body, { headers: { 'content-length': String(body.size) } });
    });
    // A failed early download is retried by the real load, which reports it.
    response.catch(() => {});
    early = { key, response, abort, holders: 0 };
  }
  const entry = early;
  entry.holders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.holders > 0 || early !== entry) return;
    early = null;
    entry.abort.abort();
  };
}

// use the engine to load a gsplat asset (ply, compressed.ply, sog, sog-bundle)
export const loadGsplat = (assets: AssetRegistry, assetSource: AssetSource) => {
  const { url } = assetSource;
  const entry = !assetSource.contents && url && early?.key === cacheKeyFor(url) ? early : null;
  if (entry) early = null;
  // PC awaits `contents`, so the download in flight goes in as it is.
  const contents = entry
    ? entry.response.catch(() => fetch(url!))
    : assetSource.contents &&
      (assetSource.contents instanceof Response
        ? assetSource.contents
        : new Response(assetSource.contents));

  const file = {
    // we must construct a unique url if contents is provided
    url: contents
      ? `local-asset-${assetId++}`
      : (assetSource.url ?? assetSource.filename),
    filename: assetSource.filename,
    contents,
  };

  const data = {
    decompress: true,
    reorder: true,
  };

  return new Promise<Asset>((resolve, reject) => {
    const asset = new Asset(
      assetSource.filename || assetSource.url || 'gsplat',
      'gsplat',
      // @ts-ignore
      file,
      data,
    );

    // A decompressed `.sog` bundle leaves its source textures (and the zip
    // bytes behind them) registered until unload; nothing reads them once the
    // resource is built, so they go at 'load'.
    // PC types `Asset.file` as a bare object.
    type AssetFile = { url?: string; contents?: unknown } | null;
    const sources: Asset[] = [];
    const prefix = `${asset.getFileUrl()}/`;
    const onAdd = (added: Asset) => {
      if (added.type === 'texture' && (added.file as AssetFile)?.url?.startsWith(prefix)) sources.push(added);
    };
    assets.on('add', onAdd);

    asset.on('load:data', (data: GSplatData) => {
      // support loading 2d splats by adding scale_2 property with almost 0 scale
      if (
        data instanceof GSplatData &&
        data.getProp('scale_0') &&
        data.getProp('scale_1') &&
        !data.getProp('scale_2')
      ) {
        const scale2 = new Float32Array(data.numSplats).fill(Math.log(1e-6));
        data.addProp('scale_2', scale2);

        const props = data.getElement('vertex').properties;
        props.splice(
          props.findIndex((prop: { name: string }) => prop.name === 'scale_1') + 1,
          0,
          props.splice(props.length - 1, 1)[0],
        );
      }
    });

    asset.on('load', () => {
      assets.off('add', onAdd);
      if (asset.resource instanceof GSplatResource) {
        for (const t of sources) {
          assets.remove(t);
          t.unload();
          // PC's unload listener still holds the asset; this is the zip slice.
          const file = t.file as AssetFile;
          if (file) file.contents = undefined;
        }
      }
      const required = [
        'x',
        'y',
        'z',
        'scale_0',
        'scale_1',
        'scale_2',
        'rot_0',
        'rot_1',
        'rot_2',
        'rot_3',
        'f_dc_0',
        'f_dc_1',
        'f_dc_2',
        'opacity',
      ];
      const splatData = (asset.resource as GSplatResource)
        .gsplatData as GSplatData;
      const missing = required.filter((x) => !splatData.getProp(x));
      if (missing.length > 0) {
        reject(
          new Error(
            `This file does not contain gaussian splatting data. The following properties are missing: ${missing.join(', ')}`,
          ),
        );
      } else {
        resolve(asset);
      }
    });

    asset.on('error', (err: string) => {
      assets.off('add', onAdd);
      reject(err);
    });

    assets.add(asset);
    assets.load(asset);
  });
};
