import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  FlipkartBillingClient,
  type FlipkartBillingOrder,
} from '../../src/adapters/flipkart-billing.js';
import type { TallySalesBill } from '../../src/adapters/tally.js';
import { BillLookupService } from '../../src/server/bill-lookup.js';
import { saleDay } from '../../src/server/billing-matcher.js';
import { BillingService, type BillingSources } from '../../src/server/billing-service.js';
import { requireStockSource } from '../../src/server/proposals.js';
import { updateInventoryObservations } from '../../src/server/marketplace-catalog.js';
import { StockAvailabilityService } from '../../src/server/stock-availability.js';
import { TrackedBillingService } from '../../src/server/tracked-billing.js';
import {
  billingFulfilments,
  type BillingFulfilment,
  type BillLookup,
  type TrackedBillHistory,
} from '../../src/shared/billing-contracts.js';
import { marketplaceData } from '../support/marketplace-fixture.js';
import { serverFixture } from '../support/server-fixture.js';

function fixture(t: TestContext, initiallyMapped = true) {
  const { store, service } = serverFixture(t, 'live');
  const companyId = 'tally:local',
    accountId = 'seller';
  const now = new Date().toISOString();
  const setup = marketplaceData(accountId);
  store.updateMarketplace((market, state) => {
    market.accounts.push(...setup.accounts);
    market.listings.push(...setup.listings);
    state.accounts.push({
      id: accountId,
      name: 'Seller',
      marketplace: 'flipkart',
      status: 'not-connected',
    });
    state.companies.push({
      id: companyId,
      name: 'Books',
      source: 'tally',
      automation: false,
      lastSuccess: now,
    });
    state.items.push({
      id: 'tyre',
      companyId,
      externalId: 'external-tyre',
      name: 'Tyre',
      brand: '',
      unit: 'ea',
      physical: 10,
      version: 1,
      observedAt: now,
      lowStockThreshold: 1,
      keepBackUnits: 0,
    });
    state.listings.push({
      id: 'mapped',
      accountId,
      sku: 'TYRE-PAIR',
      title: 'Pair',
      location: 'warehouse-1',
      itemId: initiallyMapped ? 'tyre' : null,
      packSize: 2,
      packSource: 'manual',
      packEvidence: 'seller',
      sourceScope: 'company',
      verified: true,
      observed: 5,
      observedAt: now,
      policy: 'auto',
      remaining: null,
      paused: false,
      version: 1,
    });
  });
  store.updateBilling((data) =>
    data.rules.push({
      companyId,
      accountId,
      ledgerId: 'ledger',
      ledgerName: 'Ledger',
      field: 'reference',
      reference: 'orderId',
    }),
  );
  const calls: { group: BillingFulfilment; from: string; to: string }[] = [];
  const orders = new Map<BillingFulfilment, FlipkartBillingOrder[]>();
  const errors = new Set<BillingFulfilment>();
  const inaccessible = new Set<string>();
  const bills: TallySalesBill[] = [];
  const sources: BillingSources = {
    orders: {
      readOrders: async () => assert.fail('the short preview is not an expanded order source'),
      readStockOrders: async () => assert.fail('billing must not run a stock scan'),
      readFulfilmentOrders: async (token, from, to, group) => {
        calls.push({ group, from, to });
        if (token !== accountId) return [];
        if (errors.has(group)) throw new Error('incomplete');
        return structuredClone(orders.get(group) ?? []);
      },
    },
    tally: () => ({
      listLedgers: async () => [],
      readStock: async () => assert.fail('billing must not read stock'),
      readSalesBills: async () => structuredClone(bills),
    }),
  };
  const access = async (id: string) => {
    if (inaccessible.has(id)) throw new Error('seller unavailable');
    return { token: id, verify: () => {} };
  };
  const availability = new StockAvailabilityService(store, sources, access);
  availability.coverageCommand('/api/billing/coverage/start', {
    companyId,
    accountId,
    fromDate: saleDay(now),
    confirmed: true,
  });
  const billing = new BillingService(store, sources);
  const makeLookup = () =>
    new BillLookupService(
      store,
      availability,
      billing,
      new TrackedBillingService(store, sources, access),
    );
  let lookup = makeLookup();
  const command = (path: string, values: Record<string, unknown> = {}) =>
    lookup.command('/api/billing/' + path, { companyId, ...values }, accountId);
  const history = (values: Record<string, unknown> = {}) =>
    command('tracked-bills', values) as Promise<TrackedBillHistory>;
  const preview = () => {
    const previewSources: BillingSources = {
      orders: { ...sources.orders, readOrders: async () => orders.get('standard') ?? [] },
      tally: () => ({
        ...sources.tally(''),
        listLedgers: async () => [{ externalId: 'ledger', name: 'Ledger' }],
        readStock: async () => [],
      }),
    };
    return new BillingService(store, previewSources).command(
      '/api/billing/preview',
      {
        companyId,
        accountId,
        ledgerId: 'ledger',
        field: 'reference',
        reference: 'orderId',
        days: 7,
      },
      async () => accountId,
      () => {},
      availability,
      new TrackedBillingService(store, sources, access),
    );
  };
  const sale = (orderItemId: string, orderId = orderItemId): FlipkartBillingOrder => ({
    orderItemId,
    orderId,
    sku: 'TYRE-PAIR',
    quantity: 1,
    orderDate: now,
    invoiceNumber: null,
    listingId: setup.listings[0].id,
    locationId: 'warehouse-1',
  });
  const voucher = (number: string, reference: string): TallySalesBill => ({
    externalId: 'voucher-' + number,
    number,
    reference,
    narration: '',
    date: saleDay(now),
    lines: [{ itemExternalId: 'external-tyre', unit: 'ea', quantity: 2 }],
  });
  return {
    store,
    service,
    stockStatus: () =>
      availability.coverageCommand('/api/billing/coverage', { companyId, accountId }),
    companyId,
    accountId,
    sources,
    calls,
    orders,
    errors,
    inaccessible,
    bills,
    command,
    history,
    preview,
    reopenLookup: () => {
      lookup = makeLookup();
    },
    sale,
    voucher,
  };
}

test('a warehouse order can be mapped and billed while stock updates wait for their own confirmation', async (t) => {
  const f = fixture(t, false);
  const sale = f.sale('warehouse-sale');
  f.orders.set('fbf', [sale]);
  f.bills.push(f.voucher('SALE-77', sale.orderId));
  const history = await f.history();
  assert.deepEqual(history.orders[0].mapping, {
    listingId: sale.listingId,
    location: sale.locationId,
    purpose: 'billing',
  });
  const input = {
    listingId: 'mapped',
    itemId: 'tyre',
    confirmPackEvidence: true,
    packSize: 2,
    expectedUnit: 'ea',
    packSource: 'manual',
    sourceScope: null,
    keepPaused: true,
    tyreFloor: false,
    listingVersion: 1,
    orderSource: {
      accountId: f.accountId,
      companyId: f.companyId,
      locationId: sale.locationId,
      listingId: sale.listingId,
      orderItemId: sale.orderItemId,
    },
  };
  assert.throws(
    () => f.service.mapping({ ...input, sourceScope: 'company' }),
    /stock tracking setup/,
  );
  assert.throws(
    () =>
      f.service.mapping({ ...input, orderSource: { ...input.orderSource, orderItemId: 'absent' } }),
    /tracked sale/,
  );
  const state = await f.service.mapAndCalculate(input);
  const listing = state.listings.find((row) => row.id === 'mapped')!;
  assert.equal(listing.sourceScope, null);
  assert.equal(listing.paused, true);
  assert.ok(listing.packConfirmedAt);
  assert.equal(listing.skuMappingId, sale.listingId);
  assert.equal(state.proposals.length, 0);
  assert.equal((await f.history()).billed[0].bill.number, 'SALE-77');
  assert.deepEqual(f.store.readStockCoverage(f.companyId)?.orders, []);
  assert.throws(() => requireStockSource(state, listing), /Confirm the stock source/);
  assert.throws(
    () => requireStockSource({ ...state, mode: 'demo' }, listing),
    /Confirm the stock source/,
  );
  const refreshPackageCount = (count: number) => {
    f.store.updateMarketplace((market, inventory) => {
      const remote = market.listings[0];
      remote.packageCount = count;
      remote.observedAt = new Date().toISOString();
      updateInventoryObservations(inventory, remote);
    });
    return f.service.snapshot().listings.find((row) => row.id === listing.id)!;
  };
  const refreshed = refreshPackageCount(2);
  assert.equal(refreshed.skuMappingId, sale.listingId);
  assert.equal(refreshed.sourceScope, null);
  assert.equal(refreshed.packConfirmedAt, listing.packConfirmedAt);
  const editPack = {
    listingId: listing.id,
    itemId: 'tyre',
    confirmPackEvidence: true,
    expectedUnit: 'ea',
    sourceScope: null,
    keepPaused: true,
    tyreFloor: false,
  };
  f.service.mapping({
    ...editPack,
    packSource: 'packages',
    packSize: 2,
    listingVersion: refreshed.version,
  });
  const changedPackage = refreshPackageCount(3);
  assert.equal(changedPackage.verified, false);
  assert.equal((await f.history()).billed.length, 0);
  assert.equal(f.stockStatus().current, true);
  const corrected = f.service
    .mapping({
      ...editPack,
      packSource: 'manual',
      packSize: 2,
      listingVersion: changedPackage.version,
    })
    .listings.find((row) => row.id === listing.id)!;
  assert.equal(corrected.sourceScope, null);
  assert.equal(corrected.paused, true);
  assert.equal((await f.history()).billed[0].bill.number, 'SALE-77');
  assert.equal(f.stockStatus().current, true);
  const promoted = f.service
    .mapping({
      listingId: listing.id,
      itemId: 'tyre',
      confirmPackEvidence: true,
      packSize: 2,
      expectedUnit: 'ea',
      packSource: 'manual',
      sourceScope: 'company',
      tyreFloor: true,
      listingVersion: corrected.version,
    })
    .listings.find((row) => row.id === listing.id)!;
  assert.equal(promoted.sourceScope, 'company');
  assert.equal(promoted.paused, true);
  assert.equal(f.stockStatus().current, false);
  assert.match(f.stockStatus().issue ?? '', /Review starting stock/);
  assert.deepEqual(f.store.readStockCoverage(f.companyId)?.orders, []);
});

test('a seller-held order under current starting stock keeps the stock mapping choice', async (t) => {
  const f = fixture(t, false);
  const sale = f.sale('seller-sale');
  f.orders.set('standard', [sale]);
  assert.equal((await f.history()).orders[0].mapping?.purpose, 'stock');
  const mapped = f.service
    .mapping({
      listingId: 'mapped',
      itemId: 'tyre',
      confirmPackEvidence: true,
      packSize: 2,
      expectedUnit: 'ea',
      packSource: 'manual',
      sourceScope: 'company',
      tyreFloor: false,
      listingVersion: 1,
      orderSource: {
        accountId: f.accountId,
        companyId: f.companyId,
        locationId: sale.locationId,
        listingId: sale.listingId,
        orderItemId: sale.orderItemId,
      },
    })
    .listings.find((row) => row.id === 'mapped')!;
  assert.equal(mapped.paused, false);
  assert.equal(mapped.sourceScope, 'company');
  f.bills.push(f.voucher('SALE-19', sale.orderId));
  assert.equal((await f.history()).billed[0].bill.number, 'SALE-19');
});

test('a shipment survives Flipkart invoice access denial and only a verified invoice number can settle an invoice-based match', async (t) => {
  const f = fixture(t);
  const sale = f.sale('OD123-line', 'OD123');
  const bill = f.voucher('INV-47', sale.orderId);
  f.bills.push(bill);
  let invoiceResponse: 'denied' | 'pdf' | 'json' = 'denied';
  let invoiceRequests = 0;
  let includeShipment = true;
  const searches: string[] = [];
  f.sources.orders = new FlipkartBillingClient({
    request: async (url, init) => {
      if (String(url).endsWith('/invoices')) {
        invoiceRequests++;
        if (invoiceResponse === 'denied') return Response.json({}, { status: 403 });
        if (invoiceResponse === 'pdf')
          return new Response('sample invoice', { headers: { 'content-type': 'application/pdf' } });
        return Response.json({
          invoices: [
            {
              shipmentId: 'shipment-123',
              invoiceNumber: 'FK-77',
              orderItems: [{ orderItemId: sale.orderItemId }],
            },
          ],
        });
      }
      assert.ok(String(url).endsWith('/shipments/filter'));
      const { filter } = JSON.parse(String(init?.body));
      const scope = [filter.serviceProfiles[0], filter.shipmentTypes[0]].join('/');
      searches.push(scope);
      const shipments =
        includeShipment &&
        scope === 'NON_FBF/NORMAL' &&
        filter.type === 'preDispatch' &&
        filter.hold === false
          ? [
              {
                shipmentId: 'shipment-123',
                locationId: sale.locationId,
                shipmentType: 'NORMAL',
                hold: false,
                orderItems: [
                  {
                    ...sale,
                    status: 'PACKED',
                    is_replacement: false,
                    courierReturn: false,
                    serviceProfile: 'Seller_Fulfilment',
                  },
                ],
              },
            ]
          : [];
      return Response.json({ hasMore: false, shipments });
    },
  });

  const byOrder = await f.history();
  assert.equal(byOrder.check?.complete, true);
  assert.equal(byOrder.check.groups.find((g) => g.group === 'standard')?.count, 1);
  assert.deepEqual(
    byOrder.billed.map((row) => row.bill.number),
    ['INV-47'],
  );
  assert.equal(invoiceRequests, 0);

  bill.reference = 'FK-77';
  const inspection = (await f.command('find-bill', {
    orderItemId: sale.orderItemId,
    billNumber: bill.number,
  })) as BillLookup;
  assert.ok(invoiceRequests > 0);
  assert.ok(inspection.bills[0].issue, 'A manual override needs current competing references.');
  await assert.rejects(
    f.command('link-bill', {
      orderItemId: sale.orderItemId,
      billId: inspection.bills[0].id,
      reviewId: inspection.reviewId,
      acceptReferenceMismatch: true,
    }),
  );
  f.store.updateBilling((data) => {
    data.rules[0].reference = 'invoiceNumber';
  });
  const denied = await f.history();
  assert.ok(invoiceRequests > 0);
  assert.equal(denied.check?.complete, false);
  assert.equal(denied.check.groups.find((g) => g.group === 'standard')?.count, 1);
  assert.match(denied.check.groups.find((g) => g.group === 'standard')?.error ?? '', /invoice/i);
  assert.deepEqual(
    denied.orders.map((row) => row.orderItemId),
    [sale.orderItemId],
  );
  assert.equal(denied.orders[0].status, 'review');
  assert.deepEqual(denied.billed, []);

  invoiceResponse = 'pdf';
  const unreadable = await f.history({ retryGroup: 'standard', checkId: denied.check.id });
  assert.equal(unreadable.check?.complete, false);
  assert.equal(unreadable.check.groups.find((g) => g.group === 'standard')?.count, 1);
  assert.equal(unreadable.orders[0].status, 'review');
  assert.deepEqual(unreadable.billed, []);

  invoiceResponse = 'json';
  searches.length = 0;
  const recovered = await f.history({ retryGroup: 'standard', checkId: unreadable.check.id });
  assert.ok(searches.length > 0);
  assert.deepEqual(new Set(searches), new Set(['NON_FBF/NORMAL']));
  assert.equal(recovered.check?.complete, true);
  assert.equal(recovered.check.to, denied.check.to);
  assert.deepEqual(
    recovered.billed.map((row) => row.bill.number),
    ['INV-47'],
  );

  invoiceResponse = 'denied';
  const later = await f.history();
  assert.equal(later.orders[0].status, 'review');
  assert.deepEqual(later.billed, []);
  f.reopenLookup();
  includeShipment = false;
  const retained = await f.history();
  assert.equal(retained.orders[0].orderItemId, sale.orderItemId);
  assert.deepEqual(retained.billed, []);
});

test('partial fulfilment results retain verified bills, retry just the failed group and reconcile competing claims', async (t) => {
  const f = fixture(t);
  f.orders.set('standard', [f.sale('standard-line', 'shared-order')]);
  f.orders.set('fbf', [f.sale('warehouse-line')]);
  f.bills.push(f.voucher('TALLY-52', 'shared-order'));
  f.errors.add('express');
  const first = await f.history();
  assert.deepEqual(
    f.calls.map((call) => call.group),
    billingFulfilments,
  );
  assert.equal(first.check?.complete, false);
  assert.equal(first.check.groups.find((row) => row.group === 'express')?.count, null);
  assert.deepEqual(
    first.billed.map((row) => row.bill.number),
    ['TALLY-52'],
  );
  assert.equal(
    first.orders.find((row) => row.orderItemId === 'warehouse-line')?.status,
    'unmatched',
  );
  assert.deepEqual(f.store.readStockCoverage(f.companyId)?.orders, []);
  f.calls.length = 0;
  const partialSearch = (await f.command('find-bill', {
    orderItemId: 'warehouse-line',
    billNumber: 'TALLY-52',
  })) as BillLookup;
  assert.ok(partialSearch.bills[0].issue);
  f.calls.length = 0;
  f.errors.clear();
  f.orders.set('express', [f.sale('express-line', 'shared-order')]);
  const retry = await f.history({ retryGroup: 'express', checkId: first.check.id });
  assert.deepEqual(f.calls, [{ group: 'express', from: first.check.from, to: first.check.to }]);
  assert.equal(retry.check?.complete, true);
  assert.equal(retry.orders.length, 3);
  assert.deepEqual(retry.billed, []);
  assert.equal(retry.orders.find((row) => row.orderItemId === 'standard-line')?.status, 'review');
  await assert.rejects(
    f.history({ retryGroup: 'express', checkId: first.check.id }),
    /changed|expired/,
  );
  assert.deepEqual(f.store.readStockCoverage(f.companyId)?.orders, []);
});

test('a failed shipment retry replaces the earlier read for that fulfilment type only', async (t) => {
  const f = fixture(t);
  f.store.updateBilling((data) => {
    data.rules[0].reference = 'invoiceNumber';
  });
  const offline = { ...f.sale('standard-only'), invoiceNumber: 'FK-100' };
  const shared = { ...f.sale('also-express'), invoiceNumber: 'FK-200' };
  const pending = {
    ...f.sale('unverified-invoice'),
    quantity: 2,
    invoiceLookup: 'failed' as const,
  };
  f.orders.set('standard', [offline, shared, pending]);
  f.orders.set('express', [shared]);
  f.bills.push(f.voucher('TALLY-100', 'FK-100'), f.voucher('TALLY-200', 'FK-200'));
  const initial = await f.history();
  assert.equal(initial.billed.length, 2);
  assert.equal(initial.check?.complete, false);
  f.errors.add('standard');
  const outage = await f.history({ checkId: initial.check.id, retryGroup: 'standard' });
  assert.equal(outage.check?.groups.find((row) => row.group === 'standard')?.count, null);
  assert.deepEqual(
    outage.billed.map((row) => row.bill.number),
    ['TALLY-200'],
  );
  assert.equal(
    outage.orders.find((row) => row.orderItemId === offline.orderItemId)?.status,
    'review',
  );
  f.errors.clear();
  f.orders.set('standard', [offline, shared, { ...pending, invoiceLookup: 'no-number' }]);
  const restored = await f.history({ checkId: outage.check!.id, retryGroup: 'standard' });
  assert.equal(restored.check?.complete, true);
  assert.equal(restored.billed.length, 2);
});

test('a saved manual match waits for complete shipment and invoice evidence while an independent order-ID match stays billed', async (t) => {
  const f = fixture(t);
  const manual = f.sale('manual-line');
  const automatic = f.sale('automatic-line');
  f.orders.set('standard', [manual, automatic]);
  f.bills.push(f.voucher('MANUAL', 'mistyped-reference'), f.voucher('AUTO', automatic.orderId));
  const search = (await f.command('find-bill', {
    orderItemId: manual.orderItemId,
    billNumber: 'MANUAL',
  })) as BillLookup;
  assert.equal(search.bills[0].issue, null);
  await f.command('link-bill', {
    orderItemId: manual.orderItemId,
    billId: search.bills[0].id,
    reviewId: search.reviewId,
    acceptReferenceMismatch: true,
  });
  assert.equal((await f.history()).billed.length, 2);
  f.errors.add('smart');
  const incomplete = await f.history();
  assert.deepEqual(
    incomplete.billed.map((row) => row.bill.number),
    ['AUTO'],
  );
  const previouslyLinked = incomplete.orders.find((row) => row.orderItemId === manual.orderItemId)!;
  assert.equal(previouslyLinked.status, 'review');
  assert.equal(previouslyLinked.manualBillNumber, 'MANUAL');
  assert.match(previouslyLinked.reason, /retry/i);
  f.errors.clear();
  const complete = await f.history({ checkId: incomplete.check!.id, retryGroup: 'smart' });
  assert.equal(complete.billed.length, 2);
  f.orders.set('standard', [{ ...manual, invoiceLookup: 'failed' }, automatic]);
  const denied = await f.history();
  assert.equal(denied.check?.complete, false);
  assert.equal(denied.check.groups.find((g) => g.group === 'standard')?.count, 2);
  assert.deepEqual(
    denied.billed.map((r) => r.bill.number),
    ['AUTO'],
  );
  const pending = denied.orders.find((row) => row.orderItemId === manual.orderItemId)!;
  assert.equal(pending.status, 'review');
  assert.equal(pending.manualBillNumber, 'MANUAL');
  f.orders.set('standard', [{ ...manual, invoiceNumber: 'FK-MANUAL' }, automatic]);
  const retry = await f.history({ checkId: denied.check.id, retryGroup: 'standard' });
  assert.equal(retry.check?.complete, true);
  assert.equal(retry.billed.length, 2);
});

test('retained warehouse receipts survive a shorter read, manual bill links are verified and a failed source cannot present a saved match as current', async (t) => {
  const f = fixture(t);
  f.orders.set('fbf', [f.sale('warehouse-line', 'FK-112')]);
  f.bills.push(f.voucher('TALLY-65', 'FK-121'));
  const first = await f.history();
  assert.equal(first.orders[0].canFindBill, true);
  f.reopenLookup();
  f.orders.clear();
  const search = (await f.command('find-bill', {
    orderItemId: 'warehouse-line',
    billNumber: 'TALLY-65',
  })) as BillLookup;
  assert.equal(search.bills[0].referenceMismatch, true);
  await f.command('link-bill', {
    orderItemId: 'warehouse-line',
    billId: search.bills[0].id,
    reviewId: search.reviewId,
    acceptReferenceMismatch: true,
  });
  const matched = await f.history();
  assert.deepEqual(
    matched.billed.map((row) => [row.method, row.bill.number]),
    [['seller-confirmed', 'TALLY-65']],
  );
  f.errors.add('fbf');
  const partial = await f.history();
  assert.equal(partial.check?.complete, false);
  assert.equal(partial.orders[0].status, 'review');
  assert.deepEqual(partial.billed, []);
  assert.equal(partial.orders[0].manualBillNumber, 'TALLY-65');
  await f.command('release-bill', {
    orderItemId: 'warehouse-line',
    billId: search.bills[0].id,
    linkToken: partial.orders[0].linkToken,
  });
  assert.deepEqual(f.store.readBilling().links, []);
  assert.deepEqual(f.store.readStockCoverage(f.companyId)?.orders, []);
});

test('returns one sale across fulfilment groups and retains a changed identity for review', async (t) => {
  const f = fixture(t);
  const sale = f.sale('duplicate');
  f.orders.set('standard', [sale]);
  f.orders.set('smart', [sale]);
  f.bills.push(f.voucher('TALLY-101', sale.orderId));
  const first = await f.history();
  assert.equal(first.orders.length, 1);
  assert.equal(first.billed.length, 1);
  f.orders.clear();
  f.errors.add('smart');
  assert.equal((await f.history()).billed.length, 0);
  f.orders.set('standard', [sale]);
  assert.equal((await f.history()).billed.length, 1);
  f.errors.clear();
  f.orders.set('smart', [{ ...sale, quantity: 4 }]);
  const conflict = await f.history();
  assert.equal(conflict.orders.length, 1);
  assert.equal(conflict.orders[0].status, 'review');
  assert.equal(conflict.billed.length, 0);
  f.reopenLookup();
  f.orders.clear();
  assert.equal((await f.history()).orders[0].status, 'review');
});

test('conflicting invoice results across fulfilment types require a retry in either search order', async (t) => {
  for (const numberedGroup of ['standard', 'smart'] as const) {
    for (const invoiceLookup of ['no-number', 'unsupported-format'] as const) {
      const f = fixture(t);
      f.store.updateBilling((data) => {
        data.rules[0].reference = 'invoiceNumber';
      });
      const sale = { ...f.sale('shared-line'), invoiceNumber: 'FK-17' };
      const otherGroup = numberedGroup === 'smart' ? 'standard' : 'smart';
      f.bills.push(f.voucher('TALLY-17', sale.invoiceNumber));
      f.orders.set(numberedGroup, [sale]);
      f.orders.set(otherGroup, [{ ...sale, invoiceNumber: null, invoiceLookup }]);
      const disputed = await f.history();
      assert.deepEqual(disputed.billed, []);
      assert.equal(disputed.check?.complete, false);
      assert.equal(disputed.orders.length, 1);
      f.orders.set(otherGroup, [sale]);
      const resolved = await f.history({ checkId: disputed.check.id, retryGroup: otherGroup });
      assert.equal(resolved.billed[0]?.bill.number, 'TALLY-17');
    }
  }
});

test('invoice recovery for an order found in two fulfilment types survives a later read that omits it', async (t) => {
  const f = fixture(t);
  f.store.updateBilling((data) => {
    data.rules[0].reference = 'invoiceNumber';
  });
  const sale = { ...f.sale('same-line'), invoiceNumber: 'FK-908' };
  f.bills.push(f.voucher('TALLY-908', sale.invoiceNumber));
  f.orders.set('standard', [sale]);
  f.orders.set('smart', [sale]);
  assert.equal((await f.history()).billed.length, 1);

  const deniedSale: FlipkartBillingOrder = {
    ...sale,
    invoiceNumber: null,
    invoiceLookup: 'failed',
  };
  f.orders.set('standard', [deniedSale]);
  f.orders.set('smart', [deniedSale]);
  const denied = await f.history();
  assert.equal(denied.check?.complete, false);
  assert.deepEqual(denied.billed, []);
  f.orders.set('standard', [sale]);
  f.orders.delete('smart');
  f.calls.length = 0;
  const retry = await f.history({ checkId: denied.check.id, retryGroup: 'standard' });
  assert.deepEqual(
    f.calls.map(({ group }) => group),
    ['standard'],
  );
  assert.equal(retry.billed[0]?.bill.number, 'TALLY-908');

  f.orders.clear();
  f.reopenLookup();
  const retained = await f.history();
  assert.equal(retained.check?.complete, true);
  for (const group of ['standard', 'smart']) {
    assert.equal(retained.check.groups.find((g) => g.group === group)?.count, 1);
  }
  assert.deepEqual(
    retained.orders.map((row) => row.orderItemId),
    [sale.orderItemId],
  );
  assert.deepEqual(
    retained.billed.map((row) => row.bill.number),
    ['TALLY-908'],
  );
});

test('a changed bill rule invalidates the earlier partial check before requesting more orders', async (t) => {
  const f = fixture(t);
  f.errors.add('express');
  const first = await f.history();
  f.calls.length = 0;
  f.store.updateBilling((data) => {
    data.rules[0].field = 'narration';
  });
  await assert.rejects(
    f.history({ retryGroup: 'express', checkId: first.check?.id }),
    /changed|expired/,
  );
  assert.deepEqual(f.calls, []);
});

test('a missing warehouse location can be completed, but a different known location conflicts', async (t) => {
  const f = fixture(t);
  const sale = f.sale('warehouse-line');
  f.bills.push(f.voucher('TALLY-112', sale.orderId));
  f.orders.set('fbf', [{ ...sale, locationId: '', eligibilityUnverified: true }]);
  const incomplete = await f.history();
  assert.equal(incomplete.billed.length, 0);
  assert.match(incomplete.orders[0].reason, /location/);
  f.orders.set('fbf', [sale]);
  assert.equal((await f.history()).billed[0].bill.number, 'TALLY-112');
  f.orders.set('fbf', [{ ...sale, locationId: 'other' }]);
  assert.equal((await f.history()).orders[0].status, 'review');
  assert.deepEqual(f.store.readStockCoverage(f.companyId)?.orders, []);
});

test('a saved clean billing observation cannot erase a later uncertain stock receipt when Flipkart omits the sale', async (t) => {
  const f = fixture(t);
  const sale = f.sale('line');
  f.orders.set('standard', [sale]);
  f.bills.push(f.voucher('TALLY-32', sale.orderId));
  assert.equal((await f.history()).billed.length, 1);
  const stock = f.store.readStockCoverage(f.companyId)!;
  stock.orders.push({
    accountId: f.accountId,
    order: {
      ...sale,
      stockDisposition: 'uncertain',
      eligibilityUnverified: true,
    },
  });
  f.store.saveStockCoverage(stock);
  f.orders.clear();
  const current = await f.history();
  assert.equal(current.orders[0].status, 'review');
  assert.equal(current.billed.length, 0);
});

test('an inaccessible peer holds shared stock-item bill claims and preserves independent seller matches', async (t) => {
  const f = fixture(t);
  const peerId = 'peer';
  const peer = marketplaceData(peerId, 'other-seller');
  f.store.updateMarketplace((market, state) => {
    const remote = market.listings[0];
    const original = state.listings[0];
    market.accounts.push(...peer.accounts);
    market.listings.push(
      { ...peer.listings[0], id: 'peer-listing' },
      { ...remote, id: 'independent-remote', sku: 'OWN-TYRE' },
    );
    state.accounts.push({ ...state.accounts[0], id: peerId });
    state.items.push({ ...state.items[0], id: 'own-tyre', externalId: 'own-ref' });
    state.listings.push(
      { ...original, accountId: peerId, id: 'peer-mapped' },
      { ...original, id: 'own', sku: 'OWN-TYRE', itemId: 'own-tyre' },
    );
  });
  f.inaccessible.add(peerId);
  f.orders.set('standard', [
    f.sale('shared-line'),
    { ...f.sale('independent-line'), sku: 'OWN-TYRE', listingId: 'independent-remote' },
  ]);
  const ownBill = f.voucher('INDEPENDENT', 'independent-line');
  ownBill.lines[0].itemExternalId = 'own-ref';
  const sharedBill = f.voucher('SHARED', 'shared-line');
  f.bills.push(sharedBill, ownBill);
  const noRule = await f.history();
  assert.equal(noRule.check?.complete, true);
  assert.deepEqual(
    noRule.billed.map((r) => r.bill.number),
    ['INDEPENDENT'],
  );
  assert.match(
    noRule.orders.find((r) => r.orderItemId === 'shared-line')!.reason,
    /Confirm its bill matching rule/,
  );
  sharedBill.reference = 'misspelled';
  const search = (await f.command('find-bill', {
    orderItemId: 'shared-line',
    billNumber: 'SHARED',
  })) as BillLookup;
  assert.match(search.bills[0].issue ?? '', /Confirm its bill matching rule/);
  sharedBill.reference = 'shared-line';
  f.store.updateBilling((billing) =>
    billing.rules.push({ ...billing.rules[0], accountId: peerId, ledgerId: 'peer-ledger' }),
  );
  const first = await f.history();
  assert.equal(first.check?.complete, false);
  assert.deepEqual(
    first.billed.map((r) => r.bill.number),
    ['INDEPENDENT'],
  );
  assert.equal(first.orders.find((r) => r.orderItemId === 'shared-line')?.status, 'review');
  for (const group of first.check.groups) {
    assert.equal(group.count, group.group === 'standard' ? 2 : 0);
    assert.ok(group.error, 'A failed peer check must still offer a retry.');
  }
  f.inaccessible.clear();
  f.calls.length = 0;
  const partial = await f.history({ checkId: first.check.id, retryGroup: 'standard' });
  assert.deepEqual(
    f.calls.map((r) => r.group),
    ['standard'],
  );
  assert.equal(partial.check?.groups.find((r) => r.group === 'standard')?.count, 2);
  assert.equal(partial.check.groups.find((r) => r.group === 'standard')?.error, undefined);
  assert.ok(partial.check.groups.find((r) => r.group === 'express')?.error);
  assert.equal(partial.orders.find((r) => r.orderItemId === 'shared-line')?.status, 'review');
  const complete = await f.history();
  assert.equal(complete.check?.complete, true);
  assert.equal(complete.billed.length, 2);
  sharedBill.reference = 'misspelled';
  const reviewed = (await f.command('find-bill', {
    orderItemId: 'shared-line',
    billNumber: 'SHARED',
  })) as BillLookup;
  assert.equal(reviewed.bills[0].issue, null);
  await f.command('link-bill', {
    orderItemId: 'shared-line',
    billId: reviewed.bills[0].id,
    reviewId: reviewed.reviewId,
    acceptReferenceMismatch: true,
  });
  await f.preview();
  f.errors.add('express');
  await assert.rejects(f.preview(), /check is incomplete/);
  f.errors.clear();
  f.store.updateBilling((data) => {
    data.rules = data.rules.filter((rule) => rule.accountId !== peerId);
  });
  await assert.rejects(f.preview(), /Confirm its bill matching rule/);
});
