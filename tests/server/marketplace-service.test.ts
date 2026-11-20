import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { FlipkartListingError } from '../../src/adapters/flipkart-listings.js';
import type { FlipkartConnectionStatus } from '../../src/shared/contracts.js';
import type { MarketplaceListing } from '../../src/shared/marketplace-contracts.js';
import {
  MarketplaceService,
  type AccountConnection,
} from '../../src/server/marketplace-service.js';
import type { ListingTransport } from '../../src/server/marketplace-publication.js';
import { InventoryService } from '../../src/server/service.js';
import { serverFixture } from '../support/server-fixture.js';
import { marketplaceData } from '../support/marketplace-fixture.js';

function fixture(t: TestContext, mode: 'live' | 'demo' = 'live') {
  const base = serverFixture(t, mode);
  const credentials = new Map<string, string>();
  const statusChecks: string[] = [];
  const transportCalls: string[] = [];
  const listingReadStatusChecks: boolean[] = [];
  const remote = new Map<string, MarketplaceListing[]>();
  const writes: Array<{
    token: string;
    kind: string;
    quantity?: number;
    mrp?: number;
    price?: number;
  }> = [];
  let failWrite: 'no' | 'before' | 'after' = 'no';
  let failRead = false;
  let failImport = false;
  let afterRead: (() => void) | undefined;
  function createConnection(id: string): AccountConnection {
    const status = async (): Promise<FlipkartConnectionStatus> => {
      statusChecks.push(id);
      return {
        state: credentials.has(id) ? 'verified' : 'not-configured',
        applicationIdHint: credentials.has(id) ? '***test' : null,
        checkedAt: null,
        expiresAt: null,
        message: 'Fixture status',
      };
    };
    const save = async (input: unknown) => {
      credentials.set(id, (input as { applicationId: string }).applicationId);
      return status();
    };
    return {
      status,
      save,
      connect: save,
      check: status,
      disconnect: async () => {
        credentials.delete(id);
        return status();
      },
      getAccessToken: async () => {
        const token = credentials.get(id);
        if (!token) throw new Error('Not connected');
        return token;
      },
      stop() {},
      async idle() {},
    };
  }
  const client: ListingTransport = {
    async listListings(token, accountId) {
      transportCalls.push('listListings');
      if (failImport) throw new FlipkartListingError('Import failed.');
      return structuredClone(remote.get(token) ?? []).map((row) => ({ ...row, accountId }));
    },
    async getListing(token, listing, options) {
      transportCalls.push('getListing');
      listingReadStatusChecks.push(options?.requireCurrentStatus === true);
      if (failRead) throw new FlipkartListingError('Read failed.');
      const result = remote.get(token)?.find((row) => row.id === listing.id);
      if (!result) throw new FlipkartListingError('Listing unavailable.');
      const observed = afterRead;
      afterRead = undefined;
      observed?.();
      return {
        ...structuredClone(result),
        accountId: listing.accountId,
        version: listing.version,
        observedAt: new Date().toISOString(),
      };
    },
    async updateStock(token, listing, locationId, quantity) {
      transportCalls.push('updateStock');
      writes.push({ token, kind: 'stock', quantity });
      if (failWrite === 'before') throw new FlipkartListingError('Flipkart rejected this stock.');
      remote
        .get(token)!
        .find((row) => row.id === listing.id)!
        .locations.find((row) => row.id === locationId)!.quantity = quantity;
      if (failWrite === 'after') {
        failRead = true;
        throw new FlipkartListingError('Connection interrupted.', true);
      }
    },
    async updatePrice(token, listing, mrp, price) {
      transportCalls.push('updatePrice');
      writes.push({ token, kind: 'price', mrp, price });
      const result = remote.get(token)!.find((row) => row.id === listing.id)!;
      result.mrp = mrp;
      result.sellingPrice = price;
    },
  };
  let service = new MarketplaceService(base.store, base.folder, { client, createConnection });
  t.after(async () => {
    service.stop();
    await service.idle();
  });
  async function add(seller = 'seller-a') {
    const account = await service.add({
      marketplace: 'flipkart',
      name: seller,
      applicationId: seller,
      applicationSecret: 'test-only',
      verify: false,
    });
    remote.set(seller, [
      {
        id: 'listing-one',
        accountId: account.id,
        sellerId: seller,
        productId: 'product-one',
        sku: 'SAME-SKU',
        title: 'Fixture tyre',
        imageUrl: null,
        status: 'ACTIVE',
        mrp: 5000,
        sellingPrice: 4000,
        version: 1,
        observedAt: new Date().toISOString(),
        locations: [
          { id: 'warehouse-a', quantity: 5, status: 'ENABLED' },
          { id: 'warehouse-b', quantity: 3, status: 'ENABLED' },
        ],
      },
    ]);
    await service.refresh(account.id);
    return account;
  }
  function listing(accountId: string) {
    return service.page(new URLSearchParams({ accountId })).listings[0];
  }
  function stock(accountId: string, quantity: number, automation = 'once') {
    const current = listing(accountId);
    return service.apply({
      accountId,
      listingId: current.id,
      version: current.version,
      edit: { kind: 'stock', locationId: 'warehouse-a', quantity, automation },
    });
  }
  return {
    ...base,
    get service() {
      return service;
    },
    credentials,
    statusChecks,
    transportCalls,
    listingReadStatusChecks,
    remote,
    writes,
    add,
    listing,
    stock,
    setFailWrite(value: typeof failWrite) {
      failWrite = value;
    },
    setFailRead(value: boolean) {
      failRead = value;
    },
    onNextRead(callback: () => void) {
      afterRead = callback;
    },
    setFailImport(value: boolean) {
      failImport = value;
    },
    async restart() {
      service.stop();
      await service.idle();
      service = new MarketplaceService(base.store, base.folder, { client, createConnection });
    },
  };
}

test('verified connections import immediately, while saved-only credentials require an explicit verification', async (t) => {
  const f = fixture(t);
  const connect = (seller: string, verify: boolean) =>
    f.service.add({
      marketplace: 'flipkart',
      name: seller,
      applicationId: seller,
      applicationSecret: 'test-only',
      verify,
    });
  function products(seller: string) {
    return marketplaceData('unused', seller).listings.map((row) => ({
      ...row,
      id: seller + '-listing',
      packageCount: 3,
    }));
  }
  f.remote.set('first', products('first'));
  const first = await connect('first', true);
  assert.equal(first.catalogOwnershipVerified, true);
  assert.equal(f.listing(first.id).packageCount, 3);
  const second = await connect('second', false);
  const calls = f.transportCalls.length;
  await f.service.refreshInventoryAccounts();
  assert.equal(f.transportCalls.length, calls + 1); // Only the first account.
  assert.equal(f.listing(second.id), undefined);

  const empty = await f.service.changeConnection({ accountId: second.id, action: 'check' });
  assert.ok(empty.lastRefreshedAt);
  assert.equal(empty.catalogOwnershipVerified, false);
  f.remote.set('second', products('second'));
  await f.service.refreshInventoryAccounts();
  assert.equal(f.listing(second.id).id, 'second-listing');

  f.setFailImport(true);
  const third = await connect('third', true);
  assert.equal(third.connection.state, 'verified');
  assert.match(third.catalogImportError!, /Import failed/);
  assert.equal(third.lastRefreshedAt, null);
  assert.equal(f.credentials.get(third.id), 'third');
  f.setFailImport(false);
  f.remote.set('third', products('third'));
  await f.service.refreshInventoryAccounts();
  assert.equal(f.listing(third.id).id, 'third-listing');
  assert.equal(
    (await f.service.accounts()).accounts.find((row) => row.id === third.id)?.catalogImportError,
    undefined,
  );

  f.setFailImport(true);
  await f.service.changeConnection({ accountId: third.id, action: 'check' });
  await f.service.changeConnection({
    accountId: third.id,
    action: 'save',
    applicationId: 'unverified',
    applicationSecret: 'test-only',
  });
  f.setFailImport(false);
  const prior = f.transportCalls.length;
  await f.service.refreshInventoryAccounts();
  assert.equal(f.transportCalls.length, prior + 2); // Skip saved-only replacement credentials.
});

test('authenticated catalogue ownership survives restarts, rejects duplicate accounts and requires listing overlap', async (t) => {
  const f = fixture(t);
  await f.add();
  const addTile = (name: string) =>
    f.service.add({
      name,
      marketplace: 'flipkart',
      applicationId: 'standard-access',
      applicationSecret: 'test-only',
      verify: false,
    });
  const primary = await addTile('Catalogue seller');
  const duplicate = await addTile('Duplicate seller');
  const listing: MarketplaceListing = {
    ...f.remote.get('seller-a')![0],
    id: 'authenticated-listing',
    sellerId: null,
    packageCount: 2,
  };
  f.remote.set('standard-access', [listing]);
  const first = (await f.service.refresh(primary.id)).account;
  assert.equal(first.catalogOwnershipVerified, true);
  assert.equal(first.sellerId, null);
  assert.equal(f.listing(primary.id).sellerId, null);
  await assert.rejects(f.service.refresh(duplicate.id), /already added/);
  const inventory = () => f.store.read().listings.find((row) => row.accountId === primary.id)!;
  assert.equal(inventory().packageAvailable, true);
  await f.restart();
  assert.equal(inventory().packageCount, 2);
  assert.equal(inventory().packageAvailable, false);
  assert.equal((await f.service.refresh(primary.id)).account.catalogOwnershipVerified, true);
  f.setFailImport(true);
  await assert.rejects(f.service.refresh(primary.id));
  assert.equal(inventory().packageAvailable, false);
  assert.equal(inventory().packageCount, 2);
  f.setFailImport(false);
  f.remote.set('standard-access', [{ ...listing, id: 'different-listing' }]);
  await assert.rejects(f.service.refresh(primary.id), /no listing identities in common/);
  assert.equal(f.listing(primary.id).id, listing.id);
});

async function mappedInventory(t: TestContext, packSource: 'manual' | 'packages' = 'manual') {
  const f = fixture(t);
  const account = await f.add();
  const remote = f.remote.get('seller-a')![0];
  remote.packageCount = 2;
  await f.service.refresh(account.id);
  let physical = 14;
  const inventory = () =>
    new InventoryService(f.store, {
      marketplaces: f.service,
      createTallyReader: () => ({
        async listCompanies() {
          return [{ externalId: 'a', name: 'Tally company' }];
        },
        async readStock() {
          return [{ externalId: 'item', name: 'Tyres', unit: 'pieces', physical }];
        },
      }),
    });
  const service = inventory();
  const first = await service.refresh();
  const listing = first.listings.find((entry) => entry.location === 'warehouse-a')!;
  const item = first.items[0];
  service.mapping({
    itemId: item.id,
    listingId: listing.id,
    listingVersion: listing.version,
    confirmPackEvidence: true,
    packSize: 2,
    packSource,
    sourceScope: 'company',
    tyreFloor: true,
  });
  function prepare() {
    service.calculate(item.companyId, [listing.id]);
    return service.review(item.companyId, [listing.id]);
  }
  return {
    f,
    account,
    remote,
    service,
    inventory,
    item,
    listing,
    prepare,
    setPhysical(value: number) {
      physical = value;
    },
  };
}

test('reviewed Inventory publication sends only the captured destination, confirms it, and rejects replay or stale proposals', async (t) => {
  const s = await mappedInventory(t);
  const review = s.prepare();
  assert.equal(review.publishingEnabled, true);
  assert.equal(review.rows[0].quantity, 7);
  const sent = await s.service.publish(review.id);
  assert.equal(sent.rows[0].status, 'confirmed');
  assert.deepEqual(
    s.f.listingReadStatusChecks,
    [true, false],
    'the Inventory preflight requires current listing status',
  );
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [7],
  );
  assert.equal(s.remote.locations[1].quantity, 3);
  await assert.rejects(s.service.publish(review.id), /fresh Inventory review/);
  const unchanged = await s.service.publish(s.prepare().id);
  assert.equal(unchanged.rows[0].status, 'unchanged');
  const earlier = s.prepare();
  s.setPhysical(1);
  await s.service.refresh();
  assert.equal((await s.service.publish(earlier.id)).rows[0].status, 'blocked');
  assert.equal(s.f.writes.length, 1);
});

test('automatic Inventory follows Tally and saved mappings across restart; it does not replenish a marketplace-only reduction', async (t) => {
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  s.setPhysical(12);
  await s.service.refresh();
  s.remote.locations[0].quantity = 3;
  await s.f.service.refresh(s.account.id);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [7, 6],
  );
  await s.f.restart();
  const restarted = s.inventory();
  s.setPhysical(1);
  await restarted.refresh();
  assert.equal(s.f.writes.length, 2, 'account requires a new complete import');
  await s.f.service.refreshInventoryAccounts();
  await restarted.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [7, 6, 0],
  );
  restarted.pause(s.item.companyId, [s.listing.id], true);
  s.setPhysical(16);
  await restarted.refresh();
  assert.equal(s.f.writes.length, 3);
  restarted.pause(s.item.companyId, [s.listing.id], false);
  await restarted.refresh();
  assert.equal(s.f.writes.at(-1)?.quantity, 8);
});

test('a remote package change blocks a package-based write at final preflight and leaves a custom multiplier intact', async (t) => {
  for (const source of ['packages', 'manual'] as const) {
    const s = await mappedInventory(t, source);
    const reviewed = s.prepare();
    s.remote.packageCount = 1;
    const result = await s.service.publish(reviewed.id);
    assert.equal(result.rows[0].status, source === 'packages' ? 'blocked' : 'confirmed');
    assert.equal(s.f.writes.length, source === 'packages' ? 0 : 1);
    const current = s.service.snapshot().listings.find((row) => row.id === s.listing.id)!;
    assert.equal(current.packSize, 2);
    assert.equal(current.verified, source === 'manual');
  }
});

test('a rejected automatic zero stays pending through restart and retries with bounded backoff', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  s.setPhysical(1);
  s.f.setFailWrite('before');
  await s.service.refresh();
  assert.equal(s.f.writes.length, 1);
  assert.equal(s.remote.locations[0].quantity, 5);
  await s.f.restart();
  await s.f.service.refreshInventoryAccounts();
  const restarted = s.inventory();
  for (const [index, delay] of [30, 60, 120, 240, 480, 600, 600].entries()) {
    t.mock.timers.tick(delay * 1000 - 1);
    await restarted.refresh();
    assert.equal(s.f.writes.length, index + 1);
    t.mock.timers.tick(1);
    if (index === 6) s.f.setFailWrite('no');
    await restarted.refresh();
    assert.equal(s.f.writes.length, index + 2);
  }
  assert.equal(s.remote.locations[0].quantity, 0);
  assert.equal(s.f.store.readMarketplace().changes[0].state, 'confirmed');
  await restarted.refresh();
  assert.equal(s.f.writes.length, 8);
});

test('new automatic quantities supersede rejected writes and uncertain attempts cannot be retried blindly', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  s.f.setFailWrite('before');
  await s.service.refresh();
  s.setPhysical(1);
  s.f.setFailWrite('after');
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [7, 0],
  );
  const uncertain = s.f.store.readMarketplace().changes[0];
  assert.equal(uncertain.state, 'uncertain');
  await s.f.restart();
  s.f.setFailWrite('no');
  s.f.setFailRead(false);
  await s.f.service.refreshInventoryAccounts();
  s.setPhysical(16);
  const restarted = s.inventory();
  t.mock.timers.tick(600_000);
  await restarted.refresh();
  assert.equal(s.f.writes.length, 2);
  const checked = await s.f.service.reconcile({ accountId: s.account.id, changeId: uncertain.id });
  assert.equal(checked.change.state, 'confirmed');
  await restarted.refresh();
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [7, 0, 8],
  );
});

test('a rejected direct Update once preserves an automatic zero for the next unchanged Tally fetch', async (t) => {
  const s = await mappedInventory(t);
  s.setPhysical(1);
  await s.service.refresh();
  s.service.automation(s.item.companyId, true);
  s.f.setFailWrite('before');
  assert.equal((await s.f.stock(s.account.id, 2)).change.state, 'failed');
  s.f.setFailWrite('no');
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [2, 0],
  );
  assert.equal(s.remote.locations[0].quantity, 0);
});

test('a rejected reviewed Update once preserves the pending calculated quantity', async (t) => {
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  s.service.edit(s.item.companyId, s.listing.id, 2);
  s.f.setFailWrite('before');
  const review = s.service.review(s.item.companyId, [s.listing.id]);
  assert.equal((await s.service.publish(review.id, 'once')).rows[0].status, 'failed');
  s.f.setFailWrite('no');
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [2, 7],
  );
});

test('a rejected reviewed zero activates the hold and queues its correction', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  s.service.edit(s.item.companyId, s.listing.id, 0);
  s.f.setFailWrite('before');
  const review = s.service.review(s.item.companyId, [s.listing.id]);
  assert.equal((await s.service.publish(review.id)).rows[0].status, 'failed');
  s.f.setFailWrite('no');
  t.mock.timers.tick(30_000);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [7, 0, 0],
  );
  assert.equal(s.remote.locations[0].quantity, 0);
});

test('an uncertain Update once supersedes earlier pending stock only after the outcome is checked', async (t) => {
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  s.f.setFailWrite('after');
  const result = await s.f.stock(s.account.id, 2);
  assert.equal(result.change.state, 'uncertain');
  s.f.setFailRead(false);
  s.f.setFailWrite('no');
  await s.service.refresh();
  const checked = await s.f.service.reconcile({
    accountId: s.account.id,
    changeId: result.change.id,
  });
  assert.equal(checked.change.state, 'confirmed');
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [2],
  );
});

test('an Inventory operation rechecks a changed mapping after its asynchronous preflight', async (t) => {
  const s = await mappedInventory(t);
  const review = s.prepare();
  s.f.onNextRead(() => {
    const row = s.service.snapshot().listings.find((entry) => entry.id === s.listing.id)!;
    s.service.mapping({
      listingId: row.id,
      itemId: s.item.id,
      listingVersion: row.version,
      confirmPackEvidence: true,
      packSize: 4,
      packSource: 'manual',
      sourceScope: 'company',
      tyreFloor: true,
    });
  });
  assert.equal((await s.service.publish(review.id)).rows[0].status, 'blocked');
  assert.equal(s.f.writes.length, 0);
  assert.equal(s.f.store.readMarketplace().changes.length, 0);
});

test('Update once publishes an edited quantity, preserves Auto and lets the next Tally sale recalculate', async (t) => {
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  s.service.edit(s.item.companyId, s.listing.id, 2);
  const manual = s.service.review(s.item.companyId, [s.listing.id]);
  assert.equal(manual.rows[0].oneTimeProblem, null);
  assert.match(manual.rows[0].problem!, /order reconciliation/);
  assert.equal((await s.service.publish(manual.id, 'once')).rows[0].status, 'confirmed');
  assert.equal(
    s.service.snapshot().listings.find((row) => row.id === s.listing.id)?.policy,
    'auto',
  );
  await s.service.refresh();
  s.setPhysical(10);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [7, 2, 5],
  );
  s.service.pause(s.item.companyId, [s.listing.id], true);
  s.service.edit(s.item.companyId, s.listing.id, 1);
  assert.equal(
    (await s.service.publish(s.service.review(s.item.companyId, [s.listing.id]).id, 'once')).rows[0]
      .status,
    'confirmed',
  );
  assert.equal(s.service.snapshot().listings.find((row) => row.id === s.listing.id)?.paused, true);
});

test('a reviewed zero activates a hold; positive live allowances require eligible order accounting', async (t) => {
  const s = await mappedInventory(t);
  s.service.edit(s.item.companyId, s.listing.id, 2);
  const limited = s.service.review(s.item.companyId, [s.listing.id]);
  assert.match(limited.rows[0].problem!, /order reconciliation/);
  assert.equal((await s.service.publish(limited.id)).rows[0].status, 'blocked');
  s.service.edit(s.item.companyId, s.listing.id, 0);
  const zero = s.service.review(s.item.companyId, [s.listing.id]);
  assert.equal((await s.service.publish(zero.id)).rows[0].status, 'confirmed');
  s.service.automation(s.item.companyId, true);
  s.setPhysical(20);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [0],
  );
  assert.equal(
    s.service.snapshot().listings.find((row) => row.id === s.listing.id)?.policy,
    'hold',
  );
  s.service.edit(s.item.companyId, s.listing.id, 2);
  const kept = s.service.review(s.item.companyId, [s.listing.id]);
  assert.match(kept.rows[0].oneTimeProblem!, /existing hold/);
  assert.equal((await s.service.publish(kept.id, 'once')).rows[0].status, 'blocked');
  assert.equal(s.f.writes.length, 1);
});

test('returning to Auto cancels the pending zero correction and waits for a new Tally change', async (t) => {
  const s = await mappedInventory(t);
  s.service.edit(s.item.companyId, s.listing.id, 0);
  await s.service.publish(s.service.review(s.item.companyId, [s.listing.id]).id);
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  s.remote.locations[0].quantity = 2;
  await s.f.service.refresh(s.account.id);
  const row = () => s.service.snapshot().listings.find((entry) => entry.id === s.listing.id)!;
  assert.equal(row().syncPendingItemVersion, s.item.version);
  const market = s.f.listing(s.account.id);
  await s.f.service.changePolicy({
    accountId: s.account.id,
    listingId: market.id,
    version: market.version,
    locationId: s.listing.location,
    policy: 'auto',
    confirmed: true,
  });
  await s.service.refresh();
  assert.equal(row().syncPendingItemVersion, null);
  assert.equal(s.remote.locations[0].quantity, 2);
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [0],
  );
  s.setPhysical(16);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [0, 8],
  );
});

test('live account tiles are empty until added; multiple credentials and same-SKU catalogs stay isolated', async (t) => {
  const f = fixture(t);
  await f.service.initialize();
  assert.deepEqual(await f.service.accounts(), { accounts: [] });
  assert.deepEqual(f.store.read().accounts, []);
  const first = await f.add();
  const second = await f.add('seller-b');
  assert.equal((await f.service.accounts()).accounts.length, 2);
  assert.equal(f.store.read().companies.length, 0);
  const result = await f.stock(first.id, 2);
  assert.equal(result.change.state, 'confirmed');
  assert.equal(f.listing(first.id).locations[0].quantity, 2);
  assert.equal(f.listing(first.id).locations[1].quantity, 3);
  assert.equal(f.listing(second.id).locations[0].quantity, 5);
  assert.deepEqual(f.writes, [{ token: 'seller-a', kind: 'stock', quantity: 2 }]);
  assert.ok(!JSON.stringify(await f.service.accounts()).includes('test-only'));
});

test('initialization adopts saved legacy credentials without a seeded seller account or external requests', async (t) => {
  const f = fixture(t);
  f.credentials.set('flipkart-primary', 'legacy-test-only');
  await f.service.initialize();
  await f.service.initialize();
  assert.deepEqual(f.store.read().accounts, [
    {
      id: 'flipkart-primary',
      name: 'Flipkart seller',
      marketplace: 'flipkart',
      status: 'not-connected',
    },
  ]);
  assert.deepEqual(f.store.readMarketplace().accounts, [
    {
      id: 'flipkart-primary',
      name: 'Flipkart seller',
      sellerId: null,
      lastRefreshedAt: null,
    },
  ]);
  assert.deepEqual(f.statusChecks, ['flipkart-primary']);
  assert.deepEqual(f.transportCalls, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.store.readMarketplace().listings, []);
  assert.equal(f.credentials.get('flipkart-primary'), 'legacy-test-only');
});

test('legacy credential adoption preserves a saved seller name', async (t) => {
  const f = fixture(t);
  f.store.update((state) => {
    state.accounts.push({
      id: 'flipkart-primary',
      name: 'Saved seller name',
      marketplace: 'flipkart',
      status: 'not-connected',
    });
  });
  f.credentials.set('flipkart-primary', 'legacy-test-only');
  const { accounts } = await f.service.accounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].name, 'Saved seller name');
  assert.equal(accounts[0].sellerId, null);
  assert.equal(f.store.read().accounts[0].name, 'Saved seller name');
});

test('initialization does not read credentials for explicitly added accounts', async (t) => {
  const f = fixture(t);
  const first = await f.add();
  const second = await f.add('seller-b');
  f.statusChecks.length = 0;
  await f.service.initialize();
  assert.deepEqual(f.statusChecks, ['flipkart-primary']);
  assert.deepEqual(
    f.store.readMarketplace().accounts.map((account) => account.id),
    [first.id, second.id],
  );
});

test('price Apply preserves companion price and leaves stock/pause policies unchanged', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  const listing = f.listing(account.id);
  const result = await f.service.apply({
    accountId: account.id,
    listingId: listing.id,
    version: listing.version,
    edit: { kind: 'price', field: 'sellingPrice', value: 3500 },
  });
  assert.equal(result.change.state, 'confirmed');
  assert.deepEqual(f.writes, [{ token: 'seller-a', kind: 'price', mrp: 5000, price: 3500 }]);
  assert.equal(result.listing.locations[0].quantity, 5);
  assert.ok(f.store.read().listings.every((row) => !row.paused));
});

test('fresh read conflicts prevent overwriting stock changed since the editor opened', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  f.remote.get('seller-a')![0].locations[0].quantity = 4;
  await assert.rejects(f.stock(account.id, 2), /changed since this editor/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.listing(account.id).locations[0].quantity, 4);
});

test('hold and sales allowance cannot be bypassed by Apply or Pause; policy change is explicit', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  f.store.update((state) => {
    const row = state.listings.find(
      (row) => row.accountId === account.id && row.location === 'warehouse-a',
    )!;
    row.policy = 'hold';
  });
  await assert.rejects(f.stock(account.id, 5, 'pause'), /kept out of stock/);
  assert.equal(f.writes.length, 0);
  assert.equal(
    f.store.read().listings.find((row) => row.location === 'warehouse-a')!.paused,
    false,
  );
  const listing = f.listing(account.id);
  await assert.rejects(
    f.service.changePolicy({
      accountId: account.id,
      listingId: listing.id,
      locationId: 'warehouse-a',
      version: listing.version,
      policy: 'auto',
      confirmed: false,
    }),
    /Explicitly confirm/,
  );
  await f.service.changePolicy({
    accountId: account.id,
    listingId: listing.id,
    locationId: 'warehouse-a',
    version: listing.version,
    policy: 'auto',
    confirmed: true,
  });
  assert.equal(f.writes.length, 0);
  await f.stock(account.id, 2, 'pause');
  assert.equal(f.store.read().listings.find((row) => row.location === 'warehouse-a')!.paused, true);
  f.store.update((state) => {
    const row = state.listings.find((row) => row.location === 'warehouse-a')!;
    row.policy = 'limited';
    row.remaining = 1;
  });
  await assert.rejects(f.stock(account.id, 5), /remaining sales allowance/);
  await assert.rejects(f.stock(account.id, 1), /order reconciliation/);
  await f.stock(account.id, 0);
  const after = f.store.read().listings.find((row) => row.location === 'warehouse-a')!;
  assert.equal(after.policy, 'limited');
  assert.equal(after.remaining, 1);
  assert.equal(after.paused, true);
});

test('an uncertain write is durable, blocks replay, and can be confirmed by readback after restart', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  f.setFailWrite('after');
  const result = await f.stock(account.id, 2);
  assert.equal(result.change.state, 'uncertain');
  await assert.rejects(f.stock(account.id, 2), /previous update result/);
  await f.restart();
  await assert.rejects(
    f.service.reconcile({ accountId: account.id, changeId: result.change.id }),
    /Refresh listings/,
  );
  f.setFailRead(false);
  await f.service.refresh(account.id);
  const reconciled = await f.service.reconcile({
    accountId: account.id,
    changeId: result.change.id,
  });
  assert.equal(reconciled.change.state, 'confirmed');
  assert.equal(f.writes.length, 1);
});

test('a rejected stock write keeps the requested pause and reports failure without changing stock', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  f.setFailWrite('before');
  const result = await f.stock(account.id, 2, 'pause');
  assert.equal(result.change.state, 'failed');
  assert.equal(result.listing.locations[0].quantity, 5);
  assert.equal(f.store.read().listings.find((row) => row.location === 'warehouse-a')!.paused, true);
});

test('replacing credentials cannot change a bound seller and failed imports preserve prior catalog', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  f.setFailImport(true);
  await assert.rejects(f.service.refresh(account.id), /Import failed/);
  assert.equal(f.listing(account.id).title, 'Fixture tyre');
  f.setFailImport(false);
  await f.service.changeConnection({
    accountId: account.id,
    action: 'save',
    applicationId: 'wrong-seller',
    applicationSecret: 'fixture',
  });
  f.remote.set('wrong-seller', [{ ...f.remote.get('seller-a')![0], sellerId: 'wrong-seller' }]);
  await assert.rejects(f.stock(account.id, 2), /Refresh listings/);
  await assert.rejects(f.service.refresh(account.id), /different seller/);
  assert.equal(f.listing(account.id).sellerId, 'seller-a');
  assert.equal(f.writes.length, 0);
});

test('unknown destinations, negative stock, bad prices and stale versions never reach transport', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  const row = f.listing(account.id);
  for (const input of [
    {
      version: row.version,
      edit: { kind: 'stock', locationId: 'other', quantity: 1, automation: 'once' },
    },
    {
      version: row.version,
      edit: { kind: 'stock', locationId: 'warehouse-a', quantity: -1, automation: 'once' },
    },
    { version: row.version, edit: { kind: 'price', field: 'mrp', value: 1 } },
    { version: row.version - 1, edit: { kind: 'price', field: 'sellingPrice', value: 3000 } },
  ])
    await assert.rejects(f.service.apply({ accountId: account.id, listingId: row.id, ...input }));
  assert.equal(f.writes.length, 0);
});

test('demo edits simulate confirmation without credentials or external transport', async (t) => {
  const f = fixture(t, 'demo');
  const account = (await f.service.accounts()).accounts[0];
  const listing = f.listing(account.id);
  const result = await f.service.apply({
    accountId: account.id,
    listingId: listing.id,
    version: listing.version,
    edit: { kind: 'price', field: 'sellingPrice', value: 4000 },
  });
  assert.equal(result.change.state, 'confirmed');
  assert.match(result.change.message, /Sample/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.credentials.size, 0);
});

test('simultaneous Apply actions for the same observation send only once', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  const results = await Promise.allSettled([f.stock(account.id, 2), f.stock(account.id, 2)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(f.writes.length, 1);
});

test('an unresolved listing omitted by refresh and older than the history preview stays visible', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  f.setFailWrite('after');
  const result = await f.stock(account.id, 2);
  f.store.updateMarketplace((data) => {
    for (let index = 0; index < 210; index++)
      data.changes.unshift({ ...result.change, id: `older-preview-${index}`, state: 'confirmed' });
  });
  f.remote.set('seller-a', []);
  f.setFailRead(false);
  await f.service.refresh(account.id);
  const page = f.service.page(new URLSearchParams({ accountId: account.id }));
  assert.equal(page.listings.length, 1);
  assert.equal(page.listings[0].observedAt, null);
  assert.equal(page.listings[0].locations[0].quantity, null);
  assert.ok(
    page.changes.some((change) => change.id === result.change.id && change.state === 'uncertain'),
  );
  assert.equal(f.writes.length, 1);
});

test('a recreated unprotected SKU imports with fresh Inventory identities and rejects the old listing editor', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  const otherAccount = await f.add('seller-b');
  const otherInventory = f.store.read().listings.filter((row) => row.accountId === otherAccount.id);
  const completed = await f.stock(account.id, 2);
  const old = structuredClone(f.remote.get('seller-a')![0]);
  const oldInventory = f.store.read().listings.filter((row) => row.accountId === account.id);
  f.store.update((state) => {
    const row = state.listings.find((row) => row.id === oldInventory[0].id)!;
    row.packSize = 2;
    row.packEvidence = 'Evidence for the old listing';
    row.verified = true;
  });
  f.remote.set('seller-a', []);
  await f.service.refresh(account.id);
  f.remote.set('seller-a', [
    {
      ...old,
      id: 'different-listing',
      productId: 'different-product',
      locations: [old.locations[0], { id: 'warehouse-c', quantity: 8, status: 'ENABLED' }],
    },
  ]);
  await f.service.refresh(account.id);
  const imported = f.listing(account.id);
  assert.equal(imported.id, 'different-listing');
  assert.equal(imported.productId, 'different-product');
  assert.equal(f.service.page(new URLSearchParams({ accountId: account.id })).total, 1);
  const inventory = f.store.read().listings.filter((row) => row.accountId === account.id);
  assert.deepEqual(
    inventory.map((row) => row.location),
    ['warehouse-a', 'warehouse-c'],
  );
  assert.ok(inventory.every((row) => !oldInventory.some((oldRow) => oldRow.id === row.id)));
  assert.ok(
    inventory.every((row) => row.itemId === null && row.packSize === null && !row.verified),
  );
  assert.deepEqual(
    f.store.read().listings.filter((row) => row.accountId === otherAccount.id),
    otherInventory,
  );
  assert.equal(
    f.store.readMarketplace().changes.find((row) => row.id === completed.change.id)?.listingId,
    old.id,
  );
  await assert.rejects(
    f.service.apply({
      accountId: account.id,
      listingId: old.id,
      version: old.version,
      edit: { kind: 'stock', locationId: 'warehouse-a', quantity: 4, automation: 'once' },
    }),
    /not in the selected account/,
  );
  assert.equal(f.writes.length, 1);
  assert.equal((await f.stock(account.id, 4)).change.state, 'confirmed');
});

test('a recreated SKU cannot inherit mappings, policies, pause or unresolved updates after an empty refresh', async (t) => {
  for (const protection of ['mapped', 'hold', 'limited', 'paused', 'uncertain'] as const) {
    await t.test(protection, async (t) => {
      const f = fixture(t);
      const account = await f.add();
      const old = structuredClone(f.remote.get('seller-a')![0]);
      if (protection === 'uncertain') {
        f.setFailWrite('after');
        await f.stock(account.id, 2);
      } else {
        f.store.update((state) => {
          const row = state.listings.find((row) => row.accountId === account.id)!;
          if (protection === 'mapped') {
            state.companies.push({
              id: 'company',
              name: 'Fixture company',
              automation: false,
              source: 'tally',
              lastSuccess: null,
            });
            state.items.push({
              id: 'item',
              companyId: 'company',
              externalId: 'item',
              name: 'Fixture item',
              brand: '',
              unit: 'unit',
              physical: 5,
              observedAt: null,
              version: 1,
              lowStockThreshold: 1,
            });
            row.itemId = 'item';
          } else if (protection === 'paused') row.paused = true;
          else {
            row.policy = protection;
            if (protection === 'limited') row.remaining = 1;
          }
        });
      }
      f.remote.set('seller-a', []);
      await f.service.refresh(account.id);
      const before = f.store.readMarketplace();
      const inventoryBefore = f.store.read().listings;
      f.remote.set('seller-a', [
        { ...old, id: 'different-listing', productId: 'different-product' },
      ]);
      await assert.rejects(f.service.refresh(account.id), /listing identity changed/);
      assert.deepEqual(f.store.readMarketplace(), before);
      assert.deepEqual(f.store.read().listings, inventoryBefore);
    });
  }
});

test('a protected identity failure rolls back earlier safe replacements in the same import', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  const old = structuredClone(f.remote.get('seller-a')![0]);
  const protectedListing = { ...old, id: 'protected-listing', sku: 'PROTECTED-SKU' };
  f.remote.set('seller-a', [old, protectedListing]);
  await f.service.refresh(account.id);
  f.store.update((state) => {
    state.listings.find((row) => row.sku === protectedListing.sku)!.policy = 'hold';
  });
  const before = f.store.readMarketplace();
  const inventoryBefore = f.store.read();
  f.remote.set('seller-a', [
    { ...old, id: 'replacement-one' },
    { ...protectedListing, id: 'replacement-two' },
  ]);
  await assert.rejects(f.service.refresh(account.id), /listing identity changed/);
  assert.deepEqual(f.store.readMarketplace(), before);
  assert.deepEqual(f.store.read(), inventoryBefore);
});
