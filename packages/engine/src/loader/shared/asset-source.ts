import { fetchAsset } from './asset-fetch';
import { ReadSource } from './read-source';

interface AssetSource {
  filename?: string;
  url?: string;
  /** In-memory bytes. Prefer `ArrayBuffer`: {@link ReadSource.arrayBuffer}
   *  returns it as-is, where a `File` is read back out of the blob store. */
  contents?: File | ArrayBuffer;
}

const createReadSource = async (
  assetSource: AssetSource,
  start?: number,
  end?: number,
): Promise<ReadSource> => {
  let source: ArrayBuffer | Blob | string | Response;
  if (start === undefined || end === undefined) {
    const s = assetSource.contents ?? assetSource.url ?? assetSource.filename;
    if (!s) throw new Error('AssetSource has no contents / url / filename');
    source = s;
  } else if (assetSource.contents) {
    source = assetSource.contents.slice(start, end);
  } else {
    const u = assetSource.url ?? assetSource.filename;
    if (!u) throw new Error('AssetSource has no url / filename for range fetch');
    source = await fetchAsset(u, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    });
  }
  return new ReadSource(source);
};

export type { AssetSource };

export { createReadSource };
