import assert from 'node:assert/strict';
import test from 'node:test';
import { updateInventoryObservations } from '../../src/server/marketplace-catalog.js';
import { serverFixture } from '../support/server-fixture.js';

test('saving an unchanged mapping preserves the review and does not queue a stock refill', (t) => {
  const f = serverFixture(t);
  const row = () => f.store.read().listings.find((listing) => listing.id === 'listing-9')!;
  const confirm = () =>
    f.service.mapping({
      listingId: row().id,
      listingVersion: row().version,
      itemId: 'item-d',
      confirmPackEvidence: true,
      packSize: 2,
      packSource: 'manual',
      sourceScope: 'company',
      tyreFloor: false,
    });
  confirm();
  f.service.automation('demo-a', true);
  const queued = row();
  assert.ok(queued.syncPendingItemVersion != null);
  confirm();
  assert.deepEqual(row(), queued);
  // The prior sync completed and a subsequent Flipkart sale reduced marketplace stock.
  f.store.update((state) => {
    const listing = state.listings.find((entry) => entry.id === queued.id)!;
    listing.syncPendingItemVersion = null;
    listing.observed = 0;
  });
  const sold = row();
  confirm();
  assert.deepEqual(row(), sold);
});

test('package confirmation survives a restart, flags a changed count and preserves a subsequent manual choice', (t) => {
  const f = serverFixture(t);
  const listingId = 'listing-9';
  const itemId = 'item-d';
  const current = () => f.store.read().listings.find((row) => row.id === listingId)!;
  const observe = (packageCount: number | null, minute: number) => {
    const row = current();
    const observedAt = new Date(Date.UTC(2026, 1, 1, 8, minute)).toISOString();
    f.store.update((state) => {
      updateInventoryObservations(state, {
        accountId: row.accountId,
        id: 'marketplace-listing',
        sellerId: null,
        sku: row.sku,
        productId: 'product',
        title: row.title,
        imageUrl: null,
        status: 'ACTIVE',
        mrp: null,
        sellingPrice: null,
        locations: [{ id: row.location, quantity: 2, status: 'ENABLED' }],
        observedAt,
        packageCount,
        version: 1,
      });
    });
    return observedAt;
  };
  const confirm = (
    source: string,
    size: number,
    listingVersion = current().version,
    expectedUnit?: string,
  ) =>
    f.service.mapping({
      listingId,
      itemId,
      expectedUnit,
      confirmPackEvidence: true,
      packSource: source,
      packSize: size,
      listingVersion,
      sourceScope: 'company',
      tyreFloor: false,
    });

  observe(2, 0);
  assert.throws(
    () => confirm('packages', 2, current().version, 'previous base unit'),
    /Tally base unit changed/,
  );
  assert.throws(() => confirm('packages', 1), /actual Flipkart package count/);
  confirm('packages', 2);
  assert.equal(
    current().packEvidence,
    "Confirmed 2 Tally units per sale using Flipkart's package count.",
  );
  const beforeRestart = current();
  f.reopen();
  assert.deepEqual(current(), beforeRestart);
  assert.equal(current().packSource, 'packages');
  assert.equal(current().sourceScope, 'company');
  assert.equal(current().tyreFloor, false);
  const observedAt = observe(1, 1);
  assert.equal(current().verified, false);
  assert.equal(current().packSize, 2);
  assert.equal(current().packConfirmedAt, beforeRestart.packConfirmedAt);
  assert.equal(current().packageCount, 1);
  assert.throws(() => confirm('packages', 1, beforeRestart.version), /listing changed/);
  observe(null, 2);
  assert.equal(current().packageAvailable, false);
  assert.equal(current().packageObservedAt, observedAt);
  assert.equal(current().packageCount, 1);
  assert.throws(() => confirm('packages', 1), /actual Flipkart package count/);
  observe(2, 3);
  assert.equal(current().verified, false);
  confirm('manual', 3);
  const version = current().version;
  observe(5, 4);
  observe(null, 5);
  f.reopen();
  assert.equal(current().version, version);
  assert.equal(current().packSource, 'manual');
  assert.equal(current().packSize, 3);
  assert.equal(current().verified, true);
  assert.equal(current().packageCount, 5);
  assert.equal(current().packageAvailable, false);
  confirm('manual', 1);
  assert.equal(current().packEvidence, 'Seller confirmed 1 Tally unit per sale.');
  f.service.remove('demo-a', listingId, true);
  assert.equal(current().packSize, null);
  assert.equal(current().syncPendingItemVersion, null);
});
