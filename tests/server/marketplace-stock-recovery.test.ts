import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { FlipkartListingError } from '../../src/adapters/flipkart-listings.js';
import {
  MarketplacePublication,
  type ListingTransport,
} from '../../src/server/marketplace-publication.js';
import { MarketplaceStockRecovery } from '../../src/server/marketplace-stock-recovery.js';
import { MarketplaceService } from '../../src/server/marketplace-service.js';
import { marketplaceData } from '../support/marketplace-fixture.js';
import { serverFixture } from '../support/server-fixture.js';

function setup(t: TestContext) {
  const f = serverFixture(t);
  const mapping = f.store.read().listings[0];
  const account = mapping.accountId;
  const data = marketplaceData(account);
  const remote = data.listings[0];
  remote.sku = mapping.sku;
  remote.locations = [{ id: mapping.location, status: 'ENABLED', quantity: 6 }];
  remote.observedAt = new Date().toISOString();
  data.changes = [];
  f.store.updateMarketplace((market, state) => {
    Object.assign(market, structuredClone(data));
    Object.assign(state.listings[0], {
      tyreFloor: false,
      packSource: 'manual',
      packSize: 1,
      sourceScope: 'company',
      observed: 6,
    });
  });
  let available = 4;
  let mode: 'completed' | 'lost' | 'rejected' = 'completed';
  const writes: number[] = [];
  let reads = 0;
  let duringWrite: (() => void) | undefined;
  const client: ListingTransport = {
    async listListings() {
      return [structuredClone(remote)];
    },
    async getListing(_token, listing) {
      return { ...structuredClone(remote), version: listing.version };
    },
    async updatePrice() {
      throw new Error('Unexpected price write');
    },
    async updateStock(_token, _listing, _loc, quantity) {
      const dispatching = f.store.readMarketplace().changes[0];
      assert.equal(dispatching.state, 'sending');
      assert.equal(dispatching.stockRequestFinality, undefined);
      writes.push(quantity);
      duringWrite?.();
      if (mode === 'rejected') throw new FlipkartListingError('Rejected');
      if (mode === 'lost') throw new FlipkartListingError('Missing receipt', true);
      // Model another customer purchasing one item after the provider's
      // terminal success. Only the second update is visible as submitted.
      remote.locations[0].quantity = writes.length === 1 ? quantity - 1 : quantity;
    },
  };
  let publisher = new MarketplacePublication(f.store, client);
  function service() {
    return new MarketplaceStockRecovery(f.store, client, publisher, async (companyId, itemId) => {
      assert.equal(itemId, mapping.itemId);
      assert.equal(f.store.read().items.find((i) => i.id === itemId)?.companyId, companyId);
      reads++;
      return { available, verify() {} };
    });
  }
  let recovery = service();
  const seller = () => {};
  const apply = async (quantity: number) => {
    const listing = f.store.readMarketplace().listings[0];
    return publisher.apply(
      account,
      {
        listingId: listing.id,
        version: listing.version,
        edit: { kind: 'stock', locationId: mapping.location, quantity, automation: 'once' },
      },
      'token',
    );
  };
  return {
    f,
    write: apply,
    writes,
    remote,
    account,
    get publisher() {
      return publisher;
    },
    onWrite(callback: () => void) {
      duringWrite = callback;
    },
    reads: () => reads,
    quantity: (n: number) => {
      available = n;
    },
    writeMode: (m: typeof mode) => {
      mode = m;
    },
    review: (id: string) => recovery.review(account, id, 'token', seller),
    approve: (id: string, reviewId: string) =>
      recovery.approve(account, id, reviewId, 'token', seller),
    check: (id: string) => publisher.reconcile(account, id, 'token'),
    restart: () => {
      f.reopen();
      publisher = new MarketplacePublication(f.store, client);
      recovery = service();
    },
  };
}

test('a completed stock request with a different readback can be reconciled without writing its quantity again', async (t) => {
  const s = setup(t);
  const { change } = await s.write(5);
  assert.equal(change.state, 'uncertain');
  assert.equal(change.stockRequestFinality, 'completed');
  s.restart();
  const review = await s.review(change.id);
  assert.equal(review.observed, 4);
  assert.equal(review.quantity, 4);
  const result = await s.approve(change.id, review.reviewId);
  assert.equal(result.change.id, change.id);
  assert.equal(result.change.state, 'reconciled');
  assert.match(result.change.message, /outcome was not verified/);
  assert.equal(s.reads(), 2);
  assert.deepEqual(s.writes, [5]);
  assert.equal((await s.check(change.id)).change.state, 'reconciled');
  await assert.rejects(s.approve(change.id, review.reviewId), /review expired or changed/);
});

test('a lost response stays blocked on matching and differing reads, including after restart', async (t) => {
  const s = setup(t);
  s.writeMode('lost');
  const { change } = await s.write(5);
  assert.equal(change.state, 'uncertain');
  assert.equal(change.stockRequestFinality, undefined);
  for (const current of [5, 4]) {
    s.remote.locations[0].quantity = current;
    s.restart();
    assert.equal((await s.check(change.id)).change.state, 'uncertain');
    await assert.rejects(s.review(change.id), /can still take effect/);
    await assert.rejects(s.write(3), /previous update result/);
  }
  assert.deepEqual(s.writes, [5]);
});

test('approval sends a separate current quantity and saves the old attempt even if the new update is rejected', async (t) => {
  for (const reject of [false, true])
    await t.test(reject ? 'rejected replacement' : 'confirmed replacement', async (t) => {
      const s = setup(t);
      const { change } = await s.write(5);
      s.quantity(3);
      const review = await s.review(change.id);
      if (reject) s.writeMode('rejected');
      const next = await s.approve(change.id, review.reviewId);
      assert.notEqual(next.change.id, change.id);
      assert.equal(next.change.state, reject ? 'failed' : 'confirmed');
      const prior = s.f.store.readMarketplace().changes.find((c) => c.id === change.id)!;
      assert.equal(prior.state, 'reconciled');
      assert.match(prior.message, /separate stock update of 3/);
      assert.deepEqual(s.writes, [5, 3]);
    });
});

test('stock recovery rejects a changed quantity, destination, mapping or expired approval', async (t) => {
  for (const failure of ['quantity', 'remote', 'mapping', 'expired'] as const)
    await t.test(failure, async (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      const s = setup(t);
      const { change } = await s.write(5);
      const review = await s.review(change.id);
      if (failure === 'quantity') s.quantity(2);
      if (failure === 'remote') s.remote.locations[0].quantity = 2;
      if (failure === 'mapping')
        s.f.store.update((state) => {
          state.listings[0].version++;
        });
      if (failure === 'expired') t.mock.timers.tick(120_001);
      await assert.rejects(s.approve(change.id, review.reviewId), /changed|expired/);
      assert.deepEqual(s.writes, [5]);
      assert.equal(s.f.store.readMarketplace().changes[0].state, 'uncertain');
    });
});

test('a request proved never dispatched can be closed without treating it as confirmed', async (t) => {
  const s = setup(t);
  const id = 'interrupted-before-send';
  s.f.store.updateMarketplace((data) => {
    const at = new Date().toISOString();
    data.changes.unshift({
      id,
      accountId: s.account,
      listingId: s.remote.id,
      sku: s.remote.sku,
      edit: {
        kind: 'stock',
        locationId: s.remote.locations[0].id,
        quantity: 5,
        automation: 'once',
      },
      state: 'pending',
      stockRequestFinality: 'not-sent',
      message: 'Update prepared.',
      createdAt: at,
      updatedAt: at,
    });
  });
  s.restart();
  const restarted = new MarketplaceService(s.f.store, s.f.folder);
  restarted.stop();
  await restarted.idle();
  assert.equal(s.f.store.readMarketplace().changes[0].state, 'uncertain');
  s.quantity(s.remote.locations[0].quantity!);
  const review = await s.review(id);
  const result = await s.approve(id, review.reviewId);
  assert.equal(result.change.state, 'reconciled');
  assert.match(result.change.message, /never sent/);
  assert.deepEqual(s.writes, []);
});

test('a newer order during a rejected stock increase preserves full Tally work and the newer order receipt', async (t) => {
  for (const origin of ['automatic', 'recovery'] as const)
    await t.test(origin, async (t) => {
      const s = setup(t);
      const old = origin === 'recovery' ? (await s.write(5)).change : null;
      const older = '00000000-0000-4000-8000-000000000001';
      const newer = '00000000-0000-4000-8000-000000000002';
      const intent = s.f.store.update((state) => {
        const row = state.listings[0];
        const item = state.items.find((entry) => entry.id === row.itemId)!;
        state.companies.find((c) => c.id === item.companyId)!.automation = true;
        item.physical = 8;
        item.version++;
        row.syncPendingItemVersion = item.version;
        row.orderSyncPending = older;
        return {
          companyId: item.companyId,
          listingId: row.id,
          itemVersion: item.version,
          listingVersion: row.version,
        };
      });
      s.quantity(8);
      s.writeMode('rejected');
      s.onWrite(() =>
        s.f.store.update((state) => {
          state.listings[0].orderSyncPending = newer;
        }),
      );
      if (old) {
        const review = await s.review(old.id);
        assert.equal((await s.approve(old.id, review.reviewId)).change.state, 'failed');
      } else {
        const market = s.f.store.readMarketplace().listings[0];
        const result = await s.publisher.apply(
          s.account,
          {
            listingId: market.id,
            version: market.version,
            edit: {
              kind: 'stock',
              locationId: market.locations[0].id,
              quantity: 8,
              automation: 'once',
            },
          },
          'token',
          intent,
        );
        assert.equal(result?.change.state, 'failed');
      }
      const saved = s.f.store.read().listings[0];
      assert.equal(saved.syncPendingItemVersion, intent.itemVersion);
      assert.equal(saved.orderSyncPending, newer);
    });
});

test('order-only retry backoff applies to the fresh write and allows a lower observed no-op', async (t) => {
  for (const noop of [false, true])
    await t.test(noop ? 'already lower' : 'recently rejected target', async (t) => {
      const s = setup(t);
      const marker = 'order-work';
      const cached = noop ? 6 : 2;
      const fresh = noop ? 2 : 6;
      const prepared = noop ? 4 : 2;
      const intent = s.f.store.updateMarketplace((data, state) => {
        const row = state.listings[0];
        const item = state.items.find((entry) => entry.id === row.itemId)!;
        state.companies.find((c) => c.id === item.companyId)!.automation = true;
        item.physical = 4;
        item.version++;
        row.orderSyncPending = marker;
        row.syncPendingItemVersion = null;
        row.observed = cached;
        data.listings[0].locations[0].quantity = cached;
        const at = new Date().toISOString();
        data.changes.unshift({
          id: 'previous-rejection',
          accountId: s.account,
          listingId: s.remote.id,
          sku: s.remote.sku,
          edit: { kind: 'stock', locationId: row.location, quantity: 4, automation: 'once' },
          state: 'failed',
          message: 'Rejected',
          createdAt: at,
          updatedAt: at,
        });
        return {
          companyId: item.companyId,
          listingId: row.id,
          itemVersion: item.version,
          listingVersion: row.version,
          orderOnly: marker,
        };
      });
      s.remote.locations[0].quantity = fresh;
      const result = s.publisher.apply(
        s.account,
        {
          listingId: s.remote.id,
          version: 1,
          edit: {
            kind: 'stock',
            locationId: s.remote.locations[0].id,
            quantity: prepared,
            automation: 'once',
          },
        },
        'token',
        intent,
      );
      if (noop) {
        assert.equal(await result, null);
        assert.equal(s.f.store.read().listings[0].observed, fresh);
        assert.equal(s.f.store.read().listings[0].orderSyncPending ?? null, null);
      } else {
        await assert.rejects(result, /after backoff/);
        assert.equal(s.f.store.read().listings[0].orderSyncPending, marker);
      }
      assert.deepEqual(s.writes, []);
    });
});
