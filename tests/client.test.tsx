import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import type { Snapshot } from '../src/shared/contracts.js';
import { initialState } from '../src/server/seed.js';
import { App } from '../src/client/App.js';
import { RemoveMappingDialog } from '../src/client/screens/InventoryDialogs.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4311',
});
Object.defineProperties(globalThis, {
  window: { configurable: true, value: dom.window },
  document: { configurable: true, value: dom.window.document },
  navigator: { configurable: true, value: dom.window.navigator },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  HTMLInputElement: { configurable: true, value: dom.window.HTMLInputElement },
  HTMLDialogElement: { configurable: true, value: dom.window.HTMLDialogElement },
  MutationObserver: { configurable: true, value: dom.window.MutationObserver },
  IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
});
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};

// Testing Library must bind its queries after the document exists.
const { render, screen, within, fireEvent, waitFor, cleanup } =
  await import('@testing-library/react');
afterEach(() => cleanup());

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

test('failed unlink stays open and closes only after a successful retry', async () => {
  const state = initialState('demo', 'unused');
  let closes = 0;
  let attempts = 0;
  render(
    <RemoveMappingDialog
      listing={state.listings[0]}
      busy={false}
      onClose={() => {
        closes++;
      }}
      onRemove={async () =>
        ++attempts === 1
          ? { ok: false, error: 'The mapping changed. Try again after reviewing.' }
          : { ok: true, value: state }
      }
    />,
  );

  const dialog = screen.getByRole('dialog', { name: 'Remove stock mapping' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Leave stock unchanged & unlink' }));
  await within(dialog).findByRole('alert');
  assert.equal(closes, 0);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Leave stock unchanged & unlink' }));
  await waitFor(() => assert.equal(closes, 1));
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
