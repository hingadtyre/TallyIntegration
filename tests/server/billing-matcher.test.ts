import assert from 'node:assert/strict';
import test from 'node:test';
import type { FlipkartBillingOrder } from '../../src/adapters/flipkart-billing.js';
import type { TallySalesBill } from '../../src/adapters/tally.js';
import type { BillingRule } from '../../src/shared/billing-contracts.js';
import {
  matchBills,
  storeReviewedBillLink,
  type BillingEvidence,
} from '../../src/server/billing-matcher.js';
import { seedSampleMarketplace } from '../../src/server/marketplace-catalog.js';
import { initialState } from '../../src/server/seed.js';
import type { BillingData } from '../../src/server/storage/billing-records.js';
import type { MarketplaceData } from '../../src/server/storage/marketplace-records.js';

function fixture() {
  const state = initialState('demo', '');
  const catalogue: MarketplaceData = { accounts: [], listings: [], changes: [] };
  seedSampleMarketplace(catalogue, state);
  const scope = { companyId: 'demo-a', accountId: 'flipkart-primary' };
  const rule: BillingRule = {
    ledgerId: 'sales-guid',
    ledgerName: 'Marketplace sales',
    field: 'reference',
    reference: 'orderId',
  };
  const stock = state.items[0];
  const listing = catalogue.listings[0];
  const order: FlipkartBillingOrder = {
    orderItemId: 'OI-1',
    orderId: 'OD-12',
    invoiceNumber: 'INV/12',
    listingId: listing.id,
    sku: listing.sku,
    locationId: listing.locations[0].id,
    quantity: 1,
    orderDate: '2026-11-19T18:40:00Z',
  };
  const bill: TallySalesBill = {
    externalId: 'voucher-guid',
    number: 'INV/12',
    date: '2026-11-20',
    reference: order.orderId,
    narration: '',
    lines: [{ itemExternalId: stock.externalId, unit: stock.unit, quantity: 1 }],
  };
  const saved: BillingData = { rules: [], links: [] };
  return {
    state,
    catalogue,
    scope,
    rule,
    stock,
    order,
    bill,
    saved,
    match(orders = [order], bills = [bill]) {
      return matchBills(scope, rule, { orders, bills }, saved, state, catalogue.listings);
    },
    find(
      billNumber = bill.number,
      knownOrders: BillingEvidence['knownOrders'] = [],
      bills = [bill],
      knownBills: BillingEvidence['knownBills'] = [],
    ) {
      return matchBills(
        scope,
        rule,
        { orders: [order], bills, knownOrders, knownBills },
        saved,
        state,
        catalogue.listings,
        { orderItemId: order.orderItemId, billNumber },
      );
    },
  };
}

test('stock preview deducts an unbilled order across purchases and releases it after matching the bill', () => {
  const f = fixture();
  const preview = (bills: TallySalesBill[]) => {
    const result = f.match([f.order], bills);
    const { physical, unmatchedUnits, previewAvailable } = result.stock[0];
    return [result.rows[0].status, physical, unmatchedUnits, previewAvailable];
  };
  assert.deepEqual(preview([]), ['unmatched', 4, 1, 3]);
  f.stock.physical = 6;
  assert.deepEqual(preview([]), ['unmatched', 6, 1, 5]);
  f.stock.physical = 5;
  assert.deepEqual(preview([f.bill]), ['matched', 5, 0, 5]);
  assert.equal(
    f.match([], [f.bill]).rows.length,
    0,
    'a Tally bill alone cannot establish an order',
  );
  f.state.listings[0].packSize = 2;
  assert.deepEqual(preview([f.bill]), ['review', 5, 2, 3]);
});

test('a second voucher referencing the same sale with a conflicting stock deduction requires reconciliation', () => {
  const f = fixture();
  const conflicting = {
    ...f.bill,
    externalId: 'second-voucher',
    lines: [{ ...f.bill.lines[0], quantity: 2 }],
  };
  const row = f.match([f.order], [f.bill, conflicting]).rows[0];
  assert.equal(row.status, 'review');
  assert.equal(row.bill, null);
  assert.deepEqual(row.candidates, []);
  const sibling = { ...f.order, orderItemId: 'OI-2', quantity: 2 };
  const orders = [f.order, sibling];
  const initial = f.match(orders, [f.bill, conflicting]);
  f.saved.links.push(initial.links.get(f.order.orderItemId)!.get(f.bill.externalId)!);
  assert.equal(f.match(orders, [f.bill, conflicting]).rows[0].status, 'matched');
  const unexplained = { ...conflicting, lines: [{ ...f.bill.lines[0], quantity: 3 }] };
  const disputed = f.match(orders, [f.bill, unexplained]).rows[0];
  assert.equal(disputed.status, 'review');
  assert.equal(disputed.bill, null);
  assert.deepEqual(disputed.candidates, []);
});

test('exact fields and delimited narration distinguish similar references and missing invoice numbers', () => {
  const f = fixture();
  f.rule.field = 'number';
  f.rule.reference = 'invoiceNumber';
  assert.equal(f.match().rows[0].status, 'matched');
  assert.equal(f.match([{ ...f.order, invoiceNumber: null }]).rows[0].status, 'review');
  f.rule.field = 'reference';
  f.rule.reference = 'orderId';
  f.bill.reference = 'prefix OD-12';
  assert.equal(f.match().rows[0].status, 'unmatched');
  f.rule.field = 'narration';
  for (const [narration, status] of [
    ['Seller order (OD-12), confirmed', 'matched'],
    ['Seller order OD-12.', 'matched'],
    ['Order OD-12. Thank you.', 'matched'],
    ['OD-123', 'unmatched'],
    ['X/OD-12', 'unmatched'],
    ['OD-12.A', 'unmatched'],
  ]) {
    f.bill.narration = narration;
    assert.equal(f.match().rows[0].status, status, narration);
  }
});

test('the seller-period stock preview shows keep-back and unbilled units as separate deductions', () => {
  const f = fixture();
  f.stock.physical = 8;
  f.stock.keepBackUnits = 2;
  const unbilled = f.match([f.order], []).stock[0];
  assert.deepEqual(
    [unbilled.physical, unbilled.keepBackUnits, unbilled.unmatchedUnits, unbilled.previewAvailable],
    [8, 2, 1, 5],
  );
  f.stock.keepBackUnits = 10;
  assert.equal(f.match().stock[0].previewAvailable, 0);
  f.stock.physical = null;
  assert.equal(f.match().stock[0].previewAvailable, null);
});

test('wrong seller, listing identity, location, company, item, unit, quantity or earlier voucher cannot settle an order', () => {
  const f = fixture();
  for (const edit of [
    { listingId: 'recreated' },
    { locationId: 'other location' },
    { sku: 'another offer' },
  ]) {
    assert.equal(f.match([{ ...f.order, ...edit }]).rows[0].status, 'unmapped');
  }
  const sameDayInUtcButEarlierTallyDay = { ...f.bill, date: '2026-11-19' };
  assert.equal(f.match([f.order], [sameDayInUtcButEarlierTallyDay]).rows[0].status, 'unmatched');
  for (const edit of [{ itemExternalId: 'different-item' }, { unit: 'pairs' }, { quantity: 2 }]) {
    assert.equal(
      f.match([f.order], [{ ...f.bill, lines: [{ ...f.bill.lines[0], ...edit }] }]).rows[0].status,
      'itemExternalId' in edit ? 'unmatched' : 'review',
    );
  }
  f.catalogue.listings[0].accountId = 'another seller';
  assert.equal(f.match().rows[0].status, 'unmapped');
  f.catalogue.listings[0].accountId = f.scope.accountId;
  f.scope.companyId = 'demo-b';
  assert.deepEqual(f.match().rows, []);
});

test('manual choices preserve identical candidates until the seller confirms and a voucher line can only pay for one order', () => {
  const f = fixture();
  f.rule.field = 'manual';
  const otherOrder = { ...f.order, orderItemId: 'OI-2', orderId: 'OD-13' };
  const otherBill = { ...f.bill, externalId: 'another-guid', number: 'another-number' };
  const orders = [f.order, otherOrder];
  const bills = [f.bill, otherBill];
  const initial = f.match(orders, bills);
  assert.deepEqual(
    initial.rows.map((r) => [r.status, r.candidates.length]),
    [
      ['review', 2],
      ['review', 2],
    ],
  );
  const selected = initial.links.get(f.order.orderItemId)!.get(f.bill.externalId)!;
  f.saved.links.push(selected);
  const confirmed = f.match(orders, bills);
  assert.equal(confirmed.rows[0].bill?.id, f.bill.externalId);
  assert.equal(confirmed.rows[0].status, 'matched');
  assert.deepEqual(
    confirmed.rows[1].candidates.map((b) => b.id),
    [otherBill.externalId],
  );
  // A cancelled/amended bill disappears from the eligible voucher export or changes quantity.
  for (const changed of [
    [otherBill],
    [otherBill, { ...f.bill, lines: [{ ...f.bill.lines[0], quantity: 2 }] }],
  ]) {
    const row = f.match(orders, changed).rows[0];
    assert.equal(row.status, 'review');
    assert.equal(row.bill, null);
  }
});

test('unverified sale eligibility and unknown pack conversions cannot imply a known stock estimate', () => {
  const f = fixture();
  const report = f.match([{ ...f.order, eligibilityUnverified: true }]);
  assert.equal(report.rows[0].status, 'review');
  assert.deepEqual(report.rows[0].candidates, []);
  assert.equal(report.stock[0].unmatchedUnits, null);
  assert.equal(report.stock[0].previewAvailable, null);
  f.state.listings[0].verified = false;
  const unknownPack = f.match();
  assert.equal(unknownPack.rows[0].status, 'unmapped');
  assert.equal(unknownPack.stock[0].previewAvailable, null);
});

test('duplicate reference claimants and shared ledgers require human attribution', () => {
  const f = fixture();
  const twins = f.match([f.order, { ...f.order, orderItemId: 'OI-2' }]);
  assert.deepEqual(
    twins.rows.map((r) => r.status),
    ['review', 'review'],
  );
  const duplicate = f.match([f.order], [f.bill, { ...f.bill, externalId: 'other-guid' }]);
  assert.equal(duplicate.rows[0].status, 'review');
  f.saved.rules.push({ ...f.scope, ...f.rule, accountId: 'other-seller' });
  const shared = f.match();
  assert.equal(shared.rows[0].status, 'review');
  f.saved.links.push({
    ...shared.links.get(f.order.orderItemId)!.get(f.bill.externalId)!,
    accountId: 'other-seller',
  });
  assert.equal(f.match().rows[0].candidates.length, 0);
});

test('a shared order reference on two lines for the same stock item cannot identify a partial bill by coincident quantity', () => {
  const f = fixture();
  const orders = [f.order, { ...f.order, orderItemId: 'OI-2', quantity: 2 }];
  const partial = f.match(orders, [f.bill]);
  assert.equal(partial.rows[0].status, 'review');
  assert.equal(partial.rows[0].bill, null);
  assert.ok(partial.rows.every((row) => row.status !== 'matched'));
  assert.equal(partial.stock[0].unmatchedUnits, 3);
  const consolidated = { ...f.bill, lines: [{ ...f.bill.lines[0], quantity: 3 }] };
  const aggregate = f.match(orders, [consolidated]);
  assert.ok(aggregate.rows.every((row) => row.status !== 'matched'));
  assert.equal(aggregate.stock[0].unmatchedUnits, 3);
});

test('a manual confirmation across a missing marketplace invoice number needs review after its configured Tally reference changes', () => {
  const f = fixture();
  f.rule.reference = 'invoiceNumber';
  f.order.invoiceNumber = null;
  f.bill.reference = 'INV-123';
  const pending = f.match();
  assert.equal(pending.rows[0].status, 'review');
  f.saved.links.push(pending.links.get(f.order.orderItemId)!.get(f.bill.externalId)!);
  assert.equal(f.match().rows[0].status, 'matched');
  f.bill.reference = 'INV-456';
  const changed = f.match();
  assert.equal(changed.rows[0].status, 'review');
  assert.equal(changed.rows[0].bill, null);
  assert.equal(changed.stock[0].unmatchedUnits, 1);
});

test('an exact voucher-number lookup leaves ordinary matches alone and verifies a saved exception on later reads', () => {
  const f = fixture();
  f.order.orderId = 'FK-123';
  f.bill.reference = 'FK-132';
  const initial = f.find();
  assert.deepEqual(initial.rows[0].candidates, []);
  assert.equal(initial.rows[0].status, 'unmatched');
  assert.deepEqual(f.find(f.bill.number.slice(0, -1)).voucherMatches, []);
  const [chosen] = initial.voucherMatches;
  assert.equal(chosen.reason, null);
  assert.equal(chosen.actualReference, 'FK-132');
  assert.equal(chosen.referenceMatches, false);
  assert.equal(chosen.lines[0].quantity, 1);
  assert.ok(chosen.link);
  const saved = storeReviewedBillLink(chosen.link, 'first');
  f.saved.links.push(saved);
  assert.equal(f.match().rows[0].status, 'matched');
  assert.equal(f.match().stock[0].unmatchedUnits, 0);
  assert.equal(f.match().rows[0].manualBillId, f.bill.externalId);
  f.state.listings[0].verified = false;
  assert.equal(f.match().rows[0].status, 'review');
  assert.equal(f.match().stock[0].previewAvailable, null);
  f.state.listings[0].verified = true;
  f.bill.reference = 'FK-123';
  assert.equal(f.match().rows[0].status, 'review');
  assert.equal(f.match().stock[0].unmatchedUnits, 1);
  f.bill.reference = 'FK-132';
  f.bill.lines.push({ itemExternalId: 'another-item', unit: 'ea', quantity: 2 });
  assert.equal(f.match().rows[0].status, 'review');
  f.bill.lines.pop();
  f.saved.links.pop();
  assert.equal(f.match().rows[0].status, 'unmatched');
  assert.notEqual(
    storeReviewedBillLink(f.find().voucherMatches[0].link!, 'second').fingerprint,
    saved.fingerprint,
  );
});

test('a competing order claim prevents a voucher-number exception and invalidates one already saved', () => {
  const f = fixture();
  f.bill.reference = 'FK-132';
  const other = {
    ...f.order,
    orderItemId: 'line-2',
    orderId: 'FK-132',
    invoiceNumber: 'other-invoice',
  };
  const known = [{ accountId: 'another-seller', order: other }];
  const eligible = f.find().voucherMatches[0].link!;
  assert.match(f.find(f.bill.number, known).voucherMatches[0].reason!, /another known order/);
  f.saved.links.push(eligible);
  assert.equal(f.find(f.bill.number, known).rows[0].status, 'review');
  const contested = f.match([f.order, other]);
  assert.deepEqual(
    contested.rows.map((row) => row.status),
    ['review', 'review'],
  );
  assert.equal(contested.stock[0].unmatchedUnits, 2);
  const extra = { ...f.bill, externalId: 'another-bill', reference: f.order.orderId };
  assert.equal(f.match([f.order], [f.bill, extra]).rows[0].status, 'review');
  assert.equal(f.find(f.bill.number, [], [f.bill], [extra]).rows[0].status, 'review');
  f.saved.links.pop();
  assert.match(
    f.find(f.bill.number, [], [f.bill], [extra]).voucherMatches[0].reason!,
    /Another voucher/,
  );
  assert.deepEqual(f.find(extra.number, [], [], [extra]).voucherMatches, []);
});

test('separate mapped items on the same Flipkart order can have distinct assignments in one voucher', () => {
  const f = fixture();
  f.bill.reference = 'wrong';
  const sibling = {
    ...f.order,
    orderItemId: 'another-line',
    listingId: 'another-listing',
    sku: 'another-sku',
  };
  const listing = { ...f.catalogue.listings[0], id: sibling.listingId, sku: sibling.sku };
  f.catalogue.listings.push(listing);
  const target = f.state.listings.find(
    (row) => row.sku === f.order.sku && row.location === f.order.locationId,
  )!;
  const mapped = {
    ...target,
    id: 'another-mapping',
    marketplaceListingId: listing.id,
    sku: listing.sku,
    itemId: f.state.items[1].id,
  };
  f.state.listings.push(mapped);
  const known = [{ accountId: f.scope.accountId, order: sibling }];
  assert.ok(f.find(f.bill.number, known).voucherMatches[0].link);
  mapped.itemId = f.stock.id;
  assert.match(f.find(f.bill.number, known).voucherMatches[0].reason!, /another known order/);
});

test('voucher inspection explains stock, date, ownership and order status blockers without issuing an assignment', () => {
  const f = fixture();
  f.bill.reference = 'FK-132';
  const checkBill = (bill: TallySalesBill, problem: RegExp) => {
    const [choice] = f.find(bill.number, [], [bill]).voucherMatches;
    assert.match(choice.reason!, problem);
    assert.equal(choice.link, undefined);
  };
  checkBill({ ...f.bill, date: '2026-11-19' }, /before the order/);
  checkBill({ ...f.bill, lines: [] }, /no line/);
  checkBill({ ...f.bill, lines: [{ ...f.bill.lines[0], quantity: 3 }] }, /unit and quantity/);
  checkBill({ ...f.bill, lines: [{ ...f.bill.lines[0], unit: 'pairs' }] }, /unit and quantity/);
  checkBill({ ...f.bill, lines: [f.bill.lines[0], f.bill.lines[0]] }, /one line/);
  for (const change of [
    { stockDisposition: 'cancelled' as const },
    { stockDisposition: 'uncertain' as const },
    { eligibilityUnverified: true as const },
    { stockIdentityConflict: true as const },
    { quantity: 3 },
  ]) {
    const known = [{ accountId: f.scope.accountId, order: { ...f.order, ...change } }];
    const [choice] = f.find(f.bill.number, known).voucherMatches;
    assert.match(choice.reason!, /unverified or conflicting/);
    assert.equal(choice.link, undefined);
  }
  const [choice] = f.find().voucherMatches;
  f.saved.links.push({ ...choice.link!, accountId: 'second-seller' });
  checkBill(f.bill, /already assigned/);
});
