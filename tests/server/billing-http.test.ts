import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/server/http.js';
import { MarketplaceService } from '../../src/server/marketplace-service.js';
import { seedSampleMarketplace } from '../../src/server/marketplace-catalog.js';
import { InventoryService } from '../../src/server/service.js';
import { BillingService } from '../../src/server/billing-service.js';
import { saleDay } from '../../src/server/billing-matcher.js';
import { marketplaceData } from '../support/marketplace-fixture.js';
import type {
  BillLookup,
  BillingReport,
  BillingWorkspace,
  PendingListingCheck,
  PendingListings,
} from '../../src/shared/billing-contracts.js';
import { close, listen, serverFixture } from '../support/server-fixture.js';

test('finds a posted voucher for one preview order and verifies a reference exception without changing the seller rule', async (t) => {
  const f = serverFixture(t);
  const markets = new MarketplaceService(f.store, f.folder);
  const app = createApp(f.service, f.folder, undefined, undefined, markets);
  const address = await listen(app);
  t.after(async () => {
    await close(app);
    markets.stop();
    await markets.idle();
  });
  const scope = { companyId: 'demo-a', accountId: 'flipkart-primary' };
  const post = (action: string, input: Record<string, unknown>) =>
    fetch(address + '/api/billing/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: JSON.stringify({ ...scope, ...input }),
    });
  const settings = {
    ledgerId: 'sample-sales-demo-a',
    field: 'reference',
    reference: 'orderItemId',
    days: 7,
  };
  const preview = async () => {
    const response = await post('preview', settings);
    assert.equal(response.status, 200);
    return (await response.json()) as BillingReport;
  };
  const setup = await post('confirm', { previewId: (await preview()).previewId });
  assert.equal(setup.status, 200);
  const { report, rule } = (await setup.json()) as BillingWorkspace;
  const initialMarket = f.store.readMarketplace();
  const search = async (orderItemId: string) => {
    const response = await post('find-bill', {
      orderItemId,
      billNumber: 'SAMPLE-INV-1',
      previewId: report!.previewId,
    });
    assert.equal(response.status, 200);
    return (await response.json()) as BillLookup;
  };
  // Both orders use the same stock and quantity. The printed bill identifies the first sale.
  const wrong = await search('SAMPLE-LINE-2');
  assert.ok(wrong.bills[0]?.issue);
  const selected = await search('SAMPLE-LINE-1');
  assert.equal(selected.expectedReference, 'SAMPLE-LINE-1');
  const bill = selected.bills[0];
  assert.equal(bill.recordedReference, 'SAMPLE-ORDER-1');
  assert.equal(bill.referenceMismatch, true);
  assert.equal(bill.issue, null);
  const selection = {
    orderItemId: selected.orderItemId,
    billId: bill.id,
    reviewId: selected.reviewId,
  };
  assert.ok(
    (await post('link-bill', { ...selection, acceptReferenceMismatch: false })).status >= 400,
  );
  assert.deepEqual(f.store.readBilling().links, []);
  const reviewed = await search(selected.orderItemId);
  const saved = await post('link-bill', {
    ...selection,
    reviewId: reviewed.reviewId,
    acceptReferenceMismatch: true,
  });
  assert.equal(saved.status, 200);
  const after = await preview();
  assert.equal(after.rows[0].status, 'matched');
  assert.equal(after.rows[0].manualBillId, bill.id);
  assert.equal(after.rows[1].status, 'unmatched');
  assert.equal(after.stock[0].unmatchedUnits, 1);
  const undo = await post('unmatch', {
    previewId: after.previewId,
    orderItemId: selected.orderItemId,
  });
  assert.equal(undo.status, 200);
  const released = (await undo.json()) as BillingWorkspace;
  assert.equal(released.report!.stock[0].unmatchedUnits, 2);
  assert.deepEqual(released.rule, rule);
  assert.deepEqual(f.store.readMarketplace(), initialMarket);
});

test('seller selects a ledger, previews, confirms and corrects a bill without publishing stock', async (t) => {
  const f = serverFixture(t);
  const markets = new MarketplaceService(f.store, f.folder);
  const app = createApp(f.service, f.folder, undefined, undefined, markets);
  const address = await listen(app);
  t.after(async () => {
    await close(app);
    markets.stop();
    await markets.idle();
  });
  const scope = { companyId: 'demo-a', accountId: 'flipkart-primary' };
  const post = (action: string, data: Record<string, unknown> = {}) =>
    fetch(address + '/api/billing/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: JSON.stringify({ ...scope, ...data }),
    });
  assert.equal((await fetch(address + '/api/billing/confirm', { method: 'POST' })).status, 403);
  assert.equal((await post('ledgers', { accountId: 'nonexistent' })).status, 404);
  const market = f.store.readMarketplace();
  const inventory = f.store.read();
  const { ledgers } = (await (await post('ledgers')).json()) as {
    ledgers: { externalId: string }[];
  };
  const settings = {
    ledgerId: ledgers[0].externalId,
    field: 'manual',
    reference: 'orderId',
    days: 7,
  };
  const preview = (await (await post('preview', settings)).json()) as BillingReport;
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.stock[0].unmatchedUnits, 2);
  assert.equal(
    (
      await post('match', {
        previewId: preview.previewId,
        orderItemId: 'SAMPLE-LINE-1',
        billId: 'sample-bill-1',
      })
    ).status,
    409,
  );
  const confirmed = (await (
    await post('confirm', { previewId: preview.previewId })
  ).json()) as BillingWorkspace;
  assert.equal(confirmed.rule?.ledgerId, settings.ledgerId);
  f.service.calculate(scope.companyId, ['listing-2']);
  const savedDraft = () =>
    f.service.snapshot().proposals.find((draft) => draft.listingId === 'listing-2')!;
  assert.equal(savedDraft().stale, false);
  const linked = (await (
    await post('match', {
      previewId: confirmed.report!.previewId,
      orderItemId: 'SAMPLE-LINE-1',
      billId: 'sample-bill-1',
    })
  ).json()) as BillingWorkspace;
  const row = linked.report!.rows[0];
  assert.equal(row.status, 'matched');
  assert.equal(row.manualBillId, 'sample-bill-1');
  assert.equal(
    savedDraft().stale,
    true,
    'saving a manual bill link invalidates sibling calculations',
  );
  assert.equal(linked.report!.rows[1].candidates.length, 0);
  assert.equal(linked.report!.stock[0].unmatchedUnits, 1);
  assert.equal(
    (
      await post('match', {
        previewId: confirmed.report!.previewId,
        orderItemId: 'SAMPLE-LINE-2',
        billId: 'sample-bill-1',
      })
    ).status,
    409,
  );
  const other = (await (
    await post('workspace', { companyId: 'demo-b' })
  ).json()) as BillingWorkspace;
  assert.deepEqual(other, { rule: null, report: null });
  f.service.calculate(scope.companyId, ['listing-2']);
  assert.equal(savedDraft().stale, false);
  const released = (await (
    await post('unmatch', { previewId: linked.report!.previewId, orderItemId: row.orderItemId })
  ).json()) as BillingWorkspace;
  assert.equal(released.report!.stock[0].unmatchedUnits, 2);
  assert.equal(savedDraft().stale, true, 'unlinking the bill requires fresh reservation evidence');
  const automatic = (await (
    await post('preview', { ...settings, field: 'reference' })
  ).json()) as BillingReport;
  assert.equal(automatic.rows[0].status, 'matched');
  assert.equal(automatic.rows[1].status, 'unmatched');
  f.store.update((state) => {
    state.listings[0].verified = false;
  });
  assert.equal((await post('confirm', { previewId: automatic.previewId })).status, 409);
  assert.equal(f.store.readBilling().rules[0].field, 'manual');
  assert.deepEqual(f.store.readMarketplace(), market);
  assert.deepEqual(f.store.read().items, inventory.items);
});

test('the tracking preview uses the saved Indian date and rejects reports from an earlier cutoff', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T19:00:00Z') });
  const f = serverFixture(t);
  f.store.updateMarketplace(seedSampleMarketplace);
  const billing = new BillingService(f.store);
  const scope = { companyId: 'demo-a', accountId: 'flipkart-primary' };
  const rule = { ledgerId: 'sample-sales-demo-a', field: 'manual', reference: 'orderId' };
  const command = (action: string, data: Record<string, unknown> = {}) =>
    billing.command('/api/billing/' + action, { ...scope, ...data }, async () => null);
  const workspace = () => command('workspace') as Promise<BillingWorkspace>;
  const preview = (days: number | 'tracking') =>
    command('preview', { ...rule, days }) as Promise<BillingReport>;
  const setStart = (from: string) =>
    f.store.saveStockCoverage({
      companyId: scope.companyId,
      from,
      signature: 'setup',
      checkedThrough: null,
      orders: [],
    });
  const recent = '2026-11-22T18:30:00.000Z';
  setStart(recent);
  assert.deepEqual(await workspace(), { rule: null, report: null });
  await assert.rejects(preview('tracking'), /Set up bill matching/);
  const fixed = await preview(7);
  assert.equal(fixed.from, '2026-11-19T18:30:00.000Z');
  assert.equal(fixed.period, undefined);
  const confirmed = (await command('confirm', { previewId: fixed.previewId })) as BillingWorkspace;
  assert.equal(confirmed.trackingFrom, recent);

  const tracked = await preview('tracking');
  assert.equal(tracked.from, recent);
  assert.equal(tracked.period, 'tracking');
  assert.equal((await workspace()).report?.previewId, tracked.previewId);
  setStart('2026-09-30T18:30:00.000Z');
  assert.equal((await workspace()).report, null);
  await assert.rejects(
    command('confirm', { previewId: tracked.previewId }),
    /tracking period changed/,
  );
  const capped = await preview('tracking');
  assert.equal(capped.from, '2026-10-27T18:30:00.000Z');
  assert.equal((await workspace()).trackingFrom, '2026-09-30T18:30:00.000Z');
  const pending = command('match', {
    previewId: capped.previewId,
    orderItemId: 'SAMPLE-LINE-1',
    billId: 'sample-bill-1',
  });
  // Both older cutoffs produce the same effective 30-day period.
  setStart('2026-09-29T18:30:00.000Z');
  await assert.rejects(pending, /tracking period changed during the read/);
  assert.deepEqual(f.store.readBilling().links, []);
  const inFlight = preview('tracking');
  setStart(recent);
  await assert.rejects(inFlight, /tracking period changed during the read/);
  assert.equal((await workspace()).report, null);

  t.mock.timers.setTime(Date.parse('2026-11-26T18:29:00Z'));
  const previousDay = await preview('tracking');
  t.mock.timers.setTime(Date.parse('2026-11-26T18:30:01Z'));
  assert.equal((await workspace()).report, null);
  await assert.rejects(
    command('confirm', { previewId: previousDay.previewId }),
    /tracking period changed/,
  );
});

test('keep-back preview verifies sample orders and the next sync publishes both increases and decreases', async (t) => {
  const f = serverFixture(t);
  const markets = new MarketplaceService(f.store, f.folder);
  const inventory = new InventoryService(f.store, { marketplaces: markets });
  const app = createApp(inventory, f.folder, undefined, undefined, markets);
  const address = await listen(app);
  t.after(async () => {
    await close(app);
    markets.stop();
    await inventory.idle();
    await markets.idle();
  });
  const scope = { companyId: 'demo-a', accountId: 'flipkart-primary' };
  const itemId = 'item-a';
  const post = (action: string, data: Record<string, unknown>) =>
    fetch(address + '/api/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: JSON.stringify({ ...scope, ...data }),
    });
  const list = () => f.store.read().listings.find((row) => row.id === 'listing-2')!;
  const base = f.store.read().items.find((row) => row.id === itemId)!;
  assert.equal((await post('items/keep-back/preview', { itemId })).status, 409);
  const rule = await post('billing/preview', {
    ledgerId: 'sample-sales-demo-a',
    field: 'reference',
    reference: 'orderId',
    days: 7,
  });
  const { previewId } = (await rule.json()) as BillingReport;
  assert.equal((await post('billing/confirm', { previewId })).status, 200);
  assert.equal(
    (await post('billing/coverage/start', { fromDate: saleDay(base.observedAt!), confirmed: true }))
      .status,
    200,
  );
  f.store.update((state) => {
    state.companies.find((row) => row.id === scope.companyId)!.automation = true;
    state.listings.find((row) => row.id === 'listing-2')!.tyreFloor = false;
  });
  const coverage = f.store.readStockCoverage(scope.companyId);
  const preview = await post('items/keep-back/preview', { itemId });
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), {
    physical: 4,
    reservedUnits: 1,
    itemVersion: base.version,
  });
  assert.deepEqual(f.store.readStockCoverage(scope.companyId), coverage);
  assert.equal(
    (await post('items/keep-back', { itemId, itemVersion: base.version, keepBackUnits: 4 })).status,
    200,
  );
  assert.equal(list().observed, 5);
  assert.equal(f.store.readMarketplace().changes.length, 0);
  await inventory.refresh(scope.companyId);
  assert.equal(list().observed, 0);
  assert.equal(list().paused, false);
  assert.equal(list().syncPendingItemVersion, null);
  const version = f.store.read().items.find((row) => row.id === itemId)!.version;
  assert.equal(
    (await post('items/keep-back', { itemId, itemVersion: version, keepBackUnits: 0 })).status,
    200,
  );
  assert.equal(list().observed, 0);
  await inventory.refresh(scope.companyId);
  assert.equal(list().observed, 1);
  assert.equal(f.store.readStockCoverage(scope.companyId)?.from, coverage?.from);
});

test('live review reads the configured books and seller, and a ledger bill alone creates no order', async (t) => {
  const f = serverFixture(t, 'live');
  const scope = { companyId: 'tally:company-guid', accountId: 'seller' };
  const now = new Date(Date.now() - 60_000).toISOString();
  const market = marketplaceData(scope.accountId);
  f.store.updateMarketplace((data, state) => {
    Object.assign(data, { ...market, changes: [] });
    state.accounts.push({
      id: scope.accountId,
      marketplace: 'flipkart',
      name: 'Seller',
      status: 'not-connected',
    });
    state.companies.push({
      id: scope.companyId,
      name: 'Books',
      source: 'tally',
      lastSuccess: null,
      automation: false,
    });
    state.items.push({
      id: 'local-item',
      companyId: scope.companyId,
      externalId: 'tally-item',
      name: 'Tyre',
      unit: 'ea',
      brand: '',
      physical: 99,
      observedAt: null,
      version: 1,
      lowStockThreshold: 1,
      keepBackUnits: 0,
    });
    state.listings.push({
      id: 'destination',
      accountId: scope.accountId,
      sku: 'TYRE-PAIR',
      title: 'Pair',
      location: 'warehouse-1',
      itemId: 'local-item',
      packSize: 2,
      packSource: 'manual',
      packEvidence: 'seller',
      verified: true,
      observed: 5,
      observedAt: now,
      policy: 'auto',
      remaining: null,
      paused: false,
      version: 1,
    });
  });
  let hasOrder = false;
  let hasBill = true;
  const service = new BillingService(f.store, {
    tally: () => ({
      async listLedgers(company) {
        assert.equal(company.externalId, 'company-guid');
        return [{ externalId: 'ledger-guid', name: 'My online sales' }];
      },
      async readSalesBills(company, ledger) {
        assert.equal(company.name, 'Books');
        assert.equal(ledger, 'ledger-guid');
        return hasBill
          ? [
              {
                externalId: 'voucher',
                number: 'B1',
                reference: 'O1',
                narration: 'Private customer details',
                date: saleDay(now),
                lines: [{ itemExternalId: 'tally-item', unit: 'ea', quantity: 2 }],
              },
            ]
          : [];
      },
      async readStock() {
        return [{ externalId: 'tally-item', name: 'Tyre', unit: 'ea', physical: 6 }];
      },
    }),
    orders: {
      async readOrders(token, from, to, invoices) {
        assert.equal(token, 'test-token');
        assert.ok(from <= now && to >= now);
        assert.equal(invoices, false);
        return hasOrder
          ? [
              {
                orderId: 'O1',
                orderItemId: 'I1',
                invoiceNumber: null,
                listingId: 'remote-listing',
                sku: 'TYRE-PAIR',
                locationId: 'warehouse-1',
                orderDate: now,
                quantity: 1,
              },
            ]
          : [];
      },
    },
  });
  const preview = () =>
    service.command(
      '/api/billing/preview',
      { ...scope, ledgerId: 'ledger-guid', field: 'reference', reference: 'orderId', days: 30 },
      async () => 'test-token',
    ) as Promise<BillingReport>;
  const empty = await preview();
  assert.deepEqual(empty.rows, []);
  hasOrder = true;
  const matched = await preview();
  assert.equal(matched.rows[0].status, 'matched');
  assert.equal(matched.stock[0].physical, 6);
  assert.ok(!JSON.stringify(matched).includes('Private customer details'));
  hasBill = false;
  await assert.rejects(
    service.command(
      '/api/billing/confirm',
      { ...scope, previewId: matched.previewId },
      async () => 'test-token',
    ),
    /changed/,
  );
  assert.deepEqual(f.store.readBilling().rules, []);
  const unbilled = await preview();
  assert.equal(unbilled.stock[0].previewAvailable, 4);
  assert.equal(f.store.read().items[0].physical, 99);
});

test('Order matching finds tracked listings outside the preview and rechecks the saved orders after mapping with sync off', async (t) => {
  const f = serverFixture(t);
  const markets = new MarketplaceService(f.store, f.folder);
  const app = createApp(f.service, f.folder, undefined, undefined, markets);
  const address = await listen(app);
  t.after(async () => {
    await close(app);
    markets.stop();
    await markets.idle();
  });
  const scope = { companyId: 'demo-a', accountId: 'flipkart-primary' };
  const post = (action: string, data: Record<string, unknown> = {}) =>
    fetch(address + '/api/billing/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: JSON.stringify({ ...scope, ...data }),
    });
  const earlier = new Date(Date.now() - 12 * 86_400_000).toISOString();
  f.store.update((state) => {
    state.companies.find((row) => row.id === scope.companyId)!.automation = false;
    state.listings.find((row) => row.id === 'listing-1')!.itemId = null;
    state.items.find((row) => row.id === 'item-a')!.observedAt = earlier;
  });
  const rule = {
    ledgerId: 'sample-sales-demo-a',
    field: 'reference',
    reference: 'orderId',
    days: 7,
  };
  const preview = (await (await post('preview', rule)).json()) as BillingReport;
  assert.deepEqual(preview.rows, []);
  assert.equal((await post('confirm', { previewId: preview.previewId })).status, 200);
  assert.deepEqual(await (await post('pending')).json(), { trackingStarted: false, listings: [] });
  const fromDate = saleDay(earlier);
  assert.equal((await post('coverage/start', { fromDate, confirmed: true })).status, 200);
  assert.deepEqual(await (await post('pending', { savedOnly: true })).json(), {
    trackingStarted: true,
    listings: [],
  });
  const { listings, checkedThrough } = (await (await post('pending')).json()) as PendingListings;
  assert.ok(checkedThrough);
  assert.equal(checkedThrough, f.store.readStockCoverage(scope.companyId)!.checkedThrough);
  assert.deepEqual(listings, [
    {
      listingId: 'sample-listing-1',
      sku: 'SAMPLE-CEAT-1-1',
      location: 'Sample warehouse',
      mapped: false,
      orderItemIds: ['SAMPLE-LINE-1', 'SAMPLE-LINE-2'],
    },
  ]);
  const [group] = listings;
  assert.deepEqual(await (await post('pending', { savedOnly: true })).json(), {
    trackingStarted: true,
    listings,
    checkedThrough,
  });
  assert.equal((await post('pending/recheck', { ...group, location: 'Other' })).status, 409);
  assert.equal(
    (await post('pending/recheck', { ...group, orderItemIds: ['another-sale'] })).status,
    409,
  );
  assert.deepEqual(await (await post('pending', { companyId: 'demo-b' })).json(), {
    trackingStarted: false,
    listings: [],
  });
  f.service.mapping({
    listingId: 'listing-1',
    listingVersion: f.store.read().listings.find((r) => r.id === 'listing-1')!.version,
    itemId: 'item-a',
    packSource: 'manual',
    packSize: 1,
    sourceScope: 'company',
    tyreFloor: false,
    confirmPackEvidence: true,
    keepPaused: true,
  });
  const check = await post('pending/recheck', { ...group });
  assert.equal(check.status, 200);
  const { rows } = (await check.json()) as PendingListingCheck;
  assert.deepEqual(
    rows.map(({ orderItemId, status, baseUnits }) => [orderItemId, status, baseUnits]),
    [
      ['SAMPLE-LINE-1', 'matched', 1],
      ['SAMPLE-LINE-2', 'reserved', 1],
    ],
  );
  assert.equal(f.store.read().listings.find((r) => r.id === 'listing-1')!.paused, true);
  assert.equal(f.store.readMarketplace().changes.length, 0);
  assert.equal(saleDay(f.store.readStockCoverage(scope.companyId)!.from), fromDate);
});
