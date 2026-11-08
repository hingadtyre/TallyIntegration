import assert from 'node:assert/strict';
import test from 'node:test';
import { InputError } from '../../src/server/service.js';
import { serverFixture as fixture } from '../support/server-fixture.js';

test('a verified unmapped listing can use an existing item without creating source records', (t) => {
  const f = fixture(t);
  const before = f.service.snapshot();
  const previous = before.listings.find((row) => row.id === 'listing-9')!;
  const result = f.service.mapping({
    listingId: previous.id,
    itemId: 'item-d',
    confirmPackEvidence: true,
  });
  const mapped = result.listings.find((row) => row.id === previous.id)!;
  assert.deepEqual(mapped, { ...previous, itemId: 'item-d', version: previous.version + 1 });
  assert.deepEqual(result.items, before.items);
  assert.deepEqual(result.accounts, before.accounts);
  assert.equal(result.listings.length, before.listings.length);
  assert.equal(result.activity[0].operation, 'mapping-added');
  assert.equal(result.activity[0].companyId, 'demo-a');
  assert.equal(f.service.calculate('demo-a', [mapped.id]).proposals[0].quantity, 8);
});

test('mapping rejects missing records, existing mappings and unconfirmed pack evidence atomically', (t) => {
  const f = fixture(t);
  const before = f.service.snapshot();
  for (const input of [
    { listingId: 'missing', itemId: 'item-d', confirmPackEvidence: true },
    { listingId: 'listing-9', itemId: 'missing', confirmPackEvidence: true },
    { listingId: 'listing-1', itemId: 'item-d', confirmPackEvidence: true },
    { listingId: 'listing-9', itemId: 'item-d', confirmPackEvidence: false },
    { listingId: 'listing-9', itemId: 'item-d', confirmPackEvidence: 'true' },
  ]) {
    assert.throws(() => f.service.mapping(input), InputError);
    assert.deepEqual(f.service.snapshot(), before);
  }
  for (const change of [{ verified: false }, { packSize: null }]) {
    f.store.update((state) => {
      Object.assign(
        state.listings.find((row) => row.id === 'listing-9')!,
        { verified: true, packSize: 1 },
        change,
      );
    });
    const unverified = f.service.snapshot();
    assert.throws(
      () =>
        f.service.mapping({ listingId: 'listing-9', itemId: 'item-d', confirmPackEvidence: true }),
      /pack evidence/i,
    );
    assert.deepEqual(f.service.snapshot(), unverified);
  }
});

test('commands reject empty, malformed, missing and mixed-company destination sets', (t) => {
  const f = fixture(t);
  const before = f.service.snapshot();
  for (const ids of [undefined, 'listing-1', [], [1], ['missing'], ['listing-1', 'listing-8']]) {
    assert.throws(() => f.service.calculate('demo-a', ids), InputError);
    assert.throws(() => f.service.review('demo-a', ids), InputError);
    assert.throws(() => f.service.pause('demo-a', ids, true), InputError);
    assert.deepEqual(f.service.snapshot(), before);
  }
  assert.throws(() => f.service.calculate('missing', ['listing-1']), InputError);
  assert.throws(() => f.service.pause('demo-a', ['listing-1'], 'true'), InputError);
  assert.deepEqual(f.service.snapshot(), before);
});

test('manual proposals require a non-negative whole number within available stock', (t) => {
  const f = fixture(t);
  const before = f.service.snapshot();
  for (const quantity of [-1, 0.5, '1', null, Number.NaN, Number.POSITIVE_INFINITY, 6]) {
    assert.throws(() => f.service.edit('demo-a', 'listing-1', quantity), InputError);
    assert.deepEqual(f.service.snapshot(), before);
  }
  assert.equal(f.service.edit('demo-a', 'listing-1', 0).proposals[0].quantity, 0);
});

test('unknown stock and unverified packs cannot produce a zero or normal proposal', (t) => {
  const f = fixture(t);
  for (const problem of ['unknown-stock', 'unverified-pack'] as const) {
    f.store.update((state) => {
      state.items.find((row) => row.id === 'item-a')!.physical =
        problem === 'unknown-stock' ? null : 4;
      state.listings.find((row) => row.id === 'listing-1')!.verified =
        problem !== 'unverified-pack';
    });
    const before = f.service.snapshot();
    assert.throws(() => f.service.calculate('demo-a', ['listing-1']), InputError);
    assert.throws(() => f.service.calculate('demo-a', ['listing-1'], true), InputError);
    assert.throws(() => f.service.edit('demo-a', 'listing-1', 0), InputError);
    assert.deepEqual(f.service.snapshot(), before);
  }
});
test('aged stock blocks proposals and review even while the Tally connection remains online', async (t) => {
  const f = fixture(t, 'live', {
    createTallyReader: () => ({
      async listCompanies() {
        return [{ externalId: 'company-a', name: 'Company A' }];
      },
      async readStock() {
        return [{ externalId: 'item-a', name: 'Tyre A', unit: 'tyres', physical: 4 }];
      },
    }),
  });
  await f.service.refresh();
  f.store.update((state) => {
    state.listings.push({
      id: 'live-listing',
      accountId: 'flipkart-primary',
      sku: 'TEST-PAIR',
      title: 'Test pair',
      location: 'Test location',
      itemId: state.items[0].id,
      packSize: 2,
      packEvidence: 'Fixture metadata',
      verified: true,
      observed: 5,
      observedAt: state.items[0].observedAt,
      policy: 'auto',
      remaining: null,
      paused: false,
      version: 1,
    });
  });
  const fresh = f.service.calculate('tally:company-a', ['live-listing']);
  assert.equal(fresh.proposals[0].quantity, 5);
  assert.equal(f.service.review('tally:company-a', ['live-listing']).rows[0].problem, null);

  f.store.update((state) => {
    state.items[0].observedAt = '2000-01-01T00:00:00.000Z';
  });
  const before = f.service.snapshot();
  assert.equal(before.connection.tally, 'online');
  assert.equal(before.proposals[0].stale, false, 'the captured source version has not changed');
  assert.throws(
    () => f.service.calculate('tally:company-a', ['live-listing']),
    /Tally stock is stale/,
  );
  assert.throws(
    () => f.service.calculate('tally:company-a', ['live-listing'], true),
    /Tally stock is stale/,
  );
  assert.throws(() => f.service.edit('tally:company-a', 'live-listing', 0), /Tally stock is stale/);
  assert.match(
    f.service.review('tally:company-a', ['live-listing']).rows[0].problem!,
    /Tally stock is stale/,
  );
  assert.deepEqual(f.service.snapshot(), before);
});

test('calculation is limited to its explicit company scope and failed scope is atomic', (t) => {
  const f = fixture(t);
  const initial = f.service.snapshot();
  const result = f.service.calculate('demo-a', ['listing-1', 'listing-1', 'listing-3']);
  assert.deepEqual(result.proposals.map((row) => row.listingId).sort(), ['listing-1', 'listing-3']);
  assert.deepEqual(
    result.proposals.map((row) => row.quantity),
    [5, 5],
  );
  assert.deepEqual(
    result.items,
    initial.items,
    'unmapped stock items and physical stock are preserved',
  );
  assert.deepEqual(
    result.listings,
    initial.listings,
    'calculation cannot alter marketplace observations or policies',
  );
  const saved = f.service.snapshot();
  assert.throws(() => f.service.calculate('demo-a', ['listing-2', 'listing-8']), InputError);
  assert.deepEqual(
    f.service.snapshot(),
    saved,
    'an invalid second row cannot partially save the first row',
  );
});

test('edited quantity and zero drafts survive calculation without activating policies', (t) => {
  const f = fixture(t);
  const original = f.service.snapshot().listings;
  f.service.edit('demo-a', 'listing-1', 1);
  f.service.calculate('demo-a', ['listing-2'], true);
  const result = f.service.calculate('demo-a', ['listing-1', 'listing-2', 'listing-3']);
  assert.deepEqual(
    result.proposals.map((row) => [row.listingId, row.quantity, row.edited]),
    [
      ['listing-1', 1, true],
      ['listing-2', 0, true],
      ['listing-3', 5, false],
    ],
  );
  assert.deepEqual(result.listings, original);
  assert.equal(result.publishingEnabled, false);
  assert.throws(() => f.service.edit('demo-a', 'listing-1', 6), InputError);
});

test('a changed source preserves the seller edit but makes its review stale', (t) => {
  const f = fixture(t);
  f.service.edit('demo-a', 'listing-1', 1);
  f.store.update((state) => {
    const item = state.items.find((row) => row.id === 'item-a')!;
    item.physical = 0;
    item.version++;
  });
  const afterCalculate = f.service.calculate('demo-a', ['listing-1']);
  assert.equal(afterCalculate.proposals[0].quantity, 1);
  assert.equal(afterCalculate.proposals[0].stale, true);
  const review = f.service.review('demo-a', ['listing-1']);
  assert.equal(review.rows[0].stale, true);
  assert.match(review.rows[0].problem!, /changed/i);
  f.service.edit('demo-a', 'listing-1', 0);
  assert.equal(f.service.review('demo-a', ['listing-1']).rows[0].problem, null);
});

test('review captures destinations and does not expand when later proposals are added', (t) => {
  const f = fixture(t);
  const missing = f.service.review('demo-a', ['listing-1']);
  assert.equal(missing.rows[0].quantity, null, 'an absent proposal is not zero');
  f.service.calculate('demo-a', ['listing-1']);
  const captured = f.service.review('demo-a', ['listing-1']);
  f.service.calculate('demo-a', ['listing-2', 'listing-3']);
  assert.deepEqual(
    captured.rows.map((row) => row.listingId),
    ['listing-1'],
  );
  assert.equal(captured.companyId, 'demo-a');
  assert.equal(captured.rows[0].account, 'Sample seller · Flipkart');
  assert.equal(captured.rows[0].location, 'Sample warehouse');
  assert.equal(captured.publishingEnabled, false);
});

test('pause and resume retain limited-sales and zero-hold policies', (t) => {
  const f = fixture(t);
  const original = f.service.snapshot();
  f.service.pause('demo-a', ['listing-5', 'listing-6'], true);
  f.service.calculate('demo-a', ['listing-5', 'listing-6']);
  const review = f.service.review('demo-a', ['listing-5', 'listing-6']);
  assert.deepEqual(
    review.rows.map((row) => [row.quantity, row.problem]),
    [
      [0, null],
      [1, null],
    ],
  );
  const resumed = f.service.pause('demo-a', ['listing-5', 'listing-6'], false);
  for (const id of ['listing-5', 'listing-6']) {
    const before = original.listings.find((row) => row.id === id)!;
    const after = resumed.listings.find((row) => row.id === id)!;
    assert.deepEqual(
      [after.policy, after.remaining, after.observed],
      [before.policy, before.remaining, before.observed],
    );
    assert.equal(after.paused, false);
  }
});

test('explicit unlink keeps remote stock unchanged and allows a confirmed remapping', (t) => {
  const f = fixture(t);
  f.service.calculate('demo-a', ['listing-1']);
  const before = f.service.snapshot().listings.find((row) => row.id === 'listing-1')!;
  assert.throws(() => f.service.remove('demo-a', 'listing-1', false), InputError);
  const removed = f.service.remove('demo-a', 'listing-1', true);
  const listing = removed.listings.find((row) => row.id === 'listing-1')!;
  assert.equal(listing.itemId, null);
  assert.equal(listing.observed, before.observed);
  assert.equal(
    removed.proposals.some((row) => row.listingId === 'listing-1'),
    false,
  );
  assert.throws(
    () =>
      f.service.mapping({ listingId: 'listing-1', itemId: 'item-a', confirmPackEvidence: false }),
    InputError,
  );
  const remapped = f.service.mapping({
    listingId: 'listing-1',
    itemId: 'item-a',
    confirmPackEvidence: true,
  });
  assert.equal(remapped.listings.find((row) => row.id === 'listing-1')!.itemId, 'item-a');
  assert.equal(remapped.items.length, removed.items.length);
});
