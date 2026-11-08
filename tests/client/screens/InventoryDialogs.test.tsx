import assert from 'node:assert/strict';
import test from 'node:test';
import { render, screen, within, fireEvent, waitFor } from '../../support/client-dom.js';
import { initialState } from '../../../src/server/seed.js';
import {
  MappingDialog,
  RemoveMappingDialog,
  ReviewDialog,
} from '../../../src/client/screens/InventoryDialogs.js';
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

test('mapping offers only unmapped listings from the selected seller account', () => {
  const state = initialState('demo', 'unused');
  state.listings.push({
    ...state.listings[8],
    id: 'other-listing',
    accountId: 'other-account',
    sku: 'OTHER-ACCOUNT',
  });
  render(
    <MappingDialog
      item={state.items[3]}
      state={state}
      accountId="flipkart-primary"
      busy={false}
      onClose={() => {}}
      onSave={async () => ({ ok: true, value: state })}
    />,
  );

  const choices = screen
    .getAllByRole('option')
    .map((option) => (option as HTMLOptionElement).value);
  assert.deepEqual(choices, ['', 'listing-9']);
  assert.equal(screen.queryByText('OTHER-ACCOUNT'), null);
});

test('changing the mapping destination resets product confirmation and blocks unverified packs', () => {
  const state = initialState('demo', 'unused');
  state.listings.push({
    ...state.listings[8],
    id: 'unverified-listing',
    sku: 'UNVERIFIED',
    verified: false,
    packSize: null,
  });
  render(
    <MappingDialog
      item={state.items[3]}
      state={state}
      accountId="flipkart-primary"
      busy={false}
      onClose={() => {}}
      onSave={async () => ({ ok: true, value: state })}
    />,
  );
  const select = screen.getByLabelText('Existing marketplace listing');
  const save = screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement;
  fireEvent.change(select, { target: { value: 'listing-9' } });
  fireEvent.click(screen.getByRole('checkbox'));
  assert.equal(save.disabled, false);

  fireEvent.change(select, { target: { value: 'unverified-listing' } });
  const confirmation = screen.getByRole('checkbox') as HTMLInputElement;
  assert.equal(confirmation.checked, false);
  assert.equal(confirmation.disabled, true);
  assert.equal(save.disabled, true);
  assert.ok(screen.getByText('Unknown - mapping blocked'));
  fireEvent.change(select, { target: { value: 'listing-9' } });
  assert.equal((screen.getByRole('checkbox') as HTMLInputElement).checked, false);
  assert.equal(save.disabled, true);
});

test('mapping without available listings explains the empty state and keeps save disabled', () => {
  const state = initialState('demo', 'unused');
  state.listings = state.listings.filter((listing) => listing.itemId !== null);
  render(
    <MappingDialog
      item={state.items[3]}
      state={state}
      accountId="flipkart-primary"
      busy={false}
      onClose={() => {}}
      onSave={async () => ({ ok: true, value: state })}
    />,
  );

  assert.ok(screen.getByRole('heading', { name: 'No unmapped listings available' }));
  assert.equal(screen.queryByRole('combobox'), null);
  assert.equal(
    (screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled,
    true,
  );
});

test('review reports stale or blocked destinations and keeps publication unavailable', () => {
  const state = initialState('demo', 'unused');
  render(
    <ReviewDialog
      state={state}
      review={{
        id: 'review-stale',
        companyId: 'demo-a',
        createdAt: '2026-11-08T00:00:00.000Z',
        publishingEnabled: false,
        rows: [
          {
            listingId: 'listing-1',
            sku: 'STALE-DRAFT',
            account: 'Sample account',
            location: 'Warehouse',
            quantity: 5,
            observed: 3,
            policy: 'Auto',
            stale: true,
            problem: null,
          },
          {
            listingId: 'listing-2',
            sku: 'BLOCKED-DRAFT',
            account: 'Sample account',
            location: 'Warehouse',
            quantity: null,
            observed: null,
            policy: 'Auto',
            stale: false,
            problem: 'Pack evidence needs verification.',
          },
        ],
      }}
      onClose={() => {}}
    />,
  );

  assert.ok(screen.getByText('Source values changed. Recalculate and review again.'));
  assert.ok(screen.getByText('Pack evidence needs verification.'));
  assert.ok(screen.getByText('2 listing destinations'));
  assert.equal(
    (screen.getByRole('button', { name: 'Publish unavailable' }) as HTMLButtonElement).disabled,
    true,
  );
});
