import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { FlipkartBillingOrder } from '../../src/adapters/flipkart-billing.js';
import type { TallySalesBill, TallyStockItem } from '../../src/adapters/tally.js';
import { saleDay } from '../../src/server/billing-matcher.js';
import { StockAvailabilityService } from '../../src/server/stock-availability.js';
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
  const source = { unavailable: '', revoked: '', dates, stockRead: () => physical };
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
          async readStockOrders(token, from, to) {
            if (source.unavailable === token) throw new Error('Offline');
            return structuredClone(
              orders.get(token)!.filter((o) => o.orderDate >= from && o.orderDate <= to),
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
    available: (batch?: object, target = itemId) => service.forItem(companyId, target, batch),
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

test('a restock can publish five and the matching Tally sale leaves five available', async (t) => {
  const s = setup(t);
  await assert.rejects(s.available(), /coverage/);
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
      await assert.rejects(s.available({}, wheelId), /coverage/);
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
  await assert.rejects(s.available(), /coverage/);
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
