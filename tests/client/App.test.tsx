import assert from 'node:assert/strict';
import test from 'node:test';
import { render, screen, within, fireEvent, waitFor, response } from '../support/client-dom.js';
import type { FlipkartConnectionStatus, Review, Snapshot } from '../../src/shared/contracts.js';
import { initialState } from '../../src/server/seed.js';
import { App } from '../../src/client/App.js';

const disconnectedFlipkart: FlipkartConnectionStatus = {
  state: 'not-configured',
  checkedAt: null,
  expiresAt: null,
  applicationIdHint: null,
  message: 'No Flipkart API credentials are saved.',
};

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

test('an empty live workspace guides the user to connections and disables listing actions', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/flipkart/connection') return response(disconnectedFlipkart);
    assert.equal(String(input), '/api/state');
    return response(initialState('live', 'unused'));
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Start with your Tally company' });
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
  await screen.findByText('Not configured');
  fireEvent.click(screen.getByRole('button', { name: 'Open Tally settings' }));
  assert.ok(screen.getByRole('heading', { name: 'Settings', level: 1 }));
  assert.ok(screen.getByRole('textbox', { name: /Connection address/ }));
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
      });
      state = {
        ...state,
        listings: state.listings.map((listing) =>
          listing.id === 'listing-9' ? { ...listing, itemId: 'item-d' } : listing,
        ),
      };
      return response(state);
    },
  );
  render(<App />);
  const parent = await screen.findByRole('row', { name: /Bridgestone Sturdo/ });
  fireEvent.click(within(parent).getByRole('button', { name: 'Map listing' }));
  const dialog = screen.getByRole('dialog', { name: 'Map an existing listing' });
  fireEvent.change(within(dialog).getByLabelText('Existing marketplace listing'), {
    target: { value: 'listing-9' },
  });
  assert.equal(
    (within(dialog).getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(within(dialog).getByRole('checkbox'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save mapping' }));

  await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
  assert.ok(screen.getByText('SAMPLE-UNMAPPED-1'));
  assert.ok(screen.getByText('8 filtered listings'));
  assert.ok(
    screen.getByText('Mapping saved locally. No Tally product or marketplace listing was created.'),
  );
});

test('selected listings keep priority over filters when preparing zero drafts and review', async (t) => {
  let state = initialState('demo', 'unused');
  const commands: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/state') return response(state);
      commands.push(path);
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
        publishingEnabled: false,
        rows: [
          {
            listingId: 'listing-2',
            sku: 'SAMPLE-CEAT-2-2',
            account: 'Sample seller',
            location: 'Sample warehouse',
            quantity: 0,
            observed: 5,
            policy: 'Keep out of stock',
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
    'Zero-stock drafts saved. Active policies and marketplace stock are unchanged.',
  );
  fireEvent.click(screen.getByRole('button', { name: /Review changes/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Review proposed stock' });
  assert.ok(within(dialog).getByText('1 listing destinations'));
  assert.ok(within(dialog).getByText('SAMPLE-CEAT-2-2'));
  assert.equal(within(dialog).queryByText('SAMPLE-MRF-2'), null);
  assert.equal(
    (within(dialog).getByRole('button', { name: 'Publish unavailable' }) as HTMLButtonElement)
      .disabled,
    true,
  );
  assert.deepEqual(commands, ['/api/zero', '/api/review']);
  assert.equal(state.listings[1].observed, 5);
  assert.equal(state.listings[1].policy, 'auto');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back to inventory' }));
  assert.equal(screen.queryByRole('dialog'), null);
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
  fireEvent.click(within(row).getByRole('button', { name: 'Paused · resume' }));
  fireEvent.click(await within(row).findByRole('button', { name: 'Pause automation' }));
  await within(row).findByRole('button', { name: 'Paused · resume' });
  assert.deepEqual(pauses, [false, true]);
  const listing = state.listings.find((value) => value.id === 'listing-6')!;
  assert.equal(listing.policy, 'limited');
  assert.equal(listing.remaining, 1);
  assert.equal(listing.observed, 1);
});

test('failed refresh retains the shown stock and a retry uses the selected company', async (t) => {
  const state = initialState('demo', 'unused');
  let refreshes = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/state') return response(state);
      assert.equal(String(input), '/api/refresh');
      assert.deepEqual(JSON.parse(String(options?.body)), { companyId: 'demo-b' });
      refreshes++;
      return refreshes === 1
        ? response({ error: 'Tally is offline. Saved observations were retained.' }, 503)
        : response(state);
    },
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.change(screen.getByLabelText('Tally company'), { target: { value: 'demo-b' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh Tally' }));
  assert.match((await screen.findByRole('alert')).textContent ?? '', /Tally is offline/);
  assert.ok(screen.getByText('SAMPLE-BRANCH-1'));
  assert.ok(within(screen.getByRole('row', { name: /SAMPLE-BRANCH-1/ })).getByText('20'));

  fireEvent.click(screen.getByRole('button', { name: 'Refresh Tally' }));
  await screen.findByText('Refresh completed. Saved observations are shown below.');
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
        assert.equal(String(input), '/api/refresh');
        assert.deepEqual(
          JSON.parse(String(options?.body)),
          view === 'Inventory' ? { companyId: 'demo-a' } : {},
        );
        refreshes++;
        return response({
          ...state,
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
    const action = view === 'Inventory' ? 'Refresh Tally' : 'Check & discover companies';
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
    await screen.findByText('Refresh completed. Saved observations are shown below.');
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
  const select = within(dialog).getByLabelText('Existing marketplace listing') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'listing-9' } });
  const confirmation = within(dialog).getByRole('checkbox');
  fireEvent.click(confirmation);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save mapping' }));

  const alert = await within(dialog).findByRole('alert');
  assert.match(alert.textContent ?? '', /Pack evidence changed/);
  assert.equal(screen.getByRole('dialog', { name: 'Map an existing listing' }), dialog);
  assert.equal(select.value, 'listing-9');
  assert.equal((confirmation as HTMLInputElement).checked, true);
  assert.equal(mappingAttempts, 1);
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
        return response(state);
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
  assert.equal(
    (screen.getByRole('button', { name: /Review changes/ }) as HTMLButtonElement).disabled,
    true,
  );
  assert.equal(
    (screen.getByRole('button', { name: 'Calculate' }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save draft quantity for SAMPLE-CEAT-2-2' }));
  await screen.findByText('Draft: allow 1 more');
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
  assert.match(screen.getByText('1 filtered listings').textContent ?? '', /1 filtered listings/);
});
