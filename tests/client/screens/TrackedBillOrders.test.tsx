import assert from 'node:assert/strict';
import test from 'node:test';
import { BillingScreen } from '../../../src/client/screens/BillingScreen.js';
import { initialState } from '../../../src/server/seed.js';
import { act, fireEvent, render, response, screen, within } from '../../support/client-dom.js';

const from = '2026-11-08T18:30:00.000Z';
const rule = {
  ledgerId: 'ledger',
  ledgerName: 'Marketplace sales',
  field: 'number',
  reference: 'orderId',
};
const inventory = initialState('demo', 'unused');
const scope = { companyId: inventory.companies[0].id, accountId: inventory.accounts[0].id };

function showOrders() {
  return render(
    <BillingScreen
      {...scope}
      inventory={inventory}
      onAccountChange={assert.fail}
      onConnect={assert.fail}
      onSaveMapping={async () => assert.fail()}
    />,
  );
}

test('partial counts distinguish retained identities, verified statuses, reserved units and the last complete check', async (t) => {
  const verifiedAt = '2026-11-26T02:00:00Z';
  const order = {
    orderId: 'OD-4',
    orderItemId: 'item-live',
    orderDate: from,
    sku: 'PAIR',
    status: 'reserved',
    reason: 'Awaiting a bill.',
    canFindBill: false,
  };
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/workspace')) return response({ trackingFrom: from, rule, report: null });
    if (url.endsWith('/coverage')) return response({ from, current: true });
    assert.equal(url, '/api/billing/tracked-bills');
    return response({
      billed: [],
      orders: [
        {
          ...order,
          marketplaceStatus: 'READY_TO_DISPATCH',
          statusVerifiedAt: verifiedAt,
          reserved: { quantity: 4, unit: 'tyres' },
        },
        {
          ...order,
          orderItemId: 'item-saved',
          reason: 'Bill check incomplete.',
          status: 'review',
          marketplaceStatus: 'SHIPPED',
          savedOnly: true,
        },
      ],
      check: {
        id: 'partial',
        complete: false,
        from,
        to: '2026-11-28T04:00:00Z',
        lastCompleteAt: verifiedAt,
        groups: [
          { group: 'standard', count: 1 },
          { group: 'smart', count: null },
        ],
      },
    });
  });
  showOrders();
  const table = within(await screen.findByRole('table', { name: 'Tracked orders' }));
  const live = within(table.getByRole('row', { name: /item-live/ }));
  const saved = within(table.getByRole('row', { name: /item-saved/ }));
  assert.ok(live.getByText('Ready to dispatch'));
  assert.ok(live.getByText('No matched bill'));
  assert.ok(live.getByText('4 tyres reserved'));
  assert.match(live.getByText(/Last verified/).textContent!, /26 Nov 2026/);
  assert.match(screen.getByText(/Last complete check/).textContent!, /26 Nov 2026/);
  assert.ok(saved.getByText('Shipped'));
  assert.ok(saved.getByText(/Saved order item/));
  assert.ok(saved.getByText('Bill check incomplete.'));
  assert.equal(saved.queryByText(/Last verified/), null);
  assert.ok(screen.getByText(/1 observed in this check · 1 saved from earlier checks/));
  assert.ok(screen.getByText(/1 order item across the verified fulfilment types/));
  assert.ok(screen.getByText('Unknown'));
});

test('a missing exact order lookup is seller scoped, read only and exposes the location shipment count on request', async (t) => {
  const calls: unknown[] = [];
  let finish!: (r: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/workspace')) return response({ trackingFrom: from, rule, report: null });
    if (url.endsWith('/coverage')) return response({ from, current: true });
    if (url.endsWith('/tracked-bills')) return response({ billed: [], orders: [] });
    const body = JSON.parse(String(init.body));
    calls.push([url, body]);
    if (url.endsWith('/lookup-order')) {
      if (body.orderId === 'OD-old')
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return response({
        orderId: body.orderId,
        checkedAt: from,
        items: [
          {
            orderItemId: 'line-1',
            shipmentId: 'SHP-7',
            sku: 'TYRE',
            orderDate: from,
            quantity: 2,
            locationId: 'Shop',
            marketplaceStatus: 'APPROVED',
            marketplaceHold: true,
            fulfilment: 'standard',
          },
        ],
      });
    }
    assert.equal(url, '/api/billing/pickup-count');
    return response({ shipmentCount: 3, checkedAt: from });
  });
  showOrders();
  await screen.findByText('No tracked orders for this seller since the starting date.');
  const search = screen.getByLabelText('Search by bill or order number');
  fireEvent.change(search, { target: { value: 'OD-old' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check exact order on Flipkart' }));
  fireEvent.change(search, { target: { value: '  OD-verified  ' } });
  await act(async () => finish(response({ orderId: 'OD-old', checkedAt: from, items: [] })));
  assert.equal(screen.queryByRole('heading', { name: 'Flipkart order OD-old' }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Check exact order on Flipkart' }));
  await screen.findByRole('heading', { name: 'Flipkart order OD-verified' });
  assert.ok(screen.getByText('line-1'));
  assert.ok(screen.getByText(/Shipment SHP-7/));
  assert.ok(screen.getByText(/On hold · Approved/));
  assert.ok(screen.getByText(/2 listing units/));
  assert.equal(screen.queryByRole('button', { name: 'Find Tally bill' }), null);
  fireEvent.click(
    screen.getByRole('button', { name: 'Check shipments awaiting handover at Shop' }),
  );
  await screen.findByText(/3 shipments awaiting handover for this seller at Shop/);
  assert.deepEqual(calls, [
    ['/api/billing/lookup-order', { ...scope, orderId: 'OD-old' }],
    ['/api/billing/lookup-order', { ...scope, orderId: 'OD-verified' }],
    ['/api/billing/pickup-count', { ...scope, orderId: 'OD-verified', locationId: 'Shop' }],
  ]);
});

test('receiving a whole returned item requires its full quantity confirmation and refreshes the reviewed row', async (t) => {
  const writes: unknown[] = [];
  let accepted = false;
  t.mock.method(window, 'confirm', (message: string) => {
    assert.match(message, /all 4 tyres for order item return-1/);
    return accepted;
  });
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/workspace')) return response({ trackingFrom: from, rule, report: null });
    if (url.endsWith('/coverage')) return response({ from, current: true });
    if (url.endsWith('/confirm-return')) {
      writes.push(JSON.parse(String(init.body)));
      return response({ saved: true });
    }
    assert.equal(url, '/api/billing/tracked-bills');
    return response({
      billed: [],
      orders: [
        {
          orderId: 'OD-return',
          orderItemId: 'return-1',
          orderDate: from,
          sku: 'TYRE-PAIR',
          marketplaceStatus: 'RETURNED',
          status: writes.length ? 'received' : 'reserved',
          canFindBill: false,
          reason: 'Order return.',
          ...(!writes.length && {
            reserved: { quantity: 4, unit: 'tyres' },
            returnReceipt: { quantity: 4, unit: 'tyres', token: 'receipt-1' },
          }),
        },
      ],
    });
  });
  showOrders();
  const button = await screen.findByRole('button', { name: 'Received back and sellable' });
  fireEvent.click(button);
  assert.deepEqual(writes, []);
  assert.ok(screen.getByText('4 tyres reserved'));
  accepted = true;
  fireEvent.click(button);
  await screen.findByText('Return check completed for return-1.');
  await screen.findByText('Received back and sellable');
  assert.equal(screen.queryByRole('button', { name: 'Received back and sellable' }), null);
  assert.equal(screen.queryByText('4 tyres reserved'), null);
  fireEvent.change(screen.getByLabelText('Order status'), { target: { value: 'unresolved' } });
  assert.equal(screen.queryByText('return-1'), null);
  assert.deepEqual(writes, [
    { ...scope, orderItemId: 'return-1', token: 'receipt-1', confirmed: true },
  ]);
});
