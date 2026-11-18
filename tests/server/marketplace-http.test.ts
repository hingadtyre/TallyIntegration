import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/server/http.js';
import { MarketplaceService } from '../../src/server/marketplace-service.js';
import type { MarketplacePage } from '../../src/shared/marketplace-contracts.js';
import { close, listen, serverFixture } from '../support/server-fixture.js';

const headers = { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' };

test('marketplace HTTP flow scopes accounts and requires dashboard authorization for every mutation', async (t) => {
  const f = serverFixture(t);
  const markets = new MarketplaceService(f.store, f.folder);
  const app = createApp(f.service, f.folder, undefined, undefined, markets);
  const address = await listen(app);
  try {
    const post = (path: string, input: unknown, requestHeaders = headers) =>
      fetch(`${address}/api/marketplaces/${path}`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(input),
      });
    const response = await fetch(`${address}/api/marketplaces`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const directory = (await response.json()) as { accounts: Array<{ id: string }> };
    const accountId = directory.accounts[0].id;
    const page = (await (
      await fetch(`${address}/api/marketplaces/listings?accountId=${accountId}`)
    ).json()) as MarketplacePage;
    const listing = page.listings[0];
    const edit = {
      accountId,
      listingId: listing.id,
      version: listing.version,
      edit: { kind: 'price', field: 'sellingPrice', value: 4500 },
    };
    for (const path of ['apply', 'add', 'refresh', 'connection', 'policy', 'reconcile']) {
      assert.equal(
        (await post(path, edit, { 'Content-Type': 'application/json' } as typeof headers)).status,
        403,
      );
      assert.equal(
        (
          await post(path, edit, {
            ...headers,
            Origin: 'https://untrusted.example',
          } as typeof headers)
        ).status,
        403,
      );
    }
    const applied = await post('apply', edit);
    assert.equal(applied.status, 200);
    assert.equal(
      ((await applied.json()) as { change: { state: string } }).change.state,
      'confirmed',
    );
    assert.equal((await post('apply', edit)).status, 409);
    assert.equal((await fetch(`${address}/api/marketplaces/listings?accountId=wrong`)).status, 404);
    assert.equal(
      (await fetch(`${address}/api/marketplaces/listings?accountId=${accountId}&page=-1`)).status,
      400,
    );
    assert.equal((await post('unknown', {})).status, 404);
    assert.equal(
      (
        await fetch(
          `${address}/api/marketplaces/listings?accountId=${accountId}&search=not-a-real-sku`,
        )
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${address}/api/publish`, { method: 'POST', headers, body: '{}' })).status,
      409,
    );
  } finally {
    await close(app);
    markets.stop();
    await markets.idle();
  }
});
