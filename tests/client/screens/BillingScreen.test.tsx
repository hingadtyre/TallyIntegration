import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type {
  BillLookup,
  BilledOrderItem,
  BillingReport,
  BillingRow,
  BillingRule,
  PendingOrderResult,
  TrackedBillHistory,
} from '../../../src/shared/billing-contracts.js';
import { initialState } from '../../../src/server/seed.js';
import { createApp } from '../../../src/server/http.js';
import { MarketplaceService } from '../../../src/server/marketplace-service.js';
import { InventoryService } from '../../../src/server/service.js';
import { saleDay } from '../../../src/server/billing-matcher.js';
import { close, listen, storageFixture } from '../../support/server-fixture.js';
import { requestJson } from '../../../src/client/api.js';
import { formatIndiaDay } from '../../../src/client/format.js';
import { App } from '../../../src/client/App.js';
import { BillingListingMappings } from '../../../src/client/screens/BillingListingMappings.js';
import { BillingResults } from '../../../src/client/screens/BillingResults.js';
import { BillingScreen } from '../../../src/client/screens/BillingScreen.js';
import { BillingSetup } from '../../../src/client/screens/BillingSetup.js';
import { StockCoverageSetup } from '../../../src/client/screens/StockCoverageSetup.js';
import {
  act,
  fireEvent,
  render,
  response,
  screen,
  waitFor,
  within,
} from '../../support/client-dom.js';

const rule: BillingRule = {
  ledgerId: 'trade-07',
  ledgerName: 'Online sales north',
  field: 'manual',
  reference: 'orderId',
};
const candidate = { id: 'voucher-a', number: 'INV-4', date: '2026-11-19' };
const item: BillingRow = {
  orderItemId: 'OI-82',
  orderId: 'ORDER-2',
  listingId: 'listing-pair',
  orderDate: '2026-11-18T18:45:00Z',
  sku: 'PAIR-4',
  location: 'Shop',
  quantity: 1,
  baseUnits: 2,
  status: 'review',
  reason: 'Choose the corresponding bill.',
  bill: null,
  candidates: [candidate, { ...candidate, id: 'voucher-b' }],
};
const report: BillingReport = {
  previewId: 'preview-a',
  from: '2026-10-21T18:30:00.000Z',
  to: '2026-11-20',
  checkedAt: '2026-11-20T07:00:00Z',
  rule,
  rows: [item],
  stock: [
    {
      name: 'Sample tyre',
      unit: 'tyres',
      physical: 6,
      keepBackUnits: 0,
      unmatchedUnits: 2,
      previewAvailable: 4,
    },
  ],
};

const billLookup: BillLookup = {
  reviewId: 'search-a',
  orderDate: item.orderDate!,
  orderItemId: item.orderItemId,
  orderId: item.orderId,
  sku: item.sku,
  ledgerName: rule.ledgerName,
  itemName: 'Sample tyre',
  unit: 'tyres',
  baseUnits: 2,
  expectedReference: item.orderId,
  field: 'reference',
  bills: [
    {
      ...candidate,
      lines: [{ itemName: 'Sample tyre', quantity: 2, unit: 'tyres' }],
      referenceMismatch: true,
      recordedReference: 'ODER-2',
      issue: null,
    },
  ],
};

test('an incomplete fulfilment check shares verified bills with Billed, retries only the failed group and replaces competing matches', async (t) => {
  const scope = { companyId: 'company', accountId: 'seller' };
  const from = '2026-11-15T18:30:00.000Z';
  const billed = {
    orderId: item.orderId,
    orderItemId: item.orderItemId,
    orderDate: item.orderDate!,
    sku: item.sku,
    bill: candidate,
    method: 'automatic' as const,
  };
  const order = {
    ...billed,
    status: 'matched' as const,
    reason: 'Reference and item match.',
    canFindBill: false,
    fulfilment: 'standard' as const,
  };
  const check = {
    id: 'check-1',
    from,
    to: '2026-11-20T12:00:00.000Z',
    complete: false,
    groups: [
      { group: 'standard' as const, count: 1 },
      { group: 'selfShip' as const, count: 0 },
      { group: 'express' as const, count: null, error: 'Flipkart could not check Express orders.' },
      { group: 'smart' as const, count: 0 },
      { group: 'fbf' as const, count: 0 },
    ],
  };
  const initial: TrackedBillHistory = { check, orders: [order], billed: [billed] };
  let finishRetry!: (response: Response) => void;
  const calls: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, '/api/billing/tracked-bills');
    calls.push(JSON.parse(String(init?.body)));
    if (calls.length === 1) return response(initial);
    return new Promise<Response>((resolve) => {
      finishRetry = resolve;
    });
  });
  render(
    <BillingResults
      report={null}
      trackingFrom={from}
      tracking={{
        ...scope,
        revision: 0,
        onFind: () => assert.fail(),
        onRelease: () => assert.fail(),
      }}
      busy={false}
      confirmed
      onMatch={assert.fail}
      onUnmatch={assert.fail}
    />,
  );
  fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'billed' } });
  await screen.findByText('Fulfilment check · Incomplete');
  assert.ok(screen.getByText('Unknown'));
  assert.match(screen.getByRole('table', { name: 'Tracked orders' }).textContent!, /INV-4/);
  assert.ok(screen.getByText('Flipkart could not check Express orders.'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry Express orders' }));
  assert.match(screen.getByRole('table', { name: 'Tracked orders' }).textContent!, /INV-4/);
  assert.equal(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Checking Express orders…' }).disabled,
    true,
  );
  assert.deepEqual(calls, [scope, { ...scope, checkId: check.id, retryGroup: 'express' }]);
  const reviews = [order, { ...order, orderItemId: 'express-item', fulfilment: 'express' }].map(
    (row) => ({ ...row, status: 'review', reason: 'Two order items claim this bill.' }),
  );
  await act(async () =>
    finishRetry(
      response({
        check: {
          ...check,
          id: 'check-2',
          complete: true,
          groups: check.groups.map((row) =>
            row.group === 'express' ? { group: 'express', count: 1 } : row,
          ),
        },
        orders: reviews,
        billed: [],
      }),
    ),
  );
  assert.ok(screen.getByText('Fulfilment check · Complete'));
  assert.equal(screen.queryByText('Unknown'), null);
  assert.equal(screen.queryByText(candidate.number), null);
  fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'unresolved' } });
  const table = within(screen.getByRole('table', { name: 'Tracked orders' }));
  assert.equal(table.getAllByRole('row').length, 3);
  assert.equal(table.getAllByText('Needs review').length, 2);
  assert.ok(table.getByText('Express'));
  assert.equal(calls.length, 2);
});

test('verified seller counts remain visible while another seller or an invoice check is retried', async (t) => {
  const scope = { companyId: 'company', accountId: 'shop' };
  const from = '2026-11-15T18:30:00.000Z';
  const check = {
    id: 'partial-1',
    from,
    to: '2026-11-20T12:00:00.000Z',
    complete: false,
    groups: [
      {
        group: 'standard' as const,
        count: 8,
        error: 'Stockbridge could not check orders for Seller B.',
      },
      {
        group: 'express' as const,
        count: 0,
        error: 'Stockbridge could not check invoice details for Seller B.',
      },
    ],
  };
  const orders = Array.from({ length: 8 }, (_, i) => ({
    orderId: 'OD-' + i,
    orderItemId: 'item-' + i,
    sku: 'tyre',
    orderDate: check.to,
    status: 'unmatched' as const,
    reason: 'No verified Tally bill was found for this sale.',
    canFindBill: false,
  }));
  const calls: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, '/api/billing/tracked-bills');
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    const groups = check.groups.map((group) => ({
      ...group,
      error: calls.length === 3 || group.group === body.retryGroup ? undefined : group.error,
    }));
    return response({
      orders,
      billed: [],
      check: {
        ...check,
        id: 'partial-' + calls.length,
        complete: groups.every((group) => !group.error),
        groups,
      },
    });
  });
  render(
    <BillingResults
      trackingFrom={from}
      tracking={{
        ...scope,
        revision: 0,
        onFind: () => assert.fail(),
        onRelease: () => assert.fail(),
      }}
      busy={false}
    />,
  );
  await screen.findByText('Order counts complete · Bill checks incomplete');
  const counts = within(screen.getByLabelText('Order item counts by fulfilment type'));
  assert.ok(counts.getByText('8'));
  assert.ok(counts.getByText('0'));
  assert.equal(counts.queryByText('Unknown'), null);
  assert.ok(counts.getByText('Stockbridge could not check orders for Seller B.'));
  assert.equal(
    within(screen.getByRole('table', { name: 'Tracked orders' })).getAllByRole('row').length,
    9,
  );
  fireEvent.click(counts.getByRole('button', { name: 'Retry Standard checks' }));
  await waitFor(() =>
    assert.equal(counts.queryByRole('button', { name: 'Retry Standard checks' }), null),
  );
  assert.ok(counts.getByText('8'));
  fireEvent.click(counts.getByRole('button', { name: 'Retry Express checks' }));
  await screen.findByText('Fulfilment check · Complete');
  assert.deepEqual(calls, [
    scope,
    { ...scope, checkId: 'partial-1', retryGroup: 'standard' },
    { ...scope, checkId: 'partial-2', retryGroup: 'express' },
  ]);
});

test('empty tracked orders share the horizontal inset of the status filter', async (t) => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/client/styles.css', 'utf8');
  document.head.append(style);
  t.after(() => style.remove());
  t.mock.method(globalThis, 'fetch', async () => response({ orders: [], billed: [] }));
  render(
    <BillingResults
      tracking={{
        companyId: 'company',
        accountId: 'seller',
        revision: 0,
        onFind: () => assert.fail(),
        onRelease: () => assert.fail(),
      }}
      busy={false}
    />,
  );
  const message = await screen.findByText(
    'No tracked orders for this seller since the starting date.',
  );
  const filters = screen.getByLabelText('Order status').closest('.billing-filters')!;
  const filterStyle = window.getComputedStyle(filters);
  const messageStyle = window.getComputedStyle(message);
  const inset = Number.parseFloat(filterStyle.paddingLeft);
  assert.ok(inset > 0);
  assert.equal(
    Number.parseFloat(messageStyle.marginLeft) + Number.parseFloat(messageStyle.paddingLeft),
    inset,
  );
});

test('a failed check cannot announce zero orders, and expired or late retries cannot replace a new seller check', async (t) => {
  const from = '2026-11-15T18:30:00.000Z';
  const props = (accountId: string) => ({
    report: null,
    trackingFrom: from,
    confirmed: true,
    busy: false,
    onMatch: assert.fail,
    onUnmatch: assert.fail,
    tracking: {
      companyId: 'company',
      accountId,
      revision: 0,
      onFind: () => assert.fail(),
      onRelease: () => assert.fail(),
    },
  });
  const counts = new Map<string, number>();
  let finishOld!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(url, '/api/billing/tracked-bills');
    if (body.retryGroup) {
      if (body.accountId === 'first')
        return new Promise<Response>((resolve) => {
          finishOld = resolve;
        });
      return response({ error: 'The check expired. Refresh tracked orders.' }, 409);
    }
    const reads = (counts.get(body.accountId) ?? 0) + 1;
    counts.set(body.accountId, reads);
    return response({
      orders: [],
      billed: [],
      check: {
        id: body.accountId,
        from,
        to: from,
        complete: reads > 1,
        groups: [
          {
            group: 'express',
            count: reads > 1 ? 0 : null,
            error: reads > 1 ? undefined : 'Could not check ' + body.accountId,
          },
        ],
      },
    });
  });
  const view = render(<BillingResults {...props('first')} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry Express orders' }));
  assert.ok(screen.getByText('No order items are available from the completed checks.'));
  assert.equal(
    screen.queryByText('No tracked orders for this seller since the starting date.'),
    null,
  );
  view.rerender(<BillingResults {...props('second')} />);
  await screen.findByText('Could not check second');
  await act(async () =>
    finishOld(
      response({
        orders: [],
        billed: [],
        check: { id: 'old', from, to: from, complete: true, groups: [] },
      }),
    ),
  );
  assert.ok(screen.getByText('Could not check second'));
  fireEvent.click(screen.getByRole('button', { name: 'Retry Express orders' }));
  await screen.findByText(/The check expired/);
  assert.equal(screen.queryByText('Unknown'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tracked orders' }));
  await screen.findByText('Fulfilment check · Complete');
  assert.ok(screen.getByText('No tracked orders for this seller since the starting date.'));
});

test('all filters use the same seller history, including older Smart orders, reviewed claims and verified cancellations', async (t) => {
  const from = '2026-08-01T00:00:00.000Z';
  const tracked = {
    orderId: 'OD-HIST',
    orderItemId: 'AUG-1',
    orderDate: '2026-08-01T10:00:00.000Z',
    sku: 'summer',
    canFindBill: true,
    reason: 'Awaiting a bill.',
  };
  const automatic = {
    ...tracked,
    bill: { id: 'old', number: 'SALE-55', date: '2026-08-03' },
    method: 'automatic' as const,
  };
  const confirmed = { ...automatic, orderItemId: 'AUG-2', method: 'seller-confirmed' as const };
  const history: TrackedBillHistory = {
    orders: [
      { ...automatic, status: 'matched' },
      { ...confirmed, status: 'matched' },
      { ...tracked, orderItemId: 'SMART-OLD', fulfilment: 'smart', status: 'unmatched' },
      {
        ...tracked,
        orderItemId: 'CONFLICT',
        status: 'review',
        reason: 'Two orders claim the same bill.',
      },
      { ...tracked, orderItemId: 'CANCELLED', status: 'cancelled', canFindBill: false },
    ],
    billed: [automatic, confirmed],
  };
  let reads = 0;
  let finishRefresh!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    switch (url) {
      case '/api/billing/workspace':
        return response({ rule, report, trackingFrom: from });
      case '/api/billing/coverage':
        return response({ from, current: true, checkedThrough: null });
      case '/api/billing/tracked-bills':
        assert.deepEqual(JSON.parse(String(init?.body)), {
          companyId: 'company',
          accountId: 'seller',
        });
        if (++reads === 2) return response({ error: 'Tally is offline.' }, 503);
        if (reads === 3)
          return new Promise<Response>((resolve) => {
            finishRefresh = resolve;
          });
        return response(history);
      default:
        throw new Error('Unexpected request ' + url);
    }
  });
  render(
    <BillingScreen
      companyId="company"
      accountId="seller"
      inventory={initialState('demo', 'unused')}
      onSaveMapping={async () => assert.fail()}
      onAccountChange={assert.fail}
      onConnect={assert.fail}
    />,
  );
  const table = () => within(screen.getByRole('table', { name: 'Tracked orders' }));
  await screen.findByText('SMART-OLD');
  assert.equal(table().getAllByRole('row').length, 6);
  assert.ok(table().getByText('CANCELLED'));
  assert.equal(
    screen.queryByText(item.orderItemId),
    null,
    'the preview cannot add rows to the tracked result',
  );
  assert.equal(screen.queryByRole('table', { name: 'Order and bill matches' }), null);
  const filter = screen.getByLabelText('Order status');
  fireEvent.change(filter, { target: { value: 'unresolved' } });
  assert.equal(table().getAllByRole('row').length, 3);
  assert.ok(table().getByText('SMART-OLD'));
  assert.ok(table().getByText('CONFLICT'));
  assert.equal(table().queryByText('CANCELLED'), null);
  fireEvent.change(filter, { target: { value: 'billed' } });
  assert.equal(table().getAllByRole('row').length, 3);
  assert.ok(table().getByText('Automatic'));
  assert.ok(table().getByText('Seller-confirmed'));
  const input = screen.getByLabelText('Search by bill or order number');
  fireEvent.change(input, { target: { value: '  le-55 ' } });
  assert.equal(table().getAllByRole('row').length, 3);
  fireEvent.change(input, { target: { value: 'od-hi' } });
  assert.ok(table().getByText('AUG-1'));
  fireEvent.change(input, { target: { value: 'aug-2' } });
  assert.equal(table().getAllByRole('row').length, 2);
  assert.match(table().getByRole('row', { name: /AUG-2/ }).textContent!, /3 Aug 2026/);
  assert.equal(reads, 1, 'filter and search reuse the same check');
  fireEvent.change(input, { target: { value: 'not-an-order' } });
  assert.ok(screen.getByText('No order items match your search.'));
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tracked orders' }));
  await screen.findByText(/Tally is offline/);
  assert.equal(
    screen.queryByRole('table', { name: 'Tracked orders' }),
    null,
    'stale matches are hidden',
  );
  fireEvent.change(filter, { target: { value: 'all' } });
  assert.ok(table().getByText('AUG-1'));
  assert.equal(table().getAllByText(/Saved order item/).length, history.orders.length);
  assert.equal(table().queryByRole('button'), null);
  assert.equal(table().queryByText('SALE-55'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tracked orders' }));
  await waitFor(() => assert.equal(typeof finishRefresh, 'function'));
  await act(async () =>
    finishRefresh(response({ orders: [history.orders[0]], billed: [automatic] })),
  );
  assert.ok(table().getByText('AUG-1'));
  assert.equal(table().queryByText('AUG-2'), null);
  assert.equal(reads, 3);
});

test('billed search covers every tracked page and excludes preview-only bills before the saved date', async (t) => {
  const billed = Array.from({ length: 57 }, (_, index): BilledOrderItem => ({
    orderId: 'OD-' + index,
    orderItemId: 'history-' + index.toString().padStart(2, '0'),
    orderDate: '2026-11-15',
    sku: 'rubber',
    bill: { ...candidate, number: 'TALLY-' + index },
    method: 'automatic',
  }));
  const orders = billed.map((row) => ({
    ...row,
    status: 'matched',
    reason: 'Matched by reference.',
    canFindBill: false,
  }));
  t.mock.method(globalThis, 'fetch', async () => response({ orders, billed }));
  const before: BillingRow = {
    ...item,
    status: 'matched',
    manualBillId: candidate.id,
    bill: candidate,
    orderDate: '2026-11-01',
  };
  const props = {
    trackingFrom: '2026-11-10',
    tracking: {
      companyId: 'company',
      accountId: 'seller',
      revision: 0,
      onFind: () => assert.fail(),
      onRelease: () => assert.fail(),
    },
    confirmed: true,
    busy: false,
    onMatch: assert.fail,
    onUnmatch: assert.fail,
  };
  const view = render(<BillingResults {...props} report={{ ...report, rows: [before] }} />);
  await screen.findByText('Showing 50 of 57 tracked order items');
  const table = () => within(screen.getByRole('table', { name: 'Tracked orders' }));
  assert.equal(table().getAllByRole('row').length, 51);
  fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'billed' } });
  const input = screen.getByLabelText('Search by bill or order number');
  fireEvent.change(input, { target: { value: 'TALLY-56' } });
  assert.ok(table().getByText('history-56'));
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  fireEvent.click(screen.getByRole('button', { name: 'Show more tracked orders' }));
  assert.equal(table().getAllByRole('row').length, 58);
  assert.equal(table().queryByText(candidate.number), null);
  fireEvent.change(input, { target: { value: 'history' } });
  assert.equal(table().getAllByRole('row').length, 51);
  view.rerender(<BillingResults {...props} report={null} />);
  assert.equal(
    screen.getByLabelText<HTMLInputElement>('Search by bill or order number').value,
    'history',
  );
  assert.equal(table().queryByText(candidate.number), null);
});

test('finding a bill from a preview separates duplicate voucher numbers and requires a fresh mismatch acknowledgement', async (t) => {
  const inventory = initialState('demo', 'unused');
  const seller = inventory.accounts[0];
  const scope = { companyId: 'company', accountId: seller.id };
  const savedRule: BillingRule = { ...rule, field: 'reference' };
  const currentReport = {
    ...report,
    rule: savedRule,
    rows: [
      item,
      {
        ...item,
        orderItemId: 'needs-mapping',
        status: 'unmapped',
        baseUnits: null,
        reason: 'Map this listing to a Tally stock item first.',
        candidates: [],
      },
    ],
  };
  let searches = 0;
  let links = 0;
  let previews = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    switch (String(url)) {
      case '/api/billing/workspace':
        return response({ rule: savedRule, report: currentReport });
      case '/api/billing/coverage':
        return response({ from: null, current: false, checkedThrough: null });
      case '/api/billing/pending':
        return response({ trackingStarted: false, listings: [] });
      case '/api/billing/find-bill':
        searches++;
        assert.deepEqual(body, {
          ...scope,
          orderItemId: item.orderItemId,
          billNumber: 'INV-4',
          previewId: report.previewId,
        });
        return response({
          ...billLookup,
          reviewId: 'search-' + searches,
          bills:
            searches === 1
              ? []
              : [
                  ...billLookup.bills,
                  {
                    ...billLookup.bills[0],
                    id: 'wrong-stock',
                    lines: [{ itemName: 'Other tyre', unit: 'tyres', quantity: 1 }],
                    issue: 'The stock item differs from the order.',
                  },
                ],
        });
      case '/api/billing/link-bill':
        links++;
        assert.deepEqual(body, {
          ...scope,
          orderItemId: item.orderItemId,
          billId: candidate.id,
          reviewId: 'search-3',
          acceptReferenceMismatch: true,
        });
        return response({ saved: true });
      case '/api/billing/preview':
        if (++previews === 1) return response({ error: 'Preview unavailable' }, 503);
        return response({
          ...currentReport,
          rows: [{ ...item, status: 'matched', bill: candidate, manualBillId: candidate.id }],
        });
      default:
        throw new Error('Unexpected request ' + url);
    }
  });
  render(
    <BillingScreen
      {...scope}
      inventory={inventory}
      onSaveMapping={async () => assert.fail('Unexpected mapping')}
      onAccountChange={assert.fail}
      onConnect={assert.fail}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Find Tally bill' }));
  const dialog = within(screen.getByRole('dialog'));
  const unmappedRow = within(screen.getByText('needs-mapping').closest('tr')!);
  assert.ok(unmappedRow.getByText('Map this listing to a Tally stock item first.'));
  assert.equal(unmappedRow.queryByText('Find Tally bill'), null);
  const input = dialog.getByRole('textbox', { name: 'Exact Tally bill number' });
  fireEvent.change(input, { target: { value: ' INV-4 ' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Search bills' }));
  await dialog.findByText(/No sales bill with this number/);
  fireEvent.click(dialog.getByRole('button', { name: 'Recheck bill' }));
  const select = await dialog.findByRole('combobox', { name: 'Matching Tally vouchers' });
  assert.ok(dialog.getByRole('option', { name: /Tally voucher ID wrong-stock/ }));
  fireEvent.change(select, { target: { value: 'wrong-stock' } });
  assert.ok(dialog.getByText('The stock item differs from the order.'));
  assert.ok(dialog.getByRole<HTMLButtonElement>('button', { name: 'Confirm bill link' }).disabled);
  fireEvent.change(select, { target: { value: candidate.id } });
  const comparison = within(dialog.getByRole('table', { name: 'Order and bill comparison' }));
  assert.ok(dialog.getByText(seller.name));
  assert.ok(dialog.getByRole('img', { name: 'Flipkart' }));
  assert.ok(comparison.getByRole('columnheader', { name: 'Flipkart order item' }));
  assert.ok(comparison.getByText(item.orderId));
  assert.ok(comparison.getByText('ODER-2'));
  assert.equal(comparison.getAllByText('19 Nov 2026').length, 2);
  assert.ok(dialog.getByRole<HTMLButtonElement>('button', { name: 'Confirm bill link' }).disabled);
  fireEvent.click(dialog.getByRole('checkbox'));
  fireEvent.click(dialog.getByRole('button', { name: 'Recheck bill' }));
  fireEvent.change(await dialog.findByRole('combobox', { name: 'Matching Tally vouchers' }), {
    target: { value: candidate.id },
  });
  assert.equal(dialog.getByRole<HTMLInputElement>('checkbox').checked, false);
  fireEvent.click(dialog.getByRole('checkbox'));
  fireEvent.click(dialog.getByRole('button', { name: 'Confirm bill link' }));
  await screen.findByText('Preview unavailable');
  assert.ok(screen.getByText('Tally bill linked to ' + item.orderItemId + '.'));
  assert.equal(screen.queryByRole('dialog'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
  await screen.findByRole('button', { name: 'Release manual match' });
  assert.equal(links, 1);
});

test('tracked orders show current bills and support locating and releasing an older order’s voucher', async (t) => {
  const scope = { companyId: 'company', accountId: 'seller' };
  const tracked = { ...report, period: 'tracking' as const };
  const older = {
    orderItemId: 'old-item',
    orderId: 'old-order',
    orderDate: '2026-08-01',
    sku: 'old-sku',
    status: 'reserved',
    reason: 'Waiting for a matching bill.',
    canFindBill: true,
  };
  let linked = false;
  let historyReads = 0;
  let lookups = 0;
  let saves = 0;
  let releases = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    switch (String(url)) {
      case '/api/billing/workspace':
        return response({ rule, report: tracked, trackingFrom: older.orderDate });
      case '/api/billing/coverage':
        return response({ from: older.orderDate, current: true, checkedThrough: null });
      case '/api/billing/pending':
        return response({ trackingStarted: true, listings: [] });
      case '/api/billing/tracked-bills':
        historyReads++;
        return response({
          orders: [
            {
              ...older,
              ...(linked && {
                status: 'matched',
                canFindBill: false,
                reason: 'Confirmed by seller.',
                manualBillId: candidate.id,
                manualBillNumber: candidate.number,
                manualBillDate: candidate.date,
                linkToken: 'release-a',
              }),
            },
            { ...older, orderItemId: item.orderItemId, status: 'matched', canFindBill: false },
            {
              ...older,
              orderItemId: 'held',
              status: 'review',
              canFindBill: false,
              reason: 'A held order needs review.',
            },
            {
              ...older,
              orderItemId: 'previous-link',
              status: 'review',
              canFindBill: false,
              manualBillId: 'previous-id',
              manualBillNumber: 'OLD-1',
              linkToken: 'old-token',
              reason: 'The earlier confirmation needs review.',
            },
          ],
          billed: [
            { ...item, bill: { ...candidate, number: 'AUTOMATIC-1' }, method: 'automatic' },
            ...(linked ? [{ ...older, bill: candidate, method: 'seller-confirmed' }] : []),
          ],
        });
      case '/api/billing/find-bill':
        assert.deepEqual(body, {
          ...scope,
          orderItemId: older.orderItemId,
          billNumber: candidate.number,
        });
        if (++lookups === 1)
          return response({ error: 'The order changed. Refresh tracked orders.' }, 409);
        return response({
          ...billLookup,
          ...older,
          field: 'manual',
          bills: [{ ...billLookup.bills[0], referenceMismatch: false }],
        });
      case '/api/billing/link-bill':
        assert.deepEqual(body, {
          ...scope,
          orderItemId: older.orderItemId,
          billId: candidate.id,
          reviewId: billLookup.reviewId,
          acceptReferenceMismatch: false,
        });
        saves++;
        linked = true;
        return response({ saved: true });
      case '/api/billing/release-bill':
        assert.deepEqual(body, {
          ...scope,
          orderItemId: older.orderItemId,
          billId: candidate.id,
          linkToken: 'release-a',
        });
        releases++;
        linked = false;
        return response({ saved: true });
      case '/api/billing/preview':
        return response(tracked);
      default:
        throw new Error('Unexpected request ' + url);
    }
  });
  render(
    <BillingScreen
      {...scope}
      inventory={initialState('demo', 'unused')}
      onSaveMapping={async () => assert.fail('Unexpected mapping')}
      onAccountChange={assert.fail}
      onConnect={assert.fail}
    />,
  );
  const history = within(await screen.findByRole('table', { name: 'Tracked orders' }));
  assert.ok(history.getByText(item.orderItemId));
  assert.ok(history.getByText('AUTOMATIC-1'));
  assert.ok(history.getByText('A held order needs review.'));
  assert.ok(history.getByText('Previously linked bill OLD-1'));
  assert.equal(history.queryByText('Bill OLD-1'), null);
  const search = screen.getByLabelText('Search by bill or order number');
  const status = screen.getByLabelText('Order status');
  fireEvent.change(search, { target: { value: ' old-1 ' } });
  assert.equal(screen.getAllByRole('row').length, 2);
  assert.ok(screen.getByText('previous-link'));
  fireEvent.change(status, { target: { value: 'unresolved' } });
  assert.ok(screen.getByText('previous-link'));
  fireEvent.change(status, { target: { value: 'billed' } });
  assert.equal(screen.queryByText('previous-link'), null);
  fireEvent.change(status, { target: { value: 'all' } });
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  const trigger = screen.getByRole('button', { name: 'Find Tally bill' });
  fireEvent.click(trigger);
  screen.getByLabelText('Exact Tally bill number').focus();
  fireEvent(screen.getByRole('dialog'), new window.Event('cancel', { cancelable: true }));
  assert.equal(document.activeElement, trigger);
  fireEvent.click(trigger);
  let dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Exact Tally bill number'), {
    target: { value: candidate.number },
  });
  fireEvent.click(dialog.getByRole('button', { name: 'Search bills' }));
  fireEvent.click(await dialog.findByRole('button', { name: 'Close and refresh tracked orders' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Find Tally bill' }));
  dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText('Exact Tally bill number'), {
    target: { value: candidate.number },
  });
  fireEvent.click(dialog.getByRole('button', { name: 'Search bills' }));
  fireEvent.click(await dialog.findByRole('button', { name: 'Confirm bill link' }));
  const linkedRow = within(await screen.findByRole('row', { name: /old-item.*Seller-confirmed/ }));
  assert.ok(linkedRow.getByText('INV-4'));
  fireEvent.click(linkedRow.getByRole('button', { name: 'Release manual match' }));
  await screen.findByText('Manual confirmation released for old-item.');
  const freshHistory = within(await screen.findByRole('table', { name: 'Tracked orders' }));
  assert.ok(freshHistory.getByRole('button', { name: 'Find Tally bill' }));
  assert.deepEqual([historyReads, saves, releases], [4, 1, 1]);
});

test('the preview shows the listing and Tally quantities in their own units', () => {
  const rows = [
    { ...item, orderItemId: 'single', baseUnits: 1 },
    { ...item, orderItemId: 'pair' },
    { ...item, orderItemId: 'two-pairs', quantity: 2, baseUnits: 4 },
    { ...item, orderItemId: 'unmapped', status: 'unmapped' as const, baseUnits: null },
  ];
  render(
    <BillingResults
      report={{ ...report, rows }}
      confirmed={false}
      busy={false}
      onMatch={assert.fail}
      onUnmatch={assert.fail}
    />,
  );
  const table = within(screen.getByRole('table', { name: 'Order and bill matches' }));
  assert.ok(table.getByText('1 listing unit · 1 Tally unit'));
  assert.ok(table.getByText('1 listing unit · 2 Tally units'));
  assert.ok(table.getByText('2 listing units · 4 Tally units'));
  assert.ok(table.getByText('1 listing unit · Tally units unknown'));
});

test('seller selects their ledger, previews, confirms setup, and explicitly matches or releases a bill', async (t) => {
  const state = initialState('demo', 'unused');
  const scope = { companyId: state.companies[0].id, accountId: state.accounts[0].id };
  const commands: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/state') return response(state);
    if (path === '/api/billing/pending') return response({ trackingStarted: false, listings: [] });
    commands.push(path);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.companyId, scope.companyId);
    assert.equal(body.accountId, scope.accountId);
    switch (path) {
      case '/api/billing/workspace':
        return response({ rule: null, report: null });
      case '/api/billing/ledgers':
        return response({
          ledgers: [
            { externalId: 'fees', name: 'Fees' },
            { externalId: rule.ledgerId, name: rule.ledgerName },
          ],
        });
      case '/api/billing/preview':
        assert.deepEqual(body, {
          ...scope,
          ledgerId: rule.ledgerId,
          field: 'manual',
          reference: 'orderId',
          days: 30,
        });
        return response(report);
      case '/api/billing/confirm':
        assert.deepEqual(body, { ...scope, previewId: report.previewId });
        return response({ rule, report: { ...report, previewId: 'confirmed' } });
      case '/api/billing/coverage':
        return response({ from: null, current: false, checkedThrough: null });
      case '/api/billing/match':
        assert.deepEqual(body, {
          ...scope,
          previewId: 'confirmed',
          orderItemId: item.orderItemId,
          billId: candidate.id,
        });
        return response({
          rule,
          report: {
            ...report,
            previewId: 'matched',
            rows: [{ ...item, status: 'matched', manualBillId: candidate.id, bill: candidate }],
          },
        });
      case '/api/billing/unmatch':
        assert.deepEqual(body, {
          ...scope,
          previewId: 'matched',
          orderItemId: item.orderItemId,
        });
        return response({ rule, report });
      default:
        throw new Error('Unexpected ' + path);
    }
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  assert.deepEqual(commands, []);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Order matching' }));
  });
  const ledger = screen.getByRole<HTMLInputElement>('combobox', {
    name: 'Sales bill ledger',
  });
  assert.equal(ledger.value, '');
  assert.equal(screen.queryByLabelText('Search ledgers'), null);
  fireEvent.focus(ledger);
  fireEvent.click(ledger);
  assert.ok(within(screen.getByRole('listbox')).getByRole('option', { name: 'Fees' }));
  fireEvent.change(ledger, { target: { value: 'NoRtH' } });
  const matches = within(screen.getByRole('listbox'));
  assert.equal(matches.getAllByRole('option').length, 1);
  fireEvent.click(matches.getByRole('option', { name: rule.ledgerName }));
  assert.equal(ledger.value, rule.ledgerName);
  assert.equal(screen.queryByRole('listbox'), null);
  fireEvent.change(screen.getByLabelText('Order period'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText(/Where do you enter/), { target: { value: 'manual' } });
  assert.equal(screen.queryByLabelText(/Which order reference/), null);
  fireEvent.click(screen.getByRole('button', { name: 'Preview matches' }));
  await screen.findByText('0 matched · 1 unresolved');
  assert.ok(screen.getByText('Ordered 19 Nov 2026'));
  assert.equal(screen.queryByRole('button', { name: 'Confirm bill match' }), null);
  fireEvent.change(screen.getByLabelText('Order period'), { target: { value: '1' } });
  assert.ok(
    (screen.getByRole('button', { name: 'Confirm billing setup' }) as HTMLButtonElement).disabled,
  );
  fireEvent.change(screen.getByLabelText('Order period'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'unresolved' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm billing setup' }));
  const bill = await screen.findByLabelText('Choose bill for OI-82');
  assert.equal(screen.getByLabelText<HTMLSelectElement>('Order status').value, 'unresolved');
  assert.ok(screen.getByRole('option', { name: /Tally voucher ID voucher-a/ }));
  assert.ok(screen.getByRole('option', { name: /Tally voucher ID voucher-b/ }));
  const confirm = screen.getByRole('button', { name: 'Confirm bill match' }) as HTMLButtonElement;
  assert.ok(confirm.disabled);
  fireEvent.change(bill, { target: { value: candidate.id } });
  fireEvent.click(confirm);
  await screen.findByText('1 matched · 0 unresolved');
  assert.ok(screen.getByText('All order items in this preview have a matched bill.'));
  fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'all' } });
  fireEvent.click(screen.getByRole('button', { name: 'Release manual match' }));
  await screen.findByText('0 matched · 1 unresolved');
  assert.deepEqual(commands, [
    '/api/billing/workspace',
    '/api/billing/ledgers',
    '/api/billing/preview',
    '/api/billing/confirm',
    '/api/billing/coverage',
    '/api/billing/match',
    '/api/billing/unmatch',
  ]);
});

test('editing a saved ledger restores dismissed searches and accepts a keyboard choice before preview', async (t) => {
  const replacement = { externalId: 'trade-18', name: 'Online sales south' };
  t.mock.method(globalThis, 'fetch', async () =>
    response({ ledgers: [{ externalId: rule.ledgerId, name: rule.ledgerName }, replacement] }),
  );
  const previews: Pick<BillingRule, 'ledgerId' | 'field' | 'reference'>[] = [];
  render(
    <BillingSetup
      companyId="company"
      accountId="seller"
      initialRule={rule}
      busy={false}
      onPreview={async (input) => {
        previews.push(input);
      }}
    />,
  );
  const ledger = await screen.findByRole<HTMLInputElement>('combobox', {
    name: 'Sales bill ledger',
  });
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Preview matches' });
  assert.equal(ledger.value, rule.ledgerName);
  assert.equal(submit.disabled, false);

  fireEvent.focus(ledger);
  fireEvent.change(ledger, { target: { value: 'no such ledger' } });
  assert.ok(screen.getByText(/No matching ledgers/i));
  fireEvent.keyDown(ledger, { key: 'Escape' });
  assert.equal(ledger.value, rule.ledgerName);
  assert.equal(screen.queryByRole('listbox'), null);
  fireEvent.change(ledger, { target: { value: 'south' } });
  fireEvent.blur(ledger);
  assert.equal(ledger.value, rule.ledgerName);
  assert.equal(screen.queryByRole('listbox'), null);
  assert.equal(submit.disabled, false);

  fireEvent.focus(ledger);
  fireEvent.change(ledger, { target: { value: 'online sales' } });
  fireEvent.keyDown(ledger, { key: 'ArrowDown' });
  assert.equal(fireEvent.keyDown(ledger, { key: 'Enter' }), false);
  assert.equal(ledger.value, replacement.name);
  assert.equal(screen.queryByRole('listbox'), null);
  assert.equal(previews.length, 0);
  fireEvent.click(submit);
  assert.deepEqual(previews, [
    { ledgerId: replacement.externalId, field: rule.field, reference: rule.reference },
  ]);
});

test('editing billing setup preserves a changed tracking date until the seller chooses to discard it', async (t) => {
  const inventory = initialState('demo', 'unused');
  const dirty: boolean[] = [];
  let discard = false;
  t.mock.method(window, 'confirm', () => discard);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/workspace')) return response({ rule, report: null });
    if (url.endsWith('/coverage')) return response({ from: null, current: false });
    if (url.endsWith('/pending')) return response({ trackingStarted: false, listings: [] });
    if (url.endsWith('/ledgers'))
      return response({ ledgers: [{ externalId: rule.ledgerId, name: rule.ledgerName }] });
    throw new Error('Unexpected route');
  });
  render(
    <BillingScreen
      companyId={inventory.companies[0].id}
      accountId={inventory.accounts[0].id}
      inventory={inventory}
      onConnect={() => {}}
      onAccountChange={() => {}}
      onSaveMapping={async () => assert.fail()}
      onUnsavedChange={(value) => {
        dirty.push(value);
      }}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Set billing start date' }));
  const date = screen.getByLabelText<HTMLInputElement>('Match orders from (India)');
  fireEvent.change(date, { target: { value: date.max } });
  assert.equal(dirty.at(-1), true);
  fireEvent.click(screen.getByRole('button', { name: 'Change setup' }));
  assert.equal(date.isConnected, true);
  assert.equal(date.value, date.max);
  discard = true;
  fireEvent.click(screen.getByRole('button', { name: 'Change setup' }));
  await screen.findByRole('combobox', { name: 'Sales bill ledger' });
  assert.equal(date.isConnected, false);
  assert.equal(dirty.at(-1), false);
  fireEvent.change(screen.getByLabelText(/Where do you enter/), { target: { value: 'number' } });
  assert.equal(dirty.at(-1), true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.equal(dirty.at(-1), false);
});

test('an empty ledger list can be reloaded and a sole ledger still requires selection', async (t) => {
  const ledgers: { externalId: string; name: string }[] = [];
  t.mock.method(globalThis, 'fetch', async () => response({ ledgers }));
  render(
    <BillingSetup
      companyId="company"
      accountId="seller"
      initialRule={null}
      busy={false}
      onPreview={async () => assert.fail('Selecting a ledger must not submit the form.')}
    />,
  );
  await screen.findByText('No ledgers were found in the selected company.');
  ledgers.push({ externalId: rule.ledgerId, name: rule.ledgerName });
  fireEvent.click(screen.getByRole('button', { name: 'Reload ledgers' }));
  const ledger = await screen.findByRole<HTMLInputElement>('combobox', {
    name: 'Sales bill ledger',
  });
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Preview matches' });
  fireEvent.change(screen.getByLabelText(/Where do you enter/), { target: { value: 'manual' } });
  fireEvent.focus(ledger);
  fireEvent.change(ledger, { target: { value: rule.ledgerName } });
  assert.ok(submit.disabled);
  fireEvent.keyDown(ledger, { key: 'Enter' });
  assert.equal(submit.disabled, false);
});

test('a late result from another seller cannot replace the selected billing workspace', async (t) => {
  const accounts = ['first', 'second'].map((id) => ({
    id,
    name: id,
    marketplace: 'flipkart' as const,
    status: 'demo' as const,
  }));
  let release!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === '/api/billing/pending')
      return response({ trackingStarted: false, listings: [] });
    if (String(input) === '/api/billing/coverage')
      return response({ from: null, current: false, checkedThrough: null });
    const { accountId } = JSON.parse(String(init?.body));
    if (accountId === 'first')
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return response({ rule: { ...rule, ledgerName: 'Second seller ledger' }, report: null });
  });
  const view = (accountId: string) => (
    <BillingScreen
      companyId="company"
      accountId={accountId}
      inventory={{ ...initialState('demo', 'unused'), accounts }}
      onSaveMapping={async () => {
        throw new Error('Unexpected mapping');
      }}
      onAccountChange={() => {}}
      onConnect={() => {}}
    />
  );
  const { rerender } = render(view('first'));
  await waitFor(() => assert.equal(typeof release, 'function'));
  rerender(view('second'));
  await screen.findByText('Second seller ledger');
  await act(async () => release(response({ rule, report })));
  assert.ok(screen.getByText('Second seller ledger'));
  assert.equal(screen.queryByText(item.orderItemId), null);
});

test('saving a billing-only date immediately checks all fulfilment types without requesting a recent preview', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T20:00:00Z') });
  const scope = { companyId: 'company', accountId: 'first' };
  const from = '2026-11-24T18:30:00.000Z';
  const groupReads: unknown[] = [];
  let previewReads = 0;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    switch (input) {
      case '/api/billing/workspace':
        return response({ rule, report: null });
      case '/api/billing/coverage':
        return response({
          setupVersion: 'reviewed',
          from: null,
          current: false,
          checkedThrough: null,
        });
      case '/api/billing/pending':
        return response({ trackingStarted: false, listings: [] });
      case '/api/billing/tracking/start':
        assert.deepEqual(body, { ...scope, fromDate: '2026-11-25', setupVersion: 'reviewed' });
        return response({
          setupVersion: 'saved',
          billingFrom: from,
          from: null,
          current: false,
          checkedThrough: null,
        });
      case '/api/billing/preview':
        previewReads++;
        return response({ error: 'Recent seller-fulfilled preview unavailable.' }, 503);
      case '/api/billing/tracked-bills': {
        groupReads.push(body);
        const order = {
          orderId: 'ORDER-FBF',
          orderItemId: 'FBF-SALE',
          sku: 'FBF-SKU',
          orderDate: from,
        };
        return response({
          orders: [{ ...order, fulfilment: 'fbf', status: 'matched', reason: 'Matched to Tally.' }],
          billed: [{ ...order, bill: candidate, method: 'automatic' }],
          check: {
            id: 'date-check',
            from,
            to: '2026-11-25T20:00:00Z',
            complete: true,
            groups: ['standard', 'selfShip', 'smart', 'express', 'fbf'].map((group) => ({
              group,
              count: group === 'fbf' ? 1 : 0,
            })),
          },
        });
      }
      default:
        throw new Error('Unexpected request ' + input);
    }
  });
  render(
    <BillingScreen
      {...scope}
      inventory={initialState('demo', 'unused')}
      onSaveMapping={async () => assert.fail()}
      onAccountChange={assert.fail}
      onConnect={assert.fail}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Set billing start date' }));
  fireEvent.change(screen.getByLabelText('Match orders from (India)'), {
    target: { value: '2026-11-25' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save billing start date' }));
  const tracked = within(await screen.findByRole('table', { name: 'Tracked orders' }));
  assert.ok(tracked.getByText('FBF-SALE'));
  assert.equal(document.activeElement, screen.getByRole('heading', { name: 'Tracked orders' }));
  assert.ok(tracked.getByText('INV-4'));
  assert.equal(previewReads, 0);
  assert.equal(screen.queryByRole('table', { name: 'Order and bill matches' }), null);
  fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'billed' } });
  assert.ok(within(screen.getByRole('table', { name: 'Tracked orders' })).getByText('INV-4'));
  assert.deepEqual(groupReads, [scope]);
});

test('a seller saves the date, finds the sample invoice and maps an older Smart order directly from Unresolved', async (t) => {
  const fixture = storageFixture(t);
  const store = fixture.open();
  const markets = new MarketplaceService(store, fixture.directory);
  const service = new InventoryService(store, { marketplaces: markets });
  const server = createApp(service, fixture.directory, undefined, undefined, markets);
  const address = await listen(server);
  const localFetch = fetch;
  t.mock.method(globalThis, 'fetch', (path: string, init?: RequestInit) =>
    localFetch(new URL(path, address), init),
  );
  const scope = { companyId: 'demo-a', accountId: 'flipkart-primary' };
  try {
    const preview = await requestJson<BillingReport>('/billing/preview', {
      ...scope,
      ledgerId: 'sample-sales-demo-a',
      field: 'reference',
      reference: 'orderId',
      days: 7,
    });
    await requestJson('/billing/confirm', { ...scope, previewId: preview.previewId });
    const listing = store
      .readMarketplace()
      .listings.find((row) => row.sku === 'SAMPLE-UNMAPPED-1')!;
    const orderDate = new Date(Date.now() - 14 * 86400_000).toISOString();
    const fromDate = saleDay(orderDate);
    store.saveBillingOrders(scope.companyId, scope.accountId, 'smart', [
      {
        orderItemId: 'SMART-ARCHIVED-LINE',
        orderId: 'SMART-ARCHIVED-ORDER',
        orderDate,
        listingId: listing.id,
        sku: listing.sku,
        locationId: listing.locations[0].id,
        quantity: 1,
        invoiceNumber: null,
      },
    ]);

    const view = render(<App />);
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Set billing start date' }));
      fireEvent.change(screen.getByLabelText('Match orders from (India)'), {
        target: { value: fromDate },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save billing start date' }));
      const all = within(await screen.findByRole('table', { name: 'Tracked orders' }));
      assert.equal(all.getAllByRole('row').length, 4);
      const matched = within(all.getByRole('row', { name: /SAMPLE-LINE-1/ }));
      assert.ok(matched.getByText('SAMPLE-INV-1'));
      assert.ok(
        matched.getByText(
          formatIndiaDay(
            preview.rows.find((row) => row.orderItemId === 'SAMPLE-LINE-1')!.bill!.date,
          ),
        ),
      );
      assert.ok(matched.getByText('Automatic'));
      fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'billed' } });
      assert.equal(all.getAllByRole('row').length, 2);
      assert.ok(all.getByRole('row', { name: /SAMPLE-INV-1/ }));
      fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'unresolved' } });
      assert.equal(all.getAllByRole('row').length, 3);
      const archived = within(all.getByRole('row', { name: /SMART-ARCHIVED-LINE/ }));
      fireEvent.click(archived.getByRole('button', { name: 'Map listing' }));
      const dialog = within(await screen.findByRole('dialog'));
      const picker = dialog.getByRole('combobox', { name: 'Tally stock item' });
      fireEvent.click(picker);
      fireEvent.change(picker, { target: { value: 'sample-d' } });
      fireEvent.click(dialog.getByRole('option', { name: /sample-d$/ }));
      fireEvent.click(dialog.getByRole('checkbox', { name: /I confirm the item/ }));
      fireEvent.click(dialog.getByRole('button', { name: 'Save mapping and check orders' }));
      // Saving the mapping and rechecking tracked orders are separate real HTTP requests.
      const mapped = await screen.findByRole(
        'row',
        { name: /SMART-ARCHIVED-LINE.*Find Tally bill/ },
        { timeout: 5000 },
      );
      assert.equal(screen.getByLabelText<HTMLSelectElement>('Order status').value, 'unresolved');
      const saved = store.read().listings.find((row) => row.sku === listing.sku);
      assert.equal(saved?.itemId, 'item-d');
      assert.equal(saved.paused, true);
      assert.equal(store.readStockCoverage(scope.companyId), null);
      assert.deepEqual(store.readMarketplace().changes, []);
      fireEvent.click(within(mapped).getByRole('button', { name: 'Find Tally bill' }));
      const lookup = within(await screen.findByRole('dialog'));
      fireEvent.change(lookup.getByLabelText('Exact Tally bill number'), {
        target: { value: 'NO-SUCH-VOUCHER' },
      });
      fireEvent.click(lookup.getByRole('button', { name: 'Search bills' }));
      assert.ok(await lookup.findByText(/No sales bill with this number was found/));
      fireEvent.click(lookup.getByRole('button', { name: 'Close dialog' }));
      fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
      const reopened = within(await screen.findByRole('table', { name: 'Tracked orders' }));
      assert.equal(reopened.getAllByRole('row').length, 4);
      assert.ok(reopened.getByRole('row', { name: /SMART-ARCHIVED-LINE.*Find Tally bill/ }));
      assert.ok(reopened.getByRole('row', { name: /SAMPLE-INV-1/ }));
    } finally {
      view.unmount();
    }
  } finally {
    await close(server);
    service.stop();
    markets.stop();
    await Promise.all([service.idle(), markets.idle()]);
  }
});

test('company stock tracking starts only after the seller confirms the chosen Indian day and every coverage condition', async (t) => {
  const scope = { companyId: 'company', accountId: 'first' };
  const dates = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = dates.format(new Date());
  const yesterday = dates.format(new Date(Date.now() - 86_400_000));
  const saved: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    switch (String(input)) {
      case '/api/billing/pending':
        return response({ trackingStarted: false, listings: [] });
      case '/api/billing/workspace':
        return response({ rule, report: null });
      case '/api/billing/coverage':
        return response({
          setupVersion: 'reviewed',
          from: null,
          current: false,
          checkedThrough: null,
        });
      case '/api/billing/coverage/start':
        saved.push(JSON.parse(String(init?.body)));
        return response({
          setupVersion: 'saved',
          from: new Date(today + 'T00:00:00+05:30').toISOString(),
          current: true,
          checkedThrough: null,
        });
      case '/api/billing/preview':
        return response({ ...report, period: 'tracking', rows: [], stock: [] });
      case '/api/billing/tracked-bills':
        return response({ orders: [], billed: [] });
      default:
        throw new Error('Unexpected request');
    }
  });
  render(
    <BillingScreen
      {...scope}
      inventory={initialState('demo', 'unused')}
      onSaveMapping={async () => {
        throw new Error('Unexpected mapping');
      }}
      onAccountChange={() => {}}
      onConnect={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Set starting stock' }));
  const date = screen.getByLabelText('Track orders from (India)') as HTMLInputElement;
  const button = screen.getByRole('button', {
    name: 'Confirm starting stock',
  }) as HTMLButtonElement;
  const confirmation = screen.getByRole('checkbox', {
    name: /I have checked all three/,
  }) as HTMLInputElement;
  assert.equal(date.max, today);
  assert.ok(button.disabled);
  fireEvent.change(date, { target: { value: yesterday } });
  fireEvent.click(confirmation);
  assert.equal(button.disabled, false);
  fireEvent.change(date, { target: { value: today } });
  assert.ok(button.disabled);
  fireEvent.click(confirmation);
  fireEvent.click(button);
  await screen.findByRole('button', { name: 'Change tracking date' });
  assert.deepEqual(saved, [
    { ...scope, fromDate: today, confirmed: true, setupVersion: 'reviewed' },
  ]);
});

test('review displays an older saved Indian day and cancel restores it without saving', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T20:00:00Z') });
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    requests.push(String(input));
    return response({
      from: '2026-09-30T18:30:00Z',
      current: false,
      checkedThrough: null,
      issue: 'Review the starting stock for this company.',
    });
  });
  render(<StockCoverageSetup companyId="company" accountId="seller" onStart={assert.fail} />);
  const date = () => screen.getByLabelText<HTMLInputElement>('Track orders from (India)');
  const acknowledgement = () =>
    screen.getByRole<HTMLInputElement>('checkbox', { name: /I have checked all three/ });
  const confirm = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm starting stock' });
  fireEvent.click(await screen.findByRole('button', { name: 'Review starting stock' }));
  assert.equal(date().value, '2026-10-01');
  assert.equal(date().min, '2026-10-28');
  assert.equal(date().max, '2026-11-26');
  assert.equal(acknowledgement().checked, false);
  fireEvent.click(acknowledgement());
  assert.ok(confirm().disabled);
  fireEvent.change(date(), { target: { value: '2026-10-28' } });
  assert.equal(acknowledgement().checked, false);
  assert.ok(confirm().disabled);
  fireEvent.click(acknowledgement());
  assert.equal(confirm().disabled, false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review starting stock' }));
  assert.equal(date().value, '2026-10-01');
  assert.equal(acknowledgement().checked, false);
  assert.ok(confirm().disabled);
  assert.deepEqual(requests, ['/api/billing/coverage']);
});

test('refreshing tracked orders picks up a tracking date and starting stock changed in another tab', async (t) => {
  const original = '2026-11-19T18:30:00.000Z';
  const changed = '2026-11-22T18:30:00.000Z';
  let savedFrom = original;
  let checks = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    switch (url) {
      case '/api/billing/workspace':
        return response({ rule, report: null, trackingFrom: savedFrom });
      case '/api/billing/coverage':
        return response(
          savedFrom === original
            ? { from: null, billingFrom: savedFrom, current: false }
            : { from: savedFrom, current: true },
        );
      case '/api/billing/tracked-bills':
        checks++;
        return response({
          orders: [],
          billed: [],
          check: {
            id: String(checks),
            from: savedFrom,
            to: '2026-11-25T04:00:00.000Z',
            complete: true,
            groups: [],
          },
        });
      default:
        throw new Error('Unexpected request ' + url);
    }
  });
  render(
    <BillingScreen
      companyId="company"
      accountId="seller"
      inventory={initialState('demo', 'unused')}
      onSaveMapping={async () => assert.fail()}
      onAccountChange={assert.fail}
      onConnect={assert.fail}
    />,
  );
  await screen.findByText('Orders placed since 20 Nov 2026 (India)');
  await screen.findByText('Fulfilment check · Complete');
  fireEvent.click(screen.getByRole('button', { name: 'Change tracking date' }));
  const oldDate = screen.getByLabelText<HTMLInputElement>('Match orders from (India)');
  assert.equal(oldDate.value, '2026-11-20');
  savedFrom = changed;
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tracked orders' }));
  await screen.findByText('Orders placed since 23 Nov 2026 (India)');
  fireEvent.click(await screen.findByRole('button', { name: 'Change tracking date' }));
  assert.equal(
    screen.getByLabelText<HTMLInputElement>('Track orders from (India)').value,
    '2026-11-23',
  );
  assert.equal(checks, 2, 'adopting the completed check does not fetch Flipkart and Tally again');
});

test('changing the company date refreshes tracked orders; the short preview runs inside setup', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T20:00:00Z') });
  const inventory = initialState('demo', 'unused');
  const scope = { companyId: inventory.companies[0].id, accountId: inventory.accounts[0].id };
  const originalFrom = '2026-11-23T18:30:00.000Z';
  const changedFrom = '2026-11-25T18:30:00.000Z';
  let trackingFrom = originalFrom;
  const saves: unknown[] = [];
  const periods: (string | number)[] = [];
  let failNextHistory = false;
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    if (input === '/api/state') return response(inventory);
    const body = JSON.parse(String(init?.body));
    switch (input) {
      case '/api/billing/workspace':
        return response({ rule, trackingFrom, report });
      case '/api/billing/coverage':
        return response({
          setupVersion: 'reviewed',
          from: trackingFrom,
          current: true,
          checkedThrough: null,
        });
      case '/api/billing/coverage/start':
        saves.push(body);
        if (saves.length === 1) return response({ error: 'Reconcile earlier sales first.' }, 409);
        trackingFrom = changedFrom;
        failNextHistory = true;
        return response({
          setupVersion: 'saved',
          from: changedFrom,
          current: true,
          checkedThrough: null,
        });
      case '/api/billing/tracked-bills':
        if (failNextHistory) {
          failNextHistory = false;
          return response({ error: 'Order check temporarily unavailable.' }, 503);
        }
        return response({
          orders: [
            {
              ...item,
              orderItemId: trackingFrom === originalFrom ? 'EARLIER-ORDER' : 'CURRENT-ORDER',
              orderDate: trackingFrom,
              status: 'unmatched',
              canFindBill: true,
            },
          ],
          billed: [],
        });
      case '/api/billing/ledgers':
        return response({ ledgers: [{ externalId: rule.ledgerId, name: rule.ledgerName }] });
      case '/api/billing/preview':
        periods.push(body.days);
        return response({
          ...report,
          from: '2026-11-19T18:30:00.000Z',
          to: '2026-11-25T20:00:00.000Z',
          rows: [{ ...item, orderItemId: 'PREVIEW-ORDER' }],
        });
      default:
        throw new Error('Unexpected request ' + input);
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  await screen.findByText('EARLIER-ORDER');
  assert.equal(screen.queryByLabelText('Order period'), null);
  assert.equal(screen.queryByText(item.orderItemId), null);
  assert.deepEqual(periods, []);
  fireEvent.click(screen.getByRole('button', { name: 'Change tracking date' }));
  assert.ok(
    screen.getByText(
      'Saving this date changes tracking for all participating sellers in ' +
        inventory.companies[0].name +
        '.',
    ),
  );
  const date = screen.getByLabelText<HTMLInputElement>('Track orders from (India)');
  const confirmation = screen.getByRole<HTMLInputElement>('checkbox', {
    name: /I have checked all three/,
  });
  assert.equal(date.value, '2026-11-24');
  fireEvent.change(date, { target: { value: '2026-11-26' } });
  fireEvent.click(confirmation);
  const save = screen.getByRole('button', { name: 'Confirm starting stock' });
  fireEvent.click(save);
  await screen.findByText('Reconcile earlier sales first.');
  assert.equal(trackingFrom, originalFrom);
  assert.ok(screen.getByText('EARLIER-ORDER'));
  fireEvent.click(save);
  await screen.findByText('Order check temporarily unavailable.');
  assert.equal(screen.queryByText('EARLIER-ORDER'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh tracked orders' }));
  await screen.findByText('CURRENT-ORDER');
  assert.deepEqual(periods, []);
  fireEvent.click(screen.getByRole('button', { name: 'Change setup' }));
  assert.equal(screen.queryByRole('table', { name: 'Tracked orders' }), null);
  fireEvent.change(screen.getByLabelText('Order period'), { target: { value: '7' } });
  const preview = await screen.findByRole<HTMLButtonElement>('button', { name: 'Preview matches' });
  await waitFor(() => assert.equal(preview.disabled, false));
  fireEvent.click(preview);
  await screen.findByText('PREVIEW-ORDER');
  assert.ok(screen.getByRole('table', { name: 'Available stock preview' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to tracked orders' }));
  await screen.findByText('CURRENT-ORDER');
  assert.equal(screen.queryByText('PREVIEW-ORDER'), null);
  assert.deepEqual(periods, [7]);
  assert.deepEqual(
    saves,
    Array(2).fill({ ...scope, fromDate: '2026-11-26', confirmed: true, setupVersion: 'reviewed' }),
  );
});

test('maps a listing once and checks tracked orders outside the current billing preview', async (t) => {
  const state = initialState('demo', 'unused');
  const originalItem = state.items.find((row) => row.id === 'item-a')!;
  const replacement = state.items.find((row) => row.id === 'item-d')!;
  replacement.name = originalItem.name;
  const listing = state.listings.find((row) => !row.itemId)!;
  const company = state.companies[0];
  company.automation = true;
  listing.marketplaceListingId = 'FK-71';
  const source = { listingId: 'FK-71', sku: listing.sku, location: listing.location };
  const scope = { companyId: company.id, accountId: listing.accountId };
  const ids = ['OI-earlier', 'OI-later'];
  const commands: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/state') return response(state);
    const body = JSON.parse(String(init?.body));
    commands.push(path);
    switch (path) {
      case '/api/billing/workspace':
        return response({ rule, report: { ...report, rows: [], stock: [] } });
      case '/api/billing/coverage':
        return response({ current: true, from: report.from });
      case '/api/billing/pending':
        assert.deepEqual(body, scope);
        return response({
          trackingStarted: true,
          listings: [{ ...source, orderItemIds: ids, mapped: !!listing.itemId }],
        });
      case '/api/mappings':
        assert.deepEqual(body, {
          listingId: listing.id,
          itemId: 'item-d',
          expectedUnit: 'tyres',
          listingVersion: listing.version,
          confirmPackEvidence: true,
          packSize: 1,
          packSource: 'manual',
          sourceScope: 'company',
          tyreFloor: false,
          keepPaused: true,
          orderSource: { ...scope, listingId: 'FK-71', locationId: listing.location },
        });
        listing.itemId = 'item-d';
        listing.paused = true;
        return response(state);
      case '/api/billing/pending/recheck':
        assert.deepEqual(body, { ...scope, ...source });
        if (commands.filter((path) => path === '/api/billing/pending/recheck').length === 1)
          return response({ error: 'Tally is unavailable.' }, 409);
        return response({
          ...source,
          rows: [
            {
              orderItemId: ids[0],
              status: 'matched',
              baseUnits: 2,
              reason: 'Reference, stock item and quantity match.',
              bill: { id: 'b2', number: 'INV-2', date: '2026-11-19' },
            },
            {
              orderItemId: ids[1],
              status: 'reserved',
              baseUnits: 1,
              reason: 'Awaiting a matching bill.',
            },
          ],
        });
      case '/api/billing/preview':
        return response({ ...report, previewId: 'updated', rows: [], stock: [] });
      default:
        throw new Error('Unexpected request ' + path);
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Map listing' }));
  const dialog = within(screen.getByRole('dialog'));
  const picker = dialog.getByRole<HTMLInputElement>('combobox', { name: 'Tally stock item' });
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: 'mIlAzE' } });
  const results = within(dialog.getByRole('listbox'));
  assert.equal(results.getAllByRole('option').length, 2);
  assert.equal(results.queryByRole('option', { name: /sample-e/ }), null);
  fireEvent.click(results.getByRole('option', { name: /tyres · sample-a$/ }));
  const units = dialog.getByLabelText<HTMLInputElement>('Tally units per sale');
  const confirmation = () =>
    dialog.getByRole<HTMLInputElement>('checkbox', { name: /I confirm the item/ });
  fireEvent.change(units, { target: { value: '4' } });
  fireEvent.click(confirmation());
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: 'No such stock item' } });
  assert.ok(dialog.getByText('No items match this search.'));
  assert.equal(fireEvent.keyDown(picker, { key: 'Escape' }), false);
  assert.ok(picker.value.endsWith('tyres · sample-a'));
  assert.equal(units.value, '4');
  assert.equal(confirmation().checked, true);

  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: 'sample-d' } });
  fireEvent.keyDown(picker, { key: 'Enter' });
  assert.ok(picker.value.endsWith('tyres · sample-d'));
  assert.equal(confirmation().checked, false);
  fireEvent.change(dialog.getByLabelText('Tally units per sale'), { target: { value: '1' } });
  const pause = dialog.getByRole('checkbox', {
    name: /Keep this listing paused/,
  }) as HTMLInputElement;
  assert.equal(pause.checked, false);
  fireEvent.click(pause);
  fireEvent.click(confirmation());
  fireEvent.click(dialog.getByRole('button', { name: 'Save mapping and check orders' }));
  await screen.findByText('Tally is unavailable.');
  const retry = await screen.findByRole<HTMLButtonElement>('button', { name: 'Retry order check' });
  await waitFor(() => assert.equal(retry.disabled, false));
  fireEvent.click(retry);
  await screen.findByText('1 billed · 1 awaiting a bill · 1 Tally unit reserved');
  fireEvent.click(screen.getByText('Order item details'));
  const [billed, reserved] = screen.getAllByRole('listitem');
  assert.ok(within(billed).getByText('OI-earlier · Billed in Tally'));
  assert.ok(within(billed).getByText('Tally bill INV-2 · 19 Nov 2026'));
  assert.ok(within(reserved).getByText('OI-later · Reserved for this order'));
  assert.equal(within(reserved).queryByText(/INV-2/), null);
  assert.equal(within(reserved).getByRole('paragraph').textContent, 'Awaiting a matching bill.');
  assert.equal(commands.filter((path) => path === '/api/mappings').length, 1);
  assert.ok(screen.getByText('No order items in this preview'));
});

test('the order check distinguishes confirmed reservations while another order needs review', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings[0];
  const source = { listingId: 'FK-71', sku: listing.sku, location: listing.location };
  const rows: PendingOrderResult[] = [
    { orderItemId: 'pair', status: 'reserved', baseUnits: 2, reason: 'Awaiting a matching bill.' },
    { orderItemId: 'unknown', status: 'review', baseUnits: null, reason: 'Check the order.' },
  ];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === '/api/billing/pending/recheck') return response({ ...source, rows });
    assert.equal(url, '/api/billing/pending');
    return response({
      trackingStarted: true,
      listings: [{ ...source, mapped: true, orderItemIds: rows.map((row) => row.orderItemId) }],
    });
  });
  render(
    <BillingListingMappings
      companyId={state.companies[0].id}
      accountId={listing.accountId}
      inventory={state}
      report={report}
      busy={false}
      onSaveMapping={() => assert.fail('Checking saved orders must not change the mapping.')}
      onRefreshPreview={async () => {}}
    />,
  );
  fireEvent.click(await screen.findByText('Previously mapped listings (1)'));
  const check = screen.getByRole<HTMLButtonElement>('button', { name: 'Check orders' });
  fireEvent.click(check);
  await screen.findByText(
    '0 billed · 1 awaiting a bill · 2 Tally units in confirmed reservations · 1 needs review',
  );
  rows[0] = { ...rows[0], status: 'matched', reason: 'Recorded in Tally.' };
  await waitFor(() => assert.equal(check.disabled, false));
  fireEvent.click(check);
  await screen.findByText('1 billed · 0 awaiting a bill · 1 needs review');
});

test('a preview-only order completes the exact pickup of a paused SKU mapping and refreshes bill matching', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings[0];
  Object.assign(listing, {
    marketplaceListingId: item.listingId,
    skuMappingId: item.listingId,
    sku: item.sku,
    paused: true,
    location: '',
    pickupChoices: ['Shop', 'Other'],
  });
  state.listings.push({
    ...listing,
    id: 'new-location-observation',
    location: 'Shop',
    itemId: null,
    skuMappingId: undefined,
    paused: false,
    pickupChoices: undefined,
  });
  const company = state.companies[0];
  const preview = { ...report, rows: [{ ...item, status: 'unmapped' as const }] };
  const mapped: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    switch (String(url)) {
      case '/api/state':
        return response(state);
      case '/api/billing/workspace':
        return response({ rule, report: preview });
      case '/api/billing/coverage':
        return response({ current: false, from: null });
      case '/api/billing/pending':
        return response({ trackingStarted: false, listings: [] });
      case '/api/mappings': {
        const input = JSON.parse(String(init?.body));
        assert.equal(input.keepPaused, true);
        assert.equal(input.pickupLocation, 'Shop');
        assert.deepEqual(input.orderSource, {
          accountId: listing.accountId,
          companyId: company.id,
          listingId: item.listingId,
          locationId: 'Shop',
        });
        assert.equal(input.itemId, listing.itemId);
        mapped.push(input.listingId);
        listing.location = 'Shop';
        return response(state);
      }
      case '/api/billing/preview':
        return response({
          ...preview,
          previewId: 'after-mapping',
          rows: [{ ...item, status: 'matched', bill: candidate }],
        });
      default:
        throw new Error('Unexpected request ' + String(url));
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  await screen.findByText('Billing preview only');
  const pickup = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm order pickup' });
  await waitFor(() => assert.equal(pickup.disabled, false));
  fireEvent.click(pickup);
  const dialog = within(screen.getByRole('dialog'));
  assert.equal(dialog.queryByLabelText('Tally stock item'), null);
  assert.equal(dialog.queryByLabelText('Pickup location'), null);
  assert.ok(dialog.getByText(/Stock updates are paused/));
  fireEvent.click(dialog.getByRole('checkbox', { name: /I confirm the item/ }));
  fireEvent.click(dialog.getByRole('button', { name: 'Save mapping and check orders' }));
  await screen.findByText('1 matched · 0 unresolved');
  assert.deepEqual(mapped, [listing.id]);
  assert.equal(screen.queryByText('Reserved for this order'), null);
});

test('a confirmed tracking date keeps earlier and cancelled preview orders out of the mapping queue', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings.find((row) => !row.itemId)!;
  const started = '2026-11-17T18:30:00Z';
  t.mock.timers.enable({ apis: ['setInterval'] });
  let cancelled = false;
  const current = {
    ...item,
    listingId: 'active-listing',
    sku: listing.sku,
    location: listing.location,
    status: 'unmapped' as const,
  };
  const previewRows = [
    current,
    { ...current, orderItemId: 'before-start', orderDate: '2026-11-16T12:30:00Z' },
    {
      ...current,
      orderItemId: 'since-cancelled',
      listingId: 'cancelled-listing',
      sku: 'CANCELLED',
    },
  ];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    switch (String(input)) {
      case '/api/state':
        return response(state);
      case '/api/billing/workspace':
        return response({ rule, report: { ...report, rows: previewRows } });
      case '/api/billing/coverage':
        return response({ current: true, from: started });
      case '/api/billing/pending':
        return response({
          trackingStarted: true,
          listings: cancelled
            ? []
            : [
                {
                  listingId: current.listingId,
                  sku: current.sku,
                  location: current.location,
                  mapped: false,
                  orderItemIds: [current.orderItemId],
                },
              ],
        });
      default:
        throw new Error('Unexpected request ' + input);
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  const queue = within(await screen.findByRole('table', { name: 'Listings to map' }));
  await screen.findByRole('button', { name: 'Review starting stock' });
  await queue.findByText('1 tracked since starting stock');
  assert.equal(queue.getAllByRole('row').length, 2);
  assert.equal(queue.getByText('1').textContent, '1');
  assert.equal(queue.queryByText('CANCELLED'), null);
  assert.ok(screen.getByText('before-start'));
  fireEvent.click(queue.getByRole('button', { name: 'Map listing' }));
  await screen.findByRole('dialog');
  cancelled = true;
  await act(async () => t.mock.timers.tick(30_000));
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(screen.queryByRole('table', { name: 'Listings to map' }), null);
});

test('an open Order matching screen picks up newly saved orders without another Flipkart scan', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings.find((row) => !row.itemId)!;
  // Older located Inventory rows can be bound by the server against the current catalogue.
  assert.equal(listing.marketplaceListingId, undefined);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const reads: boolean[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    switch (String(input)) {
      case '/api/state':
        return response(state);
      case '/api/billing/workspace':
        return response({ rule, report: null });
      case '/api/billing/coverage':
        return response({ current: true, from: report.from });
      case '/api/billing/pending': {
        const { savedOnly } = JSON.parse(String(init?.body));
        reads.push(!!savedOnly);
        return response({
          trackingStarted: true,
          listings: savedOnly
            ? [
                {
                  listingId: 'market-id',
                  sku: listing.sku,
                  location: listing.location,
                  orderItemIds: ['new-item'],
                  mapped: false,
                },
              ]
            : [],
        });
      }
      default:
        throw new Error('Unexpected request ' + String(input));
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  await screen.findByText('No listings need a mapping from the orders checked.');
  await act(async () => t.mock.timers.tick(30_000));
  await screen.findByRole('button', { name: 'Map listing' });
  assert.deepEqual(reads, [false, true]);
});
