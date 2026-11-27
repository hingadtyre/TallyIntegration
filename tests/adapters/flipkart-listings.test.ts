import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FlipkartListingError,
  FlipkartListingsClient,
} from '../../src/adapters/flipkart-listings.js';
import type { MarketplaceListing } from '../../src/shared/marketplace-contracts.js';

const token = 'private-test-bearer-token';
const now = Date.parse('2026-11-18T12:00:00.000Z');
const states = [
  'ACTIVE',
  'INACTIVE',
  'READY_FOR_ACTIVATION',
  'ARCHIVED',
  'INACTIVATED_BY_FLIPKART',
];
const listing: MarketplaceListing = {
  id: 'listing-1',
  accountId: 'account-a',
  sellerId: 'seller-1',
  productId: 'product-1',
  sku: 'sku-1',
  title: 'Tyre listing',
  imageUrl: 'https://images.example.test/tyre.jpg',
  status: 'ACTIVE',
  mrp: 2000,
  sellingPrice: 1800,
  locations: [
    { id: 'warehouse-1', quantity: 10, status: 'ENABLED' },
    { id: 'warehouse-2', quantity: 20, status: 'DISABLED' },
  ],
  observedAt: '2026-11-17T12:00:00.000Z',
  version: 7,
};

function searchRow(index: number) {
  return {
    listingId: `listing-${index}`,
    sellerId: 'seller-1',
    productId: `product-${index}`,
    sku: `sku-${index}`,
    status: 'ACTIVE',
    product_name: `Tyre ${index}`,
    product_image_url: 'https://images.example.test/tyre.jpg',
    product_description: { mrp: 2000, ssp: 1800, esp: 1500 },
  };
}

function detail(index = 1) {
  return {
    listing_id: `listing-${index}`,
    product_id: `product-${index}`,
    product_url: `https://www.flipkart.com/tyre/p/itm123?pid=product-${index}`,
    listing_status: 'ACTIVE',
    price: { mrp: 2200, selling_price: 1900, currency: 'INR' },
    locations: [
      { id: 'warehouse-1', inventory: 6, pending_inventory: 99, status: 'ENABLED' },
      { id: 'warehouse-2', inventory: 9, status: 'DISABLED' },
    ],
  };
}

function detailsResponse(value: unknown) {
  return Response.json({ available: { 'sku-1': value }, unavailable: [], invalid: [] });
}

function clientForDetails(value: unknown): FlipkartListingsClient {
  return new FlipkartListingsClient({
    request: async () => detailsResponse(value),
    now: () => now,
  });
}

function safeError(uncertain: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof FlipkartListingError);
    assert.equal(error.uncertain, uncertain);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.message + error.stack, /private-test-bearer-token|private-upstream/);
    return true;
  };
}

test('account import reads every state and page, batches details by ten and uses authenticated fixed endpoints', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const datasets = new Map(states.map((state, index) => [state, [searchRow(23 + index)]]));
  datasets.set(
    'ACTIVE',
    Array.from({ length: 22 }, (_, index) => searchRow(index + 1)),
  );
  const client = new FlipkartListingsClient({
    now: () => now,
    request: async (url, options) => {
      assert.equal(options?.method, 'POST');
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.cache, 'no-store');
      assert.ok(options?.signal);
      assert.deepEqual(options?.headers, {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
      });
      assert.ok(String(url).startsWith('https://api.flipkart.net/sellers/listings/v3/'));
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path.endsWith('/product/search')) {
        const rows = datasets.get(String(body.internalState))!;
        const start = Number(body.batchNo) * 20;
        return Response.json({
          totalListingsCount: rows.length,
          listingData: rows.slice(start, start + 20),
        });
      }
      assert.ok(path.endsWith('/details'));
      const skus = body.sku_ids as string[];
      assert.ok(skus.length > 0 && skus.length <= 10);
      return Response.json({
        available: Object.fromEntries(skus.map((sku) => [sku, detail(Number(sku.slice(4)))])),
        unavailable: [],
        invalid: [],
      });
    },
  });
  const result = await client.listListings(token, 'account-a');
  assert.equal(result.length, 26);
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith('/search')).map((call) => call.body),
    [
      { batchNo: 0, internalState: 'ACTIVE' },
      { batchNo: 1, internalState: 'ACTIVE' },
      ...states.slice(1).map((state) => ({ batchNo: 0, internalState: state })),
    ],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.path.endsWith('/details'))
      .map((call) => (call.body.sku_ids as string[]).length),
    [10, 10, 6],
  );
  assert.deepEqual(result[0], {
    ...listing,
    productUrl: detail().product_url,
    packageCount: null,
    title: 'Tyre 1',
    mrp: 2200,
    sellingPrice: 1900,
    locations: [
      { id: 'warehouse-1', quantity: 6, status: 'ENABLED' },
      { id: 'warehouse-2', quantity: 9, status: 'DISABLED' },
    ],
    observedAt: new Date(now).toISOString(),
    version: 0,
  });
  assert.deepEqual(
    result.slice(-3).map((row) => row.status),
    states.slice(-3),
  );
  assert.ok(result.every((row) => row.sellerId === 'seller-1' && row.accountId === 'account-a'));
  assert.ok(result.every((row) => !Object.hasOwn(row, 'settlement')));
});

test('standard listing search uses the complete cursor chain and reads exact SKUs with parcel counts', async () => {
  const cursors: unknown[] = [];
  const originalSku = ' tyre/2';
  const client = new FlipkartListingsClient({
    request: async (url, options) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(options?.body));
      if (path.endsWith('/product/search')) return new Response(null, { status: 404 });
      if (path.endsWith('/search')) {
        cursors.push(body.page_id);
        const first = body.page_id === null;
        return Response.json({
          listings: [
            {
              listing_id: first ? 'listing-1' : 'listing-2',
              product_id: first ? 'product-1' : 'product-2',
              sku_id: first ? originalSku : 'sku-2',
            },
          ],
          has_more: first,
          next_page_id: first ? 'next' : null,
        });
      }
      assert.deepEqual(body.sku_ids, [originalSku, 'sku-2']);
      return Response.json({
        available: {
          [originalSku]: { ...detail(1), packages: [{ id: '2' }, { id: '1' }] },
          'sku-2': {
            ...detail(2),
            locations: undefined,
            packages: [],
            archived_status: 'ARCHIVED',
          },
        },
      });
    },
  });
  const result = await client.listListings(token, 'tile');
  assert.deepEqual(cursors, [null, 'next']);
  assert.deepEqual(
    result.map((row) => [row.sku, row.status, row.packageCount, row.sellerId]),
    [
      [originalSku, 'ACTIVE', 2, null],
      ['sku-2', 'ARCHIVED', null, null],
    ],
  );
  assert.deepEqual(result[1].locations, []);
  assert.equal(result[0].productUrl, detail(1).product_url);
});

test('listing details keep only Flipkart buyer product links for the returned product', async () => {
  for (const [input, expected] of [
    ['/tyre/p/itm123?pid=product-1', 'https://www.flipkart.com/tyre/p/itm123?pid=product-1'],
    ['http://flipkart.com/p/itm123', 'https://flipkart.com/p/itm123'],
    [undefined, undefined],
    [42, undefined],
    ['https://www.flipkart.com/tyre/p/itm123?pid=other', undefined],
    ['https://www.flipkart.com/tyre/p/itm123?pid=product-1&pid=other', undefined],
    ['https://www.flipkart.com/tyre/p/itm123?pid=', undefined],
    ['https://www.flipkart.com/search?q=product-1', undefined],
    ['https://www.flipkart.com.example.org/tyre/p/itm123', undefined],
    ['https://seller.flipkart.com/tyre/p/itm123', undefined],
    ['//example.org/tyre/p/itm123', undefined],
    ['https://user@www.flipkart.com/tyre/p/itm123', undefined],
    ['https://www.flipkart.com:8000/tyre/p/itm123', undefined],
    ['javascript:alert(1)', undefined],
  ] as const) {
    const client = clientForDetails({ ...detail(), product_url: input });
    const refreshed = await client.getListing(token, {
      ...listing,
      productUrl: detail().product_url,
    });
    assert.equal(refreshed.productUrl, expected);
    assert.equal(refreshed.sku, listing.sku);
  }
});

test('a repeated standard-search cursor rejects the import before any details are applied', async () => {
  let page = 0;
  const client = new FlipkartListingsClient({
    request: async (url) => {
      if (String(url).endsWith('/product/search')) return new Response(null, { status: 404 });
      page++;
      return Response.json({
        listings: [{ listing_id: `lid-${page}`, sku_id: `sku-${page}`, product_id: `p-${page}` }],
        has_more: true,
        next_page_id: 'same',
      });
    },
  });
  await assert.rejects(client.listListings(token, 'tile'), safeError(false));
  assert.equal(page, 2);
});

test('an empty account is complete only after every state is checked', async () => {
  const queried: string[] = [];
  const client = new FlipkartListingsClient({
    request: async (_url, options) => {
      queried.push(JSON.parse(String(options?.body)).internalState);
      return Response.json({ totalListingsCount: 0, listingData: [] });
    },
  });
  assert.deepEqual(await client.listListings(token, 'empty-account'), []);
  assert.deepEqual(queried, states);
});

test('search rejects mixed sellers, duplicate identities and missing identity without returning a partial import', async () => {
  for (const changes of [
    { sellerId: 'different-seller' },
    { sku: 'sku-1' },
    { listingId: 'listing-1' },
    { productId: '' },
    { sellerId: null },
    { sku: '\r\nprivate-upstream' },
  ]) {
    const client = new FlipkartListingsClient({
      request: async () =>
        Response.json({
          totalListingsCount: 2,
          listingData: [searchRow(1), { ...searchRow(2), ...changes }],
        }),
    });
    await assert.rejects(client.listListings(token, 'account-a'), safeError(false));
  }
});

test('duplicate listings across states fail instead of silently choosing one observation', async () => {
  const client = new FlipkartListingsClient({
    request: async () => Response.json({ totalListingsCount: 1, listingData: [searchRow(1)] }),
  });
  await assert.rejects(client.listListings(token, 'account-a'), safeError(false));
});

test('search validates totals, bounds work and fails on missing pages or moving totals', async () => {
  for (const response of [
    {},
    { totalListingsCount: -1, listingData: [] },
    { totalListingsCount: '1', listingData: [searchRow(1)] },
    { totalListingsCount: 20_001, listingData: [] },
    { totalListingsCount: 2, listingData: [searchRow(1)] },
    { totalListingsCount: 0, listingData: [searchRow(1)] },
  ]) {
    const client = new FlipkartListingsClient({ request: async () => Response.json(response) });
    await assert.rejects(client.listListings(token, 'account-a'), safeError(false));
  }
  for (const secondPage of [
    { totalListingsCount: 21, listingData: [] },
    { totalListingsCount: 22, listingData: [searchRow(21), searchRow(22)] },
    { totalListingsCount: 21, listingData: [searchRow(1)] },
  ]) {
    let calls = 0;
    const client = new FlipkartListingsClient({
      request: async () =>
        Response.json(
          ++calls === 1
            ? {
                totalListingsCount: 21,
                listingData: Array.from({ length: 20 }, (_, index) => searchRow(index + 1)),
              }
            : secondPage,
        ),
    });
    await assert.rejects(client.listListings(token, 'account-a'), safeError(false));
    assert.equal(calls, 2);
  }
});

test('a failure in a later state or details batch rejects the entire account import', async () => {
  for (const failDetails of [false, true]) {
    const client = new FlipkartListingsClient({
      request: async (url, options) => {
        if (String(url).endsWith('/details'))
          return Response.json({ available: {}, unavailable: ['sku-1'] });
        const body = JSON.parse(String(options?.body));
        if (body.internalState === 'ACTIVE')
          return Response.json({ totalListingsCount: 1, listingData: [searchRow(1)] });
        if (!failDetails) return new Response('private-upstream', { status: 500 });
        return Response.json({ totalListingsCount: 0, listingData: [] });
      },
    });
    await assert.rejects(client.listListings(token, 'account-a'), safeError(false));
  }
});

test('fresh details preserve display identity and version while replacing prices, stock and observation time', async () => {
  let body: unknown;
  const client = new FlipkartListingsClient({
    now: () => now,
    request: async (url, options) => {
      assert.equal(url, 'https://api.flipkart.net/sellers/listings/v3/details');
      body = JSON.parse(String(options?.body));
      return detailsResponse(detail());
    },
  });
  const result = await client.getListing(token, listing);
  assert.deepEqual(body, { sku_ids: ['sku-1'] });
  assert.equal(result.id, listing.id);
  assert.equal(result.sellerId, listing.sellerId);
  assert.equal(result.title, listing.title);
  assert.equal(result.imageUrl, listing.imageUrl);
  assert.equal(result.version, 7);
  assert.equal(result.mrp, 2200);
  assert.equal(result.sellingPrice, 1900);
  assert.equal(result.locations[0].quantity, 6);
  assert.equal(result.observedAt, new Date(now).toISOString());
  assert.equal(listing.locations[0].quantity, 10);
});

test('Inventory publication requires a fresh recognized listing status even when its cached status is active', async () => {
  const options = { requireCurrentStatus: true };
  for (const fields of [
    { listing_status: undefined },
    { listing_status: 'UNKNOWN' },
    { listing_status: ['ACTIVE'] },
    { archived_status: 'UNKNOWN' },
  ]) {
    const client = clientForDetails({ ...detail(), ...fields });
    await assert.rejects(client.getListing(token, listing, options), /current listing status/);
    assert.equal((await client.getListing(token, listing)).mrp, 2200);
  }
  for (const status of ['ACTIVE', 'INACTIVE']) {
    const client = clientForDetails({
      ...detail(),
      listing_status: status,
      archived_status: 'NONE',
    });
    assert.equal((await client.getListing(token, listing, options)).status, status);
  }
  const archived = clientForDetails({
    ...detail(),
    listing_status: undefined,
    archived_status: 'ARCHIVED',
  });
  assert.equal((await archived.getListing(token, listing, options)).status, 'ARCHIVED');
});

test('details use the documented alternative selling-price name and authoritative title and status', async () => {
  const client = clientForDetails({
    ...detail(),
    product_title: 'Updated title',
    listing_status: 'INACTIVE',
    price: { mrp: 2500, flipkart_selling_price: 2100, currency: 'INR' },
  });
  const result = await client.getListing(token, listing);
  assert.equal(result.sellingPrice, 2100);
  assert.equal(result.title, 'Updated title');
  assert.equal(result.status, 'INACTIVE');
  assert.equal(
    (
      await clientForDetails({ ...detail(), archived_status: 'ARCHIVED' }).getListing(
        token,
        listing,
      )
    ).status,
    'ARCHIVED',
  );
});

test('missing and invalid numeric observations remain unknown, and pending inventory never replaces inventory', async () => {
  for (const invalid of [undefined, null, '', '7', -1, 1.5, Infinity, 2_147_483_648]) {
    const result = await clientForDetails({
      ...detail(),
      price: { mrp: invalid, selling_price: invalid, currency: 'INR' },
      locations: [
        { id: 'warehouse-1', status: 'ENABLED', inventory: invalid, pending_inventory: 12 },
      ],
    }).getListing(token, listing);
    assert.equal(result.mrp, null);
    assert.equal(result.sellingPrice, null);
    assert.equal(result.locations[0].quantity, null);
  }
  const result = await clientForDetails({
    listing_id: listing.id,
    product_id: listing.productId,
  }).getListing(token, listing);
  assert.equal(result.mrp, null);
  assert.equal(result.sellingPrice, null);
  assert.deepEqual(result.locations, []);
  for (const currency of ['USD', undefined]) {
    assert.equal(
      (
        await clientForDetails({
          ...detail(),
          price: { mrp: 2000, selling_price: 1800, currency },
        }).getListing(token, listing)
      ).sellingPrice,
      null,
    );
  }
});

test('details reject changed identities, unavailable SKUs and duplicate locations', async () => {
  for (const changes of [
    { listing_id: 'other-listing' },
    { product_id: 'other-product' },
    { seller_id: 'other-seller' },
    { sellerId: 'other-seller' },
    { sku: 'other-sku' },
    { locations: {} },
    { locations: [{ id: 'duplicate' }, { id: 'duplicate' }] },
    { locations: [{ inventory: 3 }] },
  ]) {
    await assert.rejects(
      clientForDetails({ ...detail(), ...changes }).getListing(token, listing),
      safeError(false),
    );
  }
  for (const response of [
    { available: {}, unavailable: ['sku-1'] },
    { available: { 'sku-1': detail() }, invalid: ['sku-1'] },
    { available: { 'sku-1': detail(), 'sku-2': detail(2) } },
    { available: { 'sku-1': detail() }, unavailable: 'private-upstream' },
  ]) {
    const client = new FlipkartListingsClient({ request: async () => Response.json(response) });
    await assert.rejects(client.getListing(token, listing), safeError(false));
  }
});

test('import retains documented search SSP/MRP if details omit prices and ignores ESP', async () => {
  const client = new FlipkartListingsClient({
    request: async (url, options) => {
      if (String(url).endsWith('/details'))
        return detailsResponse({ listing_id: listing.id, product_id: listing.productId });
      const active = JSON.parse(String(options?.body)).internalState === 'ACTIVE';
      return Response.json({
        totalListingsCount: active ? 1 : 0,
        listingData: active ? [searchRow(1)] : [],
      });
    },
  });
  const [result] = await client.listListings(token, 'account-a');
  assert.equal(result.sellingPrice, 1800);
  assert.equal(result.mrp, 2000);
  assert.deepEqual(result.locations, []);
});

test('stock writes send only the location ID and absolute inventory without changing its status', async () => {
  const client = new FlipkartListingsClient({
    request: async (url, options) => {
      assert.equal(url, 'https://api.flipkart.net/sellers/listings/v3/update/inventory');
      assert.deepEqual(JSON.parse(String(options?.body)), {
        'sku-1': {
          product_id: 'product-1',
          locations: [{ id: 'warehouse-2', inventory: 0 }],
        },
      });
      return Response.json({ 'sku-1': { status: 'SUCCESS', errors: [], attribute_errors: [] } });
    },
  });
  await client.updateStock(token, listing, 'warehouse-2', 0);
});

test('first stock write uses the confirmed pickup when the SKU has no location', async () => {
  const sku = { ...listing, sku: '155/65R14', locations: [] };
  let calls = 0;
  const client = new FlipkartListingsClient({
    request: async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.flipkart.net/sellers/listings/v3/update/inventory');
      assert.deepEqual(JSON.parse(String(options?.body)), {
        '155/65R14': {
          product_id: sku.productId,
          locations: [{ id: 'warehouse-1', inventory: 1 }],
        },
      });
      return Response.json({ '155/65R14': { status: 'SUCCESS' } });
    },
  });
  await assert.rejects(client.updateStock(token, sku, 'warehouse-1', 1), safeError(false));
  await assert.rejects(client.updateStock(token, listing, 'other', 1, true), safeError(false));
  await client.updateStock(token, sku, 'warehouse-1', 1, true);
  assert.equal(calls, 1);
});

test('price writes use the current documented selling_price field, both prices and INR', async () => {
  const client = new FlipkartListingsClient({
    request: async (url, options) => {
      assert.equal(url, 'https://api.flipkart.net/sellers/listings/v3/update/price');
      assert.deepEqual(JSON.parse(String(options?.body)), {
        'sku-1': {
          product_id: 'product-1',
          price: { mrp: 2500, selling_price: 2100, currency: 'INR' },
        },
      });
      return Response.json({ 'sku-1': { status: 'SUCCESS' } });
    },
  });
  await client.updatePrice(token, listing, 2500, 2100);
});

test('invalid quantities, prices, identity, tokens and destinations are rejected before sending', async () => {
  let calls = 0;
  const client = new FlipkartListingsClient({
    request: async () => {
      calls++;
      throw new Error('must not call');
    },
  });
  for (const quantity of [-1, 1.2, NaN, Infinity, 2_147_483_648])
    await assert.rejects(
      client.updateStock(token, listing, 'warehouse-1', quantity),
      safeError(false),
    );
  for (const [mrp, sellingPrice] of [
    [100, 101],
    [100, 0],
    [100.5, 90],
    [-1, 1],
    [100, NaN],
    [2_147_483_648, 90],
  ])
    await assert.rejects(client.updatePrice(token, listing, mrp, sellingPrice), safeError(false));
  await assert.rejects(
    client.updateStock(token, listing, 'unknown-warehouse', 5),
    safeError(false),
  );
  await assert.rejects(
    client.updateStock(
      token,
      { ...listing, locations: [{ id: 'warehouse-1', quantity: 5, status: 'UNKNOWN' }] },
      'warehouse-1',
      5,
    ),
    safeError(false),
  );
  await assert.rejects(
    client.updateStock(
      token,
      { ...listing, locations: [...listing.locations, listing.locations[0]] },
      'warehouse-1',
      5,
    ),
    safeError(false),
  );
  await assert.rejects(client.getListing(token, { ...listing, sellerId: '' }), safeError(false));
  await assert.rejects(client.listListings(token, ''), safeError(false));
  for (const badToken of ['', 'private-test-bearer-token\r\nInjected: value'])
    await assert.rejects(client.getListing(badToken, listing), safeError(false));
  assert.equal(calls, 0);
});

test('per-SKU failures are definitive; warnings and malformed or inconsistent success replies require reconciliation', async () => {
  for (const [response, uncertain] of [
    [{ 'sku-1': { status: 'FAILURE', errors: [{ description: 'private-upstream' }] } }, false],
    [
      {
        'sku-1': {
          status: 'WARNING',
          errors: [{ severity: 'WARNING', description: 'private-upstream' }],
        },
      },
      true,
    ],
    [
      {
        'sku-1': {
          status: 'SUCCESS',
          attribute_errors: [{ severity: 'ERROR', description: 'private-upstream' }],
        },
      },
      true,
    ],
    [{ 'sku-1': { status: 'SUCCESS', errors: 'private-upstream' } }, true],
    [{ 'sku-1': { status: 'WAITING' } }, true],
    [{}, true],
    [{ 'other-sku': { status: 'SUCCESS' } }, true],
    [{ 'sku-1': { status: 'SUCCESS' }, 'other-sku': { status: 'SUCCESS' } }, true],
  ] as const) {
    const client = new FlipkartListingsClient({ request: async () => Response.json(response) });
    await assert.rejects(
      client.updateStock(token, listing, 'warehouse-1', 3),
      safeError(uncertain),
    );
  }
});

test('HTTP and network errors are sanitized and distinguish uncertain writes from definite rejection', async () => {
  const rejected = new FlipkartListingsClient({
    request: async () =>
      Response.json({ code: 'Bad Request', message: 'private-upstream' }, { status: 400 }),
  });
  await assert.rejects(rejected.updateStock(token, listing, 'warehouse-1', 3), (error) => {
    assert.ok(error instanceof FlipkartListingError);
    assert.equal(error.uncertain, false);
    assert.match(error.message, /stock request \(HTTP 400\)/);
    assert.doesNotMatch(error.message, /private-upstream/);
    return true;
  });
  const accepted = new FlipkartListingsClient({
    request: async () => Response.json({ 'sku-1': { status: 'SUCCESS' } }, { status: 202 }),
  });
  await assert.rejects(accepted.updateStock(token, listing, 'warehouse-1', 3), safeError(true));
  for (const status of [301, 400, 401, 403, 408, 422, 429, 500, 503]) {
    const client = new FlipkartListingsClient({
      request: async () => new Response(`private-upstream ${token}`, { status }),
    });
    await assert.rejects(client.getListing(token, listing), safeError(false));
    await assert.rejects(
      client.updatePrice(token, listing, 2000, 1800),
      safeError(status >= 500 || status === 408 || status < 400),
    );
  }
  const client = new FlipkartListingsClient({
    request: async () => {
      throw new Error(`private-upstream ${token}`);
    },
  });
  await assert.rejects(client.getListing(token, listing), safeError(false));
  await assert.rejects(client.updateStock(token, listing, 'warehouse-1', 5), safeError(true));
});

test('malformed JSON, wrong content type and oversized response bodies never leak upstream text', async () => {
  const responses = [
    () => new Response('private-upstream', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{private-upstream', { headers: { 'content-type': 'application/json' } }),
    () => Response.json([]),
    () =>
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '2097153' },
      }),
    () =>
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': 'invalid' },
      }),
    () =>
      new Response('x'.repeat(2 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'application/json' },
      }),
  ];
  for (const response of responses) {
    const client = new FlipkartListingsClient({ request: async () => response() });
    await assert.rejects(client.getListing(token, listing), safeError(false));
    await assert.rejects(client.updateStock(token, listing, 'warehouse-1', 5), safeError(true));
  }
});

test('the deadline bounds both the initial request and a stalled response body', async () => {
  for (const stalledBody of [false, true]) {
    let signal: AbortSignal | undefined;
    const client = new FlipkartListingsClient({
      timeoutMs: 5,
      request: async (_url, options) => {
        signal = options?.signal ?? undefined;
        if (stalledBody)
          return new Response(new ReadableStream(), {
            headers: { 'content-type': 'application/json' },
          });
        return new Promise<Response>(() => undefined);
      },
    });
    await assert.rejects(client.updateStock(token, listing, 'warehouse-1', 5), safeError(true));
    assert.equal(signal?.aborted, true);
  }
  for (const timeoutMs of [0, -1, 1.5, 120_001])
    assert.throws(() => new FlipkartListingsClient({ timeoutMs }), /timeout/);
});
