import assert from 'node:assert/strict';
import test from 'node:test';
import { render, screen, within, fireEvent, waitFor } from '../../support/client-dom.js';
import { initialState } from '../../../src/server/seed.js';
import { MappingDialog } from '../../../src/client/screens/MappingDialog.js';
import { RemoveMappingDialog, ReviewDialog } from '../../../src/client/screens/InventoryDialogs.js';
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

  assert.ok(screen.getByRole('button', { name: /SAMPLE-UNMAPPED-1/ }));
  assert.equal(screen.queryByRole('button', { name: /OTHER-ACCOUNT/ }), null);
  assert.equal(screen.queryByRole('button', { name: /SAMPLE-CEAT-/ }), null);
  const search = screen.getByRole('searchbox', { name: 'Search listings' });
  fireEvent.change(search, { target: { value: 'OTHER-ACCOUNT' } });
  assert.ok(screen.getByText(/No matching listings/));
  assert.equal(screen.queryByRole('button', { name: /OTHER-ACCOUNT/ }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  assert.equal(document.activeElement, search);
  assert.ok(screen.getByRole('button', { name: /SAMPLE-UNMAPPED-1/ }));
});

test('mapping requires a selected seller before showing inventory destinations', () => {
  const state = initialState('demo', 'unused');
  render(
    <MappingDialog
      item={state.items[3]}
      state={state}
      accountId=""
      busy={false}
      onClose={() => {}}
      onSave={async () => ({ ok: true, value: state })}
    />,
  );
  assert.ok(screen.getByRole('heading', { name: 'Choose a seller account' }));
  assert.equal(screen.queryByRole('searchbox'), null);
  assert.equal(screen.queryByRole('button', { name: /SAMPLE-UNMAPPED-1/ }), null);
  assert.ok((screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled);
});

test('possible matches keep both warehouses distinct and require a confirmed destination before manual save', async () => {
  const state = initialState('demo', 'unused');
  const item = state.items[2];
  const destination = {
    ...state.listings[8],
    id: 'north-destination',
    sku: 'ALNAC-195',
    title: item.name,
    productId: 'TYR-FSN-247',
    marketplaceListingId: 'LST-247',
    location: 'North warehouse',
  };
  state.listings.push(destination, {
    ...destination,
    id: 'south-destination',
    location: 'South warehouse',
  });
  let savedId = '';
  render(
    <MappingDialog
      item={item}
      state={state}
      accountId={destination.accountId}
      busy={false}
      onClose={() => {}}
      onSave={async (input) => {
        savedId = input.listingId;
        return { ok: true, value: state };
      }}
    />,
  );
  const matches = screen.getByRole('region', { name: 'Possible matches for this item' });
  assert.ok(within(matches).getByRole('button', { name: /North warehouse/ }));
  assert.ok(within(matches).getByRole('button', { name: /South warehouse/ }));
  assert.equal(within(matches).queryByRole('button', { name: /Bridgestone/ }), null);
  assert.ok(screen.getByRole('button', { name: /Bridgestone/ }));
  assert.equal(screen.queryByLabelText(/I confirm the item/), null);
  assert.ok((screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled);
  const search = screen.getByRole('searchbox', { name: 'Search listings' });
  fireEvent.change(search, { target: { value: 'tyr-fsn-247' } });
  assert.equal(screen.queryByRole('region', { name: 'Possible matches for this item' }), null);
  const results = screen.getByRole('region', { name: 'Search results' });
  assert.equal(within(results).getAllByRole('button').length, 2);
  const south = within(results).getByRole('button', { name: /South warehouse/ });
  assert.match(south.textContent ?? '', /LST-247/);
  fireEvent.click(south);
  assert.ok(
    screen
      .getByRole('group', { name: 'Selected listing' })
      .textContent?.includes('South warehouse'),
  );
  assert.equal(document.activeElement, screen.getByRole('button', { name: 'Change listing' }));
  assert.ok((screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled);
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));
  await waitFor(() => assert.equal(savedId, 'south-destination'));
});

test('sellers can browse additional suggested warehouses or search beyond the first page', () => {
  const state = initialState('demo', 'unused');
  const item = state.items[2];
  const sample = state.listings[8];
  state.listings = Array.from({ length: 12 }, (_, index) => ({
    ...sample,
    title: item.name,
    id: 'destination-' + index,
    sku: 'VARIANT-' + index,
    location: 'Warehouse ' + index,
  }));
  render(
    <MappingDialog
      item={item}
      state={state}
      accountId={sample.accountId}
      busy={false}
      onClose={() => {}}
      onSave={async () => ({ ok: true, value: state })}
    />,
  );
  const suggestions = screen.getByRole('region', { name: 'Possible matches for this item' });
  assert.equal(within(suggestions).getAllByRole('button').length, 10);
  fireEvent.click(screen.getByRole('button', { name: /Show more listings/ }));
  assert.equal(within(suggestions).getAllByRole('button').length, 12);
  assert.equal(
    document.activeElement,
    within(suggestions).getByRole('button', { name: /Warehouse 10/ }),
  );
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'VARIANT-11' } });
  assert.equal(screen.getAllByRole('button', { name: /VARIANT-/ }).length, 1);
  assert.ok(screen.getByRole('button', { name: /Warehouse 11/ }));
  assert.ok((screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled);
});

test('changing destination resets confirmation and a missing package count accepts only a positive whole custom size', () => {
  const state = initialState('demo', 'unused');
  state.listings.push({
    ...state.listings[8],
    id: 'unverified-listing',
    sku: 'UNVERIFIED',
    verified: false,
    packSize: null,
    packageAvailable: false,
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
  const save = () => screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement;
  fireEvent.click(screen.getByRole('button', { name: /SAMPLE-UNMAPPED-1/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm/ }));
  assert.equal(save().disabled, false);

  fireEvent.click(screen.getByRole('button', { name: 'Change listing' }));
  assert.equal(document.activeElement, screen.getByRole('searchbox'));
  fireEvent.click(screen.getByRole('button', { name: /UNVERIFIED/ }));
  const confirmation = screen.getByRole('checkbox', { name: /I confirm/ }) as HTMLInputElement;
  assert.equal(confirmation.checked, false);
  assert.equal(confirmation.disabled, true);
  assert.equal(save().disabled, true);
  assert.ok(screen.getByText(/Package count unavailable/));
  for (const value of ['0', '1.5', '-1']) {
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tally units per sale' }), {
      target: { value },
    });
    assert.equal(confirmation.disabled, true);
  }
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Tally units per sale' }), {
    target: { value: '2' },
  });
  fireEvent.click(confirmation);
  assert.equal(save().disabled, false);
  fireEvent.click(screen.getByRole('button', { name: 'Change listing' }));
  fireEvent.click(screen.getByRole('button', { name: /SAMPLE-UNMAPPED-1/ }));
  assert.equal(
    (screen.getByRole('checkbox', { name: /I confirm/ }) as HTMLInputElement).checked,
    false,
  );
  assert.equal(save().disabled, true);
});

test('a changed package count can be accepted or the confirmed number kept as a manual value', async () => {
  const state = initialState('demo', 'unused');
  const listing = state.listings[1];
  Object.assign(listing, {
    packSize: 2,
    packSource: 'packages',
    packageCount: 1,
    packageAvailable: true,
    verified: false,
  });
  let submitted = 0;
  render(
    <MappingDialog
      item={state.items[0]}
      state={state}
      accountId={listing.accountId}
      editListingId={listing.id}
      busy={false}
      onClose={() => {}}
      onSave={async (input) => {
        submitted++;
        assert.equal(input.packSource, submitted === 1 ? 'packages' : 'manual');
        assert.equal(input.packSize, submitted === 1 ? 1 : 2);
        assert.equal(input.listingVersion, listing.version);
        assert.equal(input.sourceScope, 'company');
        return { ok: false, error: 'Try again.' };
      }}
    />,
  );
  assert.ok(screen.getByText(/Flipkart package count changed from 2 to 1/));
  assert.equal(
    (screen.getByLabelText(/Use 1 .current package count/) as HTMLInputElement).checked,
    true,
  );
  const confirm = screen.getByRole('checkbox', { name: /I confirm/ });
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: 'Save Set of' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByLabelText(/Keep 2 as my own value/));
  assert.equal((screen.getByLabelText('Tally units per sale') as HTMLInputElement).value, '2');
  assert.equal((confirm as HTMLInputElement).checked, false);
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: 'Save Set of' }));
  await waitFor(() => assert.equal(submitted, 2));
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
  assert.equal(screen.queryByRole('searchbox'), null);
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
      onPublish={async () => {
        throw new Error('A blocked review cannot publish');
      }}
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

test('choosing Update once on a paused listing keeps the pause visible and submits the reviewed quantity once', async () => {
  const state = initialState('demo', 'unused');
  state.mode = 'live';
  const modes: unknown[] = [];
  render(
    <ReviewDialog
      state={state}
      review={{
        id: 'positive-review',
        companyId: 'demo-a',
        createdAt: '2026-11-20T00:00:00Z',
        publishingEnabled: true,
        rows: [
          {
            listingId: 'listing-1',
            sku: 'TYRE-PAIR',
            account: 'Seller',
            location: 'Warehouse',
            quantity: 2,
            observed: 4,
            policy: 'Allow 2 more sales',
            stale: false,
            paused: true,
            problem: 'Sales allowances require order tracking.',
            oneTimeProblem: null,
          },
        ],
      }}
      onClose={() => {}}
      onPublish={async (id, mode) => {
        modes.push([id, mode]);
        return {
          ok: true,
          value: {
            rows: [
              {
                listingId: 'listing-1',
                sku: 'TYRE-PAIR',
                status: 'confirmed',
                message: 'Readback confirmed two sets.',
              },
            ],
          },
        };
      }}
    />,
  );
  assert.equal(
    (screen.getByRole('button', { name: 'Publish 0 eligible listings' }) as HTMLButtonElement)
      .disabled,
    true,
  );
  assert.equal((screen.getByLabelText(/Update once/) as HTMLInputElement).checked, false);
  assert.ok((screen.getByLabelText(/Allow this many more sales/) as HTMLInputElement).disabled);
  fireEvent.click(screen.getByLabelText(/Update once/));
  assert.equal(screen.queryByText('Sales allowances require order tracking.'), null);
  assert.ok(screen.getByText('Tally sync paused · update once'));
  fireEvent.click(screen.getByRole('button', { name: 'Publish 1 eligible listing' }));
  await screen.findByText('Readback confirmed two sets.');
  assert.deepEqual(modes, [['positive-review', 'once']]);
});

test('a missing package observation preserves the saved source until the seller chooses a custom size', () => {
  const state = initialState('demo', 'unused');
  const listing = state.listings[1];
  Object.assign(listing, {
    packSize: 2,
    packSource: 'packages',
    packageAvailable: false,
    packageCount: 2,
    packageObservedAt: '2026-11-20T00:00:00Z',
    verified: false,
  });
  render(
    <MappingDialog
      state={state}
      item={state.items[0]}
      accountId={listing.accountId}
      editListingId={listing.id}
      busy={false}
      onClose={() => {}}
      onSave={async () => ({ ok: true, value: state })}
    />,
  );
  const packageOption = screen.getByLabelText('Use package count') as HTMLInputElement;
  const confirm = screen.getByRole('checkbox', { name: /I confirm/ }) as HTMLInputElement;
  assert.ok(packageOption.checked && packageOption.disabled);
  assert.ok(confirm.disabled);
  assert.ok(screen.getByText(/Last observed count: 2/));
  fireEvent.click(screen.getByLabelText('Enter a number'));
  assert.equal((screen.getByLabelText('Tally units per sale') as HTMLInputElement).value, '2');
  fireEvent.click(confirm);
  fireEvent.change(screen.getByLabelText('Tally units per sale'), { target: { value: '3' } });
  assert.equal(confirm.checked, false);
});
