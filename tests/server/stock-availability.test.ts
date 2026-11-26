import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { FlipkartBillingOrder } from '../../src/adapters/flipkart-billing.js';
import type { TallySalesBill, TallyStockItem } from '../../src/adapters/tally.js';
import { BillingService } from '../../src/server/billing-service.js';
import { BillLookupService } from '../../src/server/bill-lookup.js';
import type { BillLookup, TrackedBillHistory } from '../../src/shared/billing-contracts.js';
import { saleDay } from '../../src/server/billing-matcher.js';
import { StockAvailabilityService } from '../../src/server/stock-availability.js';
import { desiredStock } from '../../src/server/proposals.js';
import { marketplaceData } from '../support/marketplace-fixture.js';
import { serverFixture } from '../support/server-fixture.js';

function setup(t: TestContext, sellerPacks = [1]) {
  const f = serverFixture(t, 'live');
  const companyId = 'tally:books';
  const itemId = 'local-tyre';
  const now = new Date().toISOString();
  const yesterday = saleDay(new Date(Date.now() - 86_400_000).toISOString());
  const orders = new Map<string, FlipkartBillingOrder[]>();
  const bills = new Map<string, TallySalesBill[]>();
  let physical = 6;
  const dates: (string | undefined)[] = [];
  const source = {
    unavailable: '',
    unavailableLedger: '',
    revoked: '',
    dates,
    stockRead: () => physical,
  };
  const otherStock: TallyStockItem[] = [];
  f.store.updateMarketplace((market, state) => {
    state.companies.push({
      id: companyId,
      name: 'Books',
      source: 'tally',
      lastSuccess: now,
      automation: true,
    });
    state.items.push({
      id: itemId,
      companyId,
      externalId: 'tyre',
      name: 'Tyre',
      brand: '',
      unit: 'ea',
      physical,
      version: 1,
      observedAt: now,
      lowStockThreshold: 1,
      keepBackUnits: 0,
    });
    sellerPacks.forEach((packSize, index) => {
      const id = 'seller-' + index;
      const data = marketplaceData(id, 'bound-' + id);
      data.listings[0].id += index;
      market.accounts.push(...data.accounts);
      market.listings.push(...data.listings);
      state.accounts.push({ id, name: id, marketplace: 'flipkart', status: 'not-connected' });
      state.listings.push({
        id: 'map-' + index,
        accountId: id,
        sku: 'TYRE-PAIR',
        title: 'Tyres',
        location: 'warehouse-1',
        itemId,
        packSize,
        packSource: 'manual',
        packEvidence: 'seller',
        sourceScope: 'company',
        verified: true,
        observed: 3,
        observedAt: now,
        policy: 'auto',
        remaining: null,
        paused: false,
        version: 1,
      });
      orders.set(id, [
        {
          orderItemId: 'line',
          orderId: 'purchase-' + index,
          invoiceNumber: null,
          listingId: data.listings[0].id,
          sku: 'TYRE-PAIR',
          locationId: 'warehouse-1',
          orderDate: now,
          quantity: 1,
        },
      ]);
    });
  });
  f.store.updateBilling((data) => {
    for (const accountId of orders.keys())
      data.rules.push({
        companyId,
        accountId,
        ledgerId: accountId,
        ledgerName: accountId,
        field: 'reference',
        reference: 'orderId',
      });
  });
  const makeService = () =>
    new StockAvailabilityService(
      f.store,
      {
        orders: {
          async readOrders() {
            throw new Error('Preview is not a stock source');
          },
          async readStockOrders(token, from, to, includeInvoices) {
            if (source.unavailable === token) throw new Error('Offline');
            return structuredClone(
              orders
                .get(token)!
                .filter((o) => o.orderDate >= from && o.orderDate <= to)
                .map((o) => ({ ...o, invoiceNumber: includeInvoices ? o.invoiceNumber : null })),
            );
          },
        },
        tally: () => ({
          async listLedgers() {
            return [];
          },
          async readStock(_company, asOf) {
            dates.push(asOf);
            return [
              { externalId: 'tyre', name: 'Tyre', unit: 'ea', physical: source.stockRead() },
              ...otherStock,
            ];
          },
          async readSalesBills(_company, ledger) {
            if (source.unavailableLedger === ledger) throw new Error('Ledger offline');
            return structuredClone(bills.get(ledger) ?? []);
          },
        }),
      },
      async (id) => ({
        token: id,
        verify: () => {
          if (source.revoked === id) throw new Error('Seller access changed');
        },
      }),
    );
  let service = makeService();
  const lookup = new BillLookupService(f.store, service, new BillingService(f.store));
  const confirm = (date = yesterday) =>
    service.coverageCommand('/api/billing/coverage/start', {
      companyId,
      accountId: 'seller-0',
      fromDate: date,
      confirmed: true,
    });
  return {
    f,
    orders,
    bills,
    source,
    otherStock,
    companyId,
    itemId,
    confirm,
    billCommand: (action: string, input: Record<string, unknown> = {}, seller = 'seller-0') =>
      lookup.command('/api/billing/' + action, { companyId, ...input }, seller),
    available: (batch?: object, target = itemId) => service.forItem(companyId, target, batch),
    preview: () => service.forItem(companyId, itemId, undefined, true),
    review: () => service.reviewOrders(companyId, 'seller-0'),
    pendingGroups: (accountId = 'seller-0') =>
      new BillingService(f.store).pendingOrders(
        service,
        { companyId, savedOnly: true },
        accountId,
        false,
      ),
    pending: () => service.pendingHistory(companyId, 'seller-0').orders,
    listingCheck: (input: Record<string, unknown>, recheck: boolean) =>
      new BillingService(f.store).pendingOrders(
        service,
        { companyId, ...input },
        'seller-0',
        recheck,
      ),
    refreshHistory: (accountId?: string) => service.refreshPendingOrders(companyId, accountId),
    scan: () => service.checkOrders(companyId, {}),
    restoreService() {
      f.reopen();
      service = makeService();
    },
    setStock(n: number) {
      physical = n;
      f.store.update((s) => {
        s.items[0].physical = n;
        s.items[0].version++;
      });
    },
    bill(index = 0, id = 'voucher'): TallySalesBill {
      return {
        externalId: id,
        number: 'B1',
        date: saleDay(now),
        reference: 'purchase-' + index,
        narration: '',
        lines: [{ itemExternalId: 'tyre', unit: 'ea', quantity: sellerPacks[index] }],
      };
    },
  };
}

test('an older mapped sale can be looked up, linked across previews, revalidated and released', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T08:00:00Z') });
  const s = setup(t);
  s.confirm();
  await s.available();
  const order = s.orders.get('seller-0')![0];
  const bill = { ...s.bill(), reference: 'purchase-typo' };
  s.orders.set('seller-0', []);
  t.mock.timers.setTime(Date.parse('2026-08-25T08:00:00Z'));
  await s.refreshHistory();
  t.mock.timers.setTime(Date.parse('2026-09-08T08:00:00Z'));
  s.bills.set('seller-0', [bill]);
  const history = () => s.billCommand('tracked-bills') as Promise<TrackedBillHistory>;
  const tracked = async () => (await history()).orders[0];
  const search = async () =>
    s.billCommand('find-bill', {
      orderItemId: order.orderItemId,
      billNumber: bill.number,
    }) as Promise<BillLookup>;
  const confirm = (review: BillLookup, acceptReferenceMismatch: boolean) =>
    s.billCommand('link-bill', {
      orderItemId: order.orderItemId,
      billId: bill.externalId,
      reviewId: review.reviewId,
      acceptReferenceMismatch,
    });
  const release = (linkToken: string, seller?: string) =>
    s.billCommand(
      'release-bill',
      {
        orderItemId: order.orderItemId,
        billId: bill.externalId,
        linkToken,
      },
      seller,
    );
  const coverage = s.f.store.readStockCoverage(s.companyId);
  const original = s.f.store.read();
  assert.equal((await tracked()).status, 'reserved');
  assert.deepEqual((await history()).billed, []);
  const first = await search();
  assert.deepEqual(first.bills[0], {
    id: bill.externalId,
    number: bill.number,
    date: bill.date,
    recordedReference: bill.reference,
    lines: [{ itemName: 'Tyre', unit: 'ea', quantity: 1 }],
    referenceMismatch: true,
    issue: null,
  });
  assert.equal(first.expectedReference, order.orderId);
  await assert.rejects(confirm(first, false), /Confirm the different/);
  s.bills.set('seller-0', [{ ...bill, narration: 'changed between requests' }]);
  await assert.rejects(confirm(first, true), /changed/);
  assert.equal(s.f.store.readBilling().links.length, 0);
  await confirm(await search(), true);
  const linked = await tracked();
  assert.equal(linked.status, 'matched');
  assert.equal(linked.manualBillId, bill.externalId);
  assert.equal(linked.manualBillNumber, bill.number);
  assert.equal(linked.manualBillDate, bill.date);
  assert.ok(linked.linkToken);
  assert.deepEqual((await history()).billed, [
    {
      orderId: order.orderId,
      orderItemId: order.orderItemId,
      orderDate: order.orderDate,
      sku: order.sku,
      bill: { id: bill.externalId, number: bill.number, date: bill.date },
      method: 'seller-confirmed',
    },
  ]);
  assert.deepEqual(s.f.store.readStockCoverage(s.companyId), coverage);
  assert.deepEqual(s.f.store.read(), original);
  assert.equal((await s.available()).reservedUnits, 0);
  await assert.rejects(release(linked.linkToken, 'seller-1'), /match changed/);
  s.bills.set('seller-0', []);
  assert.equal((await tracked()).status, 'review');
  assert.deepEqual((await history()).billed, []);
  await assert.rejects(s.available(), /confirmation needs review/);
  await release(linked.linkToken);
  assert.equal((await tracked()).status, 'reserved');
  s.bills.set('seller-0', [{ ...bill, narration: 'changed between requests' }]);
  await confirm(await search(), true);
  await assert.rejects(release(linked.linkToken), /match changed/);
});

test('Billed verifies retained automatic matches per seller and per order item beyond 30 days', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T08:00:00Z') });
  const s = setup(t, [1, 1]);
  s.f.store.updateBilling((data) => {
    for (const rule of data.rules) rule.reference = 'orderItemId';
  });
  const sale = s.orders.get('seller-0')![0];
  s.orders.get('seller-0')!.push({ ...sale, orderItemId: 'unbilled-sibling' });
  const first = { ...s.bill(0, 'voucher-a'), number: 'FK/1001', reference: sale.orderItemId };
  const second = { ...s.bill(1, 'voucher-b'), number: 'FK/1002', reference: sale.orderItemId };
  s.bills.set('seller-0', [first]);
  s.bills.set('seller-1', [second]);
  const history = (seller = 'seller-0') =>
    s.billCommand('tracked-bills', {}, seller) as Promise<TrackedBillHistory>;
  assert.deepEqual(await history(), { orders: [], billed: [] });
  s.confirm();
  await s.refreshHistory();
  s.orders.clear();
  s.orders.set('seller-0', []);
  s.orders.set('seller-1', []);
  t.mock.timers.setTime(Date.parse('2026-08-22T08:00:00Z'));
  await s.refreshHistory();
  t.mock.timers.setTime(Date.parse('2026-09-08T08:00:00Z'));
  const saved = s.f.store.readStockCoverage(s.companyId);
  const selected = await history();
  assert.deepEqual(selected.billed, [
    {
      orderItemId: sale.orderItemId,
      orderId: sale.orderId,
      orderDate: sale.orderDate,
      sku: sale.sku,
      bill: { id: first.externalId, number: first.number, date: first.date },
      method: 'automatic',
    },
  ]);
  assert.deepEqual(
    selected.orders.map((o) => o.orderItemId),
    ['unbilled-sibling'],
  );
  assert.deepEqual(
    (await history('seller-1')).billed.map((row) => row.bill.number),
    [second.number],
  );
  assert.deepEqual(s.f.store.readStockCoverage(s.companyId), saved);
  // Each seller's own match can initially look exact, but a competing claim
  // on the same voucher/item downgrades both when the company reconciles them.
  s.bills.set('seller-1', [first]);
  assert.deepEqual((await history()).billed, []);
  assert.deepEqual((await history('seller-1')).billed, []);
  s.bills.set('seller-1', [second]);
  s.bills.set('seller-0', [{ ...first, lines: [{ ...first.lines[0], quantity: 2 }] }]);
  assert.deepEqual((await history()).billed, []);
});

test('voucher assignment checks competing sellers, new evidence, and expiry before saving', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-01T08:00:00Z') });
  const s = setup(t, [1, 1]);
  s.confirm();
  const bill = { ...s.bill(), reference: 'mistyped' };
  const other = s.orders.get('seller-1')![0];
  const search = async () =>
    s.billCommand('find-bill', {
      orderItemId: 'line',
      billNumber: bill.number,
    }) as Promise<BillLookup>;
  const confirm = (review: BillLookup) =>
    s.billCommand('link-bill', {
      orderItemId: 'line',
      billId: bill.externalId,
      reviewId: review.reviewId,
      acceptReferenceMismatch: true,
    });
  s.bills.set('seller-0', [bill]);
  s.source.unavailable = 'seller-1';
  await assert.rejects(search(), /could not verify/i);
  s.source.unavailable = '';
  const review = await search();
  s.bills.set('seller-0', [{ ...bill, narration: 'Order ' + other.orderId }]);
  await assert.rejects(confirm(review), /changed/);
  assert.match((await search()).bills[0].issue ?? '', /another known order/);
  s.bills.set('seller-0', [bill]);
  const expires = await search();
  t.mock.timers.tick(600_001);
  await assert.rejects(confirm(expires), /expired/);
  assert.equal(s.f.store.readBilling().links.length, 0);
  await confirm(await search());
  assert.equal((await s.available()).reservedUnits, 1);
  other.invoiceNumber = bill.reference;
  await assert.rejects(s.available(), /review/);
  assert.equal(
    s.f.store.readStockCoverage(s.companyId)!.orders.find((e) => e.accountId === 'seller-1')!.order
      .invoiceNumber,
    bill.reference,
  );
  other.invoiceNumber = null;
  await assert.rejects(s.available(), /review/);
});

test('a restock can publish five and the matching Tally sale leaves five available', async (t) => {
  const s = setup(t);
  await assert.rejects(s.available(), /Order matching, choose Set starting stock/);
  s.confirm();
  s.setStock(4);
  assert.equal((await s.available()).available, 3);
  s.setStock(6);
  const restocked = await s.available();
  assert.equal(restocked.available, 5);
  s.setStock(5);
  assert.throws(restocked.verify, /changed/);
  s.bills.set('seller-0', [s.bill()]);
  assert.equal((await s.available()).available, 5);
  // A shop bill with the same quantity and a different reference never releases this sale.
  s.bills.set('seller-0', [{ ...s.bill(), reference: 'SHOP-1' }]);
  assert.equal((await s.available()).available, 4);
});

test('order checks keep calculated proposals current across sellers with sync off and paused listings', async (t) => {
  const s = setup(t, [1, 2, 1, 1]);
  const first = s.orders.get('seller-0')![0];
  const second = { ...first, orderItemId: 'second', orderId: 'second-order' };
  for (const id of s.orders.keys()) s.orders.set(id, []);
  s.confirm();
  s.f.store.update((state) => {
    state.connection.tally = 'online';
    state.companies.find((c) => c.id === s.companyId)!.automation = false;
    state.listings[1].paused = true;
  });
  s.f.service.calculate(s.companyId, ['map-0', 'map-1']);
  s.f.service.edit(s.companyId, 'map-2', 4);
  const originalEdit = s.f.store.read().proposals.find((row) => row.listingId === 'map-2');
  const calculated = () => {
    const state = s.f.store.read();
    assert.deepEqual(
      state.proposals.find((row) => row.listingId === 'map-2'),
      originalEdit,
    );
    assert.ok(!state.proposals.some((row) => row.listingId === 'map-3'));
    assert.ok(state.listings.every((row) => !row.orderSyncPending && !row.syncPendingItemVersion));
    assert.equal(state.listings[1].paused, true);
    return ['map-0', 'map-1'].map((id) => state.proposals.find((row) => row.listingId === id));
  };
  const quantities = () => calculated().map((row) => row?.quantity);
  assert.deepEqual(quantities(), [6, 3]);
  s.orders.set('seller-0', [first]);
  const baseline = s.f.store.readStockCoverage(s.companyId);
  assert.equal((await s.preview()).available, 5);
  assert.deepEqual(s.f.store.readStockCoverage(s.companyId), baseline);
  assert.deepEqual(quantities(), [6, 3]);
  await s.scan();
  assert.deepEqual(quantities(), [5, 2]);
  const stable = calculated();
  const writes = t.mock.method(s.f.store, 'update');
  await s.scan();
  assert.deepEqual(calculated(), stable, 'identical evidence preserves the reviewed calculations');
  assert.equal(writes.mock.callCount(), 0, 'unchanged calculations require no snapshot write');
  writes.mock.restore();
  s.orders.set('seller-0', [first, second]);
  await s.scan();
  assert.deepEqual(quantities(), [4, 2]);
  s.orders.set('seller-0', [{ ...second, stockDisposition: 'cancelled' }]);
  await s.scan();
  assert.deepEqual(quantities(), [5, 2], 'a verified cancellation releases only its units');
  s.bills.set('seller-0', [s.bill()]);
  await s.scan();
  assert.deepEqual(quantities(), [6, 3], 'a newly matched bill releases the remaining reservation');
  assert.equal(s.f.store.read().items[0].version, 1);
  s.source.unavailable = 'seller-0';
  await assert.rejects(s.scan(), /Could not verify/);
  assert.deepEqual(quantities(), [6, 3]);
  assert.ok(calculated().every((draft) => draft?.stale));
  assert.match(s.f.store.read().listings[1].proposalIssue ?? '', /Could not verify/);
  s.source.unavailable = '';
  s.bills.set('seller-0', []);
  s.restoreService();
  s.f.store.update((state) => {
    state.connection.tally = 'online';
    delete state.companies.find((company) => company.id === s.companyId)!.stockIssue;
  });
  await s.scan();
  assert.deepEqual(quantities(), [5, 2], 'saved receipts remain available after restart');
});

test('sum pack units across accounts even when both sellers use the same order-item ID', async (t) => {
  const s = setup(t, [1, 2]);
  s.confirm();
  const checked = await s.available();
  assert.equal(checked.available, 3);
  s.source.revoked = 'seller-1';
  assert.throws(checked.verify, /access/);
  s.source.revoked = '';
  s.orders.set('seller-0', []);
  s.orders.set('seller-1', []);
  s.restoreService();
  assert.equal((await s.available()).available, 3);
  s.bills.set('seller-1', [s.bill(1)]);
  assert.equal((await s.available()).available, 5);
});

test('one item keep-back precedes pack size, the tyre minimum and the allowance across sellers', async (t) => {
  const s = setup(t, [1, 2]);
  s.orders.set('seller-1', []);
  s.confirm();
  s.setStock(8);
  s.f.store.update((state) => {
    state.connection.tally = 'online';
    state.items[0].keepBackUnits = 2;
    state.items[0].version++;
    state.listings[1].tyreFloor = false;
  });
  const state = s.f.store.read();
  const [single, pair] = state.listings;
  const checked = await s.available();
  assert.deepEqual([checked.physical, checked.reservedUnits, checked.available], [8, 1, 5]);
  assert.equal(
    desiredStock(state, single),
    6,
    'the local estimate uses keep-back before verified orders',
  );
  assert.equal(desiredStock(state, single, 'current', checked.available), 5);
  assert.equal(desiredStock(state, pair, 'current', checked.available), 2);
  assert.equal(desiredStock(state, { ...pair, tyreFloor: true }, 'current', checked.available), 5);
  assert.equal(
    desiredStock(
      state,
      { ...pair, tyreFloor: true, policy: 'limited', remaining: 1 },
      'current',
      checked.available,
    ),
    1,
  );
  s.setStock(7);
  s.bills.set('seller-0', [s.bill()]);
  assert.equal((await s.available()).available, 5, 'a matched bill accounts for the sale once');
  s.setStock(2);
  const exhausted = await s.available();
  assert.equal(exhausted.available, 0);
  assert.equal(
    desiredStock(s.f.store.read(), { ...pair, tyreFloor: true }, 'current', exhausted.available),
    0,
  );
});

test('a failed seller check keeps already observed sales and cannot advance verified coverage', async (t) => {
  const s = setup(t, [1, 2]);
  s.confirm();
  s.source.unavailable = 'seller-1';
  await assert.rejects(s.available(), /verify/);
  assert.equal(s.f.store.readStockCoverage(s.companyId)?.checkedThrough, null);
  s.orders.set('seller-0', []);
  s.source.unavailable = '';
  assert.equal((await s.available()).available, 3);
});

test('saved pending listings report only a current complete company check for participating sellers', async (t) => {
  const s = setup(t, [1, 2]);
  s.confirm();
  await s.refreshHistory('seller-0');
  assert.deepEqual(await s.pendingGroups(), { trackingStarted: true, listings: [] });
  await s.refreshHistory();
  const checkedThrough = s.f.store.readStockCoverage(s.companyId)!.checkedThrough;
  assert.ok(checkedThrough);
  await s.refreshHistory('seller-1');
  assert.deepEqual(await s.pendingGroups('seller-1'), {
    trackingStarted: true,
    listings: [],
    checkedThrough,
  });
  assert.deepEqual(await s.pendingGroups('other-seller'), { trackingStarted: false, listings: [] });
  s.f.store.update((state) => {
    state.listings[0].packSize = 4;
  });
  assert.deepEqual(await s.pendingGroups(), { trackingStarted: true, listings: [] });
});

test('a newly verified receipt durably queues all active destinations once even if a later seller read fails', async (t) => {
  const s = setup(t, [1, 2]);
  s.confirm();
  const sale = s.orders.get('seller-0')![0];
  s.orders.set('seller-0', [{ ...sale, eligibilityUnverified: true }]);
  s.orders.set('seller-1', []);
  await s.scan();
  assert.ok(s.f.store.read().listings.every((l) => !l.orderSyncPending));
  s.orders.set('seller-0', [sale]);
  s.source.unavailable = 'seller-1';
  await assert.rejects(s.scan(), /verify/);
  const receipt = s.f.store.read().listings[0].orderSyncPending;
  assert.ok(receipt);
  s.restoreService();
  assert.ok(s.f.store.read().listings.every((l) => l.orderSyncPending === receipt));
  s.f.store.update((state) => {
    for (const row of state.listings) row.orderSyncPending = null;
  });
  s.source.unavailable = '';
  await s.scan();
  assert.ok(s.f.store.read().listings.every((l) => !l.orderSyncPending));
  assert.deepEqual(s.source.dates, [], 'discovering orders does not require reading Tally');
});

test('a later normal forward status cannot activate stock for a previously observed return', async (t) => {
  const s = setup(t);
  s.confirm();
  const sale = s.orders.get('seller-0')![0];
  s.orders.set('seller-0', [
    { ...sale, stockReconciliationRequired: true, stockDisposition: 'uncertain' },
  ]);
  await s.scan();
  s.orders.set('seller-0', [sale]);
  await s.scan();
  assert.ok(s.f.store.read().listings.every((l) => !l.orderSyncPending));
  await assert.rejects(s.available(), /unresolved sale, return/);
});

test('a pre-dispatch courier omission after known dispatch stays under review across later reads and restart', async (t) => {
  const s = setup(t);
  s.confirm();
  const sale = { ...s.orders.get('seller-0')![0], stockShipmentId: 'shipment-a' };
  const shipped: FlipkartBillingOrder = { ...sale, stockDispatchObserved: true };
  s.orders.set('seller-0', [
    { ...shipped, eligibilityUnverified: true, stockDisposition: 'uncertain' },
  ]);
  await s.scan();
  s.restoreService();
  s.orders.set('seller-0', [{ ...sale, preDispatchWithoutCourierReturn: true }]);
  await assert.rejects(s.available(), /unresolved sale/);
  assert.ok(s.f.store.read().listings.every((row) => !row.orderSyncPending));
  s.restoreService();
  s.orders.set('seller-0', [shipped]);
  await assert.rejects(s.available(), /unresolved sale/);
});

test('a pre-dispatch courier omission can progress to dispatch only for the same recorded shipment', async (t) => {
  const s = setup(t);
  s.confirm();
  const sale = { ...s.orders.get('seller-0')![0], stockShipmentId: 'shipment-a' };
  const ready: FlipkartBillingOrder = { ...sale, preDispatchWithoutCourierReturn: true };
  s.orders.set('seller-0', [ready]);
  const available = (await s.available()).available;
  s.restoreService();
  s.orders.set('seller-0', [{ ...sale, stockDispatchObserved: true }]);
  assert.equal((await s.available()).available, available);
  s.orders.set('seller-0', [{ ...ready, stockShipmentId: 'other-shipment' }]);
  await assert.rejects(s.available(), /recorded order changed/);
});

test('a later explicit courier flag cannot release an order on a different shipment’s cancellation', async (t) => {
  const s = setup(t);
  s.confirm();
  const sale = { ...s.orders.get('seller-0')![0], stockShipmentId: 'shipment-a' };
  s.orders.set('seller-0', [{ ...sale, preDispatchWithoutCourierReturn: true }]);
  assert.equal((await s.available()).reservedUnits, 1);
  s.orders.set('seller-0', [sale]);
  assert.equal((await s.available()).reservedUnits, 1);
  s.restoreService();

  s.orders.set('seller-0', [
    { ...sale, stockShipmentId: 'shipment-b', stockDisposition: 'cancelled' },
  ]);
  await assert.rejects(s.available(), /recorded order changed/);
  const recorded = s.f.store.readStockCoverage(s.companyId)!.orders[0].order;
  assert.equal(recorded.stockShipmentId, 'shipment-a');
  assert.equal(recorded.stockIdentityConflict, true);
  s.orders.set('seller-0', [sale]);
  await assert.rejects(s.available(), /recorded order changed/);
});

test('an older order without a shipment ID acquires and retains the first known shipment', async (t) => {
  const s = setup(t);
  s.confirm();
  const legacy = s.orders.get('seller-0')![0];
  assert.equal((await s.available()).reservedUnits, 1);
  s.restoreService();
  const identified = { ...legacy, stockShipmentId: 'shipment-a' };
  s.orders.set('seller-0', [identified]);
  assert.equal((await s.available()).reservedUnits, 1);
  s.orders.set('seller-0', [legacy]);
  assert.equal((await s.available()).reservedUnits, 1);
  const recorded = s.f.store.readStockCoverage(s.companyId)!.orders[0].order;
  assert.equal(recorded.stockShipmentId, 'shipment-a');
  s.orders.set('seller-0', [{ ...identified, stockDisposition: 'cancelled' }]);
  assert.equal((await s.available()).reservedUnits, 0);
});

test('a forward sale can be cancelled but a missing courier-return flag cannot reopen a verified cancellation', async (t) => {
  const s = setup(t);
  s.confirm();
  const sale = { ...s.orders.get('seller-0')![0], stockShipmentId: 'shipment-a' };
  const ready: FlipkartBillingOrder = { ...sale, preDispatchWithoutCourierReturn: true };
  s.orders.set('seller-0', [ready]);
  assert.equal((await s.available()).available, 5);
  s.orders.set('seller-0', [{ ...sale, stockDisposition: 'cancelled' }]);
  assert.equal((await s.available()).available, 6);
  s.restoreService();
  s.orders.set('seller-0', [ready]);
  await assert.rejects(s.available(), /unresolved sale/);
  const receipt = s.f.store.readStockCoverage(s.companyId)!.orders[0].order;
  assert.equal(receipt.stockReconciliationRequired, true);
  assert.equal(receipt.stockIdentityConflict, undefined);
});

for (const cleanFirst of [false, true]) {
  test(`an identified cancellation/return conflict stays with its item when a clean cancellation is seen ${cleanFirst ? 'first' : 'later'}`, async (t) => {
    const s = setup(t);
    const wheelId = 'local-wheel';
    s.f.store.updateMarketplace((market, state) => {
      state.items.push({
        ...state.items[0],
        id: wheelId,
        externalId: 'wheel',
        name: 'Wheel',
        physical: 8,
      });
      market.listings.push({
        ...market.listings[0],
        id: 'wheel-listing',
        productId: 'wheel-product',
        sku: 'WHEEL',
      });
      state.listings.push({ ...state.listings[0], id: 'map-wheel', itemId: wheelId, sku: 'WHEEL' });
    });
    s.otherStock.push({ externalId: 'wheel', name: 'Wheel', unit: 'ea', physical: 8 });
    s.confirm();
    const sale = { ...s.orders.get('seller-0')![0], stockShipmentId: 'shipment-a' };
    const cancelled = { ...sale, stockDisposition: 'cancelled' as const };
    const conflict: FlipkartBillingOrder = {
      ...sale,
      stockReturnConflict: true,
      stockReconciliationRequired: true,
      stockDispatchObserved: true,
      stockDisposition: 'uncertain',
      eligibilityUnverified: true,
    };
    if (cleanFirst) {
      s.orders.set('seller-0', [cancelled]);
      assert.equal((await s.available()).available, 6);
    }
    for (const observations of [[conflict], [cancelled], []]) {
      s.orders.set('seller-0', observations);
      if (!observations.length) s.restoreService();
      const batch = {};
      await assert.rejects(s.available(batch), /unresolved sale, return/);
      const other = await s.available(batch, wheelId);
      assert.equal(other.available, 8);
      other.verify();
    }
    if (cleanFirst) {
      s.f.store.update((state) => {
        state.listings[0].itemId = wheelId;
      });
      await assert.rejects(
        s.available({}, wheelId),
        /Order matching, choose Review starting stock/,
      );
    } else {
      s.orders.set('seller-0', [{ ...cancelled, quantity: 2 }]);
      await assert.rejects(s.available({}, wheelId), /recorded order changed/);
    }
  });
}

test('uncertain returns, ambiguous billing and unmapped orders stop a calculated increase', async (t) => {
  const s = setup(t);
  s.confirm();
  const original = s.orders.get('seller-0')![0];
  s.orders.set('seller-0', [{ ...original, stockDisposition: 'uncertain' }]);
  await assert.rejects(s.available(), /status/);
  s.orders.set('seller-0', [{ ...original, stockDisposition: 'cancelled' }]);
  assert.equal((await s.available()).available, 6);
  s.orders.set('seller-0', [original]);
  s.bills.set('seller-0', [s.bill(), s.bill(0, 'another-bill')]);
  await assert.rejects(s.available(), /billing or pack review/);
  s.orders.set('seller-0', [{ ...original, orderItemId: 'unassigned', sku: 'UNKNOWN' }]);
  await assert.rejects(s.available(), /stock mapping/);
});

test('a single bill/item cannot discharge orders from two accounts', async (t) => {
  const s = setup(t, [1, 1]);
  s.confirm();
  s.bills.set('seller-0', [s.bill(0)]);
  s.bills.set('seller-1', [s.bill(1)]);
  await assert.rejects(s.available(), /same Tally bill/);
});

for (const dependency of ['independent', 'shared item', 'shared ledger']) {
  test(`a seller's saved order recheck includes the other account only when needed: ${dependency}`, async (t) => {
    const s = setup(t, [1, 1]);
    s.f.store.update((state) => {
      state.listings[0].itemId = null;
      if (dependency !== 'shared item') {
        state.items.push({ ...state.items[0], id: 'another-item', externalId: 'another-product' });
        state.listings[1].itemId = 'another-item';
      }
    });
    if (dependency === 'shared ledger') {
      s.f.store.updateBilling((data) => {
        data.rules.find((rule) => rule.accountId === 'seller-1')!.ledgerId = 'seller-0';
      });
    }
    s.confirm();
    s.source.unavailable = 'seller-1';
    const list = await s.listingCheck({}, false);
    assert.ok('listings' in list);
    assert.ok(!list.refreshIssue);
    const [group] = list.listings;
    assert.deepEqual(group.orderItemIds, ['line']);
    assert.equal(s.f.store.readStockCoverage(s.companyId)!.checkedThrough, null);

    const row = s.f.store.read().listings[0];
    s.f.service.mapping({
      listingId: row.id,
      listingVersion: row.version,
      itemId: s.itemId,
      packSize: 1,
      packSource: 'manual',
      sourceScope: 'company',
      confirmPackEvidence: true,
      tyreFloor: false,
    });
    const check = () => s.listingCheck({ ...group }, true);
    s.bills.set('seller-0', [s.bill()]);
    if (dependency === 'independent') {
      assert.deepEqual(
        (await check()).rows?.map((r) => r.status),
        ['matched'],
      );
      s.bills.set('seller-0', []);
      s.source.unavailable = '';
      s.source.unavailableLedger = 'seller-1';
      assert.deepEqual(
        (await check()).rows?.map((r) => r.status),
        ['reserved'],
      );
      assert.equal(s.f.store.readStockCoverage(s.companyId)!.checkedThrough, null);
      await assert.rejects(s.available(), /Could not verify/);
    } else {
      await assert.rejects(check(), /Could not verify/);
      s.source.unavailable = '';
      if (dependency === 'shared item') s.bills.set('seller-1', [s.bill(1)]);
      assert.deepEqual(
        (await check()).rows?.map((r) => r.status),
        ['review'],
      );
    }
  });
}

test('a partially billed pack waits for reconciliation before setting stock', async (t) => {
  const s = setup(t, [2]);
  s.confirm();
  const bill = s.bill();
  bill.lines[0].quantity = 1;
  s.bills.set('seller-0', [bill]);
  await assert.rejects(s.available(), /billing or pack review/);
  bill.lines[0].quantity = 2;
  s.setStock(4);
  assert.equal((await s.available()).available, 4);
});

test('changing only the advertising floor keeps historical pack conversions valid', async (t) => {
  const s = setup(t);
  s.confirm();
  assert.equal((await s.available()).available, 5);
  const row = s.f.store.read().listings[0];
  s.f.service.mapping({
    listingId: row.id,
    itemId: s.itemId,
    listingVersion: row.version,
    packSize: 1,
    packSource: 'manual',
    sourceScope: 'company',
    confirmPackEvidence: true,
    tyreFloor: true,
  });
  assert.equal((await s.available()).available, 5);
});

test('stock and bills use one Indian business day, and the next day invalidates the result', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-20T18:29:55.000Z') });
  const s = setup(t);
  s.confirm();
  const result = await s.available();
  assert.deepEqual(s.source.dates, ['2026-11-20', '2026-11-20']);
  t.mock.timers.tick(10_000);
  assert.throws(result.verify, /business date changed/);
});

test('evidence is shared within one publication pass and independently refreshed on the next', async (t) => {
  const s = setup(t);
  s.confirm();
  let balanceReads = 0;
  s.source.stockRead = () => {
    balanceReads++;
    return 6;
  };
  const batch = {};
  assert.equal((await s.available(batch)).available, 5);
  assert.equal((await s.available(batch)).available, 5);
  assert.equal(balanceReads, 2);
  s.orders
    .get('seller-0')!
    .push({ ...s.orders.get('seller-0')![0], orderItemId: 'another', orderId: 'another-order' });
  assert.equal((await s.available({})).available, 4);
  assert.equal(balanceReads, 4);
  await assert.rejects(s.available(batch), /changed/);
});

test('a later cancellation cannot free previously dispatched stock; a long gap requires reconciliation', async (t) => {
  const s = setup(t);
  s.confirm();
  const original = s.orders.get('seller-0')![0];
  s.orders.set('seller-0', [{ ...original, stockDispatchObserved: true }]);
  assert.equal((await s.available()).available, 5);
  s.orders.set('seller-0', [{ ...original, stockDisposition: 'cancelled' }]);
  await assert.rejects(s.available(), /dispatch history/);
  const coverage = s.f.store.readStockCoverage(s.companyId)!;
  const old = new Date(Date.parse(coverage.from) - 31 * 86_400_000).toISOString();
  s.f.store.saveStockCoverage({ ...coverage, from: old, checkedThrough: old });
  await assert.rejects(s.available(), /gap in order coverage/);
});

test('reconfirming the current date preserves the last check, recorded sales and fresh proposals', async (t) => {
  const s = setup(t);
  s.confirm();
  s.f.store.update((state) => {
    state.connection.tally = 'online';
  });
  await s.scan();
  const coverage = s.f.store.readStockCoverage(s.companyId)!;
  assert.ok(coverage.checkedThrough);
  assert.equal(coverage.orders.length, 1);
  const drafts = s.f.store.read().proposals;
  assert.ok(drafts.some((draft) => draft.listingId === 'map-0' && !draft.stale));
  assert.equal(s.confirm().checkedThrough, coverage.checkedThrough);
  assert.deepEqual(s.f.store.readStockCoverage(s.companyId), coverage);
  assert.deepEqual(s.f.store.read().proposals, drafts);
  const today = saleDay(new Date().toISOString());
  assert.equal(s.confirm(today).checkedThrough, null);
  assert.ok(s.f.store.read().proposals.find((draft) => draft.listingId === 'map-0')?.stale);
});

test('source balance, changed conversions, baseline dates and changed order identities guard publication', async (t) => {
  const s = setup(t);
  assert.throws(() => s.confirm('2000-01-01'), /previous 29 days/);
  assert.throws(() => s.confirm('2026-02-31'), /valid starting/);
  s.confirm();
  let reads = 0;
  s.source.stockRead = () => (++reads === 1 ? 6 : 5);
  await assert.rejects(s.available(), /balance changed/);
  s.source.stockRead = () => 6;
  const check = await s.available();
  s.f.store.update((state) => {
    state.listings[0].packSize = 2;
  });
  assert.throws(check.verify, /changed/);
  await assert.rejects(s.available(), /Order matching, choose Review starting stock/);
  assert.throws(() => s.confirm(), /after those sales/);
  s.f.store.update((state) => {
    state.listings[0].packSize = 1;
  });
  s.orders.get('seller-0')![0].quantity = 3;
  await assert.rejects(s.available(), /recorded order changed/);
  s.orders.set('seller-0', []);
  s.restoreService();
  await assert.rejects(s.available(), /recorded order changed/);
});

test('an unmapped order is retained, then reserved across sibling listings and matched once after late mapping', async (t) => {
  const s = setup(t);
  const sale = {
    ...s.orders.get('seller-0')![0],
    orderItemId: 'late-line',
    orderId: 'late-sale',
    listingId: 'late-listing',
    sku: 'NEW-PAIR',
  };
  s.f.store.updateMarketplace((market, state) => {
    market.listings.push({ ...market.listings[0], id: sale.listingId, sku: sale.sku });
    state.listings.push({
      ...state.listings[0],
      id: 'pair-mapping',
      itemId: null,
      sku: sale.sku,
      paused: true,
    });
  });
  s.orders.set('seller-0', [sale]);
  s.confirm();
  await s.refreshHistory();
  assert.ok(s.f.store.read().listings.every((l) => !l.orderSyncPending));
  assert.equal((await s.available()).available, 6);
  assert.deepEqual(
    s.pending().map((e) => [e.order.orderItemId, e.mapped]),
    [['late-line', false]],
  );
  const from = s.f.store.readStockCoverage(s.companyId)!.from;
  s.orders.set('seller-0', []); // A short later read cannot erase the sale.
  s.restoreService();
  const previous = await s.available();
  s.f.store.update((state) => {
    state.connection.tally = 'online';
    delete state.companies.find((company) => company.id === s.companyId)!.stockIssue;
  });
  s.f.service.calculate(s.companyId, ['map-0']);
  const row = s.f.store.read().listings.find((l) => l.id === 'pair-mapping')!;
  s.f.service.mapping({
    listingId: row.id,
    listingVersion: row.version,
    itemId: s.itemId,
    packSize: 2,
    packSource: 'manual',
    sourceScope: 'company',
    confirmPackEvidence: true,
    tyreFloor: false,
  });
  assert.throws(previous.verify, /changed/);
  const coverage = s.f.store.readStockCoverage(s.companyId)!;
  assert.equal(coverage.from, from);
  assert.equal(coverage.orders.length, 1);
  assert.equal(
    s.f.service.snapshot().proposals.find((draft) => draft.listingId === 'map-0')?.stale,
    true,
  );
  await s.scan();
  assert.equal(
    s.f.service.snapshot().proposals.find((draft) => draft.listingId === 'map-0')?.quantity,
    4,
  );
  assert.deepEqual(
    s.pending().map((e) => [e.order.orderItemId, e.mapped]),
    [['late-line', true]],
  );
  const listings = s.f.store.read().listings;
  const pending = listings.find((l) => l.id === 'map-0')!.orderSyncPending;
  assert.ok(pending);
  assert.ok(!listings.find((l) => l.id === row.id)!.orderSyncPending);
  assert.equal((await s.available()).available, 4);
  assert.equal((await s.review())[0].result.status, 'reserved');
  assert.equal(s.f.store.read().listings.find((l) => l.id === 'map-0')!.orderSyncPending, pending);
  const bill = {
    ...s.bill(),
    reference: sale.orderId,
    lines: [{ itemExternalId: 'tyre', unit: 'ea', quantity: 2 }],
  };
  s.bills.set('shop-ledger', [bill]);
  assert.equal((await s.review())[0].result.status, 'reserved');
  s.setStock(4);
  s.bills.set('seller-0', [bill]);
  assert.equal((await s.review())[0].result.status, 'matched');
  assert.equal((await s.available()).available, 4);
  s.f.store.update((state) => {
    state.listings.find((l) => l.id === row.id)!.packSize = 3;
  });
  await assert.rejects(s.available(), /Order matching, choose Review starting stock/);
});

test('a paused first mapping retries its initial proposal after restart with sync off', async (t) => {
  const s = setup(t);
  s.setStock(8);
  s.f.store.update((state) => {
    state.companies[0].automation = false;
    state.connection.tally = 'online';
    state.listings[0].itemId = null;
    state.listings[0].observed = 5;
  });
  s.confirm();
  await s.refreshHistory();
  const original = s.f.store.read().listings[0];
  s.f.service.mapping({
    listingId: original.id,
    listingVersion: original.version,
    itemId: s.itemId,
    confirmPackEvidence: true,
    packSource: 'manual',
    packSize: 4,
    sourceScope: 'company',
    tyreFloor: false,
    keepPaused: true,
  });
  s.source.unavailableLedger = 'seller-0';
  await s.scan();
  const waiting = s.f.store.read();
  assert.equal(waiting.proposals.length, 0);
  assert.equal(waiting.listings[0].orderProposalPending, true);
  assert.match(waiting.listings[0].proposalIssue!, /Could not verify/);
  s.restoreService();
  s.f.store.update((state) => {
    state.connection.tally = 'online';
    delete state.companies[0].stockIssue;
  });
  s.source.unavailableLedger = '';
  s.orders.set('seller-0', []);
  await s.scan();
  const checked = s.f.store.read();
  assert.equal(checked.listings[0].observed, 5);
  assert.equal(checked.items[0].physical, 8);
  assert.equal((await s.available()).reservedUnits, 4);
  assert.equal(checked.proposals[0].quantity, 1);
  assert.equal(checked.listings[0].orderProposalPending, undefined);
  assert.equal(checked.listings[0].proposalIssue, undefined);
  assert.equal(checked.listings[0].paused, true);
  assert.ok(!checked.listings[0].orderSyncPending && !checked.listings[0].syncPendingItemVersion);
  s.f.store.update((state) => {
    state.proposals = [];
  });
  await s.scan();
  assert.equal(
    s.f.store.read().proposals.length,
    0,
    'handled orders cannot recreate a completed draft',
  );
});

test('a retained order verified for the first time in Order matching queues a draft and preserves a seller edit', async (t) => {
  const s = setup(t);
  const original = s.orders.get('seller-0')![0];
  s.f.store.update((state) => {
    state.connection.tally = 'online';
  });
  s.orders.set('seller-0', [
    { ...original, eligibilityUnverified: true, stockDisposition: 'uncertain' },
  ]);
  s.confirm();
  await s.refreshHistory();
  s.orders.set('seller-0', [original]);
  await s.preview();
  assert.equal(
    s.f.store.read().listings[0].orderProposalPending,
    undefined,
    'preview leaves the journal untouched',
  );
  await s.refreshHistory();
  assert.equal(s.f.store.read().listings[0].orderProposalPending, true);
  s.f.service.edit(s.companyId, 'map-0', 2);
  await s.scan();
  const done = s.f.store.read();
  assert.equal(done.listings[0].orderProposalPending, undefined);
  assert.equal(done.proposals[0].quantity, 2);
  assert.equal(done.proposals[0].edited, true);
});

test('a pre-dispatch order discovered just after mapping prepares its first proposal only at its own destination', async (t) => {
  const s = setup(t, [4, 1]);
  s.setStock(8);
  s.f.store.update((state) => {
    state.connection.tally = 'online';
  });
  const sale = s.orders.get('seller-0')![0];
  s.orders.set('seller-0', [
    {
      ...sale,
      stockShipmentId: 'forward-shipment',
      preDispatchWithoutCourierReturn: true,
    },
  ]);
  s.orders.set('seller-1', []);
  s.confirm();
  await s.scan();
  const drafts = s.f.store.read().proposals;
  assert.deepEqual(
    drafts.map((draft) => [draft.listingId, draft.quantity]),
    [['map-0', 1]],
  );
  s.f.store.update((state) => {
    state.proposals = [];
  });
  await s.scan();
  assert.equal(s.f.store.read().proposals.length, 0);
});

test('a stale tracking baseline holds the initial order proposal even below one pack', async (t) => {
  const s = setup(t);
  s.setStock(3);
  s.f.store.update((state) => {
    state.connection.tally = 'online';
    state.listings[0].itemId = null;
  });
  s.confirm();
  await s.refreshHistory();
  const coverage = s.f.store.readStockCoverage(s.companyId)!;
  s.f.store.saveStockCoverage({ ...coverage, signature: 'previous-stock-setup' });
  const row = s.f.store.read().listings[0];
  s.f.service.mapping({
    listingId: row.id,
    listingVersion: row.version,
    itemId: s.itemId,
    confirmPackEvidence: true,
    packSource: 'manual',
    packSize: 4,
    sourceScope: 'company',
    tyreFloor: false,
  });
  await assert.rejects(s.scan(), /Review starting stock/);
  const state = s.f.store.read();
  assert.equal(state.proposals.length, 0);
  assert.equal(state.listings[0].orderProposalPending, true);
  assert.match(state.listings[0].proposalIssue!, /Review starting stock/);
  assert.equal(s.f.store.readStockCoverage(s.companyId)?.signature, 'previous-stock-setup');
});

test('a sale billed before the first mapping is matched on the first recheck with sync off', async (t) => {
  const s = setup(t);
  s.f.store.update((state) => {
    state.companies.find((c) => c.id === s.companyId)!.automation = false;
    state.listings[0].itemId = null;
  });
  s.confirm();
  await s.scan();
  s.restoreService();
  assert.equal(s.pending().length, 1);
  assert.equal(s.pending()[0].mapped, false);
  s.bills.set('seller-0', [s.bill()]);
  // The bill is already in Tally, but the next inventory stock poll has not run.
  s.source.stockRead = () => 5;
  const row = s.f.store.read().listings[0];
  s.f.service.mapping({
    listingId: row.id,
    listingVersion: row.version,
    itemId: s.itemId,
    packSize: 1,
    packSource: 'manual',
    sourceScope: 'company',
    confirmPackEvidence: true,
    tyreFloor: false,
  });
  assert.equal((await s.review())[0].result.status, 'matched');
  await assert.rejects(s.available(), /balance changed/);
  let stockReads = 0;
  s.source.stockRead = () => (++stockReads === 1 ? 5 : 4);
  await assert.rejects(s.review(), /balance changed/);
  s.source.stockRead = () => 5;
  s.setStock(5);
  assert.equal((await s.available()).available, 5);
  assert.ok(s.f.store.read().listings.every((l) => !l.orderSyncPending));
});

test('a verified cancellation alone needs no mapping and remains in the journal and same-destination audit', async (t) => {
  const s = setup(t);
  const original = s.orders.get('seller-0')![0];
  const clean = {
    ...original,
    sku: 'NEW',
    listingId: 'NEW-LISTING',
    stockDisposition: 'cancelled' as const,
  };
  s.orders.set('seller-0', [clean]);
  s.confirm();
  await s.scan();
  assert.deepEqual(await s.pendingGroups(), {
    trackingStarted: true,
    listings: [],
    checkedThrough: s.f.store.readStockCoverage(s.companyId)!.checkedThrough,
  });
  assert.equal(s.f.store.readStockCoverage(s.companyId)!.orders.length, 1);
  assert.deepEqual(
    (await s.review()).map((row) => row.result.status),
    ['cancelled'],
  );
  const uncertain = {
    ...clean,
    orderItemId: 'return',
    stockDisposition: 'uncertain' as const,
    eligibilityUnverified: true as const,
  };
  s.orders.set('seller-0', [uncertain]);
  await s.scan();
  assert.deepEqual(await s.pendingGroups(), {
    trackingStarted: true,
    checkedThrough: s.f.store.readStockCoverage(s.companyId)!.checkedThrough,
    listings: [
      {
        listingId: clean.listingId,
        sku: clean.sku,
        location: clean.locationId,
        orderItemIds: [clean.orderItemId, uncertain.orderItemId],
        mapped: false,
      },
    ],
  });
  // A later contradiction on the original sale remains a stock reconciliation issue.
  s.orders.set('seller-0', [{ ...clean, quantity: 2 }]);
  await s.scan();
  const journal = s.f.store.readStockCoverage(s.companyId)!;
  assert.ok(
    journal.orders.find((e) => e.order.orderItemId === clean.orderItemId)?.order
      .stockIdentityConflict,
  );
  await assert.rejects(s.available(), /recorded order changed/);
});
