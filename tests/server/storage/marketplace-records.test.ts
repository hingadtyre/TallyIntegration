import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readMarketplace } from '../../../src/server/storage/marketplace-records.js';
import { marketplaceData } from '../../support/marketplace-fixture.js';
import { queryFile, storageFixture as fixture } from '../../support/server-fixture.js';

test('a legacy account placeholder is not a marketplace account until explicitly added', (t) => {
  const store = fixture(t).open('live');
  store.update((state) => {
    state.accounts.push({
      id: 'flipkart-primary',
      name: 'Legacy seller',
      marketplace: 'flipkart',
      status: 'not-connected',
    });
  });
  assert.equal(store.read().accounts[0].id, 'flipkart-primary');
  assert.deepEqual(store.readMarketplace(), { accounts: [], listings: [], changes: [] });
});

test('marketplace observations and changes survive restart and Inventory updates without shared mutable reads', (t) => {
  const f = fixture(t);
  const store = f.open();
  const expected = marketplaceData(store.read().accounts[0].id);
  const result = store.updateMarketplace((market, state) => {
    Object.assign(market, expected);
    state.listings[0].paused = true;
    return 'saved';
  });
  assert.equal(result, 'saved');
  store.update((state) => {
    state.settings.tallySeconds = 45;
  });
  const detached = store.readMarketplace();
  detached.listings[0].locations[0].quantity = 999;
  detached.changes[0].state = 'confirmed';
  const reopened = f.open();
  assert.deepEqual(reopened.readMarketplace(), expected);
  assert.equal(reopened.read().listings[0].paused, true);
  const backup = join(f.directory, 'marketplace.sqlite');
  reopened.backup(backup);
  assert.deepEqual(queryFile(backup, readMarketplace), expected);
});

test('a failed marketplace update rolls back the change and its Inventory pause together', (t) => {
  const store = fixture(t).open();
  const before = store.read();
  assert.throws(
    () =>
      store.updateMarketplace((market, state) => {
        Object.assign(market, marketplaceData(state.accounts[0].id));
        state.listings[0].paused = true;
        market.listings[0].sellerId = 'another-seller';
      }),
    /does not match its account/,
  );
  assert.deepEqual(store.read(), before);
  assert.deepEqual(store.readMarketplace(), { accounts: [], listings: [], changes: [] });
  assert.throws(
    () =>
      store.updateMarketplace((market, state) => {
        Object.assign(market, marketplaceData(state.accounts[0].id));
        state.listings[0].paused = true;
        throw new Error('Interrupted command');
      }),
    /Interrupted command/,
  );
  assert.deepEqual(store.read(), before);
});

test('listing and SKU identities are account-scoped and verified sellers cannot be duplicated', (t) => {
  const store = fixture(t).open();
  const first = marketplaceData(store.read().accounts[0].id);
  const second = marketplaceData('second-account', 'seller-b');
  second.changes[0].id = 'change-2';
  store.updateMarketplace((market, state) => {
    state.accounts.push({
      id: 'second-account',
      marketplace: 'flipkart',
      name: 'Second seller',
      status: 'demo',
    });
    market.accounts.push(...first.accounts, ...second.accounts);
    market.listings.push(...first.listings, ...second.listings);
    market.changes.push(...first.changes, ...second.changes);
  });
  const before = store.readMarketplace();
  assert.equal(before.listings.length, 2);
  assert.throws(
    () =>
      store.updateMarketplace((market) => {
        market.accounts[1].sellerId = 'seller-a';
      }),
    /duplicate identities/,
  );
  assert.throws(
    () =>
      store.updateMarketplace((market) => {
        market.listings.push({ ...market.listings[0], id: 'another-listing' });
      }),
    /duplicate identities/,
  );
  assert.throws(
    () =>
      store.updateMarketplace((market) => {
        market.changes[0].accountId = 'missing-account';
      }),
    /missing account/,
  );
  assert.throws(
    () =>
      store.updateMarketplace((market) => {
        market.accounts.push({
          id: 'missing-parent',
          name: 'Missing parent',
          sellerId: null,
          lastRefreshedAt: null,
        });
      }),
    /FOREIGN KEY/,
  );
  assert.deepEqual(store.readMarketplace(), before);
});

test('change history survives a listing disappearing and corrupt persisted metadata is rejected', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.updateMarketplace((market, state) =>
    Object.assign(market, marketplaceData(state.accounts[0].id)),
  );
  store.updateMarketplace((market) => {
    market.listings = [];
  });
  assert.equal(store.readMarketplace().changes[0].listingId, 'remote-listing');
  store.updateMarketplace((market, state) =>
    Object.assign(market, marketplaceData(state.accounts[0].id)),
  );
  queryFile(f.file, (database) =>
    database.prepare('UPDATE marketplace_listings SET metadata = ?').run('{"locations":[]}'),
  );
  assert.throws(() => store.readMarketplace(), /Invalid stored state/);
  assert.throws(() => f.open(), /Invalid stored state/);
});
