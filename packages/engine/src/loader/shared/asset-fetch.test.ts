import assert from 'node:assert/strict';
import { it } from 'node:test';

import { fetchAsset, setAssetFetch } from './asset-fetch.ts';

it('host transport receives range and cancellation options unchanged', async () => {
  const signal = new AbortController().signal;
  const init = { headers: { Range: 'bytes=0-31' }, signal };
  setAssetFetch(async (url, received) => {
    assert.equal(url, '/asset.bin');
    assert.equal(received, init);
    return new Response('bytes', { status: 206 });
  });
  const response = await fetchAsset('/asset.bin', init);
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'bytes');
});
