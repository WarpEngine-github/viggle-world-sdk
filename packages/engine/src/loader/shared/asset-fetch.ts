/** Host-supplied transport, e.g. for renewing expiring URLs before a download. */
export type AssetFetch = (url: string, init?: RequestInit) => Promise<Response>;
let transport: AssetFetch = (url, init) => fetch(url, init);
export function setAssetFetch(fetcher: AssetFetch): void { transport = fetcher; }
export function fetchAsset(url: string, init?: RequestInit): Promise<Response> {
  return transport(url, init);
}
