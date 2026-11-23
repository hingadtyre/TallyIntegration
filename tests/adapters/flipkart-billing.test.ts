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

test('verified pre-dispatch stock and billing orders accept an omitted or null courier return', async () => {
  const client = new FlipkartBillingClient({
    request: async (_url, options) => {
      const { filter } = JSON.parse(String(options?.body));
      if (filter.type !== 'preDispatch' || filter.hold === true) return empty();
      const type = filter.shipmentTypes[0];
      const items = [
        'APPROVED',
        'PACKING_IN_PROGRESS',
        'FORM_FAILED',
        'PACKED',
        'READY_TO_DISPATCH',
      ].map((status, index) => ({
        ...baseItem,
        orderItemId: type + '-' + status,
        status,
        is_replacement: type === 'NORMAL' ? false : undefined,
        isReplacement: type === 'SELF' ? false : undefined,
        serviceProfile: type === 'NORMAL' ? 'Seller_Fulfilment' : 'NON_FBF',
        courierReturn: index % 2 ? undefined : null,
      }));
      return Response.json({
        hasMore: false,
        shipments: [{ ...shipment, shipmentType: type, orderItems: items }],
      });
    },
  });
  for (const orders of [
    await client.readStockOrders(token, from, to),
    await client.readOrders(token, from, to),
  ]) {
    assert.equal(orders.length, 10);
    for (const order of orders) {
      assert.equal(order.eligibilityUnverified, undefined, order.orderItemId);
      assert.equal(order.stockDisposition, undefined, order.orderItemId);
      assert.equal(order.stockReconciliationRequired, undefined, order.orderItemId);
    }
  }
});

test('a missing courier-return flag still requires an unheld forward sale in the matching search partition', async () => {
  const missing = { ...baseItem, courierReturn: null };
  const item = (id: string, overrides: Record<string, unknown> = {}) => ({
    ...missing,
    orderItemId: id,
    ...overrides,
  });
  const client = new FlipkartBillingClient({
    request: async (_url, options) => {
      const { filter } = JSON.parse(String(options?.body));
      if (filter.shipmentTypes[0] !== 'NORMAL') return empty();
      let shipments;
      if (filter.type === 'preDispatch' && filter.hold !== true) {
        shipments = [
          { ...shipment, hold: undefined, orderItems: [item('unknown-hold')] },
          { ...shipment, shipmentType: undefined, orderItems: [item('unknown-type')] },
          {
            ...shipment,
            orderItems: [
              item('unknown-profile', { serviceProfile: null }),
              item('malformed-profile', { serviceProfile: ['NON_FBF'] }),
              item('unknown-replacement', { is_replacement: undefined }),
              item('positive-replacement-alias', { isReplacement: true }),
              item('malformed-flag', { courierReturn: 'false' }),
              item('wrong-status', { status: 'SHIPPED' }),
              item('unknown-status', { status: 'UNKNOWN' }),
              item('return-addon', { add_ons: [{ is_rto: true }] }),
              item('malformed-addon', { add_ons: [{ is_rto: 'true' }] }),
              item('positive-courier-return', { courierReturn: true }),
              item('cancel-date', { cancellationDate: to }),
            ],
          },
        ];
      } else if (filter.type === 'preDispatch')
        shipments = [{ ...shipment, hold: true, orderItems: [item('held')] }];
      else if (filter.type === 'postDispatch')
        shipments = [
          {
            ...shipment,
            orderItems: [item('wrong-partition'), item('shipped', { status: 'SHIPPED' })],
          },
        ];
      else
        shipments = [
          {
            ...shipment,
            orderItems: [
              item(filter.cancellationType, { status: 'CANCELLED', cancellationDate: to }),
            ],
          },
        ];
      return Response.json({ hasMore: false, shipments });
    },
  });
  const stock = await client.readStockOrders(token, from, to);
  assert.equal(stock.length, 19);
  for (const row of stock) {
    assert.equal(row.stockDisposition, 'uncertain', row.orderItemId);
    assert.equal(row.eligibilityUnverified, true, row.orderItemId);
  }
  const preview = await client.readOrders(token, from, to);
  assert.equal(preview.length, 11);
  for (const row of preview) assert.equal(row.eligibilityUnverified, true, row.orderItemId);
});

test('a duplicate order observation cannot clear disputed eligibility within the same stock or billing read', async () => {
  const clean = { ...baseItem, courierReturn: null };
  for (const suspect of [
    { ...clean, is_replacement: undefined },
    { ...clean, add_ons: [{ is_rto: true }] },
    { ...clean, isReplacement: true },
    { ...clean, serviceProfile: 'FBF' },
  ]) {
    for (const orderItems of [
      [suspect, clean],
      [clean, suspect],
    ]) {
      const client = new FlipkartBillingClient({
        request: async (_url, options) => {
          const { filter } = JSON.parse(String(options?.body));
          if (filter.type !== 'preDispatch' || filter.hold || filter.shipmentTypes[0] !== 'NORMAL')
            return empty();
          return Response.json({ hasMore: false, shipments: [{ ...shipment, orderItems }] });
        },
      });
      if (suspect.serviceProfile === 'FBF')
        await assert.rejects(client.readStockOrders(token, from, to), /incomplete or inconsistent/);
      else {
        const [stock] = await client.readStockOrders(token, from, to);
        assert.equal(stock.stockDisposition, 'uncertain');
      }
      const preview = await client.readOrders(token, from, to);
      if (suspect.is_replacement === undefined)
        assert.equal(preview[0].eligibilityUnverified, true);
      else assert.deepEqual(preview, []);
    }
  }
});

test('location recovery accepts confirming pre-dispatch details and rejects return, replacement or identity contradictions', async () => {
  const sale = { ...baseItem, status: 'READY_TO_DISPATCH', courierReturn: null };
  let detail: Record<string, unknown> = { ...sale, courierReturn: false };
  const client = new FlipkartBillingClient({
    request: async (_url, options) => {
      if (options?.method === 'GET')
        return Response.json({ shipments: [{ ...shipment, orderItems: [detail] }] });
      const { filter } = JSON.parse(String(options?.body));
      if (filter.type !== 'preDispatch' || filter.hold || filter.shipmentTypes[0] !== 'NORMAL')
        return empty();
      return Response.json({
        hasMore: false,
        shipments: [{ ...shipment, locationId: null, orderItems: [sale] }],
      });
    },
  });
  for (const method of ['readOrders', 'readStockOrders'] as const) {
    for (const courierReturn of [false, null, undefined]) {
      detail = { ...sale, courierReturn };
      const [order] = await client[method](token, from, to);
      assert.equal(order.locationId, shipment.locationId);
      assert.equal(order.eligibilityUnverified, undefined);
      assert.equal(order.stockDisposition, undefined);
    }
    for (const conflict of [
      { courierReturn: true },
      { add_ons: [{ is_rto: true }] },
      { add_ons: { is_rto: true } },
      { status: 'RETURNED' },
      { isReplacement: true },
      { orderItemId: 'other' },
    ]) {
      detail = { ...sale, ...conflict };
      await assert.rejects(client[method](token, from, to), /incomplete or inconsistent/);
    }
  }
});

test('dispatch evidence prevents accepting a later pre-dispatch omission while normal forward progress counts once', async () => {
  const ready = { ...baseItem, status: 'READY_TO_DISPATCH', courierReturn: null };
  const shipped = { ...baseItem, status: 'SHIPPED' };
  let orderItems = [ready, shipped];
  const client = new FlipkartBillingClient({
    request: async (_url, options) => {
      const { filter } = JSON.parse(String(options?.body));
      if (filter.type !== 'preDispatch' || filter.hold || filter.shipmentTypes[0] !== 'NORMAL')
        return empty();
      return Response.json({ hasMore: false, shipments: [{ ...shipment, orderItems }] });
    },
  });
  for (const method of ['readOrders', 'readStockOrders'] as const) {
    orderItems = [ready, shipped];
    const forward = await client[method](token, from, to);
    assert.equal(forward.length, 1);
    assert.equal(forward[0].eligibilityUnverified, undefined);
    assert.equal(forward[0].preDispatchWithoutCourierReturn, undefined);
    orderItems = [shipped, ready];
    const [regression] = await client[method](token, from, to);
    assert.equal(regression.eligibilityUnverified, true);
    if (method === 'readStockOrders') {
      assert.equal(regression.stockDisposition, 'uncertain');
      assert.equal(regression.stockReconciliationRequired, true);
      assert.equal(regression.stockDispatchObserved, true);
    }
  }
});

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
      if (body.filter.type === 'postDispatch')
        assert.deepEqual(body.filter.states, ['PICKUP_COMPLETE', 'SHIPPED', 'DELIVERED']);
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
    { ...baseItem, orderItemId: 'completed', status: 'COMPLETED' },
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
        assert.deepEqual(filter.states, ['PICKUP_COMPLETE', 'SHIPPED', 'DELIVERED']);
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
  for (const id of [
    'line-a',
    'shipped',
    'completed',
    'pending-return',
    'returned',
    'rto',
    'rto-addon',
  ])
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

test('recovers a missing location only from order details for the exact shipment and its search lines', async () => {
  const cancelledItem = { ...baseItem, status: 'CANCELLED', cancellationDate: to };
  // The observed details response omitted the cancellation date and courier-return flag.
  const detailItem = { ...baseItem, status: 'CANCELLED', courierReturn: undefined };
  const details: Record<string, unknown> = { ...shipment, orderItems: [detailItem] };
  let lookups = 0;
  const client = new FlipkartBillingClient({
    request: async (input, options) => {
      if (options?.method === 'GET') {
        assert.equal(
          String(input),
          'https://api.flipkart.net/sellers/v3/shipments?shipmentIds=shipment-a',
        );
        lookups++;
        return Response.json({ shipments: [details] });
      }
      const filter = JSON.parse(String(options?.body)).filter;
      if (
        filter.cancellationType !== 'marketplaceCancellation' ||
        filter.shipmentTypes[0] !== 'NORMAL'
      )
        return empty();
      return Response.json({
        hasMore: false,
        shipments: [
          {
            ...shipment,
            locationId: undefined,
            orderItems: [cancelledItem],
          },
        ],
      });
    },
  });
  const [order] = await client.readStockOrders(token, from, to);
  assert.equal(lookups, 1);
  assert.equal(order.locationId, 'location-a');
  assert.equal(order.stockDisposition, 'cancelled');
  details.orderItems = [{ orderItemId: baseItem.orderItemId }];
  assert.equal((await client.readStockOrders(token, from, to))[0].stockDisposition, 'cancelled');
  for (const status of ['RETURN_REQUESTED', 'RETURNED']) {
    details.orderItems = [{ ...detailItem, status }];
    const [held] = await client.readStockOrders(token, from, to);
    assert.equal(held.stockDisposition, 'uncertain');
    assert.equal(held.stockReconciliationRequired, true);
    assert.equal(held.stockDispatchObserved, true);
    assert.equal(held.eligibilityUnverified, true);
    assert.equal(held.stockReturnConflict, true);
    assert.equal(held.stockShipmentId, shipment.shipmentId);
  }
  for (const conflict of [
    { sku: 'other' },
    { listingId: 'other' },
    { orderId: 'other' },
    { quantity: 4 },
    { orderDate: to },
    { sku: undefined },
    { quantity: undefined },
    { orderDate: undefined },
    { listingId: undefined },
    { orderId: undefined },
    { serviceProfile: undefined },
    { is_replacement: undefined },
  ]) {
    details.orderItems = [{ ...detailItem, status: 'RETURN_REQUESTED', ...conflict }];
    await assert.rejects(client.readStockOrders(token, from, to), /incomplete or inconsistent/);
  }
  details.orderItems = [{ ...detailItem, status: 'RETURN_REQUESTED' }];
  for (const field of ['shipmentType', 'hold', 'locationId']) {
    const saved = details[field];
    delete details[field];
    await assert.rejects(client.readStockOrders(token, from, to), /incomplete or inconsistent/);
    details[field] = saved;
  }
  details.orderItems = [
    {
      ...detailItem,
      serviceProfile: 'NON_FBF',
      orderDate: '2026-11-03T17:30:00+05:30',
    },
  ];
  assert.equal((await client.readStockOrders(token, from, to))[0].stockDisposition, 'cancelled');
  for (const conflict of [
    { status: 'SHIPPED' },
    { courierReturn: true },
    { add_ons: [{ is_rto: true }] },
    { isReplacement: true },
    { orderId: 'different-order' },
    { listingId: 'different-listing' },
    { sku: 'different-sku' },
    { quantity: 3 },
    { orderDate: to },
    { cancellationDate: from },
    { serviceProfile: 'FBF' },
  ]) {
    details.orderItems = [{ ...detailItem, ...conflict }];
    await assert.rejects(
      client.readStockOrders(token, from, to),
      /incomplete or inconsistent/,
      JSON.stringify(conflict),
    );
  }
  details.orderItems = [detailItem];
  details.hold = true;
  await assert.rejects(client.readStockOrders(token, from, to), /incomplete or inconsistent/);
  details.hold = false;
  details.shipmentType = 'SELF';
  await assert.rejects(client.readStockOrders(token, from, to), /incomplete or inconsistent/);
  details.shipmentType = shipment.shipmentType;
  details.orderItems = [detailItem, detailItem];
  await assert.rejects(client.readStockOrders(token, from, to), /incomplete or inconsistent/);
  details.orderItems = [detailItem];
  details.shipmentId = 'other-shipment';
  await assert.rejects(client.readStockOrders(token, from, to), /incomplete or inconsistent/);
  details.shipmentId = shipment.shipmentId;
  details.orderItems = [{ ...baseItem, orderItemId: 'other-line' }];
  await assert.rejects(client.readStockOrders(token, from, to), /incomplete or inconsistent/);
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
