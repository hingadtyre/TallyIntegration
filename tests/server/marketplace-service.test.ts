import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { FlipkartListingError } from '../../src/adapters/flipkart-listings.js';
import type { FlipkartBillingOrder } from '../../src/adapters/flipkart-billing.js';
import type { TallySalesBill } from '../../src/adapters/tally.js';
import type { FlipkartConnectionStatus, Snapshot } from '../../src/shared/contracts.js';
import type { MarketplaceListing } from '../../src/shared/marketplace-contracts.js';
import {
  MarketplaceService,
  type AccountConnection,
} from '../../src/server/marketplace-service.js';
import type { ListingTransport } from '../../src/server/marketplace-publication.js';
import { InventoryService } from '../../src/server/service.js';
import { createApp } from '../../src/server/http.js';
import type { PollingTimers } from '../../src/server/polling.js';
import type { BillingSources } from '../../src/server/billing-service.js';
import { close, listen, serverFixture } from '../support/server-fixture.js';
import { marketplaceData } from '../support/marketplace-fixture.js';

function fixture(t: TestContext, mode: 'live' | 'demo' = 'live', billingSources?: BillingSources) {
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
  let failWrite: 'no' | 'before' | 'after' | 'lost-readback' = 'no';
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
    async updateStock(token, listing, locationId, quantity, confirmedPickup) {
      transportCalls.push('updateStock');
      writes.push({ token, kind: 'stock', quantity });
      if (failWrite === 'before') throw new FlipkartListingError('Flipkart rejected this stock.');
      const target = remote.get(token)!.find((row) => row.id === listing.id)!;
      if (confirmedPickup && !target.locations.length)
        target.locations.push({ id: locationId, quantity, status: 'ENABLED' });
      else target.locations.find((row) => row.id === locationId)!.quantity = quantity;
      if (failWrite === 'after') {
        failRead = true;
        throw new FlipkartListingError('Connection interrupted.', true);
      }
      if (failWrite === 'lost-readback') failRead = true;
    },
    async updatePrice(token, listing, mrp, price) {
      transportCalls.push('updatePrice');
      writes.push({ token, kind: 'price', mrp, price });
      const result = remote.get(token)!.find((row) => row.id === listing.id)!;
      result.mrp = mrp;
      result.sellingPrice = price;
    },
  };
  let service = new MarketplaceService(base.store, base.folder, {
    client,
    createConnection,
    billingSources,
  });
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
  function stock(accountId: string, quantity: number, automation?: 'once' | 'pause') {
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
      service = new MarketplaceService(base.store, base.folder, {
        client,
        createConnection,
        billingSources,
      });
    },
  };
}

test('slow billing reads allow stock corrections and discard results after seller verification changes', async (t) => {
  let started!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const f = fixture(t, 'live', {
    tally: () => ({
      listLedgers: async () => [{ externalId: 'ledger', name: 'Sales' }],
      readSalesBills: async () => [],
      readStock: async () => [],
    }),
    orders: {
      async readOrders() {
        started();
        await release;
        return [];
      },
    },
  });
  const account = await f.add();
  f.store.update((s) =>
    s.companies.push({
      id: 'tally:books',
      name: 'Books',
      source: 'tally',
      automation: false,
      lastSuccess: null,
    }),
  );
  const review = f.service.billingCommand('/api/billing/preview', {
    companyId: 'tally:books',
    accountId: account.id,
    ledgerId: 'ledger',
    field: 'reference',
    reference: 'orderId',
    days: 7,
  });
  await entered;
  // Always release the simulated provider even if the write queue regresses.
  const fallback = setTimeout(resume, 2000);
  try {
    assert.equal((await f.stock(account.id, 0)).change.state, 'confirmed');
    f.service.invalidate(account.id);
    resume();
    await assert.rejects(review, /verification changed/);
    assert.deepEqual(f.store.readBilling().rules, []);
  } finally {
    clearTimeout(fallback);
    resume();
  }
});

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

async function mappedInventory(
  t: TestContext,
  packSource: 'manual' | 'packages' = 'manual',
  options: { coverage?: boolean; packSize?: number; tyreFloor?: boolean; physical?: number } = {},
) {
  let physical = options.physical ?? 14;
  const readStock = async () => [{ externalId: 'item', name: 'Tyres', unit: 'pieces', physical }];
  const orders: FlipkartBillingOrder[] = [];
  const ordersBySeller = new Map([['seller-a', orders]]);
  const bills: TallySalesBill[] = [];
  let failOrders = false;
  let beforeOrders: (() => Promise<void>) | undefined;
  const f = fixture(t, 'live', {
    tally: () => ({
      listLedgers: async () => [{ externalId: 'flipkart-ledger', name: 'Flipkart sales' }],
      readStock,
      readSalesBills: async () => structuredClone(bills),
    }),
    orders: {
      readOrders: async () => structuredClone(orders),
      async readStockOrders(token) {
        if (failOrders) throw new Error('Order read unavailable');
        const action = beforeOrders;
        beforeOrders = undefined;
        await action?.();
        return structuredClone(ordersBySeller.get(token) ?? []);
      },
    },
  });
  const account = await f.add();
  const remote = f.remote.get('seller-a')![0];
  remote.packageCount = 2;
  await f.service.refresh(account.id);
  const inventory = (timers?: PollingTimers) =>
    new InventoryService(f.store, {
      timers,
      marketplaces: f.service,
      createTallyReader: () => ({
        async listCompanies() {
          return [{ externalId: 'a', name: 'Tally company' }];
        },
        readStock,
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
    packSize: options.packSize ?? 2,
    packSource,
    sourceScope: 'company',
    tyreFloor: options.tyreFloor ?? true,
  });
  const scope = { companyId: item.companyId, accountId: account.id };
  async function enableCoverage() {
    f.store.updateBilling((data) => {
      data.rules.push({
        ...scope,
        ledgerId: 'flipkart-ledger',
        ledgerName: 'Flipkart sales',
        field: 'reference',
        reference: 'orderItemId',
      });
    });
    await f.service.billingCommand('/api/billing/coverage/start', {
      ...scope,
      fromDate: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
      confirmed: true,
    });
  }
  if (options.coverage !== false) await enableCoverage();
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
    orders,
    bills,
    enableCoverage,
    onNextOrders(action: () => Promise<void>) {
      beforeOrders = action;
    },
    setOrdersOffline(offline: boolean) {
      failOrders = offline;
    },
    setPhysical(value: number) {
      physical = value;
    },
  };
}

test('a direct stock override needs confirmation for its quantity and current keep-back evidence', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 8, packSize: 2, tyreFloor: true });
  const setKeepBack = (units: number) =>
    s.f.store.update((state) => {
      const item = state.items.find((entry) => entry.id === s.item.id)!;
      item.keepBackUnits = units;
      item.version++;
    });
  setKeepBack(2);
  const input = {
    accountId: s.account.id,
    listingId: s.remote.id,
    locationId: s.listing.location,
    version: s.f.listing(s.account.id).version,
  };
  const apply = (
    quantity: number,
    keepBackConfirmation?: { reviewKey: string; quantity: number },
  ) =>
    s.f.service.apply({
      ...input,
      edit: { kind: 'stock', locationId: input.locationId, quantity },
      keepBackConfirmation,
    });
  const first = await s.f.service.reviewKeepBack(input);
  assert.equal(first?.completePacks, 3);
  await assert.rejects(apply(5), /Keep back from marketplaces/);
  await assert.rejects(
    apply(5, { reviewKey: first.reviewKey, quantity: 4 }),
    /Keep back from marketplaces/,
  );
  setKeepBack(4);
  await assert.rejects(
    apply(5, { reviewKey: first.reviewKey, quantity: 5 }),
    /Keep back from marketplaces/,
  );
  assert.equal(s.f.writes.length, 0);
  assert.equal(s.f.store.read().listings.find((row) => row.id === s.listing.id)?.paused, false);
  const fresh = await s.f.service.reviewKeepBack(input);
  assert.equal(fresh?.completePacks, 2);
  const sent = await apply(5, { reviewKey: fresh.reviewKey, quantity: 5 });
  assert.equal(sent.change.state, 'confirmed');
  assert.equal(s.f.writes.length, 1);
});

test('unverified order coverage warns on positive manual overrides and leaves zero available', async (t) => {
  const s = await mappedInventory(t, 'manual', { coverage: false });
  s.f.store.update((state) => {
    state.items[0].keepBackUnits = 1;
  });
  const input = {
    accountId: s.account.id,
    listingId: s.remote.id,
    locationId: s.listing.location,
    version: s.f.listing(s.account.id).version,
  };
  const review = await s.f.service.reviewKeepBack(input);
  assert.equal(review?.completePacks, null);
  await assert.rejects(s.f.stock(s.account.id, 2), /Keep back from marketplaces/);
  assert.equal((await s.f.stock(s.account.id, 0)).change.state, 'confirmed');
});

test('an urgent zero takes effect during a positive manual keep-back check', async (t) => {
  const s = await mappedInventory(t);
  s.service.setKeepBack(s.item.companyId, s.item.id, s.item.version, 2);
  s.onNextOrders(async () => {
    assert.equal((await s.f.stock(s.account.id, 0)).change.state, 'confirmed');
  });
  await assert.rejects(s.f.stock(s.account.id, 1), /changed|refresh/i);
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [0],
  );
});

test('the Inventory publisher rechecks a manual keep-back approval after a new order', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 8, packSize: 2, tyreFloor: true });
  const companyId = s.item.companyId;
  s.service.setKeepBack(companyId, s.item.id, s.item.version, 2);
  const edited = s.service.edit(companyId, s.listing.id, 4);
  const draft = edited.proposals.find((row) => row.listingId === s.listing.id)!;
  const intent = {
    companyId,
    listingId: s.listing.id,
    itemVersion: draft.itemVersion,
    listingVersion: draft.listingVersion,
    draft,
    positiveEdits: 'once' as const,
  };
  const input = {
    accountId: s.account.id,
    listingId: s.remote.id,
    locationId: s.listing.location,
    version: s.f.listing(s.account.id).version,
  };
  const first = await s.f.service.reviewKeepBack(input);
  assert.equal(first?.completePacks, 3);
  assert.equal((await s.f.service.publishInventory(intent)).status, 'blocked');
  s.orders.push({
    orderItemId: 'new-sale',
    orderId: 'new-order',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 1,
    orderDate: new Date().toISOString(),
  });
  const publish = (reviewKey: string) =>
    s.f.service.publishInventory({
      ...intent,
      keepBackConfirmation: { reviewKey, quantity: 4 },
    });
  const stale = await publish(first.reviewKey);
  assert.equal(stale.status, 'blocked');
  assert.match(stale.message, /Keep back from marketplaces/);
  assert.equal(s.f.writes.length, 0);
  assert.equal(
    s.f.store.read().proposals.some((row) => row.listingId === s.listing.id),
    true,
  );
  const current = await s.f.service.reviewKeepBack(input);
  assert.equal(current?.completePacks, 2);
  assert.equal((await publish(current.reviewKey)).status, 'confirmed');
  assert.equal(s.f.writes.length, 1);
  assert.equal(s.f.store.read().listings.find((row) => row.id === s.listing.id)?.paused, false);
});

test('Inventory and Marketplaces report the same automatic stock state as setup and pending work change', async (t) => {
  const s = await mappedInventory(t, 'manual', { coverage: false });
  const status = () => {
    const inventory = s.service.snapshot().listings.find((row) => row.id === s.listing.id)!;
    const listing = s.f.service
      .page(new URLSearchParams({ accountId: s.account.id }))
      .listings.find((row) => row.id === s.remote.id)!;
    assert.equal(listing.status, 'ACTIVE');
    assert.equal(
      listing.stockPolicies.find((row) => row.locationId === s.listing.location)?.automationStatus,
      inventory.automationStatus,
    );
    return inventory.automationStatus!;
  };
  assert.equal(status(), 'Company updates off');
  s.service.automation(s.item.companyId, true);
  assert.match(status(), /Order matching, choose Set starting stock/);
  await s.service.pause(s.item.companyId, [s.listing.id], true);
  assert.equal(status(), 'Paused');
  await s.enableCoverage();
  await s.service.pause(s.item.companyId, [s.listing.id], false);
  assert.equal(status(), 'Queued for a stock check');
  await s.service.refresh(s.item.companyId);
  assert.equal(status(), 'Ready for the next Tally change or verified sale');
  const coverage = s.f.store.readStockCoverage(s.item.companyId)!;
  const lastCheck = new Date(Date.parse(coverage.from) - 31 * 86_400_000).toISOString();
  s.f.store.saveStockCoverage({ ...coverage, from: lastCheck, checkedThrough: lastCheck });
  assert.match(status(), /gap in order coverage.*Review starting stock/);
  s.f.store.saveStockCoverage({ ...coverage, signature: 'previous-stock-setup' });
  assert.match(status(), /setup changed.*Review starting stock/);
  s.f.store.saveStockCoverage(coverage);
  s.f.store.updateMarketplace((market) => {
    market.changes[0].state = 'uncertain';
  });
  assert.match(status(), /previous update result/);
});

test('company preview and trial use calculated stock, preserve drafts, and require fresh approval for each destination', async (t) => {
  const s = await mappedInventory(t, 'manual', { packSize: 1, physical: 8, tyreFloor: false });
  const companyId = s.item.companyId;
  s.orders.push({
    orderItemId: 'trial-sale',
    orderId: 'trial-order',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 2,
    orderDate: new Date().toISOString(),
  });
  s.service.edit(companyId, s.listing.id, 0);
  const previous = s.service.snapshot();
  const journal = s.f.store.readStockCoverage(companyId);
  const review = await s.service.automationReviews.preview(companyId);
  assert.deepEqual(
    review.rows.map((r) => [r.status, r.observed, r.proposed]),
    [['ready', 5, 6]],
  );
  assert.deepEqual(s.service.snapshot(), previous);
  assert.deepEqual(s.f.store.readStockCoverage(companyId), journal);
  assert.equal(s.f.writes.length, 0);
  const trial = () => s.service.automationReviews.trial(companyId, review.id, s.listing.id);
  assert.equal((await trial()).status, 'confirmed');
  assert.equal(s.remote.locations[0].quantity, 6);
  assert.equal(s.remote.locations[1].quantity, 3);
  const after = s.service.snapshot();
  assert.equal(after.companies[0].automation, false);
  assert.deepEqual(
    after.proposals,
    previous.proposals.map((draft) => ({ ...draft, stale: true })),
  );
  const row = after.listings.find((l) => l.id === s.listing.id)!;
  assert.equal(row.policy, 'auto');
  assert.equal(row.paused, false);
  await assert.rejects(trial, /fresh company preview/);
  const matching = await s.service.automationReviews.preview(companyId);
  assert.equal(
    (await s.service.automationReviews.trial(companyId, matching.id, s.listing.id)).status,
    'unchanged',
  );
  assert.deepEqual(
    s.f.writes.map((w) => w.quantity),
    [6],
  );
});

test('a trial refuses changed stock and uncertain updates; company approval includes hidden sellers and waiting rows', async (t) => {
  const s = await mappedInventory(t);
  const companyId = s.item.companyId;
  const preview = () => s.service.automationReviews.preview(companyId);
  const trial = (id: string) => s.service.automationReviews.trial(companyId, id, s.listing.id);
  const enable = (id: string) =>
    s.service.automationReviews.enable(companyId, id, () => s.service.automation(companyId, true));
  const changed = await preview();
  s.remote.locations[0].quantity = 1;
  assert.equal((await trial(changed.id)).status, 'blocked');
  assert.equal(s.f.writes.length, 0);
  const stale = await preview();
  s.remote.locations[0].quantity = 2;
  await assert.rejects(enable(stale.id), /scope or stock changed/);
  assert.equal(s.service.snapshot().companies[0].automation, false);
  const beforeMapping = await preview();
  const seller = await s.f.add('seller-b');
  const other = s.service.snapshot().listings.find((l) => l.accountId === seller.id)!;
  s.service.mapping({
    itemId: s.item.id,
    listingId: other.id,
    listingVersion: other.version,
    confirmPackEvidence: true,
    packSource: 'manual',
    packSize: 1,
    sourceScope: 'company',
    tyreFloor: false,
  });
  await assert.rejects(enable(beforeMapping.id), /mappings or stock evidence changed/);
  await s.service.pause(companyId, [other.id], true);
  const waiting = await preview();
  assert.equal(waiting.rows.length, 2);
  assert.equal(waiting.rows.find((r) => r.listingId === other.id)?.status, 'paused');
  assert.equal(waiting.rows.find((r) => r.listingId === s.listing.id)?.status, 'waiting');
  assert.ok((await enable(waiting.id)).companies[0].automation);
  assert.deepEqual(s.f.writes, []);
  s.service.automation(companyId, false);
  // A pending or uncertain previous request blocks a trial even for a calculated zero.
  s.setPhysical(0);
  await s.service.refresh();
  const zero = await preview();
  s.f.setFailWrite('after');
  assert.equal((await trial(zero.id)).status, 'uncertain');
  s.f.setFailRead(false);
  const blocked = await preview();
  assert.equal(blocked.rows.find((r) => r.listingId === s.listing.id)?.status, 'waiting');
  assert.match(blocked.rows.find((r) => r.listingId === s.listing.id)!.reason!, /previous update/);
  await assert.rejects(trial(blocked.id), /ready listing/);
  assert.equal(s.f.writes.length, 1);
});

test('a trial rechecks its selected destination when another stock item changes after company preview', async (t) => {
  const s = await mappedInventory(t, 'manual', { coverage: false });
  const companyId = s.item.companyId;
  const secondItem = {
    ...s.item,
    id: 'other-item',
    externalId: 'other',
    name: 'Another tyre',
    physical: 0,
  };
  s.f.store.update((state) => state.items.push(secondItem));
  const second = s.service.snapshot().listings.find((l) => l.location === 'warehouse-b')!;
  s.service.mapping({
    itemId: secondItem.id,
    listingId: second.id,
    listingVersion: second.version,
    confirmPackEvidence: true,
    packSize: 1,
    packSource: 'manual',
    sourceScope: 'company',
    tyreFloor: false,
  });
  await s.enableCoverage();
  const preview = await s.service.automationReviews.preview(companyId);
  assert.equal(preview.rows.filter((r) => r.status === 'ready').length, 2);
  s.f.store.update((state) => {
    const item = state.items.find((i) => i.id === secondItem.id)!;
    item.physical = 4;
    item.version++;
  });
  const trial = await s.service.automationReviews.trial(companyId, preview.id, s.listing.id);
  assert.equal(trial.status, 'confirmed', trial.message);
  assert.deepEqual(
    s.remote.locations.map((l) => l.quantity),
    [7, 3],
  );
  assert.equal(s.service.snapshot().companies[0].automation, false);
});

test('the automation API requires the reviewed company before enabling and invalidates competing approvals', async (t) => {
  const s = await mappedInventory(t);
  const app = createApp(s.service, s.f.folder, undefined, undefined, s.f.service);
  const address = await listen(app);
  t.after(() => close(app));
  const post = (path: string, fields: Record<string, unknown>) =>
    fetch(address + '/api/automation' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: JSON.stringify({ companyId: s.item.companyId, ...fields }),
    });
  assert.equal((await post('', { enabled: true })).status, 409);
  const first = (await (await post('/preview', {})).json()) as { id: string };
  assert.equal(
    (await post('/trial', { previewId: first.id, listingId: 'outside-review' })).status,
    409,
  );
  const a = (await (await post('/preview', {})).json()) as { id: string };
  const b = (await (await post('/preview', {})).json()) as { id: string };
  assert.equal(
    (await post('', { enabled: true, previewId: a.id, companyId: 'another' })).status,
    409,
  );
  assert.equal((await post('', { enabled: true, previewId: a.id })).status, 200);
  assert.equal((await post('', { enabled: false })).status, 200);
  assert.equal((await post('', { enabled: true, previewId: b.id })).status, 409);
  assert.equal(s.service.snapshot().companies[0].automation, false);
  assert.deepEqual(s.f.writes, []);
});

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
  await restarted.pause(s.item.companyId, [s.listing.id], true);
  s.setPhysical(16);
  await restarted.refresh();
  assert.equal(s.f.writes.length, 3);
  await restarted.pause(s.item.companyId, [s.listing.id], false);
  await restarted.refresh();
  assert.equal(s.f.writes.at(-1)?.quantity, 8);
});

test('a fixed bulk review rechecks each pack and saves only changed quantities for a fresh decision', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 14, coverage: false, tyreFloor: false });
  const companyId = s.item.companyId;
  const second = s.service.snapshot().listings.find((row) => row.location === 'warehouse-b')!;
  s.service.mapping({
    listingId: second.id,
    itemId: s.item.id,
    listingVersion: second.version,
    confirmPackEvidence: true,
    packSize: 1,
    packSource: 'manual',
    sourceScope: 'company',
    tyreFloor: false,
  });
  await s.enableCoverage();
  const ids = [s.listing.id, second.id];
  await s.service.calculateAvailable(companyId, ids);
  const review = await s.service.prepareReview(companyId, ids);
  assert.deepEqual(
    review.rows.map((row) => row.quantity),
    [7, 14],
  );
  s.setPhysical(15);
  await s.service.refresh();
  s.f.store.update((state) => {
    const row = state.listings.find((entry) => entry.id === second.id)!;
    row.syncPendingItemVersion = state.items[0].version;
    row.orderSyncPending = 'pending-newer-work';
  });
  const [same, changed] = (await s.service.publish(review.id)).rows;
  assert.deepEqual(
    [same.status, changed.status, changed.latestQuantity],
    ['confirmed', 'blocked', 15],
  );
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [7],
  );
  const snapshot = s.service.snapshot();
  const pending = snapshot.listings.find((entry) => entry.id === second.id)!;
  assert.equal(pending.syncPendingItemVersion, snapshot.items[0].version);
  assert.equal(pending.orderSyncPending, 'pending-newer-work');
  assert.deepEqual(
    snapshot.proposals.map((draft) => [draft.listingId, draft.quantity, draft.stale]),
    [[second.id, 15, false]],
  );
  const retry = await s.service.prepareReview(companyId, [second.id]);
  assert.equal((await s.service.publish(retry.id)).rows[0].status, 'confirmed');
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [7, 15],
  );
});

test('a fixed review verifies a newer automatic sync without resending or consuming newer pending work', async (t) => {
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  const review = s.prepare();
  s.setPhysical(12);
  await s.service.refresh();
  s.f.store.update((state) => {
    state.listings.find((entry) => entry.id === s.listing.id)!.orderSyncPending = 'new-sale';
  });
  const reads = s.f.listingReadStatusChecks.length;
  const result = (await s.service.publish(review.id)).rows[0];
  assert.deepEqual([result.status, result.latestQuantity], ['unchanged', undefined]);
  assert.match(result.message, /latest calculated quantity of 6/);
  assert.deepEqual(s.f.listingReadStatusChecks.slice(reads), [true]);
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [7, 6],
  );
  const current = s.service.snapshot();
  assert.equal(
    current.listings.find((entry) => entry.id === s.listing.id)!.orderSyncPending,
    'new-sale',
  );
  assert.equal(current.proposals[0].quantity, 6);
});

test('a keep-back change and reversal or a superseding seller edit blocks the fixed review', async (t) => {
  const s = await mappedInventory(t);
  const companyId = s.item.companyId;
  const first = s.prepare();
  s.service.setKeepBack(companyId, s.item.id, s.item.version, 1);
  s.service.setKeepBack(companyId, s.item.id, s.item.version + 1, 0);
  const blocked = (await s.service.publish(first.id)).rows[0];
  assert.deepEqual([blocked.status, blocked.latestQuantity], ['blocked', undefined]);
  const second = s.prepare();
  s.f.onNextRead(() => s.service.edit(companyId, s.listing.id, 7));
  assert.equal((await s.service.publish(second.id)).rows[0].status, 'blocked');
  assert.equal(s.service.snapshot().proposals[0].edited, true);
  assert.equal(s.f.writes.length, 0);
});

test('a reviewed no-op preserves a newly discovered sale even when the tyre floor keeps the same quantity', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 11, packSize: 2, tyreFloor: true });
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  const review = s.prepare();
  assert.equal(review.rows[0].quantity, 5);
  s.orders.push({
    orderItemId: 'floor-sale',
    orderId: 'floor-order',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 1,
    orderDate: new Date().toISOString(),
  });
  const [row] = (await s.service.publish(review.id)).rows;
  assert.equal(row.status, 'unchanged');
  assert.deepEqual(s.f.writes, []);
  const snapshot = s.service.snapshot();
  assert.ok(snapshot.listings.find((entry) => entry.id === s.listing.id)!.orderSyncPending);
  assert.equal(snapshot.proposals[0].quantity, 5);
});

test('a reviewed no-op completes the stock check that was already queued when the seller opened review', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 10 });
  s.service.automation(s.item.companyId, true);
  const review = s.prepare();
  const before = s.service.snapshot().listings.find((entry) => entry.id === s.listing.id)!;
  assert.equal(before.syncPendingItemVersion, s.item.version);
  assert.equal(review.rows[0].quantity, review.rows[0].observed);
  const [result] = (await s.service.publish(review.id)).rows;
  assert.equal(result.status, 'unchanged');
  const snapshot = s.service.snapshot();
  assert.equal(
    snapshot.listings.find((entry) => entry.id === s.listing.id)!.syncPendingItemVersion,
    null,
  );
  assert.deepEqual(snapshot.proposals, []);
  assert.deepEqual(s.f.writes, []);
});

test('a sale changing both the calculated and remote quantities offers the verified draft without writing', async (t) => {
  for (const importBeforePublish of [false, true]) {
    const s = await mappedInventory(t, 'manual', { physical: 5, packSize: 1, tyreFloor: false });
    const review = s.prepare();
    s.orders.push({
      orderItemId: 'sale',
      orderId: 'order',
      invoiceNumber: null,
      listingId: s.remote.id,
      sku: s.remote.sku,
      locationId: s.listing.location,
      quantity: 1,
      orderDate: new Date().toISOString(),
    });
    s.remote.locations[0].quantity = 3;
    if (importBeforePublish) await s.f.service.refresh(s.account.id);
    const [changed] = (await s.service.publish(review.id)).rows;
    assert.deepEqual([changed.status, changed.latestQuantity], ['blocked', 4]);
    assert.deepEqual(s.f.writes, []);
    const latest = (await s.service.prepareReview(s.item.companyId, [s.listing.id])).rows[0];
    assert.deepEqual([latest.quantity, latest.observed, latest.problem], [4, 3, null]);
  }
});

test('an unchanged calculation cannot refill remotely changed stock or publish without fresh order evidence', async (t) => {
  const s = await mappedInventory(t);
  const review = s.prepare();
  s.remote.locations[0].quantity = 3;
  await s.f.service.refresh(s.account.id);
  const [conflict] = (await s.service.publish(review.id)).rows;
  assert.deepEqual([conflict.status, conflict.latestQuantity], ['blocked', undefined]);
  assert.match(conflict.message, /Flipkart changed/);
  const fresh = s.prepare();
  s.setOrdersOffline(true);
  const [missing] = (await s.service.publish(fresh.id)).rows;
  assert.deepEqual([missing.status, missing.latestQuantity], ['blocked', undefined]);
  assert.match(missing.message, /orders|shipments/i);
  assert.deepEqual(s.f.writes, []);
});

test('restocking from four to six publishes five until the Flipkart order is billed', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 4, packSize: 1, tyreFloor: false });
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  s.orders.push({
    orderItemId: 'order-line-1',
    orderId: 'order-1',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 1,
    orderDate: new Date().toISOString(),
  });
  s.remote.locations[0].quantity = 3;
  await s.f.service.refresh(s.account.id);
  await s.service.refresh();
  assert.equal(s.remote.locations[0].quantity, 3);
  s.setPhysical(6);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [4, 5],
  );
  const review = s.prepare();
  assert.equal(review.rows[0].quantity, 6);
  const result = (await s.service.publish(review.id)).rows[0];
  assert.equal(result.status, 'unchanged');
  assert.match(result.message, /latest calculated quantity of 5/);
  s.bills.push({
    externalId: 'bill-1',
    number: '1',
    date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
    reference: 'order-line-1',
    narration: '',
    lines: [{ itemExternalId: 'item', quantity: 1, unit: 'pieces' }],
  });
  s.setPhysical(5);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [4, 5],
    'billing keeps five available',
  );
  assert.equal(
    s.service.snapshot().listings.find((row) => row.id === s.listing.id)!.syncPendingItemVersion,
    null,
  );
});

test('the Tally poll publishes a healthy company while its peer fails and blocks a reviewed write after a company failure', async (t) => {
  const s = await mappedInventory(t);
  const due = new Map<number, () => void>();
  let failing = 'b';
  let slowReadStarted!: () => void;
  let releaseRead!: () => void;
  const readingPeer = new Promise<void>((resolve) => {
    slowReadStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const running = new InventoryService(s.f.store, {
    marketplaces: s.f.service,
    timers: {
      now: Date.now,
      schedule(callback, delay) {
        due.set(delay, callback);
        return () => due.delete(delay);
      },
    },
    createTallyReader: () => ({
      listCompanies: async () => [
        { externalId: 'a', name: 'Tally company' },
        { externalId: 'b', name: 'Other company' },
      ],
      async readStock(company) {
        if (company.externalId === failing) throw new Error('Company unavailable');
        if (company.externalId !== 'a') {
          slowReadStarted();
          await released;
          return [];
        }
        const { externalId, name, unit, physical } = s.item;
        return [{ externalId, name, unit, physical }];
      },
    }),
  });
  running.automation(s.item.companyId, true);
  running.start();
  try {
    await running.idle();
    const interval = s.service.snapshot().settings.tallySeconds * 1000;
    due.get(interval)!();
    await running.idle();
    assert.deepEqual(
      s.f.writes.map((write) => write.quantity),
      [7],
    );
    assert.ok(due.has(interval), 'a working company keeps its normal interval');
    running.edit(s.item.companyId, s.listing.id, 0);
    const review = running.review(s.item.companyId, [s.listing.id]);
    failing = 'a';
    due.get(interval)!();
    await readingPeer;
    const [result] = (await running.publish(review.id)).rows;
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /stale|refresh/i);
    assert.equal(s.f.writes.length, 1);
  } finally {
    releaseRead();
    running.stop();
    await running.idle();
  }
});

test('the order poll takes another seller’s pair offline after one single sells, without waiting for Tally', async (t) => {
  const s = await mappedInventory(t, 'manual', {
    physical: 2,
    packSize: 1,
    tyreFloor: false,
    coverage: false,
  });
  const sellerB = await s.f.add('seller-b');
  const catalogue = s.f.remote.get('seller-b')!;
  const pair = {
    ...structuredClone(catalogue[0]),
    id: 'pair-listing',
    productId: 'pair-product',
    sku: 'TYRE-PAIR',
  };
  catalogue.push(pair);
  await s.f.service.refresh(sellerB.id);
  const mapping = s.service
    .snapshot()
    .listings.find(
      (l) => l.accountId === sellerB.id && l.sku === pair.sku && l.location === 'warehouse-a',
    )!;
  s.service.mapping({
    listingId: mapping.id,
    itemId: s.item.id,
    listingVersion: mapping.version,
    packSize: 2,
    packSource: 'manual',
    sourceScope: 'company',
    tyreFloor: true,
    confirmPackEvidence: true,
  });
  s.f.store.updateBilling((data) =>
    data.rules.push({
      accountId: sellerB.id,
      companyId: s.item.companyId,
      ledgerId: 'ledger-b',
      ledgerName: 'Seller B sales',
      field: 'reference',
      reference: 'orderItemId',
    }),
  );
  await s.enableCoverage();
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  assert.equal(s.remote.locations[0].quantity, 2);
  assert.equal(pair.locations[0].quantity, 5);
  const due = new Map<number, () => void>();
  const running = s.inventory({
    now: Date.now,
    schedule(callback, delay) {
      due.set(delay, callback);
      return () => {
        if (due.get(delay) === callback) due.delete(delay);
      };
    },
  });
  running.start();
  try {
    await running.idle();
    const order = {
      orderItemId: 'single-sale',
      orderId: 'O1',
      invoiceNumber: null,
      listingId: s.remote.id,
      sku: s.remote.sku,
      locationId: s.listing.location,
      quantity: 1,
      orderDate: new Date().toISOString(),
    };
    s.orders.push(order);
    s.remote.locations[0].quantity = 1;
    const before = s.f.writes.length;
    const interval = s.service.snapshot().settings.marketplaceSeconds * 1000;
    due.get(interval)!();
    await running.idle();
    assert.equal(s.service.snapshot().items[0].physical, 2);
    assert.equal(s.remote.locations[0].quantity, 1);
    assert.equal(pair.locations[0].quantity, 0);
    assert.deepEqual(
      s.f.writes.slice(before).map((w) => [w.token, w.quantity]),
      [['seller-b', 0]],
    );
    const reads = s.f.listingReadStatusChecks.length;
    due.get(interval)!();
    await running.idle();
    assert.equal(
      s.f.listingReadStatusChecks.length,
      reads,
      'a duplicate receipt schedules no new checks',
    );
    s.bills.push({
      externalId: 'bill',
      number: '1',
      date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
      reference: order.orderItemId,
      narration: '',
      lines: [{ itemExternalId: 'item', quantity: 1, unit: 'pieces' }],
    });
    s.setPhysical(1);
    await s.service.refresh();
    assert.equal(s.f.writes.length, before + 1, 'billing cannot deduct the same sale again');
  } finally {
    running.stop();
    await running.idle();
  }
});

test('a new order never raises lower fresh remote stock, and a duplicate cannot override a later seller edit', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 8, packSize: 1, tyreFloor: false });
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  s.orders.push({
    orderItemId: 'first',
    orderId: 'first',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 1,
    orderDate: new Date().toISOString(),
  });
  s.remote.locations[0].quantity = 3;
  await s.service.refresh();
  const row = s.service.snapshot().listings.find((l) => l.id === s.listing.id)!;
  assert.equal(row.observed, 3);
  assert.equal(row.orderSyncPending ?? null, null);
  assert.deepEqual(
    s.f.writes.map((w) => w.quantity),
    [8],
  );
  await s.f.stock(s.account.id, 8);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((w) => w.quantity),
    [8, 8],
  );
});

test('an unchanged Tally poll drains a saved sale, and Calculate wakes automation for a newly observed sale', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 6, packSize: 1, tyreFloor: false });
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  const sale = {
    orderItemId: 'sale',
    orderId: 'sale',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 1,
    orderDate: new Date().toISOString(),
  };
  s.orders.push(sale);
  // Simulate discovery before the publishing worker starts.
  await s.f.service.checkStockOrders(s.item.companyId, {});
  assert.ok(s.service.snapshot().listings.find((l) => l.id === s.listing.id)!.orderSyncPending);
  const callbacks = new Map<number, () => void>();
  const running = s.inventory({
    now: Date.now,
    schedule(callback, delay) {
      callbacks.set(delay, callback);
      return () => callbacks.delete(delay);
    },
  });
  running.start();
  try {
    await running.idle();
    callbacks.get(s.service.snapshot().settings.tallySeconds * 1000)!();
    await running.idle();
    assert.equal(s.remote.locations[0].quantity, 5);
    s.orders.push({ ...sale, orderItemId: 'another', orderId: 'another' });
    const draft = await running.calculateAvailable(s.item.companyId, [s.listing.id]);
    assert.equal(draft.proposals[0].quantity, 4, 'Calculate finishes saving its review');
    await running.idle();
    assert.equal(
      s.remote.locations[0].quantity,
      4,
      'new sale is published without another scheduled poll',
    );
    assert.deepEqual(
      s.f.writes.map((w) => w.quantity),
      [6, 5, 4],
    );
  } finally {
    running.stop();
    await running.idle();
  }
});

for (const keepPaused of [false, true]) {
  test(`a new order mapping counts the sale and ${keepPaused ? 'keeps its location paused' : 'follows company sync'}`, async (t) => {
    const s = await mappedInventory(t, 'manual', { physical: 6, packSize: 1, tyreFloor: false });
    const dest = s.service.snapshot().listings.find((l) => l.location === 'warehouse-b')!;
    const orderSource = {
      companyId: s.item.companyId,
      accountId: s.account.id,
      listingId: s.remote.id,
      locationId: dest.location,
    };
    s.orders.push({
      orderItemId: 'pair-order-item',
      orderId: 'pair-order',
      invoiceNumber: null,
      listingId: s.remote.id,
      sku: dest.sku,
      locationId: dest.location,
      quantity: 1,
      orderDate: new Date().toISOString(),
    });
    await s.service.refresh();
    const coverage = () => s.f.store.readStockCoverage(s.item.companyId)!;
    const start = coverage().from;
    assert.equal(coverage().orders.length, 1, 'tracking remembers the sale with company sync off');
    assert.equal(s.f.writes.length, 0);
    s.service.automation(s.item.companyId, true);
    const input = {
      listingId: dest.id,
      itemId: s.item.id,
      listingVersion: dest.version,
      confirmPackEvidence: true,
      packSize: 2,
      packSource: 'manual',
      sourceScope: 'company',
      tyreFloor: false,
      orderSource,
      ...(keepPaused && { keepPaused: true }),
    };
    for (const changed of [
      { listingId: 'replaced-listing' },
      { accountId: 'other-seller' },
      { locationId: s.listing.location },
      { companyId: 'other-company' },
    ]) {
      assert.throws(
        () => s.service.mapping({ ...input, orderSource: { ...orderSource, ...changed } }),
        /order listing/,
      );
      assert.equal(s.f.store.read().listings.find((l) => l.id === dest.id)!.itemId, null);
    }
    s.service.mapping(input);
    assert.equal(coverage().from, start);
    assert.equal(s.f.store.read().listings.find((l) => l.id === dest.id)!.paused, keepPaused);
    await s.service.refresh();
    assert.equal(s.remote.locations.find((l) => l.id === s.listing.location)!.quantity, 4);
    assert.equal(
      s.remote.locations.find((l) => l.id === dest.location)!.quantity,
      keepPaused ? 3 : 2,
    );
  });
}

test('Calculate with automation off reviews and publishes five, then catches another order before Apply', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 6, packSize: 1, tyreFloor: false });
  s.orders.push({
    orderItemId: 'line-1',
    orderId: 'order-1',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 1,
    orderDate: new Date().toISOString(),
  });
  s.remote.locations[0].quantity = 3;
  await s.f.service.refresh(s.account.id);
  const calculate = () => s.service.calculateAvailable(s.item.companyId, [s.listing.id]);
  const review = () => s.service.review(s.item.companyId, [s.listing.id]);
  const draft = (await calculate()).proposals[0];
  assert.deepEqual([draft.quantity, draft.calculated, draft.edited], [5, 5, false]);
  const first = review();
  assert.equal(first.rows[0].quantity, 5);
  assert.equal((await s.service.publish(first.id)).rows[0].status, 'confirmed');
  await calculate();
  const earlier = review();
  s.orders.push({ ...s.orders[0], orderItemId: 'line-2', orderId: 'order-2' });
  const blocked = (await s.service.publish(earlier.id)).rows[0];
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.latestQuantity, 4);
  assert.equal(s.service.snapshot().proposals[0].quantity, 4);
  assert.equal((await s.service.publish(review().id)).rows[0].status, 'confirmed');
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [5, 4],
  );
});

test('an automatic draft refresh uses unbilled orders without publishing or consuming order sync work', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 8, packSize: 1, tyreFloor: false });
  const companyId = s.item.companyId;
  const listingId = s.listing.id;
  s.service.start();
  try {
    await s.service.idle();
    const original = await s.service.calculateAvailable(companyId, [listingId]);
    assert.equal(original.proposals[0].quantity, 8);
    const review = s.service.review(companyId, [listingId]);
    const coverage = s.f.store.readStockCoverage(companyId);
    s.f.store.update((state) => {
      state.listings.find((row) => row.id === listingId)!.orderSyncPending = 'pending-sale';
    });
    s.orders.push({
      orderItemId: 'reserved-sale',
      orderId: 'reserved-order',
      invoiceNumber: null,
      listingId: s.remote.id,
      sku: s.remote.sku,
      locationId: s.listing.location,
      quantity: 1,
      orderDate: new Date().toISOString(),
    });

    s.service.setKeepBack(companyId, s.item.id, s.item.version, 2);
    await s.service.idle();

    const refreshed = s.service.snapshot();
    const draft = refreshed.proposals.find((row) => row.listingId === listingId)!;
    assert.deepEqual(
      [draft.quantity, draft.calculated, draft.stale, draft.edited],
      [5, 5, false, false],
    );
    assert.equal(
      refreshed.listings.find((row) => row.id === listingId)!.orderSyncPending,
      'pending-sale',
    );
    assert.deepEqual(s.f.store.readStockCoverage(companyId), coverage);
    assert.equal((await s.service.publish(review.id)).rows[0].status, 'blocked');
    assert.equal(s.f.writes.length, 0);
  } finally {
    s.service.stop();
    await s.service.idle();
  }
});

test('an automatic draft refresh preserves a manual edit made while reading orders', async (t) => {
  const s = await mappedInventory(t);
  const companyId = s.item.companyId;
  const listingId = s.listing.id;
  s.service.start();
  try {
    await s.service.idle();
    await s.service.calculateAvailable(companyId, [listingId]);
    s.onNextOrders(async () => {
      s.service.edit(companyId, listingId, 3);
    });

    s.service.setKeepBack(companyId, s.item.id, s.item.version, 2);
    await s.service.idle();

    const current = s.service.snapshot();
    const draft = current.proposals.find((row) => row.listingId === listingId)!;
    assert.deepEqual([draft.quantity, draft.edited, draft.stale], [3, true, false]);
    assert.equal(current.listings.find((row) => row.id === listingId)!.proposalIssue, undefined);
    assert.equal(s.f.writes.length, 0);
  } finally {
    s.service.stop();
    await s.service.idle();
  }
});

test('a manual edit during Calculate is preserved and an existing edited draft survives recalculation', async (t) => {
  const s = await mappedInventory(t);
  s.onNextOrders(async () => {
    s.service.edit(s.item.companyId, s.listing.id, 1);
  });
  const calculate = () => s.service.calculateAvailable(s.item.companyId, [s.listing.id]);
  const changed = await calculate();
  assert.equal(changed.calculation[0].status, 'blocked');
  assert.match(changed.calculation[0].reason!, /selected draft changed/);
  s.setOrdersOffline(true);
  const draft = (await calculate()).proposals[0];
  assert.equal(draft.quantity, 1);
  assert.equal(draft.edited, true);
});

test('a failed Calculate keeps the last calculated quantity stale until verification succeeds', async (t) => {
  const s = await mappedInventory(t);
  const companyId = s.item.companyId;
  const ids = [s.listing.id];
  const calculate = () => s.service.calculateAvailable(companyId, ids);
  const original = (await calculate()).proposals[0];
  s.setOrdersOffline(true);

  const blocked = (await calculate()).calculation[0];
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason!, /Could not verify/);
  const saved = s.service.snapshot();
  assert.deepEqual(saved.proposals[0], { ...original, stale: true });
  assert.equal(saved.listings.find((row) => row.id === ids[0])?.proposalIssue, blocked.reason);
  assert.ok(s.service.review(companyId, ids).rows[0].problem);

  s.setOrdersOffline(false);
  const retried = await calculate();
  assert.equal(retried.proposals[0].quantity, original.quantity);
  assert.equal(retried.proposals[0].stale, false);
  assert.equal(retried.listings.find((row) => row.id === ids[0])?.proposalIssue, undefined);
  assert.deepEqual(s.f.writes, []);
});

test('bulk Calculate keeps a verified zero draft when shared order coverage blocks a positive row', async (t) => {
  const s = await mappedInventory(t, 'manual', { coverage: false });
  const zero = s.service.snapshot().listings.find((row) => row.location === 'warehouse-b')!;
  s.service.mapping({
    itemId: s.item.id,
    listingId: zero.id,
    listingVersion: zero.version,
    confirmPackEvidence: true,
    packSource: 'manual',
    packSize: 50,
    sourceScope: 'company',
    tyreFloor: false,
  });
  await s.enableCoverage();
  s.setOrdersOffline(true);
  const result = await s.service.calculateAvailable(s.item.companyId, [s.listing.id, zero.id]);
  assert.deepEqual(
    result.calculation.map((row) => [row.listingId, row.status]),
    [
      [s.listing.id, 'blocked'],
      [zero.id, 'ready'],
    ],
  );
  assert.deepEqual(
    result.proposals.map((p) => [p.listingId, p.quantity]),
    [[zero.id, 0]],
  );
  assert.equal(s.f.writes.length, 0);
});

test('unknown order coverage and failed reads keep positive work pending and retry on unchanged Tally stock', async (t) => {
  const s = await mappedInventory(t, 'manual', { coverage: false });
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  await s.service.refresh();
  const blocked = s.service.snapshot();
  assert.equal(s.f.writes.length, 0);
  assert.notEqual(
    blocked.listings.find((row) => row.id === s.listing.id)!.syncPendingItemVersion,
    null,
  );
  assert.equal(
    blocked.activity.filter((event) => event.operation === 'inventory-sync-blocked').length,
    1,
  );
  await s.enableCoverage();
  s.setOrdersOffline(true);
  await s.service.refresh();
  assert.equal(s.f.writes.length, 0);
  s.setOrdersOffline(false);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [7],
  );
});

test('losing seller verification during a protected stock no-op leaves it pending', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 10 });
  s.service.automation(s.item.companyId, true);
  s.f.onNextRead(() => s.f.service.invalidate(s.account.id));
  await s.service.refresh();
  const pending = () =>
    s.service.snapshot().listings.find((row) => row.id === s.listing.id)!.syncPendingItemVersion;
  assert.notEqual(pending(), null);
  assert.equal(s.f.store.readMarketplace().changes.length, 0);
  await s.f.service.refresh(s.account.id);
  await s.service.refresh();
  assert.equal(pending(), null);
  assert.equal(s.f.writes.length, 0);
});

test('an explicit stock correction during an order read runs immediately and supersedes the earlier calculated review', async (t) => {
  const s = await mappedInventory(t);
  const review = s.prepare();
  s.onNextOrders(async () => {
    assert.equal((await s.f.stock(s.account.id, 1)).change.state, 'confirmed');
  });
  const result = (await s.service.publish(review.id)).rows[0];
  assert.equal(result.status, 'blocked');
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [1],
  );
});

test('an unbilled multi-pack sale is deducted in base units before applying the tyre floor', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 5, packSize: 2, tyreFloor: true });
  s.orders.push({
    orderItemId: 'tyres-1',
    orderId: 'multi-1',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 2,
    orderDate: new Date().toISOString(),
  });
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  assert.equal(s.remote.locations[0].quantity, 0, 'one free tyre cannot form a set of two');
  s.setPhysical(6);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [0, 5],
  );
});

test('automatic zeros run before a positive stock check in the same refresh', async (t) => {
  const s = await mappedInventory(t, 'manual', { coverage: false });
  const second = s.service.snapshot().listings.find((row) => row.location === 'warehouse-b')!;
  s.service.mapping({
    listingId: second.id,
    itemId: s.item.id,
    listingVersion: second.version,
    confirmPackEvidence: true,
    packSize: 20,
    packSource: 'manual',
    sourceScope: 'company',
    tyreFloor: false,
  });
  await s.enableCoverage();
  s.service.automation(s.item.companyId, true);
  s.onNextOrders(async () => {
    assert.equal(s.remote.locations[1].quantity, 0);
  });
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [0, 7],
  );
});

test('a verified zero publishes even with no billing coverage', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 1, coverage: false });
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [0],
  );
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
  s.f.setFailWrite('lost-readback');
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

test('a rejected manual stock change keeps its sync lock until resume, including a pending zero', async (t) => {
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
    [2],
  );
  assert.equal(s.remote.locations[0].quantity, 5);
  assert.equal(s.f.store.read().listings.find((row) => row.id === s.listing.id)!.paused, true);
  await s.service.pause(s.item.companyId, [s.listing.id], false);
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

test('a rejected manual zero pauses sync and leaves the failure for the seller to review', async (t) => {
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
    [7, 0],
  );
  assert.equal(s.remote.locations[0].quantity, 7);
  const row = s.f.store.read().listings.find((entry) => entry.id === s.listing.id)!;
  assert.equal(row.paused, true);
  assert.equal(row.syncPendingItemVersion, null);
  assert.equal(row.orderSyncPending ?? null, null);
});

test('an uncertain manual stock change stays locked when its outcome is checked', async (t) => {
  const s = await mappedInventory(t);
  s.service.automation(s.item.companyId, true);
  s.f.setFailWrite('lost-readback');
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
  assert.equal(
    checked.listing.stockPolicies.find((row) => row.listingId === s.listing.id)?.paused,
    true,
  );
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
  await s.service.pause(s.item.companyId, [s.listing.id], true);
  s.service.edit(s.item.companyId, s.listing.id, 1);
  assert.equal(
    (await s.service.publish(s.service.review(s.item.companyId, [s.listing.id]).id, 'once')).rows[0]
      .status,
    'confirmed',
  );
  assert.equal(s.service.snapshot().listings.find((row) => row.id === s.listing.id)?.paused, true);
});

test('a manually published zero pauses Auto without changing the rule for reviewed positive updates', async (t) => {
  const s = await mappedInventory(t);
  s.service.edit(s.item.companyId, s.listing.id, 2);
  const limited = s.service.review(s.item.companyId, [s.listing.id]);
  assert.match(limited.rows[0].problem!, /order reconciliation/);
  assert.equal((await s.service.publish(limited.id)).rows[0].status, 'blocked');
  s.service.edit(s.item.companyId, s.listing.id, 0);
  const zero = s.service.review(s.item.companyId, [s.listing.id]);
  assert.equal(s.service.snapshot().listings.find((row) => row.id === s.listing.id)?.paused, false);
  assert.equal(zero.rows[0].policy, 'Tally sync paused');
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
    'auto',
  );
  s.service.edit(s.item.companyId, s.listing.id, 2);
  const positive = s.service.review(s.item.companyId, [s.listing.id]);
  assert.equal(positive.rows[0].oneTimeProblem, null);
  assert.equal((await s.service.publish(positive.id, 'once')).rows[0].status, 'confirmed');
  assert.equal(s.service.snapshot().listings.find((row) => row.id === s.listing.id)?.paused, true);
});

test('an external change stands after a manual zero until Resume publishes freshly calculated stock', async (t) => {
  const s = await mappedInventory(t);
  s.service.edit(s.item.companyId, s.listing.id, 0);
  await s.service.publish(s.service.review(s.item.companyId, [s.listing.id]).id);
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  s.remote.locations[0].quantity = 2;
  await s.f.service.refresh(s.account.id);
  const row = () => s.service.snapshot().listings.find((entry) => entry.id === s.listing.id)!;
  assert.equal(row().paused, true);
  assert.equal(row().observed, 2);
  s.setPhysical(16);
  await s.service.refresh();
  assert.equal(row().syncPendingItemVersion, null);
  assert.equal(s.remote.locations[0].quantity, 2);
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [0],
  );
  await s.service.pause(s.item.companyId, [s.listing.id], false);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [0, 8],
  );
});

test('HTTP Resume replaces a manual draft with verified available packs and keeps publication queued', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 8, packSize: 2, tyreFloor: false });
  const companyId = s.item.companyId;
  const listingId = s.listing.id;
  s.service.automation(companyId, true);
  await s.service.pause(companyId, [listingId], true);
  const saved = s.service.edit(companyId, listingId, 0);
  const observed = saved.listings.find((row) => row.id === listingId)!;
  s.orders.push({
    orderItemId: 'unbilled-pair',
    orderId: 'pair-sale',
    listingId: s.remote.id,
    invoiceNumber: null,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 1,
    orderDate: new Date().toISOString(),
  });
  const app = createApp(s.service, s.f.folder, undefined, undefined, s.f.service);
  const address = await listen(app);
  t.after(() => close(app));
  const response = await fetch(address + '/api/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
    body: JSON.stringify({
      companyId,
      listingIds: [listingId],
      listingVersion: observed.version,
      paused: false,
    }),
  });
  assert.equal(response.status, 200);
  const state = (await response.json()) as Snapshot;
  const after = state.listings.find((row) => row.id === listingId)!;
  const draft = state.proposals.find((row) => row.listingId === listingId)!;
  assert.deepEqual(
    [draft.quantity, draft.calculated, draft.edited, draft.stale],
    [3, 3, false, false],
  );
  assert.equal(draft.listingVersion, after.version);
  assert.deepEqual(
    [after.paused, after.policy, after.automationStatus],
    [false, 'auto', 'Queued for a stock check'],
  );
  assert.equal(after.observed, observed.observed);
  await s.service.idle();
  assert.equal(s.f.writes.length, 0);
  assert.equal(s.f.store.readMarketplace().changes.length, 0);
  await s.service.refresh(companyId);
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [3],
  );
});

test('Resume removes the unverified draft and explains the missing evidence until Calculate succeeds', async (t) => {
  const s = await mappedInventory(t);
  const companyId = s.item.companyId;
  const listingId = s.listing.id;
  await s.service.pause(companyId, [listingId], true);
  s.service.edit(companyId, listingId, 0);
  s.setOrdersOffline(true);
  const result = await s.service.pause(companyId, [listingId], false);
  const row = result.listings.find((entry) => entry.id === listingId)!;
  assert.equal(row.paused, false);
  assert.equal(row.syncPendingItemVersion, null, 'company sync is off');
  assert.match(row.proposalIssue!, /order|Flipkart/i);
  assert.equal(
    s.f.store.read().listings.find((entry) => entry.id === listingId)!.proposalIssue,
    row.proposalIssue,
  );
  assert.equal(
    result.proposals.find((p) => p.listingId === listingId),
    undefined,
  );
  assert.deepEqual(s.f.writes, []);
  s.setOrdersOffline(false);
  const calculated = await s.service.calculateAvailable(companyId, [listingId]);
  assert.equal(calculated.calculation[0].status, 'ready');
  assert.equal(
    calculated.listings.find((entry) => entry.id === listingId)!.proposalIssue,
    undefined,
  );
  assert.equal(calculated.proposals.find((p) => p.listingId === listingId)!.quantity, 7);
});

test('an unverified Resume cannot fall back to raw Tally stock on Calculate, and a new manual draft supersedes the issue', async (t) => {
  const s = await mappedInventory(t, 'manual', { coverage: false });
  const companyId = s.item.companyId;
  const listingId = s.listing.id;
  await s.service.pause(companyId, [listingId], true);
  s.service.edit(companyId, listingId, 2);
  await s.service.pause(companyId, [listingId], false);
  const retry = await s.service.calculateAvailable(companyId, [listingId]);
  assert.equal(retry.calculation[0].status, 'blocked');
  assert.ok(retry.listings.find((l) => l.id === listingId)!.proposalIssue);
  assert.equal(
    retry.proposals.find((p) => p.listingId === listingId),
    undefined,
  );
  const edited = s.service.edit(companyId, listingId, 0);
  assert.equal(edited.listings.find((l) => l.id === listingId)!.proposalIssue, undefined);
  assert.equal(edited.proposals.find((p) => p.listingId === listingId)!.edited, true);
  assert.deepEqual(s.f.writes, []);
});

test('a draft saved during the Resume stock check survives its late result and a repeated Resume', async (t) => {
  const s = await mappedInventory(t);
  const companyId = s.item.companyId;
  const listingId = s.listing.id;
  await s.service.pause(companyId, [listingId], true);
  s.service.edit(companyId, listingId, 0);
  s.onNextOrders(async () => {
    s.service.edit(companyId, listingId, 2);
  });
  await s.service.pause(companyId, [listingId], false);
  const result = await s.service.pause(companyId, [listingId], false);
  const draft = result.proposals.find((p) => p.listingId === listingId)!;
  assert.deepEqual([draft.quantity, draft.edited, draft.stale], [2, true, false]);
  assert.equal(result.listings.find((entry) => entry.id === listingId)!.proposalIssue, undefined);
  assert.deepEqual(s.f.writes, []);
});

test('publishing a manual zero already observed at Flipkart pauses only its location and retains its allowance', async (t) => {
  for (const screen of ['Inventory', 'Marketplaces']) {
    await t.test(screen, async (t) => {
      const s = await mappedInventory(t);
      s.remote.locations[0].quantity = 0;
      await s.f.service.refresh(s.account.id);
      s.f.store.update((state) => {
        const row = state.listings.find((entry) => entry.id === s.listing.id)!;
        row.policy = 'limited';
        row.remaining = 3;
      });
      const sibling = s.f.store.read().listings.find((entry) => entry.id !== s.listing.id)!;
      s.service.automation(s.item.companyId, true);
      if (screen === 'Inventory') {
        s.service.edit(s.item.companyId, s.listing.id, 0);
        const review = s.service.review(s.item.companyId, [s.listing.id]);
        assert.match(review.rows[0].policy, /Tally sync paused.*3 sales remaining/);
        assert.equal((await s.service.publish(review.id)).rows[0].status, 'unchanged');
      } else {
        const result = await s.f.stock(s.account.id, 0);
        assert.equal(result.change.state, 'confirmed');
        assert.equal(result.change.stockRequestFinality, undefined);
      }
      const state = s.f.store.read();
      const row = state.listings.find((entry) => entry.id === s.listing.id)!;
      assert.equal(row.paused, true);
      assert.equal(row.policy, 'limited');
      assert.equal(row.remaining, 3);
      assert.equal(row.syncPendingItemVersion, null);
      assert.equal(row.orderSyncPending ?? null, null);
      assert.equal(state.listings.find((entry) => entry.id === sibling.id)!.paused, sibling.paused);
      assert.equal(s.f.writes.length, 0);
    });
  }
});

test('a published calculated zero stays on automatic sync and restocking reopens the listing', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 1, packSize: 2, tyreFloor: false });
  const review = s.prepare();
  assert.equal(review.rows[0].quantity, 0);
  assert.equal((await s.service.publish(review.id)).rows[0].status, 'confirmed');
  assert.equal(s.f.store.read().listings.find((row) => row.id === s.listing.id)!.paused, false);
  s.service.automation(s.item.companyId, true);
  s.setPhysical(4);
  await s.service.refresh();
  assert.deepEqual(
    s.f.writes.map((entry) => entry.quantity),
    [0, 2],
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
  const result = await f.stock(first.id, 2, 'pause');
  assert.equal(result.change.state, 'confirmed');
  assert.equal(result.change.edit.kind === 'stock' && result.change.edit.automation, 'once');
  assert.ok(f.store.read().listings.every((row) => !row.paused));
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

test('a sales allowance applies while paused and requires an explicit policy change to remove', async (t) => {
  const { f, account } = await mappedInventory(t);
  f.store.update((state) => {
    const row = state.listings.find(
      (row) => row.accountId === account.id && row.location === 'warehouse-a',
    )!;
    row.policy = 'limited';
    row.remaining = 0;
  });
  await assert.rejects(f.stock(account.id, 5, 'pause'), /remaining sales allowance/);
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

test('an acknowledged write with missing readback blocks replay and can be confirmed after restart', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  f.setFailWrite('lost-readback');
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

test('a manual stock edit locks only its mapped warehouse and resume queues the latest Tally stock', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 7, packSize: 1, tyreFloor: false });
  s.service.automation(s.item.companyId, true);
  await s.service.refresh();
  const otherSeller = await s.f.add('seller-b');
  const sibling = s.f.store
    .read()
    .listings.find((row) => row.accountId === s.account.id && row.location === 'warehouse-b')!;
  const other = s.f.store
    .read()
    .listings.find(
      (row) => row.accountId === otherSeller.id && row.location === s.listing.location,
    )!;
  for (const row of [sibling, other]) {
    s.service.mapping({
      itemId: s.item.id,
      listingId: row.id,
      listingVersion: row.version,
      confirmPackEvidence: true,
      packSize: 1,
      packSource: 'manual',
      sourceScope: 'company',
      tyreFloor: false,
    });
  }
  const staleVersion = s.f.store.read().listings.find((row) => row.id === s.listing.id)!.version;
  const edit = await s.f.stock(s.account.id, 2, 'once'); // Previous clients could request a one-time direct edit.
  assert.equal(edit.change.state, 'confirmed');
  assert.equal(edit.change.edit.kind === 'stock' && edit.change.edit.automation, 'pause');
  const destination = edit.listing.stockPolicies.find((row) => row.listingId === s.listing.id)!;
  assert.equal(destination.companyId, s.item.companyId);
  assert.equal(destination.paused, true);
  assert.deepEqual(
    s.f.store
      .read()
      .listings.filter((row) => row.paused)
      .map((row) => row.id),
    [s.listing.id],
  );
  await assert.rejects(
    s.service.pause(destination.companyId, [destination.listingId], false, staleVersion),
    /listing changed/i,
  );
  s.setPhysical(0);
  await s.service.refresh();
  assert.equal(s.remote.locations[0].quantity, 2);
  assert.equal(s.remote.locations[1].quantity, 0);
  await s.service.pause(
    destination.companyId,
    [destination.listingId],
    false,
    destination.listingVersion,
  );
  const unlocked = s.f.store.read().listings.find((row) => row.id === s.listing.id)!;
  assert.equal(unlocked.paused, false);
  assert.ok(unlocked.syncPendingItemVersion);
  assert.equal(s.remote.locations[0].quantity, 2);
  await s.service.refresh();
  assert.equal(s.remote.locations[0].quantity, 0);
});

test('seller recovery via HTTP rereads Tally and unbilled orders and resumes at four without resending five', async (t) => {
  const s = await mappedInventory(t, 'manual', { packSize: 1, tyreFloor: false, physical: 5 });
  s.f.setFailWrite('lost-readback');
  const old = await s.f.stock(s.account.id, 5);
  assert.equal(old.change.state, 'uncertain');
  s.remote.locations[0].quantity = 4;
  s.orders.push({
    orderId: 'order-after-write',
    orderItemId: 'unbilled-1',
    invoiceNumber: null,
    listingId: s.remote.id,
    sku: s.remote.sku,
    locationId: s.listing.location,
    quantity: 1,
    orderDate: new Date().toISOString(),
  });
  s.f.setFailRead(false);
  s.f.setFailWrite('no');
  const app = createApp(s.service, s.f.folder, undefined, undefined, s.f.service);
  const address = await listen(app);
  t.after(() => close(app));
  const post = (action: string, extra: Record<string, unknown> = {}) =>
    fetch(address + '/api/marketplaces/recovery/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: JSON.stringify({ accountId: s.account.id, changeId: old.change.id, ...extra }),
    });
  const preview = await post('review');
  assert.equal(preview.status, 200);
  const review = (await preview.json()) as { reviewId: string; quantity: number; observed: number };
  assert.deepEqual([review.quantity, review.observed], [4, 4]);
  s.setOrdersOffline(true);
  assert.notEqual((await post('approve', { reviewId: review.reviewId })).status, 200);
  assert.equal(s.f.store.readMarketplace().changes[0].state, 'uncertain');
  s.setOrdersOffline(false);
  const again = (await (await post('review')).json()) as { reviewId: string };
  const result = await post('approve', { reviewId: again.reviewId });
  assert.equal(result.status, 200);
  assert.equal(((await result.json()) as { change: { state: string } }).change.state, 'reconciled');
  assert.deepEqual(
    s.f.writes.map((w) => w.quantity),
    [5],
  );
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
  const sample = new InventoryService(f.store)
    .snapshot()
    .listings.find(
      (row) =>
        row.accountId === account.id &&
        row.sku === listing.sku &&
        row.location === listing.locations[0].id,
    )!;
  assert.equal(sample.productId, listing.productId);
  assert.equal(sample.marketplaceListingId, listing.id);
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

test('Inventory review requests a per-listing keep-back override only for a manual quantity above available packs', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 8, packSize: 2, tyreFloor: true });
  const company = s.item.companyId;
  s.service.setKeepBack(company, s.item.id, s.item.version, 2);
  const review = () => s.service.prepareReview(company, [s.listing.id]);
  await s.service.calculateAvailable(company, [s.listing.id]);
  const calculated = (await review()).rows[0];
  assert.equal(calculated.quantity, 5);
  assert.equal(calculated.keepBackWarning, undefined);

  s.service.edit(company, s.listing.id, 3);
  assert.equal((await review()).rows[0].keepBackWarning, undefined);
  s.service.edit(company, s.listing.id, 4);
  assert.throws(() => s.service.edit(company, s.listing.id, 6), /exceeds/);
  const unconfirmed = await review();
  assert.equal(unconfirmed.rows[0].keepBackWarning?.completePacks, 3);
  assert.equal(unconfirmed.rows[0].keepBackWarning?.keepBackUnits, 2);
  const blocked = await s.service.publish(unconfirmed.id, 'once', ['another-listing']);
  assert.equal(blocked.rows[0].status, 'blocked');
  assert.equal(s.f.writes.length, 0);
  const confirmed = await review();
  const sent = await s.service.publish(confirmed.id, 'once', [s.listing.id]);
  assert.equal(sent.rows[0].status, 'confirmed');
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [4],
  );
});

test('Inventory keeps its original manual ceiling and checks even fully held-back stock', async (t) => {
  const s = await mappedInventory(t, 'manual', { physical: 8, packSize: 1, tyreFloor: false });
  const company = s.item.companyId;
  const ids = [s.listing.id];
  const updated = s.service.setKeepBack(company, s.item.id, s.item.version, 2);
  const quantity = (await s.service.calculateAvailable(company, ids)).proposals[0].quantity;
  assert.equal(quantity, 6);
  assert.throws(() => s.service.edit(company, s.listing.id, 9), /exceeds/);
  s.service.edit(company, s.listing.id, 7);
  const above = await s.service.prepareReview(company, ids);
  assert.equal(above.rows[0].keepBackWarning?.completePacks, 6);
  assert.equal((await s.service.publish(above.id, 'once', ids)).rows[0].status, 'confirmed');

  s.service.setKeepBack(
    company,
    s.item.id,
    updated.items.find((item) => item.id === s.item.id)!.version,
    8,
  );
  assert.equal((await s.service.calculateAvailable(company, ids)).proposals[0].quantity, 0);
  s.service.edit(company, s.listing.id, 1);
  const held = await s.service.prepareReview(company, ids);
  assert.equal(held.rows[0].keepBackWarning?.completePacks, 0);
  assert.equal((await s.service.publish(held.id, 'once')).rows[0].status, 'blocked');
  const approved = await s.service.prepareReview(company, ids);
  assert.equal((await s.service.publish(approved.id, 'once', ids)).rows[0].status, 'confirmed');
  assert.deepEqual(
    s.f.writes.map((write) => write.quantity),
    [7, 1],
  );
});

test('Inventory reads saved Flipkart identifiers by seller, SKU and location without refreshing the catalogue', async (t) => {
  const f = fixture(t);
  const sellerA = await f.add();
  const sellerB = await f.add('seller-b');
  const remoteB = f.remote.get('seller-b')![0];
  remoteB.id = 'listing-b';
  remoteB.productId = 'product-b';
  await f.service.refresh(sellerB.id);
  await f.restart();
  f.setFailImport(true);
  await assert.rejects(f.service.refresh(sellerA.id));
  const inventory = new InventoryService(f.store, { marketplaces: f.service });
  const calls = f.transportCalls.length;
  const rows = inventory.snapshot().listings;
  assert.deepEqual(
    rows
      .filter((row) => row.accountId === sellerA.id)
      .map((row) => [row.marketplaceListingId, row.productId]),
    [
      ['listing-one', 'product-one'],
      ['listing-one', 'product-one'],
    ],
  );
  assert.deepEqual(
    rows
      .filter((row) => row.accountId === sellerB.id)
      .map((row) => [row.marketplaceListingId, row.productId]),
    [
      ['listing-b', 'product-b'],
      ['listing-b', 'product-b'],
    ],
  );
  assert.equal(f.transportCalls.length, calls);
  assert.ok(
    f.store
      .read()
      .listings.every((row) => !('marketplaceListingId' in row) && !('productId' in row)),
  );

  f.setFailImport(false);
  f.remote.get('seller-a')![0].locations.shift();
  await f.service.refresh(sellerA.id);
  const remaining = inventory.snapshot().listings.filter((row) => row.accountId === sellerA.id);
  assert.deepEqual(
    remaining.map((row) => [row.location, row.marketplaceListingId, row.productId]),
    [
      ['warehouse-a', undefined, undefined],
      ['warehouse-b', 'listing-one', 'product-one'],
    ],
  );
  const listingWithoutLocation = f.remote.get('seller-a')![0];
  listingWithoutLocation.locations = [];
  await f.service.refresh(sellerA.id);
  const pending = inventory
    .snapshot()
    .listings.find((row) => row.accountId === sellerA.id && row.location === '')!;
  assert.equal(pending.marketplaceListingId, listingWithoutLocation.id);
  assert.deepEqual(pending.pickupChoices, []);
  f.remote.set('seller-a', []);
  await f.service.refresh(sellerA.id);
  assert.ok(
    inventory
      .snapshot()
      .listings.filter((row) => row.accountId === sellerA.id)
      .every((row) => !row.productId && !row.marketplaceListingId),
  );
});

test('map a SKU before choosing its pickup location, then publish and verify its first positive stock', async (t) => {
  const s = await mappedInventory(t, 'manual', { coverage: false });
  const remote = {
    ...s.remote,
    id: 'single-id',
    productId: 'single-product',
    sku: '155/65R14',
    locations: [],
    packageCount: 1,
  };
  s.f.remote.get('seller-a')!.push(remote);
  await s.f.service.refresh(s.account.id);
  const row = () => s.service.snapshot().listings.find((row) => row.sku === remote.sku)!;
  assert.deepEqual(row().pickupChoices, ['warehouse-a', 'warehouse-b']);
  const map = (pickupLocation: string) =>
    s.service.mapping({
      listingId: row().id,
      itemId: s.item.id,
      listingVersion: row().version,
      confirmPackEvidence: true,
      packSource: 'packages',
      packSize: 1,
      sourceScope: 'company',
      tyreFloor: false,
      pickupLocation,
    });
  map('');
  assert.equal(row().itemId, s.item.id);
  assert.throws(() => map('foreign-warehouse'), /current pickup location/);
  map('warehouse-b');
  await s.f.service.refresh(s.account.id);
  assert.equal(row().verified, true);
  assert.equal(row().observed, null);
  await s.enableCoverage();
  s.service.calculate(s.item.companyId, [row().id]);
  const review = s.service.review(s.item.companyId, [row().id]);
  const result = await s.service.publish(review.id);
  assert.equal(result.rows[0].status, 'confirmed', result.rows[0].message);
  assert.deepEqual(remote.locations, [{ id: 'warehouse-b', quantity: 14, status: 'ENABLED' }]);
  assert.equal(row().observed, 14);
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
  const recreated = new InventoryService(f.store)
    .snapshot()
    .listings.filter((row) => row.accountId === account.id);
  assert.ok(
    recreated.every(
      (row) =>
        row.productId === 'different-product' && row.marketplaceListingId === 'different-listing',
    ),
  );
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
  for (const protection of ['mapped', 'limited', 'paused', 'uncertain'] as const) {
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
              keepBackUnits: 0,
            });
            row.itemId = 'item';
          } else if (protection === 'paused') row.paused = true;
          else {
            row.policy = protection;
            row.remaining = 1;
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
    state.listings.find((row) => row.sku === protectedListing.sku)!.paused = true;
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
