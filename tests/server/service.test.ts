import assert from 'node:assert/strict';
import test from 'node:test';
import { InputError } from '../../src/server/service.js';
import { serverFixture as fixture } from '../support/server-fixture.js';

test('live selectors hide an unused legacy seller without changing its saved name or real companies', (t) => {
  const f = fixture(t, 'live');
  f.store.update((state) => {
    state.accounts.push({
      id: 'flipkart-primary',
      marketplace: 'flipkart',
      name: 'HINGADTYRES',
      status: 'not-connected',
    });
    state.companies.push({
      id: 'tally:actual-company',
      name: 'HINGADTYRES',
      source: 'tally',
      automation: false,
      lastSuccess: null,
    });
  });
  assert.deepEqual(f.service.snapshot().accounts, []);
  assert.equal(f.service.snapshot().companies[0].name, 'HINGADTYRES');
  assert.equal(f.store.read().accounts[0].name, 'HINGADTYRES');
  f.store.updateMarketplace((marketplace) => {
    marketplace.accounts.push({
      id: 'flipkart-primary',
      name: 'HINGADTYRES',
      sellerId: null,
      lastRefreshedAt: null,
    });
  });
  assert.equal(f.service.snapshot().accounts[0].name, 'HINGADTYRES');
});

test('a legacy seller with saved listing records remains available without losing its history', (t) => {
  const f = fixture(t, 'live');
  f.store.update((state) => {
    state.accounts.push({
      id: 'saved-seller',
      marketplace: 'flipkart',
      name: 'Existing business',
      status: 'not-connected',
    });
    state.listings.push({
      id: 'saved-listing',
      accountId: 'saved-seller',
      sku: 'EXISTING-SKU',
      title: 'Existing product',
      location: 'saved-location',
      itemId: null,
      packSize: null,
      packEvidence: '',
      verified: false,
      observed: null,
      observedAt: null,
      policy: 'auto',
      remaining: null,
      paused: false,
      version: 1,
    });
  });
  assert.equal(f.service.snapshot().accounts[0].name, 'Existing business');
  assert.equal(f.service.snapshot().listings[0].sku, 'EXISTING-SKU');
});

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

test('commands reject empty, malformed, missing and mixed-company destination sets', async (t) => {
  const f = fixture(t);
  const before = f.service.snapshot();
  for (const ids of [undefined, 'listing-1', [], [1], ['missing'], ['listing-1', 'listing-8']]) {
    assert.throws(() => f.service.calculate('demo-a', ids), InputError);
    assert.throws(() => f.service.review('demo-a', ids), InputError);
    await assert.rejects(f.service.pause('demo-a', ids, true), InputError);
    assert.deepEqual(f.service.snapshot(), before);
  }
  assert.throws(() => f.service.calculate('missing', ['listing-1']), InputError);
  await assert.rejects(f.service.pause('demo-a', ['listing-1'], 'true'), InputError);
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
    state.accounts.push({
      id: 'flipkart-primary',
      name: 'Fixture seller',
      marketplace: 'flipkart',
      status: 'not-connected',
    });
    state.listings.push({
      id: 'live-listing',
      accountId: 'flipkart-primary',
      sku: 'TEST-PAIR',
      title: 'Test pair',
      location: 'Test location',
      itemId: state.items[0].id,
      packSize: 2,
      sourceScope: 'company',
      tyreFloor: true,
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
  f.store.update((state) => {
    state.items[0].observedAt = new Date(Date.now() + 3_600_000).toISOString();
  });
  assert.throws(
    () => f.service.calculate('tally:company-a', ['live-listing']),
    /Tally stock is stale/,
  );
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

test('bulk Calculate prepares nineteen drafts and identifies the pack that needs confirmation', async (t) => {
  const f = fixture(t);
  const ids = f.store.update((state) => {
    const sample = state.listings.find((listing) => listing.id === 'listing-1')!;
    return Array.from({ length: 20 }, (_, index) => {
      const id = `bulk-${index}`;
      state.listings.push({ ...sample, id, sku: id, verified: index !== 7 });
      return id;
    });
  });
  const result = await f.service.calculateAvailable('demo-a', ids);
  assert.equal(result.calculation.filter((row) => row.status === 'ready').length, 19);
  assert.deepEqual(
    result.calculation.filter((row) => row.status === 'blocked'),
    [
      {
        listingId: 'bulk-7',
        status: 'blocked',
        reason: 'Verify the mapping and pack size first.',
        fix: 'pack',
      },
    ],
  );
  assert.equal(result.proposals.length, 19);
  assert.equal(
    result.proposals.some((row) => row.listingId === 'bulk-7'),
    false,
  );
  assert.deepEqual(f.service.snapshot().proposals, result.proposals);
});

test('the running workspace refreshes only saved calculated drafts after restart and keep-back changes', async (t) => {
  const f = fixture(t);
  f.service.calculate('demo-a', ['listing-1', 'listing-5', 'listing-6']);
  f.service.edit('demo-a', 'listing-2', 0);
  const before = f.store.read();
  const originalDraft = (id: string) => before.proposals.find((draft) => draft.listingId === id);
  f.service.setKeepBack('demo-a', 'item-a', 1, 4);
  f.reopen();
  f.service.start();
  await f.service.idle();
  const refreshed = f.service.snapshot();
  for (const id of ['listing-1', 'listing-5']) {
    const draft = refreshed.proposals.find((row) => row.listingId === id)!;
    assert.equal(draft.quantity, 0);
    assert.equal(draft.stale, false);
  }
  assert.deepEqual(
    f.store.read().proposals.find((p) => p.listingId === 'listing-2'),
    originalDraft('listing-2'),
  );
  assert.equal(refreshed.proposals.find((p) => p.listingId === 'listing-2')!.stale, true);
  assert.deepEqual(
    refreshed.proposals.find((p) => p.listingId === 'listing-6'),
    originalDraft('listing-6'),
  );
  assert.equal(refreshed.proposals.length, before.proposals.length);
  assert.deepEqual(refreshed.listings, before.listings);
  assert.equal(refreshed.companies[0].automation, false);

  f.service.setKeepBack('demo-a', 'item-a', 2, 0);
  await f.service.idle();
  assert.equal(
    f.service.snapshot().proposals.find((p) => p.listingId === 'listing-5')!.quantity,
    5,
  );
});

test('an unverified stale proposal keeps its old quantity and reason until the background retry succeeds', async (t) => {
  let scheduled!: { run: () => void; delay: number };
  let now = 0;
  const f = fixture(t, 'demo', {
    timers: {
      now: () => now,
      schedule(run, delay) {
        scheduled = { run, delay };
        return () => {};
      },
    },
  });
  async function nextCheck() {
    assert.equal(scheduled.delay, 15_000, 'a blocked listing must not slow down other listings');
    now += scheduled.delay;
    scheduled.run();
    await f.service.idle();
  }
  f.service.calculate('demo-a', ['listing-1', 'listing-6']);
  f.store.update((state) => {
    state.listings[0].verified = false;
    state.listings[0].version++;
    state.items[0].physical = 7;
    state.items[0].version++;
  });
  const activities = f.store.read().activity;
  f.service.start();
  await f.service.idle();
  const waiting = f.service.snapshot();
  assert.equal(waiting.proposals[0].quantity, 5);
  assert.equal(waiting.proposals[0].stale, true);
  assert.match(waiting.listings[0].proposalIssue!, /Verify the mapping and pack size/);
  f.store.update((state) => {
    const otherItem = state.items.find((item) => item.id === 'item-b')!;
    otherItem.physical = 0;
    otherItem.version++;
  });
  await nextCheck();
  const other = f.service.snapshot().proposals.find((p) => p.listingId === 'listing-6')!;
  assert.equal(other.quantity, 0);
  assert.equal(other.stale, false);
  const writes = t.mock.method(f.store, 'update');
  await nextCheck();
  assert.equal(writes.mock.callCount(), 0, 'unchanged blocked inputs wait before retrying');
  assert.deepEqual(f.store.read().activity, activities);
  f.store.update((state) => {
    state.listings[0].verified = true;
    state.listings[0].version++;
  });
  await nextCheck();
  const refreshed = f.service.snapshot();
  const recovered = refreshed.proposals.find((p) => p.listingId === 'listing-1')!;
  assert.equal(recovered.quantity, 7);
  assert.equal(recovered.stale, false);
  assert.equal(refreshed.listings[0].proposalIssue, undefined);
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

test('paused listings calculate the current target and retain sales allowances after resume', async (t) => {
  const f = fixture(t);
  const original = f.service.snapshot();
  await f.service.pause('demo-a', ['listing-5', 'listing-6'], true);
  f.service.calculate('demo-a', ['listing-5', 'listing-6']);
  const review = f.service.review('demo-a', ['listing-5', 'listing-6']);
  assert.deepEqual(
    review.rows.map((row) => [row.quantity, row.policy, row.problem]),
    [
      [5, 'Tally sync paused', null],
      [1, 'Tally sync paused · 1 sale remaining', null],
    ],
  );
  f.service.edit('demo-a', 'listing-5', 0);
  f.service.edit('demo-a', 'listing-6', 0);
  const unrelated = f.service
    .edit('demo-a', 'listing-2', 2)
    .proposals.find((p) => p.listingId === 'listing-2')!;
  const resumed = await f.service.pause('demo-a', ['listing-5', 'listing-6'], false);
  assert.deepEqual(
    resumed.proposals.find((p) => p.listingId === 'listing-2'),
    unrelated,
  );
  const resumedDrafts = resumed.proposals.filter((p) => p.listingId !== 'listing-2');
  assert.deepEqual(
    resumedDrafts.map((p) => [p.listingId, p.quantity, p.edited, p.stale]),
    [
      ['listing-5', 5, false, false],
      ['listing-6', 1, false, false],
    ],
  );
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
