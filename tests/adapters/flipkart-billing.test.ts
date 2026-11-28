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
const searchable = ['PICKUP_COMPLETE', 'SHIPPED', 'DELIVERED'];

test('billing fulfilment groups cover each documented profile and shipment type once and retain exceptional orders', async () => {
  const types = ['NORMAL', 'SELF', 'EXPRESS'];
  for (const [group, profile, alias, expectedTypes] of [
    ['standard', 'NON_FBF', 'Seller_Fulfilment', ['NORMAL']],
    ['selfShip', 'NON_FBF', 'Seller_Fulfilment', ['SELF']],
    ['express', 'NON_FBF', 'Seller_Fulfilment', ['EXPRESS']],
    ['smart', 'FBF_LITE', 'Smart_Fulfilment', types],
    ['fbf', 'FBF', 'Flipkart_Fulfilment', types],
  ] as const) {
    const searches: string[] = [];
    const client = new FlipkartBillingClient({
      request: async (_url, options) => {
        const { filter } = JSON.parse(String(options?.body));
        assert.deepEqual(filter.serviceProfiles, [profile]);
        assert.deepEqual(filter.orderDate, { from, to });
        assert.equal(filter.shipmentTypes.length, 1);
        if (filter.type === 'postDispatch') {
          assert.equal(filter.states.length, 1);
          assert.ok(searchable.includes(filter.states[0]));
        }
        const kind = filter.shipmentTypes[0];
        const partition = [
          kind,
          filter.type,
          filter.cancellationType ?? filter.hold ?? filter.states[0],
        ].join('/');
        searches.push(partition);
        const status =
          filter.type === 'cancelled'
            ? 'CANCELLED'
            : filter.type === 'postDispatch'
              ? 'RETURNED'
              : 'PACKED';
        return Response.json({
          hasMore: false,
          shipments: [
            {
              ...shipment,
              shipmentType: kind,
              hold: filter.hold ?? false,
              orderItems: [
                {
                  ...baseItem,
                  orderItemId: partition,
                  status,
                  serviceProfile: filter.hold ? profile : alias,
                  ...(status === 'CANCELLED' && { cancellationDate: to }),
                },
              ],
            },
          ],
        });
      },
    });
    const rows = await client.readFulfilmentOrders(token, from, to, group);
    const expected = expectedTypes.flatMap((kind) => [
      kind + '/preDispatch/true',
      kind + '/preDispatch/false',
      ...searchable.map((state) => kind + '/postDispatch/' + state),
      kind + '/cancelled/buyerCancellation',
      kind + '/cancelled/sellerCancellation',
      kind + '/cancelled/marketplaceCancellation',
    ]);
    assert.deepEqual(searches.sort(), expected.sort());
    assert.equal(rows.length, searches.length);
    for (const row of rows) {
      const disposition = row.orderItemId.endsWith('/preDispatch/false')
        ? undefined
        : row.orderItemId.includes('/cancelled/')
          ? 'cancelled'
          : 'uncertain';
      assert.equal(row.stockDisposition, disposition, row.orderItemId);
    }
  }
});

test('an expanded group requires the correct profile, shipment type and every continuation before reporting its count', async () => {
  const smart = {
    ...shipment,
    shipmentType: 'EXPRESS',
    orderItems: [{ ...baseItem, serviceProfile: 'Smart_Fulfilment' }],
  };
  for (const continuation of [
    new Response('', { status: 403 }),
    Response.json({ hasMore: false, shipments: [{ ...smart, shipmentType: 'SELF' }] }),
    Response.json({ hasMore: false, shipments: [{ ...smart, orderItems: [baseItem] }] }),
  ]) {
    const client = new FlipkartBillingClient({
      request: async (url, options) => {
        if (String(url).includes('next_token=')) return continuation;
        const { filter } = JSON.parse(String(options?.body));
        if (filter.type !== 'preDispatch' || filter.hold || filter.shipmentTypes[0] !== 'EXPRESS')
          return empty();
        return Response.json({
          hasMore: true,
          nextPageUrl: '?next_token=smart',
          shipments: [smart],
        });
      },
    });
    await assert.rejects(
      client.readFulfilmentOrders(token, from, to, 'smart'),
      FlipkartBillingError,
    );
  }
});

test('normal discovery finds a shipped sale without its ID and ignores a confirmed seller cancellation in other programmes', async () => {
  const observation = '2026-11-28T12:00:00.000Z';
  const cancelled = {
    ...baseItem,
    orderItemId: 'cancelled',
    status: 'CANCELLED',
    cancellationDate: to,
  };
  const client = new FlipkartBillingClient({
    now: () => Date.parse(observation),
    request: async (input, options) => {
      assert.equal(options?.method, 'POST');
      assert.equal(String(input), search);
      const { filter } = JSON.parse(String(options.body));
      assert.equal(filter.orderIds, undefined);
      assert.equal(filter.sku, undefined);
      assert.equal(filter.skus, undefined);
      if (filter.shipmentTypes[0] !== 'NORMAL') return empty();
      let item;
      if (filter.cancellationType === 'buyerCancellation') item = cancelled;
      else if (
        filter.type === 'postDispatch' &&
        filter.states.length === 1 &&
        filter.states[0] === 'SHIPPED' &&
        filter.serviceProfiles[0] === 'NON_FBF'
      )
        item = { ...baseItem, status: 'SHIPPED', courierReturn: undefined };
      else return empty();
      return Response.json({ hasMore: false, shipments: [{ ...shipment, orderItems: [item] }] });
    },
  });
  for (const read of [
    client.readOrders(token, from, to),
    client.readStockOrders(token, from, to),
    client.readFulfilmentOrders(token, from, to, 'standard'),
  ]) {
    const row = (await read).find((item) => item.orderItemId === baseItem.orderItemId)!;
    assert.equal(row.marketplaceStatus, 'SHIPPED');
    assert.equal(row.statusVerifiedAt, observation);
    assert.equal(row.eligibilityUnverified, true);
    assert.equal(row.postDispatchWithoutCourierReturn, true);
  }
  for (const group of ['smart', 'fbf'] as const)
    assert.deepEqual(await client.readFulfilmentOrders(token, from, to, group), []);
});

test('a foreign row must have a known membership and a consistent order identity before it can be skipped', async () => {
  for (const fields of [
    { serviceProfile: 'UNRECOGNIZED' },
    { serviceProfile: ['NON_FBF'] },
    { sku: undefined },
    { orderId: undefined },
  ]) {
    const client = new FlipkartBillingClient({
      request: async () =>
        Response.json({
          hasMore: false,
          shipments: [{ ...shipment, orderItems: [{ ...baseItem, ...fields }] }],
        }),
    });
    await assert.rejects(
      client.readFulfilmentOrders(token, from, to, 'fbf'),
      /incomplete or inconsistent/,
    );
  }
});

test('bill inspection evidence is absent on a shipped line with an additional exception or a contradictory duplicate', async () => {
  const clean = { ...baseItem, status: 'SHIPPED', courierReturn: null };
  const found = (items: Record<string, unknown>[], hold = false) => ({
    ...shipment,
    hold,
    orderItems: items,
  });
  for (const result of [
    found([clean], true),
    found([{ ...clean, is_replacement: true }]),
    found([{ ...clean, isReplacement: 'unknown' }]),
    found([{ ...clean, cancellationDate: to }]),
    found([{ ...clean, add_ons: [{ is_rto: true }] }]),
    found([{ ...clean, add_ons: [{ is_rto: 'unknown' }] }]),
    found([{ ...clean, status: 'RETURNED' }]),
    found([{ ...clean, is_replacement: undefined }, clean]),
    found([clean, { ...clean, is_replacement: undefined }]),
  ]) {
    const client = new FlipkartBillingClient({
      request: async (_url, options) => {
        const { filter } = JSON.parse(String(options?.body));
        return filter.type === 'postDispatch' && filter.states[0] === 'SHIPPED'
          ? Response.json({ hasMore: false, shipments: [result] })
          : empty();
      },
    });
    const [order] = await client.readFulfilmentOrders(token, from, to, 'standard');
    assert.equal(order.eligibilityUnverified, true);
    assert.equal(order.postDispatchWithoutCourierReturn, undefined);
  }
});

test('a Smart shipment in an unexpected shipment-type filter still belongs to the verified Smart programme', async () => {
  const client = new FlipkartBillingClient({
    request: async (_url, options) => {
      const { filter } = JSON.parse(String(options?.body));
      if (
        filter.shipmentTypes[0] !== 'EXPRESS' ||
        filter.type !== 'postDispatch' ||
        filter.states[0] !== 'SHIPPED'
      )
        return empty();
      return Response.json({
        hasMore: false,
        shipments: [
          {
            ...shipment,
            shipmentType: 'SELF',
            orderItems: [{ ...baseItem, status: 'SHIPPED', serviceProfile: 'Smart_Fulfilment' }],
          },
        ],
      });
    },
  });
  const [order] = await client.readFulfilmentOrders(token, from, to, 'smart');
  assert.equal(order.marketplaceStatus, 'SHIPPED');
  assert.equal(order.eligibilityUnverified, undefined);
});

test('an order cancelled during a scan releases only verified pre-pickup stock, and confirmed returns can retrieve their bill reference', async () => {
  let firstStatus = 'READY_TO_DISPATCH';
  let lastStatus = 'CANCELLED';
  const client = new FlipkartBillingClient({
    request: async (url, options) => {
      if (String(url).endsWith('/invoices'))
        return Response.json({
          invoices: [
            {
              shipmentId: shipment.shipmentId,
              invoiceNumber: 'SALE-42',
              orderItems: [{ orderItemId: baseItem.orderItemId }],
            },
          ],
        });
      const { filter } = JSON.parse(String(options?.body));
      if (filter.shipmentTypes[0] !== 'NORMAL') return empty();
      let status;
      if (filter.type === 'preDispatch' && !filter.hold && firstStatus === 'READY_TO_DISPATCH')
        status = firstStatus;
      if (
        filter.type === 'postDispatch' &&
        filter.states[0] === 'SHIPPED' &&
        firstStatus === 'SHIPPED'
      )
        status = firstStatus;
      if (
        (filter.cancellationType === 'sellerCancellation' && lastStatus === 'CANCELLED') ||
        (filter.type === 'postDispatch' &&
          filter.states[0] === 'DELIVERED' &&
          lastStatus === 'RETURNED')
      )
        status = lastStatus;
      if (!status) return empty();
      return Response.json({
        hasMore: false,
        shipments: [
          {
            ...shipment,
            orderItems: [
              { ...baseItem, status, ...(status === 'CANCELLED' && { cancellationDate: to }) },
            ],
          },
        ],
      });
    },
  });
  assert.equal((await client.readStockOrders(token, from, to))[0].stockDisposition, 'cancelled');
  firstStatus = 'SHIPPED';
  const [conflicted] = await client.readStockOrders(token, from, to);
  assert.equal(conflicted.stockDisposition, 'uncertain');
  assert.equal(conflicted.stockReconciliationRequired, true);
  lastStatus = 'RETURNED';
  assert.equal(
    (await client.readStockOrders(token, from, to, true))[0].stockReturnVerified,
    undefined,
  );
  firstStatus = '';
  const [returned] = await client.readStockOrders(token, from, to, true);
  assert.equal(returned.stockReturnVerified, true);
  assert.equal(returned.invoiceNumber, 'SALE-42');
});

test('exact order and pickup diagnostics return bounded, read-only evidence from the specified account', async () => {
  let payload: unknown = { shipments: [shipment] };
  const urls: string[] = [];
  const client = new FlipkartBillingClient({
    now: () => Date.parse(to),
    request: async (input, options) => {
      assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + token);
      assert.equal(options?.method, 'GET');
      urls.push(String(input));
      return Response.json(payload);
    },
  });
  const exact = () => client.readExactOrder(token, 'order-a');
  assert.deepEqual(await exact(), {
    orderId: 'order-a',
    checkedAt: to,
    items: [
      {
        orderItemId: 'line-a',
        shipmentId: 'shipment-a',
        sku: ' TYRE-PAIR',
        orderDate: '2026-11-03T12:00:00.000Z',
        quantity: 2,
        locationId: 'location-a',
        marketplaceStatus: 'PACKED',
        marketplaceHold: false,
        fulfilment: 'standard',
      },
    ],
  });
  assert.equal(urls[0], 'https://api.flipkart.net/sellers/v3/shipments?orderIds=order-a');
  for (const id of ['', 'one,two', 'x'.repeat(129)])
    await assert.rejects(client.readExactOrder(token, id));
  assert.equal(urls.length, 1);
  for (const bad of [
    { shipments: [{ ...shipment, orderItems: [{ ...baseItem, orderId: 'other' }] }] },
    { shipments: [shipment, shipment] },
    { shipments: [{ ...shipment, orderItems: [{ ...baseItem, quantity: 0 }] }] },
    { shipments: null },
  ]) {
    payload = bad;
    await assert.rejects(exact(), /incomplete or inconsistent/);
  }
  payload = { shipments: [] };
  assert.deepEqual((await exact()).items, []);
  payload = [
    { vendorGroupCode: 'A', count: 2, otc: { code: 'private' } },
    { vendorGroupCode: 'B', count: 3 },
  ];
  assert.equal(await client.readHandoverCount(token, 'location-a'), 5);
  assert.equal(
    urls.at(-1),
    'https://api.flipkart.net/sellers/v3/shipments/handover/counts?locationId=location-a',
  );
  for (const bad of [
    null,
    {},
    [{ count: 1 }],
    [{ vendorGroupCode: 'A', count: -1 }],
    [{ vendorGroupCode: 'A', count: 0.5 }],
  ]) {
    payload = bad;
    await assert.rejects(
      client.readHandoverCount(token, 'location-a'),
      /incomplete or inconsistent/,
    );
  }
});

test('a slower order response can finish within the order timeout and failed reads expose only public evidence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let configuredTimeout = 0;
  t.mock.method(AbortSignal, 'timeout', (duration: number) => {
    configuredTimeout = duration;
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), duration);
    return controller.signal;
  });
  const client = new FlipkartBillingClient({
    request: async (_url, options) =>
      new Promise<Response>((resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
        setTimeout(() => resolve(Response.json({ shipments: [] })), 20_000);
      }),
  });
  const pending = client.readExactOrder(token, 'order-a');
  t.mock.timers.tick(20_000);
  assert.deepEqual((await pending).items, []);
  assert.equal(configuredTimeout, 60_000);
  for (const code of ['INVALID_STATUS_REQUESTED', 'PRIVATE_ORDER_IDENTIFIER']) {
    const bad = new FlipkartBillingClient({
      request: async () =>
        Response.json({ errors: [{ code, message: 'private customer message' }] }, { status: 400 }),
    });
    await assert.rejects(
      bad.readOrders(token, from, to),
      (error) =>
        error instanceof FlipkartBillingError &&
        error.message.includes('HTTP 400') &&
        error.message.includes('INVALID_STATUS_REQUESTED') ===
          (code === 'INVALID_STATUS_REQUESTED') &&
        !/private/i.test(error.message),
    );
  }
});

test('a warehouse order can recover its pickup and invoice from the exact shipment across service profile aliases', async () => {
  const warehouseItem = { ...baseItem, serviceProfile: 'Flipkart_Fulfilment' };
  const client = new FlipkartBillingClient({
    request: async (url, options) => {
      if (String(url).includes('shipmentIds='))
        return Response.json({
          shipments: [{ ...shipment, orderItems: [{ ...warehouseItem, serviceProfile: 'FBF' }] }],
        });
      if (String(url).endsWith('/invoices'))
        return Response.json({
          invoices: [
            {
              shipmentId: shipment.shipmentId,
              invoiceNumber: 'WAREHOUSE-42',
              orderItems: [{ orderItemId: baseItem.orderItemId }],
            },
          ],
        });
      const { filter } = JSON.parse(String(options?.body));
      if (filter.type !== 'preDispatch' || filter.hold || filter.shipmentTypes[0] !== 'NORMAL')
        return empty();
      return Response.json({
        hasMore: false,
        shipments: [{ ...shipment, locationId: undefined, orderItems: [warehouseItem] }],
      });
    },
  });
  const [order] = await client.readFulfilmentOrders(token, from, to, 'fbf', true);
  assert.equal(order.invoiceNumber, 'WAREHOUSE-42');
  assert.equal(order.locationId, shipment.locationId);
  assert.equal(order.eligibilityUnverified, undefined);
});

test('a billing group displays an identified warehouse order without a pickup for review', async () => {
  const noPickup = {
    ...shipment,
    locationId: null,
    orderItems: [{ ...baseItem, serviceProfile: 'Flipkart_Fulfilment' }],
  };
  const client = new FlipkartBillingClient({
    request: async (url, options) => {
      if (String(url).includes('shipmentIds=')) return Response.json({ shipments: [noPickup] });
      const { filter } = JSON.parse(String(options?.body));
      if (filter.type !== 'preDispatch' || filter.hold || filter.shipmentTypes[0] !== 'NORMAL')
        return empty();
      return Response.json({ hasMore: false, shipments: [noPickup] });
    },
  });
  const [row] = await client.readFulfilmentOrders(token, from, to, 'fbf');
  assert.equal(row.orderItemId, baseItem.orderItemId);
  assert.equal(row.locationId, '');
  assert.equal(row.eligibilityUnverified, true);
  assert.equal(row.stockDisposition, 'uncertain');
});

test('tracked shipments survive denied invoice access and an invalid invoice batch cannot supply partial evidence', async () => {
  const shipments = Array.from({ length: 26 }, (_, index) => ({
    ...shipment,
    shipmentId: 'shipment-' + index,
    orderItems: [{ ...baseItem, orderItemId: 'item-' + index }],
  }));
  let denied = true;
  let remainingHasInvoice = true;
  const client = new FlipkartBillingClient({
    request: async (url, options) => {
      if (String(url).endsWith('/invoices')) {
        if (String(url).includes('shipment-0,')) {
          if (denied) return new Response(null, { status: 403 });
          return Response.json({
            invoices: [
              {
                shipmentId: 'shipment-0',
                invoiceNumber: 'SUSPECT',
                orderItems: [{ orderItemId: 'item-0' }],
              },
              {
                shipmentId: 'wrong-shipment',
                invoiceNumber: 'BAD',
                orderItems: [{ orderItemId: 'item-1' }],
              },
            ],
          });
        }
        return Response.json({
          invoices: remainingHasInvoice
            ? [
                {
                  shipmentId: 'shipment-25',
                  invoiceNumber: 'FK-25',
                  orderItems: [{ orderItemId: 'item-25' }],
                },
              ]
            : [],
        });
      }
      if (String(url).includes('next_token=invoice-test'))
        return Response.json({ hasMore: false, shipments: shipments.slice(20) });
      const { filter } = JSON.parse(String(options?.body));
      if (filter.type === 'preDispatch' && !filter.hold && filter.shipmentTypes[0] === 'NORMAL')
        return Response.json({
          hasMore: true,
          nextPageUrl: '?next_token=invoice-test',
          shipments: shipments.slice(0, 20),
        });
      return empty();
    },
  });
  const read = () => client.readFulfilmentOrders(token, from, to, 'standard', true);
  const fresh = await read();
  assert.equal(fresh.length, 26);
  for (const row of fresh.slice(0, 25)) {
    assert.equal(row.invoiceNumber, null);
    assert.equal(row.invoiceLookup, 'failed');
    assert.equal(row.eligibilityUnverified, undefined);
  }
  assert.equal(fresh[25].invoiceNumber, 'FK-25');
  assert.equal(fresh[25].invoiceLookup, undefined);
  await assert.rejects(client.readStockOrders(token, from, to, true), /rejected access/);
  denied = false;
  remainingHasInvoice = false;
  const retried = await read();
  assert.equal(retried[0].invoiceNumber, null);
  assert.equal(retried[0].invoiceLookup, 'failed');
  assert.equal(retried[25].invoiceNumber, null);
  assert.equal(retried[25].invoiceLookup, 'no-number');
});

test('malformed return add-ons cannot verify a sale or release a cancelled order', async () => {
  const client = new FlipkartBillingClient({
    request: async (_url, options) => {
      const { filter } = JSON.parse(String(options?.body));
      if (filter.shipmentTypes[0] !== 'NORMAL' || filter.hold === true) return empty();
      const cancelled = filter.cancellationType === 'buyerCancellation';
      if (!cancelled && filter.type !== 'preDispatch') return empty();
      const item = {
        ...baseItem,
        ...(cancelled && { orderItemId: 'cancelled', status: 'CANCELLED', cancellationDate: to }),
        add_ons: [{ is_rto: 'true' }],
      };
      return Response.json({ hasMore: false, shipments: [{ ...shipment, orderItems: [item] }] });
    },
  });
  const orders = await client.readStockOrders(token, from, to);
  assert.equal(orders.length, 2);
  for (const order of orders) assert.equal(order.stockDisposition, 'uncertain');
  const [sale] = await client.readOrders(token, from, to);
  assert.equal(sale.eligibilityUnverified, true);
});

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
  assert.equal(stock.length, 18);
  for (const row of stock) {
    assert.equal(row.stockDisposition, 'uncertain', row.orderItemId);
    assert.equal(row.eligibilityUnverified, true, row.orderItemId);
    assert.equal(
      row.postDispatchWithoutCourierReturn,
      row.orderItemId === 'shipped' ? true : undefined,
      row.orderItemId,
    );
  }
  const preview = await client.readOrders(token, from, to);
  assert.equal(preview.length, 10);
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
      if (suspect.serviceProfile === 'FBF') {
        await assert.rejects(client.readOrders(token, from, to), /incomplete or inconsistent/);
        continue;
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
  assert.equal(count, 8);
});

test('the setup preview and tracked history both require the shipment type and fulfilment profile to verify a sale', async () => {
  for (const missing of ['shipmentType', 'serviceProfile']) {
    const partial = {
      ...shipment,
      ...(missing === 'shipmentType' && { shipmentType: undefined }),
      orderItems: [
        { ...baseItem, ...(missing === 'serviceProfile' && { serviceProfile: undefined }) },
      ],
    };
    const client = new FlipkartBillingClient({
      request: async (_url, options) => {
        const { filter } = JSON.parse(String(options?.body));
        return filter.type === 'preDispatch' && filter.shipmentTypes[0] === 'NORMAL' && !filter.hold
          ? Response.json({ hasMore: false, shipments: [partial] })
          : empty();
      },
    });
    const [preview] = await client.readOrders(token, from, to);
    const [tracked] = await client.readFulfilmentOrders(token, from, to, 'standard');
    assert.equal(preview.orderItemId, tracked.orderItemId);
    assert.equal(preview.eligibilityUnverified, true);
    assert.equal(tracked.eligibilityUnverified, true);
  }
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

test('reads the setup window across each dispatch state and pages, retaining exact order and invoice line identities', async () => {
  const partitions: string[] = [];
  let invoiceReads = 0;
  const client = new FlipkartBillingClient({
    now: () => Date.parse(to),
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
      if (body.filter.type === 'postDispatch') {
        assert.equal(body.filter.states.length, 1);
        assert.ok(searchable.includes(body.filter.states[0]));
      }
      assert.deepEqual(body.filter.orderDate, { from, to });
      assert.equal(body.pagination.pageSize, 20);
      partitions.push(body.filter.states.join(',') + '-' + body.filter.shipmentTypes[0]);
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
    'APPROVED,PACKING_IN_PROGRESS,FORM_FAILED,PACKED,READY_TO_DISPATCH-NORMAL',
    'APPROVED,PACKING_IN_PROGRESS,FORM_FAILED,PACKED,READY_TO_DISPATCH-SELF',
    ...searchable.flatMap((state) => [state + '-NORMAL', state + '-SELF']),
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
    marketplaceStatus: 'PACKED',
    marketplaceHold: false,
    statusVerifiedAt: to,
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

test('missing and PDF-only invoices preserve readable tracked shipments without a permission error', async () => {
  for (const status of [200, 404, 406, 415]) {
    const client = new FlipkartBillingClient({
      request: async (url, options) => {
        if (String(url).endsWith('/invoices'))
          return new Response(null, { status, headers: { 'content-type': 'application/pdf' } });
        const { filter } = JSON.parse(String(options?.body));
        return filter.type === 'preDispatch' && !filter.hold
          ? Response.json({ hasMore: false, shipments: [shipment] })
          : empty();
      },
    });
    const [row] = await client.readFulfilmentOrders(token, from, to, 'standard', true);
    assert.equal(row.orderItemId, baseItem.orderItemId);
    assert.equal(row.invoiceNumber, null);
    assert.equal(row.invoiceLookup, status === 404 ? 'no-number' : 'unsupported-format');
  }
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
      partitions.push(
        [kind, filter.type, filter.cancellationType ?? filter.hold ?? filter.states[0]].join('/'),
      );
      const found = (orderItems: unknown[], hold = false) =>
        Response.json({
          hasMore: false,
          shipments: [{ ...shipment, hold, shipmentType: kind, orderItems }],
        });
      if (kind !== 'NORMAL') return empty();
      if (filter.type === 'preDispatch' && filter.hold)
        return found([{ ...baseItem, orderItemId: 'held' }], true);
      if (filter.type === 'postDispatch') {
        assert.equal(filter.states.length, 1);
        if (filter.states[0] !== 'SHIPPED') return empty();
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
      ...searchable.map((state) => 'postDispatch/' + state),
      'cancelled/buyerCancellation',
      'cancelled/sellerCancellation',
      'cancelled/marketplaceCancellation',
    ])
      assert.ok(partitions.includes(kind + '/' + part));
  assert.equal(partitions.length, 16);
  const byId = new Map(orders.map((order) => [order.orderItemId, order]));
  assert.ok(byId.has('sold'));
  assert.equal(byId.get('sold')?.stockDisposition, undefined);
  assert.equal(byId.get('sold')?.stockDispatchObserved, undefined);
  assert.equal(byId.get('shipped')?.stockDisposition, undefined);
  assert.equal(byId.get('shipped')?.stockReconciliationRequired, undefined);
  assert.equal(byId.get('buyerCancellation')?.stockReconciliationRequired, undefined);
  for (const id of ['line-a', 'rto', 'rto-addon'])
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
  assert.equal(byId.get('sellerCancellation')?.stockDisposition, 'cancelled');
  for (const id of ['pending-return', 'returned']) {
    assert.equal(byId.get(id)?.stockReturnObserved, true);
    assert.equal(byId.get(id)?.stockReturnVerified, true);
    assert.equal(byId.get(id)?.stockReconciliationRequired, undefined);
  }
  for (const id of [
    'line-a',
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
