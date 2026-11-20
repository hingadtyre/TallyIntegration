import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FlipkartBillingClient,
  FlipkartBillingError,
} from '../../src/adapters/flipkart-billing.js';

const from = '2026-11-01T00:00:00.000Z';
const to = '2026-11-08T00:00:00.000Z';
const token = 'test-account-token';
const search = 'https://api.flipkart.net/sellers/v3/shipments/filter';
const baseItem = {
  orderItemId: 'line-a',
  orderId: 'order-a',
  orderDate: '2026-11-03T12:00:00Z',
  listingId: 'listing-a',
  sku: ' TYRE-PAIR',
  quantity: 2,
  status: 'PACKED',
  is_replacement: false,
  courierReturn: false,
  serviceProfile: 'Seller_Fulfilment',
};
const shipment = {
  shipmentId: 'shipment-a',
  locationId: 'location-a',
  hold: false,
  shipmentType: 'NORMAL',
  orderItems: [baseItem],
};
const empty = () => Response.json({ hasMore: false, shipments: [] });

test('optional classification fields leave an identified line visible for review, and unzoned seller timestamps use IST', async () => {
  let count = 0;
  const client = new FlipkartBillingClient({
    request: async () =>
      ++count === 1
        ? Response.json({
            hasMore: false,
            shipments: [
              {
                ...shipment,
                hold: undefined,
                orderItems: [
                  {
                    ...baseItem,
                    orderDate: '2026-11-03T17:30:00',
                    is_replacement: undefined,
                    courierReturn: undefined,
                    status: undefined,
                  },
                ],
              },
            ],
          })
        : empty(),
  });
  const orders = await client.readOrders(token, from, to, true);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].eligibilityUnverified, true);
  assert.equal(orders[0].orderDate, '2026-11-03T12:00:00.000Z');
  assert.equal(count, 4);
});

test('order errors expose the actionable request limit without exposing provider text', async () => {
  const client = new FlipkartBillingClient({
    request: async () => new Response('private order data', { status: 429 }),
  });
  await assert.rejects(
    client.readOrders(token, from, to),
    (error) =>
      error instanceof FlipkartBillingError &&
      /limiting order requests/.test(error.message) &&
      !error.message.includes('private'),
  );
});

test('reads the review window across four dispatch partitions and pages, retaining exact order and invoice line identities', async () => {
  const partitions: string[] = [];
  let invoiceReads = 0;
  const client = new FlipkartBillingClient({
    request: async (input, options) => {
      const url = String(input);
      assert.equal(options?.redirect, 'error');
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + token);
      if (url.endsWith('/invoices')) {
        assert.equal(options?.method, 'GET');
        assert.equal(url, 'https://api.flipkart.net/sellers/v3/shipments/shipment-a/invoices');
        invoiceReads++;
        return Response.json({
          invoices: [
            {
              shipmentId: 'shipment-a',
              InvoiceNumber: 'FY26-42',
              orderItems: [{ orderItemId: 'line-a' }],
            },
          ],
        });
      }
      if (options?.method === 'GET') {
        assert.equal(url, search + '?next_token=second');
        return Response.json({
          hasMore: false,
          shipments: [
            {
              ...shipment,
              orderItems: [baseItem, { ...baseItem, orderItemId: 'line-b', status: 'APPROVED' }],
            },
          ],
        });
      }
      assert.equal(url, search);
      assert.equal(options?.method, 'POST');
      const body = JSON.parse(String(options.body));
      assert.deepEqual(body.filter.serviceProfiles, ['NON_FBF']);
      assert.deepEqual(body.filter.orderDate, { from, to });
      assert.equal(body.pagination.pageSize, 20);
      partitions.push(body.filter.type + '-' + body.filter.shipmentTypes[0]);
      if (partitions.length === 1)
        return Response.json({
          hasMore: true,
          nextPageUrl: '/sellers/v3/shipments/filter?next_token=second',
          shipments: [shipment],
        });
      return empty();
    },
  });
  const orders = await client.readOrders(token, from, to, true);
  assert.deepEqual(partitions, [
    'preDispatch-NORMAL',
    'preDispatch-SELF',
    'postDispatch-NORMAL',
    'postDispatch-SELF',
  ]);
  assert.equal(invoiceReads, 1);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders[0], {
    orderItemId: 'line-a',
    orderId: 'order-a',
    listingId: 'listing-a',
    invoiceNumber: 'FY26-42',
    sku: ' TYRE-PAIR',
    locationId: 'location-a',
    quantity: 2,
    orderDate: '2026-11-03T12:00:00.000Z',
  });
  assert.equal(orders[1].invoiceNumber, null);
});

test('excludes held, cancelled, returned, replacement and other fulfilment orders and never reads invoices in order-reference mode', async () => {
  const items = [
    { status: 'CANCELLED' },
    { status: 'RETURN_REQUESTED' },
    { courierReturn: true },
    { is_replacement: true },
    { serviceProfile: 'FBF' },
    { orderDate: '2026-09-01T00:00:00Z' },
  ].map((fields, index) => ({ ...baseItem, orderItemId: 'excluded-' + index, ...fields }));
  let count = 0;
  const client = new FlipkartBillingClient({
    request: async (url) => {
      assert.equal(String(url), search);
      if (++count > 1) return empty();
      return Response.json({
        hasMore: false,
        shipments: [
          { ...shipment, orderItems: [baseItem, ...items] },
          { ...shipment, hold: true, orderItems: [{ ...baseItem, orderItemId: 'on-hold' }] },
        ],
      });
    },
  });
  assert.deepEqual(
    (await client.readOrders(token, from, to)).map((line) => line.orderItemId),
    ['line-a'],
  );
});

test('a partial search, unsafe cursor, repeated cursor or contradictory line rejects the whole review', async () => {
  for (const badUrl of [
    'https://example.test/sellers/v3/shipments/filter?next_token=x',
    '/sellers/v3/shipments/labels?next_token=x',
    '?other=x',
  ]) {
    let reads = 0;
    const client = new FlipkartBillingClient({
      request: async () => {
        reads++;
        return Response.json({ hasMore: true, nextPageUrl: badUrl, shipments: [shipment] });
      },
    });
    await assert.rejects(client.readOrders(token, from, to), /incomplete/);
    assert.equal(reads, 1);
  }
  const repeated = new FlipkartBillingClient({
    request: async () =>
      Response.json({ hasMore: true, nextPageUrl: '?next_token=x', shipments: [shipment] }),
  });
  await assert.rejects(repeated.readOrders(token, from, to), /incomplete/);
  const contradictory = new FlipkartBillingClient({
    request: async () =>
      Response.json({
        hasMore: false,
        shipments: [shipment, { ...shipment, orderItems: [{ ...baseItem, quantity: 3 }] }],
      }),
  });
  await assert.rejects(contradictory.readOrders(token, from, to), /incomplete/);
  let count = 0;
  const partial = new FlipkartBillingClient({
    request: async () =>
      ++count === 1
        ? Response.json({ hasMore: false, shipments: [shipment] })
        : new Response('Customer payload', { status: 503 }),
  });
  await assert.rejects(
    partial.readOrders(token, from, to),
    (error) => error instanceof Error && !error.message.includes('Customer payload'),
  );
});

test('an unavailable JSON invoice has no reference and an invoice for a different shipment never matches', async () => {
  const read = (invoice: () => Response) => {
    let count = 0;
    return new FlipkartBillingClient({
      request: async (input) => {
        if (String(input).endsWith('/invoices')) return invoice();
        return ++count === 1 ? Response.json({ hasMore: false, shipments: [shipment] }) : empty();
      },
    }).readOrders(token, from, to, true);
  };
  const orders = await read(
    () => new Response('pdf content', { headers: { 'Content-Type': 'application/pdf' } }),
  );
  assert.equal(orders[0].invoiceNumber, null);
  await assert.rejects(
    read(() =>
      Response.json({
        invoices: [
          {
            shipmentId: 'someone-else',
            invoiceNumber: '42',
            orderItems: [{ orderItemId: 'line-a' }],
          },
        ],
      }),
    ),
    /incomplete/,
  );
});

test('stock history includes hold, forward, return and cancellation searches for both seller shipment types', async () => {
  const partitions: string[] = [];
  const rows = [
    { ...baseItem, orderItemId: 'sold' },
    { ...baseItem, orderItemId: 'shipped', status: 'SHIPPED' },
    { ...baseItem, orderItemId: 'pending-return', status: 'RETURN_REQUESTED' },
    { ...baseItem, orderItemId: 'returned', status: 'RETURNED' },
    { ...baseItem, orderItemId: 'rto', courierReturn: true },
    { ...baseItem, orderItemId: 'rto-addon', add_ons: [{ is_rto: true }] },
    { ...baseItem, orderItemId: 'replacement', is_replacement: true },
    { ...baseItem, orderItemId: 'new-status', status: 'NEW_STATE' },
    { ...baseItem, orderItemId: 'missing-flag', is_replacement: undefined },
  ];
  const client = new FlipkartBillingClient({
    request: async (input, options) => {
      if (options?.method === 'GET') {
        assert.equal(String(input), search + '?next_token=stock-page-2');
        return Response.json({ hasMore: false, shipments: [{ ...shipment, orderItems: rows }] });
      }
      const { filter } = JSON.parse(String(options?.body));
      const kind = filter.shipmentTypes[0];
      assert.deepEqual(filter.serviceProfiles, ['NON_FBF']);
      partitions.push([kind, filter.type, filter.cancellationType ?? filter.hold ?? ''].join('/'));
      const found = (orderItems: unknown[], hold = false) =>
        Response.json({
          hasMore: false,
          shipments: [{ ...shipment, hold, shipmentType: kind, orderItems }],
        });
      if (kind !== 'NORMAL') return empty();
      if (filter.type === 'preDispatch' && filter.hold)
        return found([{ ...baseItem, orderItemId: 'held' }], true);
      if (filter.type === 'postDispatch') {
        assert.ok(filter.states.includes('RETURN_REQUESTED') && filter.states.includes('RETURNED'));
        return Response.json({
          hasMore: true,
          nextPageUrl: '?next_token=stock-page-2',
          shipments: [{ ...shipment, orderItems: [{ ...baseItem, status: 'SHIPPED' }] }],
        });
      }
      if (filter.type === 'cancelled') {
        const cancellation = {
          ...baseItem,
          status: 'CANCELLED',
          cancellationDate: '2026-11-05T12:00:00Z',
        };
        return found([
          { ...cancellation, orderItemId: filter.cancellationType },
          { ...cancellation, orderItemId: 'courier-cancel', courierReturn: true },
          { ...cancellation, orderItemId: 'no-cancellation-date', cancellationDate: undefined },
          { ...cancellation, orderItemId: 'line-a' },
        ]);
      }
      return empty();
    },
  });
  const orders = await client.readStockOrders(token, from, to);
  for (const kind of ['NORMAL', 'SELF'])
    for (const part of [
      'preDispatch/true',
      'preDispatch/false',
      'postDispatch/',
      'cancelled/buyerCancellation',
      'cancelled/sellerCancellation',
      'cancelled/marketplaceCancellation',
    ])
      assert.ok(partitions.includes(kind + '/' + part));
  assert.equal(partitions.length, 12);
  const byId = new Map(orders.map((order) => [order.orderItemId, order]));
  assert.ok(byId.has('sold'));
  assert.equal(byId.get('sold')?.stockDisposition, undefined);
  assert.equal(byId.get('sold')?.stockDispatchObserved, undefined);
  assert.equal(byId.get('shipped')?.stockDisposition, undefined);
  assert.equal(byId.get('shipped')?.stockReconciliationRequired, undefined);
  assert.equal(byId.get('buyerCancellation')?.stockReconciliationRequired, undefined);
  for (const id of [
    'line-a',
    'sellerCancellation',
    'pending-return',
    'returned',
    'rto',
    'rto-addon',
  ])
    assert.equal(byId.get(id)?.stockReconciliationRequired, true, id);
  for (const id of ['line-a', 'shipped', 'pending-return', 'returned', 'rto', 'rto-addon'])
    assert.equal(byId.get(id)?.stockDispatchObserved, true, id);
  assert.equal(byId.get('buyerCancellation')?.stockDisposition, 'cancelled');
  assert.equal(byId.get('marketplaceCancellation')?.stockDisposition, 'cancelled');
  for (const id of [
    'line-a',
    'sellerCancellation',
    'held',
    'replacement',
    'pending-return',
    'returned',
    'rto',
    'rto-addon',
    'new-status',
    'missing-flag',
    'courier-cancel',
    'no-cancellation-date',
  ]) {
    assert.equal(byId.get(id)?.stockDisposition, 'uncertain', id);
    assert.equal(byId.get(id)?.eligibilityUnverified, true, id);
  }
});

test('stock history spans the fixed start in overlapping bounded windows and counts a boundary line once', async () => {
  const start = '2026-10-03T12:00:00.000Z';
  const cutoff = '2026-11-03T12:00:00.000Z';
  const windows = new Set<string>();
  const client = new FlipkartBillingClient({
    request: async (_input, options) => {
      const { filter } = JSON.parse(String(options?.body));
      windows.add(filter.orderDate.from + '/' + filter.orderDate.to);
      if (filter.type === 'preDispatch' && !filter.hold && filter.shipmentTypes[0] === 'NORMAL')
        return Response.json({ hasMore: false, shipments: [shipment] });
      return empty();
    },
  });
  assert.equal((await client.readStockOrders(token, start, to)).length, 1);
  assert.deepEqual([...windows], [start + '/' + cutoff, cutoff + '/' + to]);
});

test('incomplete stock history never returns the successful subset', async () => {
  const client = new FlipkartBillingClient({
    request: async (_input, options) => {
      const { filter } = JSON.parse(String(options?.body));
      if (filter.type === 'preDispatch' && !filter.hold && filter.shipmentTypes[0] === 'NORMAL')
        return Response.json({ hasMore: false, shipments: [shipment] });
      if (filter.cancellationType === 'sellerCancellation')
        return Response.json({ hasMore: true, shipments: [] });
      return empty();
    },
  });
  await assert.rejects(client.readStockOrders(token, from, to), /incomplete/);
});

test('stock searches reaching the provider cap exhaust both smaller windows and retain a disappearing line for review', async () => {
  let pages = 0;
  let windowSize = '';
  const ranges = new Set<string>();
  const client = new FlipkartBillingClient({
    request: async (_input, options) => {
      if (options?.body) {
        const { filter } = JSON.parse(String(options.body));
        if (filter.type !== 'preDispatch' || filter.hold || filter.shipmentTypes[0] !== 'NORMAL')
          return empty();
        windowSize = filter.orderDate.from + '/' + filter.orderDate.to;
        ranges.add(windowSize);
      }
      if (windowSize === from + '/' + to) {
        pages++;
        const chunk = Array.from({ length: 20 }, () => shipment);
        return Response.json({
          hasMore: pages < 250,
          nextPageUrl: '?next_token=' + pages,
          shipments: chunk,
        });
      }
      if (windowSize.startsWith(from + '/'))
        return Response.json({
          hasMore: false,
          shipments: [
            { ...shipment, orderItems: [{ ...baseItem, orderItemId: 'in-complete-window' }] },
          ],
        });
      return empty();
    },
  });
  const orders = await client.readStockOrders(token, from, to);
  assert.deepEqual(
    orders.map((order) => [order.orderItemId, order.stockDisposition]),
    [
      ['in-complete-window', undefined],
      ['line-a', 'uncertain'],
    ],
  );
  assert.equal(pages, 250);
  assert.equal(ranges.size, 3);
});
