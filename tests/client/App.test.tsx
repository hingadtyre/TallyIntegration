import assert from 'node:assert/strict';
import test from 'node:test';
import {
  render,
  screen,
  within,
  fireEvent,
  waitFor,
  response,
  act,
} from '../support/client-dom.js';
import type { FlipkartConnectionStatus, Review, Snapshot } from '../../src/shared/contracts.js';
import type {
  MarketplaceAccount,
  MarketplaceListingView,
} from '../../src/shared/marketplace-contracts.js';
import { initialState } from '../../src/server/seed.js';
import { App } from '../../src/client/App.js';

const disconnectedFlipkart: FlipkartConnectionStatus = {
  state: 'not-configured',
  checkedAt: null,
  expiresAt: null,
  applicationIdHint: null,
  message: 'No Flipkart API credentials are saved.',
};

test('Inventory orders mapped listings by the displayed Set of, then SKU and pickup location', async (t) => {
  const state = initialState('demo', 'unused');
  const base = state.listings.find((listing) => listing.itemId === 'item-a')!;
  const pair = {
    ...base,
    sku: 'PAIR-A',
    packSize: 2,
    packSource: 'packages' as const,
    packageCount: 2,
  };
  state.listings = [
    { ...base, id: 'unknown', sku: 'UNKNOWN', location: 'East', packSize: null, verified: false },
    {
      ...base,
      id: 'ten',
      sku: 'TEN',
      location: 'East',
      packSize: 10,
      packSource: 'manual',
      packageCount: 1,
    },
    {
      ...pair,
      id: 'pair-b',
      sku: 'PAIR-B',
      location: 'East',
      packageCount: 1,
      packageAvailable: true,
      verified: false,
    },
    { ...pair, id: 'pair-west', location: 'West' },
    { ...pair, id: 'pair-east', location: 'East' },
  ];
  t.mock.method(globalThis, 'fetch', async () => response(state));
  render(<App />);

  const buttons = await screen.findAllByRole('button', { name: /^Edit Set of for / });
  assert.deepEqual(
    buttons.map((button) => button.getAttribute('aria-label')),
    [
      'Edit Set of for PAIR-A at East',
      'Edit Set of for PAIR-A at West',
      'Edit Set of for PAIR-B at East',
      'Edit Set of for TEN at East',
      'Edit Set of for UNKNOWN at East',
    ],
  );
});

for (const mode of ['live', 'demo'] as const) {
  test(`Inventory shows a product link only for a live listing with a supplied URL (${mode})`, async (t) => {
    const state = initialState('demo', 'unused');
    state.mode = mode;
    const listing = state.listings.find((row) => row.itemId === 'item-a')!;
    listing.productUrl = 'https://www.flipkart.com/sample-tyre/p/itm123?pid=FSN123';
    t.mock.method(globalThis, 'fetch', async () => response(state));
    render(<App />);

    const select = (await screen.findByRole('checkbox', {
      name: `Select ${listing.sku}`,
    })) as HTMLInputElement;
    const links = screen.queryAllByRole('link', { name: /on Flipkart \(opens in a new tab\)/ });
    if (mode === 'demo') {
      assert.equal(links.length, 0);
      return;
    }
    assert.equal(links.length, 1);
    const link = within(select.closest('tr')!).getByRole('link', {
      name: `View ${listing.sku} on Flipkart (opens in a new tab)`,
    });
    assert.equal(link.getAttribute('href'), listing.productUrl);
    assert.equal(link.getAttribute('target'), '_blank');
    assert.ok(link.getAttribute('rel')?.includes('noopener'));
    link.focus();
    assert.equal(document.activeElement, link);
    fireEvent.click(link);
    assert.equal(select.checked, false);
    assert.equal(screen.queryByRole('dialog'), null);
  });
}

test('edits keep-back on a collapsed Tally item, previews order reservations, and saves only on request', async (t) => {
  const state = initialState('demo', 'unused');
  const item = state.items.find((row) => row.id === 'item-a')!;
  item.physical = 8;
  const pair = state.listings.find((row) => row.itemId === item.id && row.packSize === 2)!;
  state.listings
    .filter((row) => row.itemId === item.id)
    .forEach((row) => {
      row.tyreFloor = row === pair;
    });
  const writes: unknown[] = [];
  let checks = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/state') return response(state);
    if (url === '/api/items/keep-back/preview') {
      checks++;
      if (checks > 1) return response({ error: 'Order matching unavailable' }, 409);
      return response({ physical: 8, reservedUnits: 1, itemVersion: item.version });
    }
    assert.equal(url, '/api/items/keep-back');
    const input = JSON.parse(String(init?.body));
    writes.push(input);
    return response({
      ...state,
      items: state.items.map((row) =>
        row.id === item.id
          ? { ...row, keepBackUnits: input.keepBackUnits, version: row.version + 1 }
          : row,
      ),
    });
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: `Collapse ${item.name}` }));
  const field = screen.getByRole('spinbutton', {
    name: `Keep back from marketplaces for ${item.name}`,
  }) as HTMLInputElement;
  const form = within(field.closest('form')!);
  assert.equal(field.value, '0');
  assert.equal(checks, 0);
  fireEvent.change(field, { target: { value: '2' } });
  await form.findByText('Available for marketplaces');
  assert.ok(form.getByText('5 tyres'));
  assert.ok(form.getByText('6 tyres'));
  assert.ok(form.getByText(/Set of 2 can supply 2 complete sets/));
  fireEvent.change(field, { target: { value: '4' } });
  assert.ok(form.getByText('3 tyres'));
  assert.equal(checks, 1);
  assert.deepEqual(writes, []);
  fireEvent.change(screen.getByLabelText('Search stock items and listings'), {
    target: { value: 'missing item' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Show unsaved edits' }));
  assert.equal(document.activeElement, field);
  assert.equal(field.value, '4');
  fireEvent.click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.ok(!form.queryByRole('button', { name: 'Save' })));
  assert.deepEqual(writes, [
    { companyId: item.companyId, itemId: item.id, itemVersion: item.version, keepBackUnits: 4 },
  ]);
  fireEvent.change(field, { target: { value: '12' } });
  await form.findByText(/Order reservations need a fresh check/);
  assert.ok(form.getByText('0 tyres'));
  assert.ok(!form.queryByText('Available for marketplaces'));
  assert.ok(!(form.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled);
  fireEvent.change(field, { target: { value: '-1' } });
  assert.ok((form.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled);
  fireEvent.keyDown(field, { key: 'Escape' });
  assert.equal(field.value, '4');
  assert.equal(writes.length, 1);
});

test('startup shows progress until the inventory snapshot arrives', async (t) => {
  let finish!: (response: Response) => void;
  t.mock.method(
    globalThis,
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  assert.ok(screen.getByText('Opening your inventory workspace…'));
  assert.equal(screen.queryByRole('heading', { name: 'Inventory' }), null);

  finish(response(initialState('demo', 'unused')));
  await screen.findByRole('heading', { name: 'Inventory' });
  assert.equal(screen.queryByText('Opening your inventory workspace…'), null);
});

test('startup failure exposes the server error and a retry action', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    response({ error: 'Workspace could not be opened.' }, 503),
  );
  render(<App />);

  await screen.findByText('Workspace could not be opened.');
  assert.ok(screen.getByRole('button', { name: 'Try again' }));
  assert.equal(screen.queryByRole('heading', { name: 'Inventory' }), null);
});

test('listing actions dismiss on an outside click, another row, and Escape', async (t) => {
  const state = initialState('demo', 'unused');
  t.mock.method(globalThis, 'fetch', async () => response(state));
  await act(async () => {
    render(<App />);
  });
  const first = screen.getByLabelText('Actions for SAMPLE-CEAT-1-1');
  const second = screen.getByLabelText('Actions for SAMPLE-CEAT-2-2');
  const firstMenu = first.closest('details')!;
  const secondMenu = second.closest('details')!;
  const select = screen.getByRole('checkbox', {
    name: 'Select SAMPLE-CEAT-1-1',
  }) as HTMLInputElement;
  const click = (element: HTMLElement) => {
    fireEvent.pointerDown(element);
    fireEvent.click(element);
  };

  click(first);
  assert.ok(firstMenu.open);
  click(select);
  assert.ok(select.checked);
  assert.ok(!firstMenu.open);

  click(first);
  click(second);
  assert.ok(!firstMenu.open);
  assert.ok(secondMenu.open);
  const history = within(secondMenu).getByRole('button', { name: 'View history' });
  history.focus();
  fireEvent.keyDown(history, { key: 'Escape' });
  assert.ok(!secondMenu.open);
  assert.ok(document.activeElement === second);
});

test('collapsing and expanding navigation preserves filters, the selected screen and unsaved inputs', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, undefined);
    assert.equal(String(input), '/api/state');
    return response(initialState('demo', 'unused'));
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  const expand = screen.getByRole('button', { name: 'Expand sidebar' });
  assert.equal(expand.getAttribute('aria-expanded'), 'false');
  assert.equal(expand.textContent?.trim(), '');
  fireEvent.click(expand);
  const search = screen.getByRole('textbox', { name: 'Search stock items and listings' });
  fireEvent.change(search, { target: { value: 'Apollo' } });

  const collapse = screen.getByRole('button', { name: 'Collapse sidebar' });
  assert.equal(collapse.getAttribute('aria-expanded'), 'true');
  fireEvent.click(collapse);
  assert.equal(
    screen.getByRole('button', { name: 'Expand sidebar' }).getAttribute('aria-expanded'),
    'false',
  );
  assert.equal((search as HTMLInputElement).value, 'Apollo');

  const navigation = within(screen.getByRole('navigation', { name: 'Main navigation' }));
  fireEvent.click(navigation.getByRole('button', { name: 'Settings' }));
  assert.equal(
    navigation.getByRole('button', { name: 'Settings' }).getAttribute('aria-current'),
    'page',
  );
  const address = screen.getByRole('textbox', { name: /Connection address/ });
  fireEvent.change(address, { target: { value: 'http://127.0.0.1:9001/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
  assert.ok(screen.getByRole('heading', { name: 'Settings', level: 1 }));
  assert.equal((address as HTMLInputElement).value, 'http://127.0.0.1:9001/');
  assert.equal(
    screen.getByRole('button', { name: 'Collapse sidebar' }).getAttribute('aria-expanded'),
    'true',
  );

  fireEvent.click(navigation.getByRole('button', { name: 'Inventory' }));
  assert.equal(
    (screen.getByRole('textbox', { name: 'Search stock items and listings' }) as HTMLInputElement)
      .value,
    'Apollo',
  );
});

test('narrow navigation closes after selection and resizing preserves the sidebar state', async (t) => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')!;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 800 });
  t.after(() => Object.defineProperty(window, 'innerWidth', originalWidth));
  t.mock.method(globalThis, 'fetch', async () => response(initialState('live', 'unused')));
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });

  const toggle = screen.getByRole('button', { name: 'Expand sidebar' });
  const settings = screen.getByRole('button', { name: 'Settings' });
  const company = screen.getByLabelText('Tally company');
  fireEvent.click(toggle);
  act(() => settings.focus());
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  fireEvent.keyDown(settings, { key: 'Escape' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, toggle);
  fireEvent.click(toggle);
  act(() => settings.focus());
  act(() => company.focus());
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, company);

  fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
  assert.equal(
    screen.getByRole('button', { name: 'Collapse sidebar' }).getAttribute('aria-expanded'),
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  assert.ok(screen.getByRole('heading', { name: 'Settings', level: 1 }));
  assert.equal(
    screen.getByRole('button', { name: 'Expand sidebar' }).getAttribute('aria-expanded'),
    'false',
  );

  act(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1200 });
    window.dispatchEvent(new window.Event('resize'));
  });
  assert.equal(
    screen.getByRole('button', { name: 'Expand sidebar' }).getAttribute('aria-expanded'),
    'false',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
  act(() => settings.focus());
  act(() => company.focus());
  act(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1400 });
    window.dispatchEvent(new window.Event('resize'));
  });
  assert.equal(
    screen.getByRole('button', { name: 'Collapse sidebar' }).getAttribute('aria-expanded'),
    'true',
  );
});

test('an empty live workspace guides the user to connections and disables listing actions', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/flipkart/connection') return response(disconnectedFlipkart);
    assert.equal(String(input), '/api/state');
    return response(initialState('live', 'unused'));
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Start with your Tally company' });
  assert.deepEqual(
    within(screen.getByRole('combobox', { name: 'Seller account' }))
      .getAllByRole('option')
      .map((option) => option.textContent),
    ['No seller account'],
  );
  assert.equal(
    (screen.getByRole('button', { name: 'Calculate' }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByRole('button', { name: /Set to zero/ }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByRole('button', { name: /Review changes/ }) as HTMLButtonElement).disabled,
    true,
  );

  fireEvent.click(screen.getByRole('button', { name: 'View connections' }));
  assert.ok(screen.getByRole('heading', { name: 'Connections', level: 1 }));
  assert.ok(screen.getByRole('button', { name: 'Check & discover companies' }));
  assert.ok(screen.getByRole('button', { name: 'Open Marketplaces' }));
  document.documentElement.scrollTop = 565;
  fireEvent.click(screen.getByRole('button', { name: 'Open Tally settings' }));
  assert.equal(document.documentElement.scrollTop, 0);
  assert.ok(screen.getByRole('heading', { name: 'Settings', level: 1 }));
  assert.ok(screen.getByRole('textbox', { name: /Connection address/ }));
});

test('Marketplaces opens without a Tally company and hides the company selector', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/marketplaces') return response({ accounts: [] });
    assert.equal(String(input), '/api/state');
    return response(initialState('live', 'unused'));
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Start with your Tally company' });
  fireEvent.click(screen.getByRole('button', { name: 'Marketplaces' }));
  await screen.findByRole('heading', { name: 'Add your first marketplace account' });
  assert.equal(screen.queryByLabelText('Tally company'), null);
  assert.ok(screen.getByText('Marketplace edits apply individually'));
  fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
  assert.ok(screen.getByLabelText('Tally company'));
});

test('returning to Inventory immediately loads an added account and its imported listings', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let state: Snapshot = {
    ...initialState('demo', 'unused'),
    mode: 'live',
    accounts: [],
    listings: [],
  };
  const account: MarketplaceAccount = {
    id: 'new-account',
    name: 'New store',
    marketplace: 'flipkart',
    sellerId: 'new-seller',
    lastRefreshedAt: null,
    connection: disconnectedFlipkart,
  };
  const listing: MarketplaceListingView = {
    id: 'marketplace-listing',
    accountId: account.id,
    sellerId: account.sellerId!,
    productId: 'imported-product',
    sku: 'IMPORTED-TYRE',
    title: 'Imported tyre',
    imageUrl: null,
    status: 'ACTIVE',
    mrp: 1200,
    sellingPrice: 1000,
    locations: [{ id: 'warehouse-1', quantity: 4, status: 'ENABLED' }],
    observedAt: '2026-11-18T10:00:00Z',
    version: 1,
    stockPolicies: [],
  };
  let imported = false;
  let stateReads = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/state') {
        stateReads++;
        assert.equal(options?.method, undefined);
        return response(state);
      }
      if (path === '/api/marketplaces') return response({ accounts: [] });
      if (path === '/api/marketplaces/add') {
        state = {
          ...state,
          accounts: [
            {
              id: account.id,
              name: account.name,
              marketplace: 'flipkart',
              status: 'not-connected',
            },
          ],
        };
        return response(account);
      }
      if (path.startsWith('/api/marketplaces/listings?'))
        return response({
          listings: imported ? [listing] : [],
          total: imported ? 1 : 0,
          page: 1,
          pageSize: 20,
          lastRefreshedAt: imported ? listing.observedAt : null,
          changes: [],
        });
      assert.equal(path, '/api/marketplaces/refresh');
      assert.deepEqual(JSON.parse(String(options?.body)), { accountId: account.id });
      imported = true;
      state = {
        ...state,
        listings: [
          {
            id: 'inventory-listing',
            accountId: account.id,
            sku: listing.sku,
            title: listing.title,
            location: 'warehouse-1',
            itemId: null,
            packSize: null,
            packEvidence: 'Pack evidence has not been verified.',
            verified: false,
            observed: 4,
            observedAt: listing.observedAt,
            policy: 'auto',
            remaining: null,
            paused: false,
            version: 1,
          },
        ],
      };
      return response({ account: { ...account, lastRefreshedAt: listing.observedAt } });
    },
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.click(screen.getByRole('button', { name: 'Marketplaces' }));
  await screen.findByRole('heading', { name: 'Add your first marketplace account' });
  fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
  fireEvent.click(screen.getByRole('button', { name: /Flipkart/ }));
  fireEvent.change(screen.getByLabelText('Account name'), { target: { value: account.name } });
  fireEvent.change(screen.getByLabelText('Application ID'), { target: { value: 'test-id' } });
  fireEvent.change(screen.getByLabelText('Application Secret'), {
    target: { value: 'test-secret' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save without verification' }));
  const tile = await screen.findByRole('article', { name: account.name });
  fireEvent.click(within(tile).getByRole('button', { name: 'Open listings' }));
  await waitFor(() =>
    assert.equal(
      (screen.getByRole('button', { name: 'Refresh listings' }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Refresh listings' }));
  await screen.findByText(listing.title);
  assert.equal(stateReads, 1);

  fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
  await screen.findByRole('option', { name: account.name });
  assert.equal(stateReads, 2);
  assert.equal((screen.getByLabelText('Seller account') as HTMLSelectElement).value, account.id);
  const parent = screen.getByRole('row', { name: /Bridgestone Sturdo/ });
  fireEvent.click(within(parent).getByRole('button', { name: 'Map listing' }));
  const dialog = screen.getByRole('dialog', { name: 'Map an existing listing' });
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Flipkart listing' }));
  const destination = within(dialog).getByRole('option', { name: /IMPORTED-TYRE/ });
  assert.ok(within(destination).getByText(listing.title));
  assert.ok(within(destination).getByText('warehouse-1'));
});

test('a search with no matches disables bulk actions and can reset to all company listings', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(initialState('demo', 'unused')));
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.change(screen.getByLabelText('Search stock items and listings'), {
    target: { value: 'absent-stock' },
  });
  assert.ok(screen.getByRole('heading', { name: 'No matching items' }));
  assert.equal(
    (screen.getByRole('button', { name: 'Calculate' }) as HTMLButtonElement).disabled,
    true,
  );
  assert.ok(screen.getByText('0 filtered listings'));

  fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
  assert.equal(
    (screen.getByLabelText('Search stock items and listings') as HTMLInputElement).value,
    '',
  );
  assert.ok(screen.getByText('7 filtered listings'));
  assert.ok(screen.getByText('SAMPLE-CEAT-2-2'));
  assert.equal(screen.queryByText('SAMPLE-BRANCH-1'), null);
});

test('successful mapping closes the dialog and shows the listing under the chosen stock item', async (t) => {
  let state = initialState('demo', 'unused');
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/state') return response(state);
      assert.equal(String(input), '/api/mappings');
      assert.deepEqual(JSON.parse(String(options?.body)), {
        listingId: 'listing-9',
        itemId: 'item-d',
        confirmPackEvidence: true,
        expectedUnit: 'tyres',
        packSource: 'manual',
        packSize: 1,
        listingVersion: 1,
        sourceScope: 'company',
        tyreFloor: false,
      });
      state = {
        ...state,
        listings: state.listings.map((listing) =>
          listing.id === 'listing-9'
            ? {
                ...listing,
                itemId: 'item-d',
                packEvidence: 'Seller confirmed 1 Tally units per sale.',
              }
            : listing,
        ),
      };
      return response(state);
    },
  );
  render(<App />);
  const parent = await screen.findByRole('row', { name: /Bridgestone Sturdo/ });
  fireEvent.click(within(parent).getByRole('button', { name: 'Map listing' }));
  const dialog = screen.getByRole('dialog', { name: 'Map an existing listing' });
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Flipkart listing' }));
  fireEvent.click(within(dialog).getByRole('option', { name: /SAMPLE-UNMAPPED-1/ }));
  assert.equal(
    (within(dialog).getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /I confirm/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save mapping' }));

  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.ok(screen.getByText('SAMPLE-UNMAPPED-1'));
  assert.ok(screen.getByText('8 filtered listings'));
  assert.ok(screen.getByText('Mapping and Set of saved.'));
  assert.ok(screen.getByTitle('Seller confirmed 1 Tally unit per sale.'));
});

test('selected listings keep priority through zero draft, review, publication and readback', async (t) => {
  let state = initialState('demo', 'unused');
  const commands: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/state') return response(state);
      commands.push(path);
      if (path === '/api/publish') {
        assert.deepEqual(JSON.parse(String(options?.body)), { reviewId: 'review-selected' });
        state = {
          ...state,
          proposals: [],
          listings: state.listings.map((listing) =>
            listing.id === 'listing-2' ? { ...listing, paused: true, observed: 0 } : listing,
          ),
        };
        return response({
          rows: [
            {
              listingId: 'listing-2',
              sku: 'SAMPLE-CEAT-2-2',
              status: 'confirmed',
              message: 'Readback confirmed zero.',
            },
          ],
        });
      }
      assert.deepEqual(JSON.parse(String(options?.body)), {
        companyId: 'demo-a',
        listingIds: ['listing-2'],
      });
      if (path === '/api/zero') {
        state = {
          ...state,
          proposals: [
            {
              listingId: 'listing-2',
              quantity: 0,
              calculated: 5,
              edited: true,
              itemVersion: 1,
              listingVersion: 1,
              ruleVersion: 'flipkart-tyres-v1',
              createdAt: '2026-11-08T00:00:00.000Z',
              stale: false,
            },
          ],
        };
        return response(state);
      }
      assert.equal(path, '/api/review');
      const review: Review = {
        id: 'review-selected',
        companyId: 'demo-a',
        createdAt: '2026-11-08T00:00:00.000Z',
        publishingEnabled: true,
        rows: [
          {
            listingId: 'listing-2',
            sku: 'SAMPLE-CEAT-2-2',
            account: 'Sample seller',
            location: 'Sample warehouse',
            quantity: 0,
            observed: 5,
            policy: 'Tally sync paused',
            stale: false,
            problem: null,
          },
        ],
      };
      return response(review);
    },
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.click(screen.getByLabelText('Select SAMPLE-CEAT-2-2'));
  fireEvent.change(screen.getByLabelText('Filter by brand'), { target: { value: 'MRF' } });
  assert.ok(screen.getByText(/1 hidden by filters/));
  fireEvent.click(screen.getByRole('button', { name: /Set to zero/ }));
  await screen.findByText(
    'Zero-stock drafts saved. Review and publish to pause Tally sync for these locations.',
  );
  fireEvent.click(screen.getByRole('button', { name: /Review changes/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Review proposed stock' });
  assert.ok(within(dialog).getByText('1 listing destination'));
  assert.ok(within(dialog).getByText('SAMPLE-CEAT-2-2'));
  assert.ok(within(dialog).getByText('Tally sync paused'));
  assert.equal(within(dialog).queryByText('SAMPLE-MRF-2'), null);
  assert.deepEqual(commands, ['/api/zero', '/api/review']);
  assert.equal(state.listings[1].observed, 5);
  assert.equal(state.listings[1].paused, false);
  assert.equal(state.listings[1].policy, 'auto');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Publish 1 eligible listing' }));
  await within(dialog).findByText('Readback confirmed zero.');
  assert.ok(within(dialog).getByText('confirmed'));
  assert.equal(within(dialog).queryByRole('button', { name: /Publish 1/ }), null);
  assert.deepEqual(commands, ['/api/zero', '/api/review', '/api/publish']);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back to inventory' }));
  assert.equal(screen.queryByRole('dialog'), null);
  fireEvent.change(screen.getByLabelText('Filter by brand'), { target: { value: 'CEAT' } });
  const row = screen.getByRole('row', { name: /SAMPLE-CEAT-2-2/ });
  assert.ok(within(row).getByRole('button', { name: /Resume sync/ }));
  assert.equal(within(row).queryByText('Auto'), null);
});

test('polling preserves the open review and each new review includes only destinations with a verified replacement', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const state = initialState('demo', 'unused');
  const listings = state.listings.slice(0, 4);
  const [first, second, matched, uncertain] = listings;
  state.companies[0].automation = true;
  first.syncPendingItemVersion = 1;
  first.automationStatus = 'Queued for a stock check';
  second.paused = true;
  const ids = listings.map((listing) => listing.id);
  const at = new Date().toISOString();
  state.proposals = listings.map((listing, index) => ({
    listingId: listing.id,
    quantity: [7, 1, 2, 3][index],
    calculated: [7, 1, 2, 3][index],
    itemVersion: 1,
    listingVersion: 1,
    ruleVersion: 'complete-packs-v1',
    createdAt: at,
    stale: false,
    edited: false,
  }));
  const scopes: string[][] = [];
  const published: string[] = [];
  let firstRetry = true;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/state') return response(state);
    const body = JSON.parse(String(init?.body));
    if (url === '/api/review') {
      assert.equal(body.companyId, 'demo-a');
      if (scopes.length === 1 && firstRetry) {
        firstRetry = false;
        assert.deepEqual(body.listingIds, [first.id, second.id]);
        return response({ error: 'Could not load the latest quantities.' }, 503);
      }
      scopes.push(body.listingIds);
      return response({
        id: 'review-' + scopes.length,
        companyId: 'demo-a',
        createdAt: at,
        publishingEnabled: true,
        rows: (body.listingIds as string[]).map((id) => {
          const listing = listings.find((entry) => entry.id === id)!;
          const proposal = state.proposals.find((entry) => entry.listingId === id)!;
          return {
            listingId: id,
            sku: listing.sku,
            account: 'Seller',
            location: listing.location,
            observed: listing.observed,
            quantity: proposal.quantity,
            policy: 'Auto',
            problem: null,
            stale: false,
          };
        }),
      } satisfies Review);
    }
    assert.equal(url, '/api/publish');
    published.push(body.reviewId);
    const changed = (listing: typeof first, latestQuantity: number) => ({
      listingId: listing.id,
      sku: listing.sku,
      status: 'blocked',
      latestQuantity,
      message: 'Calculated stock changed.',
    });
    if (body.reviewId === 'review-1')
      return response({
        rows: [
          changed(first, 4),
          changed(second, 2),
          {
            listingId: matched.id,
            sku: matched.sku,
            status: 'unchanged',
            message: 'Already in sync.',
          },
          {
            listingId: uncertain.id,
            sku: uncertain.sku,
            status: 'uncertain',
            message: 'Check the previous update.',
          },
        ],
      });
    assert.equal(body.reviewId, 'review-2');
    state.proposals[0].quantity = 0;
    state.companies[0].automation = false;
    return response({
      rows: [
        changed(first, 0),
        {
          listingId: second.id,
          sku: second.sku,
          status: 'confirmed',
          message: 'Stock update confirmed.',
        },
      ],
    });
  });
  render(<App />);
  for (const listing of listings)
    fireEvent.click(await screen.findByLabelText('Select ' + listing.sku));
  fireEvent.click(screen.getByRole('button', { name: /Review changes/ }));
  const initial = await screen.findByRole('dialog', { name: 'Review proposed stock' });
  state.proposals[0].quantity = 4;
  state.proposals[1].quantity = 2;
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(
    (screen.getByLabelText('Proposed stock for ' + first.sku) as HTMLInputElement).value,
    '4',
  );
  assert.ok(within(initial).getByText('7'));
  assert.deepEqual(scopes, [ids]);
  assert.deepEqual(published, []);
  fireEvent.click(within(initial).getByRole('button', { name: 'Publish 4 eligible listings' }));
  const results = await screen.findByRole('dialog', { name: 'Stock publication results' });
  assert.match(
    within(results).getByRole('status').textContent ?? '',
    /1 already matched · 2 changed since review · 1 uncertain/,
  );
  assert.ok(within(results).getByText('Latest calculated stock: 4'));
  assert.ok(within(results).getByText('Automatic updates · Queued for a stock check'));
  assert.ok(within(results).getByText('Tally sync is paused at this location.'));
  fireEvent.click(
    within(results).getByRole('button', { name: 'Review latest quantities (2 listings)' }),
  );
  assert.equal(
    (await within(results).findByRole('alert')).textContent?.trim(),
    'Could not load the latest quantities.',
  );
  assert.equal(within(results).queryByRole('button', { name: /^Publish/ }), null);
  fireEvent.click(
    within(results).getByRole('button', { name: 'Review latest quantities (2 listings)' }),
  );
  const latest = await screen.findByRole('dialog', { name: 'Review proposed stock' });
  assert.deepEqual(scopes, [ids, [first.id, second.id]]);
  assert.deepEqual(published, ['review-1']);
  assert.ok(within(latest).getByText('4'));
  assert.equal(within(latest).queryByText(matched.sku), null);
  assert.equal(within(latest).queryByText(uncertain.sku), null);
  fireEvent.click(within(latest).getByRole('button', { name: 'Publish 2 eligible listings' }));
  const next = await screen.findByRole('button', { name: 'Review latest quantity (0)' });
  assert.ok(screen.getByText('Company sync is off.'));
  assert.equal(screen.queryByRole('button', { name: /^Publish \d/ }), null);
  fireEvent.click(next);
  const zero = await screen.findByRole('dialog', { name: 'Review proposed stock' });
  assert.deepEqual(scopes, [ids, [first.id, second.id], [first.id]]);
  assert.ok(within(zero).getByText('0'));
  assert.ok(within(zero).getByText('Auto'));
  assert.equal(within(zero).queryByText('Tally sync paused'), null);
  assert.deepEqual(published, ['review-1', 'review-2']);
});

test('company activation reviews every seller across filters and requires a fresh explicit decision after a trial', async (t) => {
  const state = initialState('demo', 'unused');
  state.mode = 'live';
  const company = state.companies[0];
  company.automation = false;
  let previews = 0;
  const writes: string[] = [];
  const rows = [
    {
      listingId: 'trial-a',
      sku: 'TRIAL',
      accountId: 'a',
      account: 'Seller A',
      location: 'North',
      observed: 3,
      proposed: 5,
      status: 'ready',
      reason: null,
      itemName: 'Tyre',
    },
    {
      listingId: 'same-b',
      sku: 'PAIR',
      accountId: 'b',
      account: 'Seller B',
      location: 'South',
      observed: 0,
      proposed: 0,
      status: 'ready',
      reason: null,
      itemName: 'Pair',
    },
    {
      listingId: 'blocked-b',
      sku: 'UNKNOWN',
      accountId: 'b',
      account: 'Seller B',
      location: 'West',
      observed: 2,
      proposed: null,
      status: 'waiting',
      reason: 'Verify Set of.',
      itemName: 'Tyre',
    },
    {
      listingId: 'paused-a',
      sku: 'PAUSED',
      accountId: 'a',
      account: 'Seller A',
      location: 'East',
      observed: 1,
      proposed: null,
      status: 'paused',
      reason: 'Paused by the seller.',
      itemName: 'Tyre',
    },
  ];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === '/api/state') return response(state);
    const body = JSON.parse(String(init?.body));
    if (String(input) === '/api/automation/preview') {
      assert.deepEqual(body, { companyId: company.id });
      return response({
        id: 'preview-' + ++previews,
        companyId: company.id,
        companyName: company.name,
        rows,
      });
    }
    writes.push(String(input));
    if (String(input) === '/api/automation/trial') {
      assert.deepEqual(body, {
        companyId: company.id,
        previewId: 'preview-1',
        listingId: 'trial-a',
      });
      assert.equal(company.automation, false);
      rows[0].observed = 5;
      return response({
        listingId: 'trial-a',
        sku: 'TRIAL',
        status: 'confirmed',
        message: 'Readback confirmed five.',
      });
    }
    assert.equal(String(input), '/api/automation');
    const expected = !company.automation;
    assert.deepEqual(body, {
      companyId: company.id,
      enabled: expected,
      ...(expected && { previewId: 'preview-2' }),
    });
    company.automation = expected;
    return response(state);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review automatic updates' }));
  const review = await screen.findByRole('dialog', { name: 'Review automatic updates' });
  assert.ok(within(review).getByRole('heading', { name: 'Seller B' }));
  assert.ok(within(review).getByText('Verify Set of.'));
  assert.ok(within(review).getByText('1 would change'));
  assert.ok(within(review).getByText('Already matches'));
  assert.deepEqual(writes, []);
  fireEvent.click(within(review).getByRole('button', { name: 'Try one listing' }));
  fireEvent.click(
    within(review).getByRole('button', { name: 'Choose TRIAL at North for Seller A' }),
  );
  assert.equal(within(review).queryByText('PAIR'), null);
  assert.deepEqual(writes, []);
  fireEvent.click(within(review).getByRole('button', { name: 'Publish this listing once' }));
  await within(review).findByText('Readback confirmed five.');
  assert.equal(within(review).queryByRole('button', { name: /Publish this/ }), null);
  assert.equal(within(review).queryByRole('button', { name: /Enable automatic/ }), null);
  fireEvent.click(within(review).getByRole('button', { name: 'Refresh company preview' }));
  await within(review).findByText('0 would change');
  fireEvent.click(
    within(review).getByRole('button', { name: 'Enable automatic updates for this company' }),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off automatic updates' }));
  await screen.findByRole('button', { name: 'Review automatic updates' });
  assert.deepEqual(writes, ['/api/automation/trial', '/api/automation', '/api/automation']);
});

test('an uncertain one-listing trial offers readback and requires a new preview before any other approval', async (t) => {
  const state = initialState('demo', 'unused');
  const company = state.companies[0];
  company.automation = false;
  const row = {
    listingId: 'one',
    sku: 'ONE',
    accountId: 'acct',
    account: 'Store',
    location: 'Office',
    itemName: 'Tyre',
    status: 'ready',
    reason: null,
    observed: 0,
    proposed: 5,
  };
  let writes = 0;
  let previews = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/state') return response(state);
    if (String(input) === '/api/automation/preview')
      return response({
        id: 'review-' + ++previews,
        companyId: company.id,
        companyName: company.name,
        rows: [
          writes
            ? {
                ...row,
                status: 'waiting',
                proposed: null,
                reason: 'Check the previous update result.',
              }
            : row,
        ],
      });
    assert.equal(String(input), '/api/automation/trial');
    writes++;
    return response({
      listingId: row.listingId,
      sku: row.sku,
      status: 'uncertain',
      message: 'Readback is unavailable.',
    });
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Try one listing' }));
  const dialog = await screen.findByRole('dialog', { name: 'Try one listing' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Choose ONE at Office for Store' }));
  const confirm = within(dialog).getByRole('button', { name: 'Simulate this listing once' });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await within(dialog).findByText('Check the update result');
  assert.ok(within(dialog).getByText(/Open this SKU in Marketplaces/));
  assert.equal(
    within(dialog).queryByRole('button', { name: /Simulate this listing once|Enable automatic/ }),
    null,
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh company preview' }));
  await within(dialog).findByText('Check the previous update result.');
  assert.equal(
    (within(dialog).getByRole('button', { name: 'Try one listing' }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(writes, 1);
  assert.equal(company.automation, false);
});

test('pause and resume target one listing while preserving its limited-sales policy', async (t) => {
  let state = initialState('demo', 'unused');
  const pauses: boolean[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/state') return response(state);
      assert.equal(String(input), '/api/pause');
      const body = JSON.parse(String(options?.body));
      assert.deepEqual(body, {
        companyId: 'demo-a',
        listingIds: ['listing-6'],
        listingVersion: state.listings.find((row) => row.id === 'listing-6')!.version,
        paused: pauses.length > 0,
      });
      pauses.push(body.paused);
      state = {
        ...state,
        listings: state.listings.map((listing) =>
          listing.id === 'listing-6' ? { ...listing, paused: body.paused } : listing,
        ),
      };
      return response(state);
    },
  );
  render(<App />);
  const row = await screen.findByRole('row', { name: /SAMPLE-MRF-2/ });
  fireEvent.click(within(row).getByRole('button', { name: /Resume sync for SAMPLE-MRF-2/ }));
  fireEvent.click(await within(row).findByRole('button', { name: 'Pause automation' }));
  await within(row).findByRole('button', { name: /Resume sync for SAMPLE-MRF-2/ });
  assert.deepEqual(pauses, [false, true]);
  const listing = state.listings.find((value) => value.id === 'listing-6')!;
  assert.equal(listing.policy, 'limited');
  assert.equal(listing.remaining, 1);
  assert.equal(listing.observed, 1);
});

for (const blocked of [false, true]) {
  test(`resume replaces a typed quantity with ${blocked ? 'the calculation issue' : 'fresh proposed stock'} while keeping the stock-check status and Auto badge`, async (t) => {
    const state = initialState('demo', 'unused');
    const listing = state.listings.find((row) => row.sku === 'SAMPLE-CEAT-2-2')!;
    listing.paused = true;
    const proposed = {
      listingId: listing.id,
      quantity: 0,
      calculated: 0,
      edited: true,
      itemVersion: 1,
      listingVersion: listing.version,
      ruleVersion: 'flipkart-tyres-v1',
      createdAt: '2026-11-08T00:00:00.000Z',
      stale: false,
    };
    if (!blocked) state.proposals = [proposed];
    const issue = 'Check the stock balance in Tally.';
    let resumes = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (path: string | URL | Request, options?: RequestInit) => {
        if (String(path) === '/api/state') return response(state);
        assert.equal(String(path), '/api/pause');
        const body = JSON.parse(String(options?.body));
        assert.deepEqual(body.listingIds, [listing.id]);
        assert.equal(body.paused, false);
        resumes++;
        listing.paused = false;
        listing.version++;
        listing.automationStatus = 'Queued for a stock check';
        if (blocked) listing.proposalIssue = issue;
        else
          state.proposals = [
            {
              ...proposed,
              quantity: 5,
              calculated: 5,
              edited: false,
              listingVersion: listing.version,
            },
          ];
        return response(state);
      },
    );
    render(<App />);
    const field = await screen.findByLabelText('Proposed stock for SAMPLE-CEAT-2-2');
    const row = within(field.closest('tr')!);
    const input = () => row.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input(), { target: { value: '9' } });
    fireEvent.click(row.getByRole('button', { name: /Resume sync/ }));
    await row.findByRole('button', { name: 'Pause automation' });
    assert.equal(input().value, blocked ? '' : '5');
    assert.ok(row.getByText('Auto'));
    assert.ok(row.getByText('Queued for a stock check'));
    assert.ok(
      blocked
        ? row.getByText(/Check the stock balance in Tally.*Calculate to retry/)
        : row.getByText('Calculated draft'),
    );
    await waitFor(() => {
      assert.ok(!screen.queryByText(/unsaved quantity edit/i), 'Resume clears the unsaved edit');
    });
    assert.equal(resumes, 1);
  });
}

test('failed inventory refresh retains stock and retries the selected company and seller', async (t) => {
  const state = initialState('demo', 'unused');
  let refreshes = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/state') return response(state);
      assert.equal(String(input), '/api/inventory/refresh');
      assert.deepEqual(JSON.parse(String(options?.body)), {
        companyId: 'demo-b',
        accountId: 'flipkart-primary',
      });
      refreshes++;
      return refreshes === 1
        ? response({ error: 'Tally is offline. Saved observations were retained.' }, 503)
        : response({
            ...state,
            refresh: { partial: false, message: 'Stock and listings refreshed.' },
          });
    },
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.change(screen.getByLabelText('Tally company'), { target: { value: 'demo-b' } });
  fireEvent.change(screen.getByLabelText('Seller account'), {
    target: { value: 'flipkart-primary' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  assert.match((await screen.findByRole('alert')).textContent ?? '', /Tally is offline/);
  assert.ok(screen.getByText('SAMPLE-BRANCH-1'));
  assert.ok(within(screen.getByRole('row', { name: /SAMPLE-BRANCH-1/ })).getByText('20'));

  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  await screen.findByText('Stock and listings refreshed.');
  assert.equal(refreshes, 2);
  assert.equal(screen.queryByRole('alert'), null);
});

for (const view of ['Inventory', 'Connections'] as const) {
  test(`${view} reports an offline refresh snapshot as failure and retains saved stock`, async (t) => {
    const state = initialState('demo', 'unused');
    state.mode = 'live';
    state.connection.tally = 'online';
    const failure =
      'Tally could not provide a verified snapshot. Check that Tally is open, its HTTP server is enabled, and the intended company is loaded. Previous observations are retained.';
    let refreshes = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, options?: RequestInit) => {
        if (String(input) === '/api/state') return response(state);
        if (String(input) === '/api/flipkart/connection') return response(disconnectedFlipkart);
        assert.equal(
          String(input),
          view === 'Inventory' ? '/api/inventory/refresh' : '/api/refresh',
        );
        assert.deepEqual(
          JSON.parse(String(options?.body)),
          view === 'Inventory' ? { companyId: 'demo-a', accountId: 'flipkart-primary' } : {},
        );
        refreshes++;
        return response({
          ...state,
          ...(view === 'Inventory' && {
            refresh: {
              partial: refreshes === 1,
              message: refreshes === 1 ? failure : 'Stock and listings refreshed.',
            },
          }),
          connection: {
            ...state.connection,
            tally: refreshes === 1 ? 'offline' : 'online',
            message: refreshes === 1 ? failure : 'Stock observations refreshed.',
          },
        });
      },
    );
    render(<App />);
    await screen.findByRole('heading', { name: 'Inventory' });
    if (view === 'Connections')
      fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    const action = view === 'Inventory' ? 'Refresh inventory' : 'Check & discover companies';
    fireEvent.click(screen.getByRole('button', { name: action }));

    await waitFor(() =>
      assert.match(
        screen.queryByRole('alert')?.textContent ?? '',
        /Tally could not provide a verified snapshot/,
      ),
    );
    assert.equal(
      screen.queryByText('Refresh completed. Saved observations are shown below.'),
      null,
    );
    assert.equal(screen.queryByText('Tally connection check completed.'), null);
    assert.ok(screen.getByText('Tally offline'));

    if (view === 'Connections') fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
    const listing = screen.getByRole('row', { name: /SAMPLE-CEAT-2-2/ });
    assert.ok(within(listing).getByText('5'));
    if (view === 'Connections')
      fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    fireEvent.click(screen.getByRole('button', { name: action }));
    await screen.findByText(
      view === 'Inventory'
        ? 'Stock and listings refreshed.'
        : 'Refresh completed. Saved observations are shown below.',
    );
    assert.equal(screen.queryByRole('alert'), null);
    assert.ok(screen.getByText('Tally connected'));
    assert.equal(refreshes, 2);
  });
}
test('failed mapping keeps the dialog, selected listing and confirmation available for correction', async (t) => {
  const state = initialState('demo', 'unused');
  let mappingAttempts = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/state') return response(state);
      if (path === '/api/mappings') {
        mappingAttempts++;
        assert.equal(options?.method, 'POST');
        assert.deepEqual(JSON.parse(String(options?.body)), {
          listingId: 'listing-9',
          itemId: 'item-d',
          confirmPackEvidence: true,
          expectedUnit: 'tyres',
          packSource: 'manual',
          packSize: 1,
          listingVersion: 1,
          sourceScope: 'company',
          tyreFloor: false,
        });
        return response({ error: 'Pack evidence changed. Check the listing again.' }, 409);
      }
      return response({ error: 'Unexpected request in this scenario.' }, 501);
    },
  );

  render(<App />);
  const parent = await screen.findByRole('row', { name: /Bridgestone Sturdo/ });
  fireEvent.click(within(parent).getByRole('button', { name: 'Map listing' }));
  const dialog = screen.getByRole('dialog', { name: 'Map an existing listing' });
  fireEvent.click(within(dialog).getByRole('combobox', { name: 'Flipkart listing' }));
  fireEvent.click(within(dialog).getByRole('option', { name: /SAMPLE-UNMAPPED-1/ }));
  const confirmation = within(dialog).getByRole('checkbox', { name: /I confirm/ });
  fireEvent.click(confirmation);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save mapping' }));

  const alert = await within(dialog).findByRole('alert');
  assert.match(alert.textContent ?? '', /Pack evidence changed/);
  assert.equal(screen.getByRole('dialog', { name: 'Map an existing listing' }), dialog);
  assert.ok(
    within(dialog)
      .getByRole('group', { name: 'Selected listing' })
      .textContent?.includes('SAMPLE-UNMAPPED-1'),
  );
  assert.equal((confirmation as HTMLInputElement).checked, true);
  assert.equal(mappingAttempts, 1);
});

test('a mixed calculation links to the affected Set of and reviews only the ready draft', async (t) => {
  const state = initialState('demo', 'unused');
  state.listings = state.listings.filter((l) => ['listing-1', 'listing-2'].includes(l.id));
  const [ready, blocked] = state.listings;
  blocked.verified = false;
  const draft = {
    listingId: ready.id,
    quantity: 5,
    calculated: 5,
    edited: false,
    itemVersion: 1,
    listingVersion: 1,
    ruleVersion: 'flipkart-tyres-v1',
    createdAt: new Date().toISOString(),
    stale: false,
  };
  // The failed row still has an older draft. It must stay out of the ready review.
  state.proposals = [{ ...draft, listingId: blocked.id }];
  const reviews: string[][] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/state') return response(state);
      if (path === '/api/mappings') {
        assert.equal(JSON.parse(String(options?.body)).listingId, blocked.id);
        blocked.verified = true;
        return response(state);
      }
      if (path === '/api/calculate' && blocked.verified) {
        assert.deepEqual(JSON.parse(String(options?.body)).listingIds, [blocked.id]);
        return response({
          ...state,
          proposals: [{ ...draft, listingId: blocked.id }],
          calculation: [{ listingId: blocked.id, status: 'ready' }],
        });
      }
      if (path === '/api/calculate')
        return response({
          ...state,
          proposals: [...state.proposals, draft],
          calculation: [
            { listingId: ready.id, status: 'ready' },
            {
              listingId: blocked.id,
              status: 'blocked',
              reason: 'Confirm the pack size.',
              fix: 'pack',
            },
          ],
        });
      if (path === '/api/review') {
        const ids: string[] = JSON.parse(String(options?.body)).listingIds;
        reviews.push(ids);
        return response({
          id: 'ready-review',
          companyId: 'demo-a',
          createdAt: draft.createdAt,
          rows: ids.map((listingId) => ({
            listingId,
            sku: listingId,
            account: 'Sample seller',
            location: 'Sample warehouse',
            quantity: 5,
            observed: 5,
            policy: 'Auto',
            stale: false,
            problem: null,
          })),
          publishingEnabled: true,
        });
      }
      if (path === '/api/publish') {
        return response({
          rows: [
            {
              listingId: ready.id,
              sku: ready.sku,
              status: 'unchanged',
              message: 'Stock already matches.',
            },
          ],
        });
      }
      return response({ error: 'Unexpected request' }, 404);
    },
  );
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Calculate' }));
  await screen.findByText('1 draft ready · 1 listing needs Set of confirmation');
  fireEvent.click(screen.getByRole('button', { name: /Fix Set of for/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit Set of' });
  assert.ok(within(dialog).getByText(blocked.sku));
  fireEvent.click(within(dialog).getByRole('button', { name: /Cancel/i }));
  fireEvent.click(screen.getByRole('button', { name: /Review ready drafts/ }));
  await screen.findByRole('dialog', { name: 'Review proposed stock' });
  assert.deepEqual(reviews, [[ready.id]]);
  fireEvent.click(screen.getByRole('button', { name: 'Publish 1 eligible listing' }));
  await screen.findByRole('dialog', { name: 'Stock publication results' });
  fireEvent.click(screen.getByRole('button', { name: 'Back to inventory' }));
  await screen.findByText('0 drafts ready · 1 listing needs Set of confirmation');
  fireEvent.click(screen.getByRole('button', { name: /Fix Set of for/ }));
  const repair = await screen.findByRole('dialog', { name: 'Edit Set of' });
  fireEvent.click(within(repair).getByRole('checkbox', { name: /I confirm the item/ }));
  fireEvent.click(within(repair).getByRole('button', { name: 'Save Set of' }));
  await screen.findByText('1 draft ready');
  assert.equal(screen.queryByRole('button', { name: /Fix Set of for/ }), null);
  fireEvent.click(screen.getByRole('button', { name: /Review changes/ }));
  await screen.findByRole('dialog', { name: 'Review proposed stock' });
  assert.deepEqual(reviews, [[ready.id], [blocked.id]]);
});

test('a filtered quantity edit blocks review until saved and stays separate from observed stock', async (t) => {
  let state = initialState('demo', 'unused');
  const preparedAt = new Date().toISOString();
  const submittedScopes: string[][] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/state') return response(state);
      const body = JSON.parse(String(options?.body)) as {
        companyId: string;
        listingIds?: string[];
        listingId?: string;
        quantity?: number;
      };
      assert.equal(body.companyId, 'demo-a');
      if (path === '/api/calculate') {
        submittedScopes.push(body.listingIds!);
        if (!state.proposals.length)
          state = {
            ...state,
            proposals: [
              {
                listingId: 'listing-2',
                quantity: 5,
                calculated: 5,
                edited: false,
                itemVersion: 1,
                listingVersion: 1,
                ruleVersion: 'flipkart-tyres-v1',
                createdAt: preparedAt,
                stale: false,
              },
            ],
          };
        return response({ ...state, calculation: [{ listingId: 'listing-2', status: 'ready' }] });
      }
      if (path === '/api/inventory/refresh') {
        state = {
          ...state,
          proposals: state.proposals.map((draft) => ({
            ...draft,
            quantity: 3,
            calculated: 3,
            itemVersion: draft.itemVersion + 1,
            createdAt: '2026-11-23T10:00:00.000Z',
          })),
        };
        return response({
          ...state,
          refresh: { partial: false, message: 'Stock and listings refreshed.' },
        });
      }
      if (path === '/api/proposals') {
        assert.equal(body.listingId, 'listing-2');
        assert.equal(body.quantity, 1);
        state = {
          ...state,
          proposals: [
            {
              ...state.proposals[0],
              quantity: 1,
              edited: true,
              createdAt: new Date(Date.now() + 1000).toISOString(),
            },
          ],
        };
        return response(state);
      }
      return response({ error: 'Unexpected request in this scenario.' }, 501);
    },
  );

  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.change(screen.getByLabelText('Filter by brand'), { target: { value: 'CEAT' } });
  fireEvent.change(screen.getByLabelText('Filter by pack size'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
  await waitFor(() =>
    assert.equal(
      (screen.getByLabelText('Proposed stock for SAMPLE-CEAT-2-2') as HTMLInputElement).value,
      '5',
    ),
  );

  fireEvent.change(screen.getByLabelText('Proposed stock for SAMPLE-CEAT-2-2'), {
    target: { value: '1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  await screen.findByText('Stock and listings refreshed.');
  assert.equal(
    (screen.getByLabelText('Proposed stock for SAMPLE-CEAT-2-2') as HTMLInputElement).value,
    '1',
  );
  assert.equal(
    (screen.getByRole('button', { name: /Review changes/ }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByRole('button', { name: 'Calculate' }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save draft quantity for SAMPLE-CEAT-2-2' }));
  await screen.findByText('Choose how to publish at review');
  await waitFor(() =>
    assert.equal(
      (screen.getByRole('button', { name: /Review changes/ }) as HTMLButtonElement).disabled,
      false,
    ),
  );
  assert.equal(state.listings.find((listing) => listing.id === 'listing-2')?.observed, 5);
  assert.equal(state.listings.find((listing) => listing.id === 'listing-2')?.policy, 'auto');

  fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
  await waitFor(() => assert.equal(submittedScopes.length, 2));
  assert.deepEqual(submittedScopes, [['listing-2'], ['listing-2']]);
  assert.equal(
    (screen.getByLabelText('Proposed stock for SAMPLE-CEAT-2-2') as HTMLInputElement).value,
    '1',
  );
});

test('switching company clears inventory selection and filters without combining stock', async (t) => {
  const state: Snapshot = initialState('demo', 'unused');
  t.mock.method(globalThis, 'fetch', async () => response(state));
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.click(screen.getByLabelText('Select SAMPLE-CEAT-2-2'));
  fireEvent.change(screen.getByLabelText('Filter by brand'), { target: { value: 'MRF' } });
  fireEvent.change(screen.getByLabelText('Tally company'), { target: { value: 'demo-b' } });

  assert.equal((screen.getByLabelText('Filter by brand') as HTMLSelectElement).value, '');
  assert.ok(screen.getByText('SAMPLE-BRANCH-1'));
  assert.equal(screen.queryByText('SAMPLE-CEAT-2-2'), null);
  assert.equal(screen.queryByLabelText('Select SAMPLE-CEAT-2-2'), null);
  assert.match(screen.getByText('1 filtered listing').textContent ?? '', /1 filtered listing/);
});

test('an unsaved edit survives collapse, changing filters and a stock change that removes the row from Low stock', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const state = initialState('demo', 'unused');
  const listing = state.listings[0];
  listing.paused = true;
  state.proposals = [
    {
      listingId: listing.id,
      calculated: 5,
      quantity: 5,
      edited: false,
      stale: false,
      itemVersion: state.items[0].version,
      listingVersion: listing.version,
      createdAt: new Date().toISOString(),
      ruleVersion: 'complete-packs-v1',
    },
  ];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, '/api/state');
    return response(state);
  });
  let discard = false;
  const confirmation = t.mock.method(window, 'confirm', () => discard);
  render(<App />);
  const item = state.items[0];
  const label = 'Proposed stock for ' + listing.sku;
  const input = () => screen.getByRole('spinbutton', { name: label }) as HTMLInputElement;
  fireEvent.click(await screen.findByRole('button', { name: /Show low physical stock/ }));
  const menu = screen.getByLabelText('Actions for ' + listing.sku);
  fireEvent.click(menu);
  const reviewButton = within(menu.closest('details')!).getByRole('button', {
    name: 'Review proposal',
  }) as HTMLButtonElement;
  assert.equal(reviewButton.disabled, false);
  fireEvent.change(input(), { target: { value: '3' } });
  assert.equal(reviewButton.disabled, true);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse ' + item.name }));
  assert.equal(screen.queryByRole('spinbutton', { name: label }), null);
  assert.ok(screen.getByRole('button', { name: 'Show unsaved edits' }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand ' + item.name }));
  assert.equal(input().value, '3');
  listing.paused = false; // Another dashboard resumed this listing during polling.
  item.physical = 12;
  await act(async () => t.mock.timers.tick(15_000));
  assert.equal(screen.queryByRole('spinbutton', { name: label }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Show unsaved edits' }));
  assert.equal(input().value, '3');
  assert.equal(document.activeElement, input());
  fireEvent.change(screen.getByRole('textbox', { name: 'Search stock items and listings' }), {
    target: { value: 'missing tyre' },
  });
  assert.ok(screen.getByText('No matching items'));
  assert.equal(screen.queryByRole('spinbutton', { name: label }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Show unsaved edits' }));
  assert.equal(input().value, '3');
  assert.equal(document.activeElement, input());
  const company = screen.getByLabelText('Tally company') as HTMLSelectElement;
  fireEvent.change(company, { target: { value: 'demo-b' } });
  assert.equal(company.value, 'demo-a');
  assert.equal(input().value, '3');
  discard = true;
  fireEvent.change(company, { target: { value: 'demo-b' } });
  assert.equal(company.value, 'demo-b');
  fireEvent.change(company, { target: { value: 'demo-a' } });
  assert.equal(input().value, '5');
  assert.equal(confirmation.mock.callCount(), 2);
});

test('a pending Inventory review stays with the screen and seller that requested it', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings[0];
  state.accounts.push({ ...state.accounts[0], id: 'other-seller', name: 'Other seller' });
  state.proposals = [
    {
      listingId: listing.id,
      quantity: 3,
      calculated: 3,
      itemVersion: 1,
      listingVersion: 1,
      ruleVersion: 'complete-packs-v1',
      createdAt: new Date().toISOString(),
      stale: false,
      edited: false,
    },
  ];
  let finish!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === '/api/state') return response(state);
    assert.equal(url, '/api/review');
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  render(<App />);
  const prepare = await screen.findByRole('button', { name: /Review changes/ });
  fireEvent.click(prepare);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  await act(async () =>
    finish(response({ id: 'review', companyId: 'demo-a', rows: [], publishingEnabled: true })),
  );
  assert.equal(document.querySelector('dialog[open]'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Inventory' }));
  const dialog = screen.getByRole('dialog', { name: 'Review proposed stock' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
  fireEvent.click(prepare);
  fireEvent.change(screen.getByLabelText('Seller account'), { target: { value: 'other-seller' } });
  await act(async () =>
    finish(
      response({ id: 'old-seller-review', companyId: 'demo-a', rows: [], publishingEnabled: true }),
    ),
  );
  assert.equal(document.querySelector('dialog[open]'), null);
  assert.equal(
    (screen.getByLabelText('Seller account') as HTMLSelectElement).value,
    'other-seller',
  );
});
