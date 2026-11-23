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

function openListingPicker() {
  const picker = screen.getByRole<HTMLInputElement>('combobox', { name: 'Flipkart listing' });
  fireEvent.click(picker);
  return picker;
}

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

  assert.equal(screen.queryByRole('listbox'), null);
  const search = openListingPicker();
  assert.ok(screen.getByRole('option', { name: /SAMPLE-UNMAPPED-1/ }));
  assert.equal(screen.queryByRole('option', { name: /OTHER-ACCOUNT/ }), null);
  assert.equal(screen.queryByRole('option', { name: /SAMPLE-CEAT-/ }), null);
  fireEvent.change(search, { target: { value: 'OTHER-ACCOUNT' } });
  assert.ok(screen.getByText(/No matching listings/));
  assert.equal(screen.queryByRole('option', { name: /OTHER-ACCOUNT/ }), null);
  fireEvent.change(search, { target: { value: '' } });
  assert.ok(screen.getByRole('option', { name: /SAMPLE-UNMAPPED-1/ }));
});

test('an imported SKU without a stock location is searchable but cannot select a stale warehouse or another seller', () => {
  const state = initialState('demo', 'unused');
  const accountId = 'flipkart-primary';
  const catalogueRow = {
    accountId,
    sku: '155/65R14',
    title: 'Example tyre',
    productId: 'FSN-1',
    marketplaceListingId: 'LISTING-1',
  };
  const pending = {
    ...state.listings[0],
    ...catalogueRow,
    skuMappingId: 'LISTING-1',
    itemId: null,
    location: '',
    observedAt: null,
    pickupChoices: ['North'],
  };
  state.listings = [
    pending,
    { ...pending, id: 'other-row', accountId: 'other', title: 'Other seller tyre' },
    {
      ...state.listings[0],
      id: 'historical',
      accountId,
      sku: catalogueRow.sku,
      itemId: null,
      observedAt: null,
    },
  ];
  render(
    <MappingDialog
      item={state.items[0]}
      state={state}
      accountId={accountId}
      busy={false}
      onClose={() => {}}
      onSave={async () => ({ ok: true, value: state })}
    />,
  );
  const picker = openListingPicker();
  for (const query of ['155/65R14', 'FSN-1', 'LISTING-1', 'Example tyre']) {
    fireEvent.change(picker, { target: { value: query } });
    assert.ok(screen.getByText('Example tyre'));
    assert.ok(screen.getByText(/Flipkart has not reported stock/));
    assert.equal(screen.queryByText('Other seller tyre'), null);
    assert.equal(screen.getAllByRole('option', { name: /155\/65R14/ }).length, 1);
    assert.ok((screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled);
  }
  fireEvent.click(screen.getByRole('option', { name: /155\/65R14/ }));
  assert.equal(
    (screen.getByLabelText(/Flipkart pickup location/) as HTMLSelectElement).value,
    'North',
  );
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
  assert.equal(screen.queryByRole('combobox', { name: 'Flipkart listing' }), null);
  assert.equal(screen.queryByRole('option', { name: /SAMPLE-UNMAPPED-1/ }), null);
  assert.ok((screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled);
});

test('possible matches keep both warehouses distinct and require a confirmed destination before manual save', async () => {
  const state = initialState('demo', 'unused');
  state.companies[0].automation = true;
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
        assert.equal(input.keepPaused, true);
        savedId = input.listingId;
        return { ok: true, value: state };
      }}
    />,
  );
  const search = openListingPicker();
  const matches = screen.getByRole('group', { name: 'Possible matches for this item' });
  assert.ok(within(matches).getByRole('option', { name: /North warehouse/ }));
  assert.ok(within(matches).getByRole('option', { name: /South warehouse/ }));
  assert.equal(within(matches).queryByRole('option', { name: /Bridgestone/ }), null);
  assert.ok(screen.getByRole('option', { name: /Bridgestone/ }));
  assert.equal(screen.queryByLabelText(/I confirm the item/), null);
  assert.ok((screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled);
  fireEvent.change(search, { target: { value: 'tyr-fsn-247' } });
  assert.equal(screen.queryByRole('group', { name: 'Possible matches for this item' }), null);
  const results = screen.getByRole('group', { name: 'Search results' });
  assert.equal(within(results).getAllByRole('option').length, 2);
  const south = within(results).getByRole('option', { name: /South warehouse/ });
  assert.match(south.textContent ?? '', /LST-247/);
  fireEvent.click(south);
  assert.ok(
    screen
      .getByRole('group', { name: 'Selected listing' })
      .textContent?.includes('South warehouse'),
  );
  assert.match(search.value, /South warehouse/);
  assert.equal(screen.queryByRole('listbox'), null);
  assert.ok((screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled);
  assert.ok(screen.getByText(/Company sync is on/));
  const pause = screen.getByLabelText('Keep this listing paused') as HTMLInputElement;
  assert.equal(pause.checked, false);
  fireEvent.click(pause);
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
  const search = openListingPicker();
  const suggestions = screen.getByRole('group', { name: 'Possible matches for this item' });
  assert.equal(within(suggestions).getAllByRole('option').length, 10);
  fireEvent.click(screen.getByRole('button', { name: /Show more listings/ }));
  assert.equal(within(suggestions).getAllByRole('option').length, 12);
  assert.equal(
    search.getAttribute('aria-activedescendant'),
    within(suggestions).getByRole('option', { name: /Warehouse 10/ }).id,
  );
  fireEvent.change(search, { target: { value: 'VARIANT-11' } });
  assert.equal(screen.getAllByRole('option', { name: /VARIANT-/ }).length, 1);
  assert.ok(screen.getByRole('option', { name: /Warehouse 11/ }));
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
  const search = openListingPicker();
  fireEvent.click(screen.getByRole('option', { name: /SAMPLE-UNMAPPED-1/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm/ }));
  assert.equal(save().disabled, false);

  fireEvent.click(search);
  fireEvent.change(search, { target: { value: 'UNVERIFIED' } });
  fireEvent.keyDown(search, { key: 'Escape' });
  assert.match(search.value, /SAMPLE-UNMAPPED-1/);
  assert.equal(save().disabled, false);
  fireEvent.click(search);
  fireEvent.click(screen.getByRole('option', { name: /UNVERIFIED/ }));
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
  fireEvent.click(search);
  fireEvent.click(screen.getByRole('option', { name: /SAMPLE-UNMAPPED-1/ }));
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
  assert.equal(screen.queryByRole('combobox', { name: 'Flipkart listing' }), null);
  assert.equal(
    (screen.getByRole('button', { name: 'Save mapping' }) as HTMLButtonElement).disabled,
    true,
  );
});

test('choosing a manual keep-back override explicitly approves only the affected destination', async () => {
  const state = initialState('demo', 'unused');
  const submitted: Array<string[] | undefined> = [];
  render(
    <ReviewDialog
      state={state}
      review={{
        id: 'keep-back-review',
        companyId: 'demo-a',
        createdAt: '2026-11-23T00:00:00Z',
        publishingEnabled: true,
        rows: [
          {
            listingId: 'held-pair',
            sku: 'TYRE-PAIR',
            account: 'Sample seller',
            location: 'Warehouse',
            quantity: 5,
            observed: 3,
            policy: 'Auto',
            stale: false,
            problem: null,
            oneTimeProblem: null,
            keepBackWarning: {
              itemName: 'Tyre',
              unit: 'tyres',
              keepBackUnits: 2,
              completePacks: 3,
              reviewKey: 'reviewed',
            },
          },
        ],
      }}
      onClose={() => {}}
      onPublish={async (_id, _mode, overrides) => {
        submitted.push(overrides);
        return { ok: true, value: { rows: [] } };
      }}
      onReviewLatest={async () => assert.fail('No changed calculated stock')}
    />,
  );
  const publish = screen.getByRole('button', {
    name: 'Publish 1 eligible listing',
  }) as HTMLButtonElement;
  const override = screen.getByRole('checkbox', {
    name: /Publish 5 for TYRE-PAIR at Warehouse.*keeping back 2 tyres.*3 complete packs/,
  });
  assert.equal(publish.disabled, true);
  fireEvent.click(override);
  assert.equal(publish.disabled, false);
  fireEvent.click(publish);
  await screen.findByRole('heading', { name: 'Stock publication results' });
  assert.deepEqual(submitted, [['held-pair']]);
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
      onReviewLatest={async () => assert.fail('No publication result')}
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
      onReviewLatest={async () => assert.fail('An update once cannot retry a calculated quantity')}
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

test('a blocked manual edit allows other live rows to proceed and an expired review cannot be sent again', async () => {
  const state = initialState('demo', 'unused');
  state.mode = 'live';
  const destination = {
    listingId: 'calculated',
    sku: 'READY',
    account: 'Seller',
    location: 'North',
    observed: 2,
    quantity: 3,
    policy: 'Auto',
    problem: null,
    stale: false,
  };
  let attempts = 0;
  render(
    <ReviewDialog
      state={state}
      review={{
        id: 'old-review',
        companyId: 'demo-a',
        createdAt: new Date().toISOString(),
        publishingEnabled: true,
        rows: [
          destination,
          {
            ...destination,
            listingId: 'manual',
            sku: 'HELD',
            policy: 'Limited sales',
            problem: 'Live allowances are unavailable.',
            oneTimeProblem: 'Update once requires Auto.',
          },
        ],
      }}
      onClose={() => {}}
      onPublish={async (id, mode) => {
        attempts++;
        assert.equal(id, 'old-review');
        assert.equal(mode, undefined);
        return { ok: false, error: 'Open a fresh Inventory review before publishing.' };
      }}
      onReviewLatest={async () => assert.fail('An expired review has no verified replacement.')}
    />,
  );
  assert.ok(screen.getByText('Update once requires Auto.'));
  assert.equal(screen.queryByRole('group', { name: 'Positive stock edits' }), null);
  const publish = screen.getByRole('button', {
    name: 'Publish 1 eligible listing',
  }) as HTMLButtonElement;
  fireEvent.click(publish);
  assert.match(
    (await screen.findByRole('alert')).textContent ?? '',
    /Open a fresh Inventory review/,
  );
  assert.ok(publish.disabled);
  fireEvent.click(publish);
  assert.equal(attempts, 1);
  assert.equal(screen.queryByRole('button', { name: /Review latest/ }), null);
  assert.equal(screen.queryByRole('heading', { name: 'Stock publication results' }), null);
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
