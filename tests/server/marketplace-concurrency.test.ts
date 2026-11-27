import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { FlipkartListingError } from '../../src/adapters/flipkart-listings.js';
import type { FlipkartConnectionStatus } from '../../src/shared/contracts.js';
import type { MarketplaceListing } from '../../src/shared/marketplace-contracts.js';
import { createApp } from '../../src/server/http.js';
import {
  MarketplaceService,
  type AccountConnection,
} from '../../src/server/marketplace-service.js';
import type { ListingTransport } from '../../src/server/marketplace-publication.js';
import { close, listen, serverFixture } from '../support/server-fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function gate() {
  return { entered: deferred(), released: deferred() };
}

function fixture(t: TestContext) {
  const base = serverFixture(t, 'live');
  const credentials = new Map<string, string>();
  const remote = new Map<string, MarketplaceListing>();
  const imports: string[] = [];
  const failedImports = new Set<string>();
  const writes: Array<{ token: string; kind: 'stock' | 'price' }> = [];
  let importGate: ReturnType<typeof gate> | null = null;
  let readGate: ReturnType<typeof gate> | null = null;
  function connection(id: string): AccountConnection {
    const status = async (): Promise<FlipkartConnectionStatus> => ({
      state: credentials.has(id) ? 'verified' : 'not-configured',
      applicationIdHint: credentials.has(id) ? '***test' : null,
      checkedAt: null,
      expiresAt: null,
      message: 'Fixture connection',
    });
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
        if (!token) throw new Error('Fixture is disconnected');
        return token;
      },
      stop() {},
      async idle() {},
    };
  }
  const legacy = connection('flipkart-primary');
  const client: ListingTransport = {
    async listListings(token, accountId) {
      imports.push(token);
      if (failedImports.has(token)) throw new FlipkartListingError('Fixture import failed');
      const row = remote.get(token);
      const result = row ? [{ ...structuredClone(row), accountId }] : [];
      const blocked = importGate;
      importGate = null;
      if (blocked) {
        blocked.entered.resolve();
        await blocked.released.promise;
      }
      return result;
    },
    async getListing(token, listing) {
      const row = remote.get(token);
      if (!row) throw new FlipkartListingError('Fixture listing is absent');
      const result = {
        ...structuredClone(row),
        accountId: listing.accountId,
        version: listing.version,
      };
      const blocked = readGate;
      readGate = null;
      if (blocked) {
        blocked.entered.resolve();
        await blocked.released.promise;
      }
      return result;
    },
    async updateStock(token, _listing, locationId, quantity) {
      writes.push({ token, kind: 'stock' });
      remote.get(token)!.locations.find((row) => row.id === locationId)!.quantity = quantity;
    },
    async updatePrice(token, _listing, mrp, sellingPrice) {
      writes.push({ token, kind: 'price' });
      Object.assign(remote.get(token)!, { mrp, sellingPrice });
    },
  };
  const service = new MarketplaceService(base.store, base.folder, {
    client,
    createConnection: connection,
    legacyConnection: legacy,
  });
  t.after(async () => {
    service.stop();
    await service.idle();
  });
  function seller(sellerId: string) {
    remote.set(sellerId, {
      id: 'remote-listing',
      accountId: 'assigned-on-import',
      sellerId,
      productId: 'product-one',
      sku: 'TYRE-PAIR',
      title: 'Fixture tyres',
      imageUrl: null,
      status: 'ACTIVE',
      mrp: 5000,
      sellingPrice: 4000,
      locations: [{ id: 'warehouse-one', quantity: 5, status: 'ENABLED' }],
      observedAt: '2026-11-18T08:00:00.000Z',
      version: 0,
    });
  }
  seller('seller-a');
  seller('seller-b');
  function listing(accountId: string) {
    return service.page(new URLSearchParams({ accountId })).listings[0];
  }
  async function add(sellerId = 'seller-a', verify = false) {
    return service.add({
      marketplace: 'flipkart',
      name: 'Fixture seller',
      applicationId: sellerId,
      applicationSecret: 'fixture-only',
      verify,
    });
  }
  function stock(accountId: string) {
    const row = listing(accountId);
    return service.apply({
      accountId,
      listingId: row.id,
      version: row.version,
      edit: { kind: 'stock', locationId: 'warehouse-one', quantity: 2, automation: 'once' },
    });
  }
  return {
    ...base,
    inventory: base.service,
    service,
    legacy,
    writes,
    imports,
    failedImports,
    listing,
    add,
    stock,
    blockImport() {
      importGate = gate();
      return importGate;
    },
    blockRead() {
      readGate = gate();
      return readGate;
    },
  };
}

test('Inventory, scheduled and Marketplace refreshes share pending and active catalogue reads', async (t) => {
  const f = fixture(t);
  const account = await f.add('seller-a', true);
  const ids = new Set([account.id]);
  const gate = f.blockImport();
  const scheduled = f.service.refreshInventoryAccounts();
  const pending = f.service.refreshInventoryCatalogues(ids);
  await gate.entered.promise;
  const marketplace = f.service.refresh(account.id);
  const active = f.service.refreshInventoryCatalogues(ids);
  gate.released.resolve();
  const [backgroundOk, inventory, market, secondInventory] = await Promise.all([
    scheduled,
    pending,
    marketplace,
    active,
  ]);
  assert.equal(backgroundOk, true);
  assert.equal(market.account.catalogOwnershipVerified, true);
  assert.deepEqual(inventory, [{ accountId: account.id, name: account.name, status: 'refreshed' }]);
  assert.deepEqual(secondInventory, inventory);
  assert.deepEqual(f.imports, ['seller-a', 'seller-a']); // First connection and one shared import.
  assert.deepEqual(await f.service.refreshInventoryCatalogues(ids), inventory);
  assert.deepEqual(f.imports, ['seller-a', 'seller-a', 'seller-a']);
  assert.deepEqual(f.writes, []);
});

test('Inventory reports each requested seller, recovers a verified failed first import and skips saved-only access', async (t) => {
  const f = fixture(t);
  f.failedImports.add('seller-b');
  const first = await f.add('seller-a', true);
  const second = await f.add('seller-b', true);
  const saved = await f.add('saved-only');
  const requested = new Set([first.id, second.id, saved.id]);
  const partial = await f.service.refreshInventoryCatalogues(requested);
  assert.deepEqual(
    partial.map((row) => row.status),
    ['refreshed', 'failed', 'skipped'],
  );
  f.failedImports.clear();
  const before = f.imports.length;
  const recovered = await f.service.refreshInventoryCatalogues(new Set([second.id]));
  assert.deepEqual(recovered, [{ accountId: second.id, name: second.name, status: 'refreshed' }]);
  assert.deepEqual(f.imports.slice(before), ['seller-b']);
  assert.ok(!f.imports.includes('saved-only'));
  assert.deepEqual(f.writes, []);
});

test('Inventory shares an active connection-triggered import and the timer reads sellers sequentially', async (t) => {
  const f = fixture(t);
  const first = await f.add();
  const importing = f.blockImport();
  const check = f.service.changeConnection({ accountId: first.id, action: 'check' });
  await importing.entered.promise;
  const joined = f.service.refreshInventoryCatalogues(new Set([first.id]));
  importing.released.resolve();
  await check;
  assert.equal((await joined)[0].status, 'refreshed');
  assert.deepEqual(f.imports, ['seller-a']);
  await f.add('seller-b', true);
  const scheduledGate = f.blockImport();
  const scheduled = f.service.refreshInventoryAccounts();
  await scheduledGate.entered.promise;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.imports, ['seller-a', 'seller-b', 'seller-a']);
  } finally {
    scheduledGate.released.resolve();
  }
  assert.equal(await scheduled, true);
  assert.deepEqual(f.imports, ['seller-a', 'seller-b', 'seller-a', 'seller-b']);
});

test('Inventory refresh after a queued credential save skips the replacement and does not join the old import', async (t) => {
  const f = fixture(t);
  const seller = await f.add('seller-a', true);
  const gate = f.blockImport();
  const first = f.service.refresh(seller.id);
  await gate.entered.promise;
  const save = f.service.changeConnection({
    accountId: seller.id,
    action: 'save',
    applicationId: 'seller-b',
    applicationSecret: 'fixture-only',
  });
  const later = f.service.refreshInventoryCatalogues(new Set([seller.id]));
  gate.released.resolve();
  await Promise.all([first, save]);
  assert.deepEqual(await later, [{ accountId: seller.id, name: seller.name, status: 'skipped' }]);
  assert.deepEqual(f.imports, ['seller-a', 'seller-a']);
  assert.equal(f.service.catalogVerified(seller.id), false);
});

test('queued refresh uses the seller binding established by an earlier refresh', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  const blocked = f.blockImport();
  const firstRefresh = f.service.refresh(account.id);
  await blocked.entered.promise;
  const replacement = f.service.changeConnection({
    accountId: account.id,
    action: 'save',
    applicationId: 'seller-b',
    applicationSecret: 'fixture-only',
  });
  const secondRefresh = assert.rejects(f.service.refresh(account.id), /different seller/);
  blocked.released.resolve();
  await Promise.all([firstRefresh, replacement, secondRefresh]);
  assert.equal(f.store.readMarketplace().accounts[0].sellerId, 'seller-a');
  assert.equal(f.listing(account.id).sellerId, 'seller-a');
  await assert.rejects(f.stock(account.id), /Refresh listings/);
  assert.deepEqual(f.writes, []);
});

test('legacy credential replacement waits for refresh and invalidates that verification afterward', async (t) => {
  const f = fixture(t);
  await f.legacy.save({ applicationId: 'seller-a', applicationSecret: 'fixture-only' });
  await f.service.accounts();
  const blocked = f.blockImport();
  const refresh = f.service.refresh('flipkart-primary');
  await blocked.entered.promise;
  const replacement = f.service.runLegacyCommand(() =>
    f.legacy.save({ applicationId: 'seller-b', applicationSecret: 'fixture-only' }),
  );
  blocked.released.resolve();
  await Promise.all([refresh, replacement]);
  const account = f.store.readMarketplace().accounts[0];
  assert.equal(account.sellerId, 'seller-a');
  assert.equal(account.lastRefreshedAt, null);
  await assert.rejects(f.stock(account.id), /Refresh listings/);
  assert.deepEqual(f.writes, []);
});

test('the legacy HTTP credential route invalidates marketplace freshness through the shared queue', async (t) => {
  const f = fixture(t);
  await f.legacy.save({ applicationId: 'seller-a', applicationSecret: 'fixture-only' });
  await f.service.accounts();
  await f.service.refresh('flipkart-primary');
  const app = createApp(f.inventory, undefined, undefined, f.legacy, f.service);
  t.after(() => close(app));
  const url = await listen(app);
  const response = await fetch(`${url}/api/flipkart/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
    body: JSON.stringify({ applicationId: 'seller-b', applicationSecret: 'fixture-only' }),
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(f.store.readMarketplace().accounts[0].lastRefreshedAt, null);
  await assert.rejects(f.stock('flipkart-primary'), /Refresh listings/);
  assert.deepEqual(f.writes, []);
});

test('queued stock and price editors cannot both submit the same listing version', async (t) => {
  const f = fixture(t);
  const account = await f.add();
  await f.service.refresh(account.id);
  const row = f.listing(account.id);
  const blocked = f.blockRead();
  const stock = f.stock(account.id);
  await blocked.entered.promise;
  const price = assert.rejects(
    f.service.apply({
      accountId: account.id,
      listingId: row.id,
      version: row.version,
      edit: { kind: 'price', field: 'sellingPrice', value: 3000 },
    }),
    /listing has changed/,
  );
  blocked.released.resolve();
  assert.equal((await stock).change.state, 'confirmed');
  await price;
  assert.deepEqual(f.writes, [{ token: 'seller-a', kind: 'stock' }]);
  assert.equal(f.listing(account.id).sellingPrice, 4000);
});
