import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleBills, sampleLedger, sampleOrderDate } from '../../src/server/billing-sample.js';
import { MarketplaceService } from '../../src/server/marketplace-service.js';
import type {
  BillLookup,
  BillingReport,
  TrackedBillHistory,
} from '../../src/shared/billing-contracts.js';
import { serverFixture } from '../support/server-fixture.js';

const companyId = 'demo-integration';
const retail = { companyId, accountId: 'demo-retail' };
const outlet = { companyId, accountId: 'demo-outlet' };
const itemId = 'demo-integration-tyre';

test('sample tracking, recent previews and reservations use the corresponding seller and fulfilment scopes', async (t) => {
  const { store, folder } = serverFixture(t);
  const market = new MarketplaceService(store, folder);
  t.after(async () => {
    market.stop();
    await market.idle();
  });
  store.installDemoWorkspace();
  const billing = (action: string, input: Record<string, unknown>) =>
    market.billingCommand('/api/billing/' + action, input);
  const preview = (await billing('preview', {
    ...retail,
    days: 1,
    field: 'reference',
    reference: 'orderId',
    ledgerId: sampleLedger(companyId, retail.accountId).externalId,
  })) as BillingReport;
  assert.deepEqual(preview.rows.map((row) => row.orderItemId).sort(), [
    'DEMO-LINE-1001',
    'DEMO-LINE-1002',
    'DEMO-LINE-1003',
    'DEMO-LINE-1004',
  ]);
  const available = () => market.availableStock(companyId, itemId);
  assert.partialDeepStrictEqual(await available(), {
    physical: 24,
    reservedUnits: 4,
    available: 18,
  });
  const tracked = (await billing('tracked-bills', retail)) as TrackedBillHistory;
  assert.deepEqual(
    tracked.check?.groups.map(({ group, count }) => [group, count]),
    [
      ['standard', 3],
      ['selfShip', 2],
      ['express', 1],
      ['smart', 1],
      ['fbf', 1],
    ],
  );
  assert.deepEqual(
    tracked.orders.map(({ orderItemId, status }) => [orderItemId, status]),
    [
      ['DEMO-LINE-1001', 'matched'],
      ['DEMO-LINE-1002', 'reserved'],
      ['DEMO-LINE-1003', 'reserved'],
      ['DEMO-LINE-1004', 'unmapped'],
      ['DEMO-LINE-1005', 'cancelled'],
      ['DEMO-LINE-1006', 'matched'],
      ['DEMO-LINE-1007', 'unmatched'],
      ['DEMO-LINE-1008', 'unmatched'],
    ],
  );
  assert.equal(
    tracked.orders.find((row) => row.orderItemId === 'DEMO-LINE-1004')?.mapping?.listingId,
    'sample-demo-retail-unmapped',
  );
  const outletHistory = (await billing('tracked-bills', outlet)) as TrackedBillHistory;
  assert.deepEqual(
    outletHistory.orders.map(({ orderItemId, status }) => [orderItemId, status]),
    [['DEMO-LINE-2001', 'reserved']],
  );
  const lookup = (await billing('find-bill', {
    ...retail,
    orderItemId: 'DEMO-LINE-1003',
    billNumber: 'DEMO-BILL-1003',
  })) as BillLookup;
  assert.equal(lookup.bills.length, 1);
  assert.partialDeepStrictEqual(lookup.bills[0], {
    referenceMismatch: true,
    issue: null,
    recordedReference: 'DEMO-ORDRE-1003',
  });
  await billing('link-bill', {
    ...retail,
    orderItemId: lookup.orderItemId,
    reviewId: lookup.reviewId,
    billId: lookup.bills[0].id,
    acceptReferenceMismatch: true,
  });
  assert.partialDeepStrictEqual(await available(), {
    physical: 24,
    reservedUnits: 2,
    available: 20,
  });
  assert.deepEqual(store.readMarketplace().changes, []);
});

test('sample order dates stay on the integration installation day and respect both bounds of a check', (t) => {
  const { store, folder } = serverFixture(t);
  const market = new MarketplaceService(store, folder);
  t.after(async () => {
    market.stop();
    await market.idle();
  });
  store.installDemoWorkspace();
  const items = store.read().items;
  const installed = items.find((item) => item.id === itemId)!.observedAt!;
  const before = new Date(Date.parse(installed) - 1).toISOString();
  const after = new Date(Date.parse(installed) + 1).toISOString();
  const firstRead = Date.parse(installed) + 1_000;
  t.mock.timers.enable({ apis: ['Date'], now: firstRead });
  const placed = sampleBills(retail, installed, installed, installed).stockOrders[0];
  assert.equal(placed.statusVerifiedAt, new Date(firstRead).toISOString());
  t.mock.timers.setTime(firstRead + 1_000);
  const reread = sampleBills(retail, installed, installed, installed).stockOrders[0];
  assert.equal(reread.orderDate, placed.orderDate);
  assert.equal(reread.statusVerifiedAt, new Date(firstRead + 1_000).toISOString());
  assert.equal(
    sampleOrderDate(retail, items, [
      { accountId: retail.accountId, order: { ...placed, orderDate: before } },
    ]),
    installed,
  );
  for (const [from, to] of [
    [before, before],
    [after, after],
  ]) {
    const evidence = sampleBills(retail, installed, from, to);
    assert.deepEqual(Object.values(evidence.byFulfilment).flat(), []);
    assert.deepEqual(evidence.bills, []);
  }
  assert.deepEqual(
    sampleBills({ ...retail, accountId: 'flipkart-primary' }, installed, before, after).stockOrders,
    [],
  );
});
