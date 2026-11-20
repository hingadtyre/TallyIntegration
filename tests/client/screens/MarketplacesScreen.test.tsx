import assert from 'node:assert/strict';
import test from 'node:test';
import {
  act,
  render,
  screen,
  within,
  fireEvent,
  waitFor,
  response,
} from '../../support/client-dom.js';
import type {
  MarketplaceAccount,
  MarketplaceApplyInput,
  MarketplaceApplyResult,
  MarketplaceListingView,
  MarketplacePage,
} from '../../../src/shared/marketplace-contracts.js';
import { MarketplacesScreen } from '../../../src/client/screens/MarketplacesScreen.js';

const account = (id = 'seller-a'): MarketplaceAccount => ({
  id,
  name: id === 'seller-a' ? 'Main store' : 'Second store',
  marketplace: 'flipkart',
  sellerId: id,
  lastRefreshedAt: '2026-11-18T10:00:00Z',
  connection: {
    state: 'verified',
    checkedAt: null,
    expiresAt: null,
    applicationIdHint: 'app…',
    message: 'Credentials verified.',
  },
});
const listing = (id = 'seller-a'): MarketplaceListingView => ({
  id: `listing-${id}`,
  accountId: id,
  sellerId: id,
  productId: `product-${id}`,
  sku: `SKU-${id}`,
  title: id === 'seller-a' ? 'Marketplace tyre' : 'Second account tyre',
  imageUrl: null,
  status: 'ACTIVE',
  mrp: 1200,
  sellingPrice: 1000,
  locations: [
    { id: 'warehouse-1', quantity: 4, status: 'ACTIVE' },
    { id: 'warehouse-2', quantity: 7, status: 'ACTIVE' },
  ],
  observedAt: '2026-11-18T10:00:00Z',
  version: 3,
  stockPolicies: [],
});
const page = (item = listing()): MarketplacePage => ({
  listings: [item],
  total: 1,
  page: 1,
  pageSize: 20,
  lastRefreshedAt: item.observedAt,
  changes: [],
});
function result(
  input: MarketplaceApplyInput,
  state: MarketplaceApplyResult['change']['state'] = 'confirmed',
  item = listing(input.accountId),
): MarketplaceApplyResult {
  const { edit } = input;
  if (edit.kind === 'price') item[edit.field] = edit.value;
  else
    item.locations = item.locations.map((location) =>
      location.id === edit.locationId ? { ...location, quantity: edit.quantity } : location,
    );
  return {
    listing: { ...item, version: 4 },
    change: {
      id: 'change-1',
      accountId: input.accountId,
      listingId: input.listingId,
      sku: item.sku,
      edit:
        edit.kind === 'stock'
          ? {
              ...edit,
              automation: item.stockPolicies.some(
                (policy) => policy.locationId === edit.locationId && policy.companyId,
              )
                ? 'pause'
                : 'once',
            }
          : edit,
      state,
      message:
        state === 'confirmed'
          ? 'Readback confirmed this value.'
          : 'Waiting for a reliable readback.',
      createdAt: '2026-11-18T11:00:00Z',
      updatedAt: '2026-11-18T11:00:00Z',
    },
  };
}
async function openListings() {
  const tile = await screen.findByRole('article', { name: 'Main store' });
  fireEvent.click(within(tile).getByRole('button', { name: 'Open listings' }));
  await screen.findByText('Marketplace tyre');
}
function baseResponse(input: string | URL | Request, item = listing()) {
  if (String(input) === '/api/marketplaces') return response({ accounts: [account()] });
  if (String(input).startsWith('/api/marketplaces/listings?')) return response(page(item));
  throw new Error(`Unexpected request: ${String(input)}`);
}

test('empty live marketplace view has Add account and no invented marketplace tiles or Tally requirement', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({ accounts: [] }));
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await screen.findByText('Add your first marketplace account');
  assert.equal(screen.queryAllByRole('article').length, 0);
  assert.ok(screen.getByRole('button', { name: 'Add account' }));
  assert.equal(screen.queryByLabelText('Tally company'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  assert.ok(screen.getByRole('button', { name: /Flipkart/ }));
  assert.equal(screen.queryByText('Amazon'), null);
});

for (const verify of [false, true])
  test(`adding an account sends an explicit ${verify ? 'verify' : 'save without verification'} choice`, async (t) => {
    let submitted: Record<string, unknown> | undefined;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, options?: RequestInit) => {
        if (String(input) === '/api/marketplaces') return response({ accounts: [] });
        assert.equal(String(input), '/api/marketplaces/add');
        assert.equal(new Headers(options?.headers).get('X-Stockbridge-Request'), '1');
        submitted = JSON.parse(String(options?.body));
        return response(account());
      },
    );
    render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
    await screen.findByText('Add your first marketplace account');
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    fireEvent.click(screen.getByRole('button', { name: /Flipkart/ }));
    fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Main store' } });
    fireEvent.change(screen.getByLabelText('Application ID'), { target: { value: 'test-id' } });
    fireEvent.change(screen.getByLabelText('Application Secret'), {
      target: { value: 'test-secret' },
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: verify ? 'Verify and save' : 'Save without verification',
      }),
    );
    await screen.findByRole('article', { name: 'Main store' });
    assert.deepEqual(submitted, {
      name: 'Main store',
      marketplace: 'flipkart',
      applicationId: 'test-id',
      applicationSecret: 'test-secret',
      verify,
    });
    assert.equal(screen.queryByRole('dialog'), null);
    assert.ok(screen.getByRole('button', { name: 'Add account' }));
  });

test('a listing without a stock location still shows its shipping package count', async (t) => {
  const item = { ...listing(), locations: [], packageCount: 2 };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) =>
    baseResponse(input, item),
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  assert.ok(screen.getByRole('columnheader', { name: 'Shipping packages' }));
  const row = screen.getByRole('row', { name: /Marketplace tyre/ });
  assert.ok(within(row).getByRole('cell', { name: '2' }));
  assert.ok(within(row).getByText('Flipkart supplied no stock location.'));
  assert.equal(within(row).queryByRole('button', { name: /Edit stock/ }), null);
});

test('sample account creation accepts no credentials and remains a backend simulation', async (t) => {
  let submitted: Record<string, unknown> | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/marketplaces') return response({ accounts: [] });
      submitted = JSON.parse(String(options?.body));
      return response(account());
    },
  );
  render(<MarketplacesScreen mode="demo" onOpenInventory={() => {}} />);
  await screen.findByText('Add your first marketplace account');
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  fireEvent.click(screen.getByRole('button', { name: /Flipkart/ }));
  assert.equal(screen.queryByLabelText('Application Secret'), null);
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: 'Sample store' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add sample account' }));
  await screen.findByRole('article', { name: 'Main store' });
  assert.deepEqual(submitted, {
    name: 'Sample store',
    marketplace: 'flipkart',
    applicationId: '',
    applicationSecret: '',
    verify: false,
  });
});

test('connection errors and disconnect remain scoped to their account tile', async (t) => {
  const calls: unknown[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/marketplaces')
        return response({ accounts: [account(), account('seller-b')] });
      const body = JSON.parse(String(options?.body));
      calls.push(body);
      return body.action === 'check'
        ? response({ error: 'Main account check failed.' }, 502)
        : response({
            ...account('seller-b'),
            sellerId: null,
            connection: {
              ...account().connection,
              state: 'not-configured',
              message: 'Disconnected.',
            },
          });
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  const main = await screen.findByRole('article', { name: 'Main store' });
  const second = screen.getByRole('article', { name: 'Second store' });
  fireEvent.click(within(main).getByRole('button', { name: 'Check connection' }));
  await within(main).findByText('Main account check failed.');
  assert.equal(within(second).queryByRole('alert'), null);
  fireEvent.click(within(second).getByRole('button', { name: 'Disconnect locally' }));
  await within(second).findByText('Disconnected.');
  assert.deepEqual(calls, [
    { accountId: 'seller-a', action: 'check' },
    { accountId: 'seller-b', action: 'disconnect' },
  ]);
});

test('an account keeps its verified access when the first catalog import needs a retry', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response({
      accounts: [
        { ...account(), sellerId: null, catalogImportError: 'Catalog refresh timed out.' },
      ],
    }),
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  const main = await screen.findByRole('article', { name: 'Main store' });
  assert.match(
    within(main).getByRole('alert').textContent ?? '',
    /Catalog refresh timed out.*Open listings.*Refresh listings/,
  );
  assert.ok(within(main).getByRole('button', { name: 'Open listings' }));
});

test('price Apply sends only that field, keeps stock untouched and shows verified result', async (t) => {
  let submitted: MarketplaceApplyInput | undefined;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/marketplaces/apply') {
        submitted = JSON.parse(String(options?.body));
        return response(result(submitted!));
      }
      return baseResponse(input);
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit selling price for SKU-seller-a' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit selling price' });
  assert.equal(within(dialog).queryByRole('radio'), null);
  fireEvent.change(within(dialog).getByLabelText('Selling price'), { target: { value: '950' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await within(dialog).findByText('Updated');
  assert.deepEqual(submitted, {
    accountId: 'seller-a',
    listingId: 'listing-seller-a',
    version: 3,
    edit: { kind: 'price', field: 'sellingPrice', value: 950 },
  });
  assert.ok(screen.getByRole('link', { name: /Open in Flipkart/ }));
  assert.equal(screen.queryByRole('button', { name: /Edit settlement/ }), null);
});

test('editing a mapped location locks it and resuming leaves company sync off', async (t) => {
  const item = listing();
  item.stockPolicies = [
    {
      locationId: 'warehouse-2',
      listingId: 'inventory-1',
      listingVersion: 7,
      companyId: 'company-a',
      companyName: 'Tally company A',
      automationStatus: 'Company updates off',
      policy: 'auto',
      remaining: null,
      paused: false,
    },
  ];
  let submitted: MarketplaceApplyInput | undefined;
  const resumes: unknown[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/marketplaces/apply') {
        submitted = JSON.parse(String(options?.body));
        item.stockPolicies[0] = {
          ...item.stockPolicies[0],
          paused: true,
          listingVersion: 8,
          automationStatus: 'Paused',
        };
        return response(result(submitted!, 'confirmed', item));
      }
      if (String(input) === '/api/pause') {
        resumes.push(JSON.parse(String(options?.body)));
        if (resumes.length === 1) {
          item.stockPolicies[0] = { ...item.stockPolicies[0], listingVersion: 9 };
          return response({ error: 'This mapping changed.' }, 409);
        }
        item.stockPolicies[0] = {
          ...item.stockPolicies[0],
          paused: false,
          listingVersion: 10,
          automationStatus: 'Company updates off',
        };
        return response({
          listings: [{ id: 'inventory-1', paused: false, version: 10 }],
          proposals: [{ listingId: 'inventory-1', quantity: 3, edited: false, stale: false }],
        });
      }
      return baseResponse(input, item);
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  assert.ok(screen.getByRole('columnheader', { name: 'Flipkart status' }));
  assert.ok(screen.getByText('Stockbridge · Company updates off'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Edit stock for SKU-seller-a at warehouse-2' }),
  );
  const dialog = screen.getByRole('dialog', { name: 'Edit stock' });
  assert.ok(within(dialog).getByText('Tally company A · Company updates off'));
  fireEvent.change(within(dialog).getByLabelText('Stock'), { target: { value: '9' } });
  assert.equal(within(dialog).queryByRole('radio'), null);
  assert.ok(within(dialog).getByText(/including updates to zero/));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply and pause sync' }));
  await within(dialog).findByText('Updated');
  assert.deepEqual(submitted?.edit, {
    kind: 'stock',
    locationId: 'warehouse-2',
    quantity: 9,
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  assert.equal(screen.queryByRole('button', { name: /Resume sync.*warehouse-1/ }), null);
  const resume = { name: 'Resume sync for SKU-seller-a at warehouse-2' };
  fireEvent.click(screen.getByRole('button', resume));
  await screen.findByText(/This mapping changed/);
  fireEvent.click(screen.getByRole('button', { name: 'Reload listings' }));
  await waitFor(() => assert.equal(screen.queryByText(/This mapping changed/), null));
  fireEvent.click(await screen.findByRole('button', resume));
  await screen.findByText('Stockbridge · Company updates off');
  await screen.findByText('Proposed stock on resume: 3');
  assert.deepEqual(resumes, [
    {
      companyId: 'company-a',
      listingIds: ['inventory-1'],
      listingVersion: 8,
      paused: false,
    },
    {
      companyId: 'company-a',
      listingIds: ['inventory-1'],
      listingVersion: 9,
      paused: false,
    },
  ]);
  assert.equal(screen.queryByRole('button', { name: /Resume sync/ }), null);
});

test('a resumed marketplace location with an unverified draft shows the last calculation issue', async (t) => {
  const item = listing();
  item.stockPolicies = [
    {
      listingId: 'inventory-1',
      locationId: 'warehouse-2',
      companyId: 'company-a',
      companyName: 'Tally company A',
      policy: 'auto',
      remaining: null,
      paused: false,
      proposalIssue: 'Check the stock balance in Tally.',
    },
  ];
  t.mock.method(globalThis, 'fetch', async (path: string | URL | Request) =>
    baseResponse(path, item),
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  assert.match(
    screen.getByText(/Last calculation could not verify stock/).textContent ?? '',
    /Check the stock balance in Tally.*Calculate in Inventory/,
  );
});

for (const lostResponse of [false, true])
  test(`a rejected stock update shows its retained Pause after ${lostResponse ? 'recovering a lost response' : 'Apply'}`, async (t) => {
    const item = listing();
    item.stockPolicies = [
      {
        locationId: 'warehouse-2',
        listingId: 'inventory-1',
        companyId: 'company-a',
        companyName: 'Tally company A',
        policy: 'auto',
        remaining: null,
        paused: false,
      },
    ];
    let saved: MarketplaceApplyResult | undefined;
    let writes = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (path: string | URL | Request, options?: RequestInit) => {
        if (String(path) === '/api/marketplaces/apply') {
          writes++;
          const submitted = JSON.parse(String(options?.body)) as MarketplaceApplyInput;
          saved = {
            listing: {
              ...item,
              stockPolicies: [{ ...item.stockPolicies[0], paused: true }],
            },
            change: {
              ...result(submitted, 'failed').change,
              message: 'Flipkart rejected the stock update.',
            },
          };
          if (lostResponse) throw new TypeError('Network response lost.');
          return response(saved);
        }
        if (saved && String(path).startsWith('/api/marketplaces/listings?'))
          return response({ ...page(saved.listing), changes: [saved.change] });
        return baseResponse(path, item);
      },
    );
    render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
    await openListings();
    fireEvent.click(
      screen.getByRole('button', { name: 'Edit stock for SKU-seller-a at warehouse-2' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit stock' });
    fireEvent.change(within(dialog).getByLabelText('Stock'), { target: { value: '9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply and pause sync' }));
    if (lostResponse) {
      await within(dialog).findByText('Network response lost.');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Reload saved result' }));
    }
    await within(dialog).findByText('Flipkart rejected the stock update.');
    assert.ok(within(dialog).getByText('Tally company A'));
    assert.ok(within(dialog).getByText('Tally sync paused'));
    assert.equal(within(dialog).queryByText(/Tally company A · Active/), null);
    assert.equal((within(dialog).getByLabelText('Stock') as HTMLInputElement).value, '9');
    assert.equal(writes, 1);
  });

test('a live sales allowance permits zero while requiring a confirmed policy change for a positive edit', async (t) => {
  const item = listing();
  item.stockPolicies = [
    {
      locationId: 'warehouse-1',
      listingId: 'inventory-1',
      companyId: 'company-a',
      companyName: 'Tally company A',
      policy: 'limited',
      remaining: 1,
      paused: false,
    },
  ];
  let policyRequest: unknown;
  let writes = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/marketplaces/policy') {
        policyRequest = JSON.parse(String(options?.body));
        return response({
          ...item,
          version: 4,
          stockPolicies: [{ ...item.stockPolicies[0], policy: 'auto' }],
        });
      }
      if (String(input) === '/api/marketplaces/apply') writes++;
      return baseResponse(input, item);
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(
    screen.getByRole('button', { name: 'Edit stock for SKU-seller-a at warehouse-1' }),
  );
  const dialog = screen.getByRole('dialog', { name: 'Edit stock' });
  const stock = within(dialog).getByLabelText('Stock');
  fireEvent.change(stock, { target: { value: '0' } });
  assert.equal(
    (within(dialog).getByRole('button', { name: 'Apply and pause sync' }) as HTMLButtonElement)
      .disabled,
    false,
  );
  assert.equal(within(dialog).queryByRole('button', { name: 'Change stock policy' }), null);
  fireEvent.change(stock, { target: { value: '1' } });
  assert.equal(
    (within(dialog).getByRole('button', { name: 'Apply and pause sync' }) as HTMLButtonElement)
      .disabled,
    true,
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Change stock policy' }));
  assert.equal(policyRequest, undefined);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm automatic policy' }));
  await waitFor(() =>
    assert.equal(
      (within(dialog).getByRole('button', { name: 'Apply and pause sync' }) as HTMLButtonElement)
        .disabled,
      false,
    ),
  );
  assert.deepEqual(policyRequest, {
    accountId: 'seller-a',
    listingId: 'listing-seller-a',
    locationId: 'warehouse-1',
    version: 3,
    policy: 'auto',
    confirmed: true,
  });
  assert.equal(writes, 0);
});

test('uncertain writes require readback instead of a second Apply and preserve the entered value', async (t) => {
  let writes = 0;
  let reconciliations = 0;
  let submitted!: MarketplaceApplyInput;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/marketplaces/apply') {
        writes++;
        submitted = JSON.parse(String(options?.body));
        return response(result(submitted, 'uncertain'));
      }
      if (String(input) === '/api/marketplaces/reconcile') {
        reconciliations++;
        assert.deepEqual(JSON.parse(String(options?.body)), {
          accountId: 'seller-a',
          changeId: 'change-1',
        });
        return response(result(submitted));
      }
      return baseResponse(input);
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit MRP for SKU-seller-a' }));
  const dialog = screen.getByRole('dialog', { name: 'Edit mrp' });
  fireEvent.change(within(dialog).getByLabelText('MRP'), { target: { value: '1300' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await within(dialog).findByText('Result uncertain');
  assert.equal(within(dialog).queryByRole('button', { name: 'Apply' }), null);
  assert.equal((within(dialog).getByLabelText('MRP') as HTMLInputElement).value, '1300');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check result' }));
  await within(dialog).findByText('Updated');
  assert.equal(writes, 1);
  assert.equal(reconciliations, 1);
});

for (const [finality, calculated] of [
  ['completed', 4],
  ['not-sent', 3],
] as const) {
  test(`a settled ${finality} stock request requires a fresh review and explicit approval of ${calculated}`, async (t) => {
    const item = listing();
    const input: MarketplaceApplyInput = {
      accountId: item.accountId,
      listingId: item.id,
      version: item.version,
      edit: { kind: 'stock', quantity: 5, locationId: 'warehouse-1', automation: 'once' },
    };
    const original = { ...result(input, 'uncertain').change, stockRequestFinality: finality };
    const recovered = {
      ...original,
      state: 'reconciled' as const,
      message: 'Stock review completed.',
    };
    const replacement = {
      ...result({
        ...input,
        edit: {
          kind: 'stock',
          quantity: calculated,
          locationId: 'warehouse-1',
          automation: 'once',
        },
      }).change,
      id: 'fresh-change',
      message: 'The new stock update was verified.',
    };
    let approvals = 0;
    let reviews = 0;
    let readsAfterApproval = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (url: string | URL | Request, options?: RequestInit) => {
        const path = String(url);
        if (path === '/api/marketplaces') return response({ accounts: [account()] });
        if (path.startsWith('/api/marketplaces/listings?')) {
          if (approvals) readsAfterApproval++;
          return response({
            ...page(item),
            changes: approvals
              ? calculated === 4
                ? [recovered]
                : [replacement, recovered]
              : [original],
          });
        }
        if (path === '/api/marketplaces/recovery/review') {
          assert.deepEqual(JSON.parse(String(options?.body)), {
            accountId: item.accountId,
            changeId: original.id,
          });
          reviews++;
          return response({
            reviewId: 'fresh-review',
            sku: item.sku,
            locationId: 'warehouse-1',
            observed: 4,
            quantity: calculated,
          });
        }
        assert.equal(path, '/api/marketplaces/recovery/approve');
        assert.deepEqual(JSON.parse(String(options?.body)), {
          accountId: item.accountId,
          changeId: original.id,
          reviewId: 'fresh-review',
        });
        approvals++;
        return response({ listing: item, change: calculated === 4 ? recovered : replacement });
      },
    );
    render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
    await openListings();
    fireEvent.click(screen.getByRole('button', { name: 'Review current stock' }));
    const dialog = screen.getByRole('dialog', { name: 'Review current stock' });
    const approval = await within(dialog).findByRole('button', {
      name: calculated === 4 ? 'Approve and keep 4' : 'Approve and send 3',
    });
    assert.equal(
      within(dialog).getByText('Current Flipkart stock').nextElementSibling?.textContent,
      '4',
    );
    assert.equal(
      within(dialog).getByText('Calculated listing stock').nextElementSibling?.textContent,
      String(calculated),
    );
    assert.equal(reviews, 1);
    assert.equal(approvals, 0);
    fireEvent.click(approval);
    await within(dialog).findByText(calculated === 4 ? 'Current stock confirmed' : 'Stock updated');
    assert.equal(approvals, 1);
    await waitFor(() => assert.ok(readsAfterApproval));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      assert.equal(
        (
          screen.getByRole('button', {
            name: 'Edit stock for SKU-seller-a at warehouse-1',
          }) as HTMLButtonElement
        ).disabled,
        false,
      ),
    );
  });
}

test('an uncertain stock request with unknown finality leaves recovery unavailable', async (t) => {
  const item = listing();
  const change = result(
    {
      accountId: item.accountId,
      listingId: item.id,
      version: item.version,
      edit: { kind: 'stock', quantity: 5, locationId: 'warehouse-1', automation: 'once' },
    },
    'uncertain',
  ).change;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url) === '/api/marketplaces') return response({ accounts: [account()] });
    assert.ok(String(url).startsWith('/api/marketplaces/listings?'));
    return response({ ...page(item), changes: [change] });
  });
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  assert.ok(screen.getByText(/Flipkart could still apply the earlier stock update/));
  assert.ok(screen.getByRole('button', { name: 'Check result' }));
  assert.equal(screen.queryByRole('button', { name: 'Review current stock' }), null);
});

test('an uncertain stock edit opens recovery from its editor and stale approval needs a new review', async (t) => {
  const item = listing();
  let reviewReads = 0;
  const approvals: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (path === '/api/marketplaces/apply') {
      const saved = result(JSON.parse(String(options?.body)) as MarketplaceApplyInput, 'uncertain');
      return response({ ...saved, change: { ...saved.change, stockRequestFinality: 'completed' } });
    }
    if (path === '/api/marketplaces/recovery/review') {
      reviewReads++;
      return response({
        reviewId: 'review-' + reviewReads,
        sku: item.sku,
        locationId: 'warehouse-1',
        observed: 4,
        quantity: reviewReads === 1 ? 3 : 2,
      });
    }
    if (path === '/api/marketplaces/recovery/approve') {
      approvals.push(JSON.parse(String(options?.body)).reviewId);
      return response({ error: 'A new order changed the quantity.' }, 409);
    }
    return baseResponse(url);
  });
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(
    screen.getByRole('button', { name: 'Edit stock for SKU-seller-a at warehouse-1' }),
  );
  const editor = screen.getByRole('dialog', { name: 'Edit stock' });
  fireEvent.change(within(editor).getByLabelText('Stock'), { target: { value: '5' } });
  fireEvent.click(within(editor).getByRole('button', { name: 'Apply' }));
  fireEvent.click(await within(editor).findByRole('button', { name: 'Review current stock' }));
  const dialog = screen.getByRole('dialog', { name: 'Review current stock' });
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Approve and send 3' }));
  await within(dialog).findByText('A new order changed the quantity.');
  assert.equal(within(dialog).queryByRole('button', { name: 'Approve and send 3' }), null);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check current stock again' }));
  await within(dialog).findByRole('button', { name: 'Approve and send 2' });
  assert.deepEqual(approvals, ['review-1']);
  assert.equal(reviewReads, 2);
});

test('account-wide search, status and pagination go to the backend and reset the page', async (t) => {
  const requests: URLSearchParams[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/marketplaces') return response({ accounts: [account()] });
    const query = new URL(String(input), 'http://localhost').searchParams;
    requests.push(query);
    return response({ ...page(), total: 41, page: Number(query.get('page')) });
  });
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('Page 2 of 3');
  await screen.findByText('Marketplace tyre');
  fireEvent.change(screen.getByLabelText('Search marketplace listings'), {
    target: { value: 'CEAT' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await waitFor(() => assert.equal(requests.at(-1)?.get('search'), 'CEAT'));
  assert.equal(requests.at(-1)?.get('page'), '1');
  fireEvent.change(screen.getByLabelText('Listing status'), { target: { value: 'ARCHIVED' } });
  await waitFor(() => assert.equal(requests.at(-1)?.get('status'), 'ARCHIVED'));
  assert.equal(requests.at(-1)?.get('accountId'), 'seller-a');
});

test('a lost recovery approval response reloads the saved result without submitting another approval', async (t) => {
  const item = listing();
  const initial = result(
    {
      accountId: item.accountId,
      listingId: item.id,
      version: item.version,
      edit: { kind: 'stock', quantity: 5, locationId: 'warehouse-1', automation: 'once' },
    },
    'uncertain',
  );
  const change = { ...initial.change, stockRequestFinality: 'completed' };
  let approvals = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const path = String(url);
    if (path === '/api/marketplaces') return response({ accounts: [account()] });
    if (path === '/api/marketplaces/recovery/review')
      return response({
        reviewId: 'review',
        sku: item.sku,
        locationId: 'warehouse-1',
        observed: 4,
        quantity: 4,
      });
    if (path === '/api/marketplaces/recovery/approve') {
      approvals++;
      throw new Error('Connection lost.');
    }
    assert.ok(path.startsWith('/api/marketplaces/listings?'));
    return response({
      ...page(item),
      changes: [
        approvals
          ? { ...change, state: 'reconciled', message: 'The seller approved the current stock.' }
          : change,
      ],
    });
  });
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Review current stock' }));
  const dialog = screen.getByRole('dialog', { name: 'Review current stock' });
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Approve and keep 4' }));
  await within(dialog).findByText('Connection lost.');
  assert.equal(within(dialog).queryByRole('button', { name: /Approve and keep/ }), null);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reload saved result' }));
  await screen.findByText('The seller approved the current stock.');
  assert.equal(approvals, 1);
  assert.equal(screen.queryByRole('button', { name: 'Review current stock' }), null);
});

test('a late response from a previous account cannot appear in the newly opened account', async (t) => {
  let finish!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/marketplaces')
      return response({ accounts: [account(), account('seller-b')] });
    const query = new URL(String(input), 'http://localhost').searchParams;
    return query.get('accountId') === 'seller-a'
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : response(page(listing('seller-b')));
  });
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  const main = await screen.findByRole('article', { name: 'Main store' });
  fireEvent.click(within(main).getByRole('button', { name: 'Open listings' }));
  fireEvent.click(screen.getByRole('button', { name: /All marketplace accounts/ }));
  fireEvent.click(
    within(screen.getByRole('article', { name: 'Second store' })).getByRole('button', {
      name: 'Open listings',
    }),
  );
  await screen.findByText('Second account tyre');
  await act(async () => {
    finish(response(page()));
  });
  assert.equal(screen.queryByText('Marketplace tyre'), null);
  assert.ok(screen.getByText('Second account tyre'));
});

test('closing an unsent editor discards its value without publishing', async (t) => {
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/marketplaces/apply') writes++;
    return baseResponse(input);
  });
  render(<MarketplacesScreen mode="demo" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit MRP for SKU-seller-a' }));
  fireEvent.change(screen.getByLabelText('MRP'), { target: { value: '1550' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit MRP for SKU-seller-a' }));
  assert.equal((screen.getByLabelText('MRP') as HTMLInputElement).value, '1200');
  assert.equal(writes, 0);
});

test('closing a pending editor keeps its row locked and shows its eventual result', async (t) => {
  let finish!: (value: Response) => void;
  let input!: MarketplaceApplyInput;
  let writes = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (path: string | URL | Request, options?: RequestInit) => {
      if (String(path) === '/api/marketplaces/apply') {
        writes++;
        input = JSON.parse(String(options?.body));
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return baseResponse(path);
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit MRP for SKU-seller-a' }));
  fireEvent.change(screen.getByLabelText('MRP'), { target: { value: '1500' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  const edit = screen.getByRole('button', { name: 'Edit MRP for SKU-seller-a' });
  assert.equal((edit as HTMLButtonElement).disabled, true);
  await act(async () => {
    finish(response(result(input)));
  });
  await screen.findByText('Updated');
  assert.equal((edit as HTMLButtonElement).disabled, false);
  assert.equal(writes, 1);
});

test('a validation failure preserves the draft so the seller can correct and retry it', async (t) => {
  let writes = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (path: string | URL | Request, options?: RequestInit) => {
      if (String(path) === '/api/marketplaces/apply') {
        writes++;
        return writes === 1
          ? response({ error: 'The selling price must not exceed MRP.' }, 400)
          : response(result(JSON.parse(String(options?.body))));
      }
      return baseResponse(path);
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit selling price for SKU-seller-a' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(screen.getByLabelText('Selling price'), { target: { value: '1400' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await within(dialog).findByText('The selling price must not exceed MRP.');
  assert.equal((screen.getByLabelText('Selling price') as HTMLInputElement).value, '1400');
  fireEvent.change(screen.getByLabelText('Selling price'), { target: { value: '1100' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await within(dialog).findByText('Updated');
  assert.equal(writes, 2);
});

test('a lost Apply response reloads the saved uncertain change before reconciliation', async (t) => {
  let writes = 0;
  let submitted!: MarketplaceApplyInput;
  t.mock.method(
    globalThis,
    'fetch',
    async (path: string | URL | Request, options?: RequestInit) => {
      if (String(path) === '/api/marketplaces/apply') {
        writes++;
        submitted = JSON.parse(String(options?.body));
        throw new TypeError('Network response lost.');
      }
      if (String(path).startsWith('/api/marketplaces/listings?') && writes)
        return response({ ...page(), changes: [result(submitted, 'uncertain').change] });
      if (String(path) === '/api/marketplaces/reconcile') return response(result(submitted));
      return baseResponse(path);
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit MRP for SKU-seller-a' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.change(screen.getByLabelText('MRP'), { target: { value: '1500' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await within(dialog).findByText('Network response lost.');
  assert.equal(within(dialog).queryByRole('button', { name: 'Apply' }), null);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reload saved result' }));
  await within(dialog).findByText('Result uncertain');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Check result' }));
  await within(dialog).findByText('Updated');
  assert.equal(writes, 1);
});

test('late search results cannot replace the newer filter response', async (t) => {
  let finish!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/marketplaces') return response({ accounts: [account()] });
    const query = new URL(String(input), 'http://localhost').searchParams;
    if (query.get('search') === 'old')
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return response(
      page({
        ...listing(),
        title: query.get('search') === 'new' ? 'New search tyre' : 'Marketplace tyre',
      }),
    );
  });
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.change(screen.getByLabelText('Search marketplace listings'), {
    target: { value: 'old' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  fireEvent.change(screen.getByLabelText('Search marketplace listings'), {
    target: { value: 'new' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await screen.findByText('New search tyre');
  await act(async () => {
    finish(response(page({ ...listing(), title: 'Stale search tyre' })));
  });
  assert.equal(screen.queryByText('Stale search tyre'), null);
  assert.ok(screen.getByText('New search tyre'));
});

test('an Apply result arriving during a search reloads the current filter and ignores its older read', async (t) => {
  let finishApply!: (value: Response) => void;
  let finishSearch!: (value: Response) => void;
  let submitted!: MarketplaceApplyInput;
  let searchReads = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (path: string | URL | Request, options?: RequestInit) => {
      if (String(path) === '/api/marketplaces') return response({ accounts: [account()] });
      if (String(path) === '/api/marketplaces/apply') {
        submitted = JSON.parse(String(options?.body));
        return new Promise<Response>((resolve) => {
          finishApply = resolve;
        });
      }
      const query = new URL(String(path), 'http://localhost').searchParams;
      if (query.get('search') === 'new') {
        searchReads++;
        if (searchReads === 1)
          return new Promise<Response>((resolve) => {
            finishSearch = resolve;
          });
        return response(page({ ...listing(), id: 'new-listing', title: 'New search tyre' }));
      }
      return response(page());
    },
  );
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  fireEvent.click(screen.getByRole('button', { name: 'Edit MRP for SKU-seller-a' }));
  fireEvent.change(screen.getByLabelText('MRP'), { target: { value: '1500' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.change(screen.getByLabelText('Search marketplace listings'), {
    target: { value: 'new' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
  await act(async () => {
    finishApply(response(result(submitted)));
  });
  await screen.findByText('New search tyre');
  await act(async () => {
    finishSearch(response(page()));
  });
  assert.equal(searchReads, 2);
  assert.equal(screen.queryByText('Marketplace tyre'), null);
  assert.ok(screen.getByText('New search tyre'));
});

test('a retained listing with no current observation blocks edits but keeps uncertain-result checking', async (t) => {
  const item = { ...listing(), observedAt: null };
  const change = result(
    {
      accountId: item.accountId,
      listingId: item.id,
      version: item.version,
      edit: { kind: 'price', field: 'mrp', value: 1500 },
    },
    'uncertain',
  ).change;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/marketplaces') return response({ accounts: [account()] });
    return response({ ...page(item), changes: [change] });
  });
  render(<MarketplacesScreen mode="live" onOpenInventory={() => {}} />);
  await openListings();
  assert.ok(screen.getByText('Refresh required: no current observation'));
  assert.equal(
    (screen.getByRole('button', { name: 'Edit MRP for SKU-seller-a' }) as HTMLButtonElement)
      .disabled,
    true,
  );
  assert.equal(
    (
      screen.getByRole('button', {
        name: 'Edit stock for SKU-seller-a at warehouse-1',
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.ok(screen.getByRole('button', { name: 'Check result' }));
});
