import assert from 'node:assert/strict';
import test from 'node:test';
import { actionScope, inventoryGroups, type InventoryFilters } from '../../src/client/selectors.js';
import { initialState } from '../../src/server/seed.js';
const filters: InventoryFilters = {
  companyId: 'demo-a',
  accountId: 'flipkart-primary',
  query: '',
  brand: '',
  pack: '',
};
test('unmapped Tally items remain visible but cannot enlarge listing actions', () => {
  const state = initialState('demo', 'unused');
  assert.equal(inventoryGroups(state, filters).length, 4);
  assert.equal(actionScope(state, filters, []).length, 7);
  assert.ok(!actionScope(state, filters, []).includes('listing-8'));
});
test('a matching pack or SKU does not include unmatched sibling listings', () => {
  const state = initialState('demo', 'unused');
  assert.deepEqual(actionScope(state, { ...filters, brand: 'CEAT', pack: '2' }, []), ['listing-2']);
  assert.deepEqual(actionScope(state, { ...filters, query: 'SAMPLE-CEAT-3-3' }, []), ['listing-3']);
});
test('explicit selection overrides filters while remaining company scoped', () => {
  const state = initialState('demo', 'unused');
  assert.deepEqual(
    actionScope(state, { ...filters, pack: '4' }, ['listing-2', 'listing-2', 'listing-8']),
    ['listing-2'],
  );
});
test('a selection whose mapping disappeared never falls back to all filtered listings', () => {
  const state = initialState('demo', 'unused');
  state.listings = state.listings.filter((row) => row.id !== 'listing-2');
  assert.deepEqual(actionScope(state, filters, ['listing-2']), []);
});

test('search matches parent identity case-insensitively and excludes other companies', () => {
  const state = initialState('demo', 'unused');
  const groups = inventoryGroups(state, { ...filters, query: '  cEaT mIlAzE  ' });
  assert.deepEqual(
    groups.map((group) => group.item.id),
    ['item-a'],
  );
  assert.deepEqual(
    groups[0].listings.map((listing) => listing.id),
    ['listing-1', 'listing-2', 'listing-3', 'listing-4', 'listing-5'],
  );
  assert.deepEqual(inventoryGroups(state, { ...filters, query: 'no matching stock' }), []);
});

test('seller account scope excludes another account from both filtering and explicit selection', () => {
  const state = initialState('demo', 'unused');
  state.listings.push({
    ...state.listings[0],
    id: 'other-account-listing',
    accountId: 'other-account',
  });

  assert.ok(!actionScope(state, filters, []).includes('other-account-listing'));
  assert.deepEqual(actionScope(state, filters, ['other-account-listing']), []);
  assert.deepEqual(actionScope(state, { ...filters, accountId: 'other-account' }, []), [
    'other-account-listing',
  ]);
});

test('unmapped stock is searchable but does not match a listing pack filter', () => {
  const state = initialState('demo', 'unused');
  const groups = inventoryGroups(state, { ...filters, query: 'Bridgestone' });
  assert.deepEqual(
    groups.map((group) => group.item.id),
    ['item-d'],
  );
  assert.deepEqual(groups[0].listings, []);
  assert.deepEqual(actionScope(state, { ...filters, query: 'Bridgestone' }, []), []);
  assert.deepEqual(inventoryGroups(state, { ...filters, query: 'Bridgestone', pack: '1' }), []);
});

test('summary views narrow filtered actions while an explicit selection keeps its scope', () => {
  const state = initialState('demo', 'unused');
  const lowStock = { ...filters, view: 'low' as const };
  assert.deepEqual(
    inventoryGroups(state, lowStock).map((group) => group.item.brand),
    ['Apollo', 'CEAT'],
  );
  assert.deepEqual(actionScope(state, lowStock, []), [
    'listing-7',
    'listing-1',
    'listing-2',
    'listing-3',
    'listing-4',
    'listing-5',
  ]);
  assert.ok(
    inventoryGroups(state, { ...filters, view: 'mapped' }).every((group) => group.listings.length),
  );
  const listingId = 'listing-2';
  state.proposals = [
    {
      listingId,
      calculated: 2,
      quantity: 0,
      edited: true,
      stale: false,
      createdAt: new Date().toISOString(),
      listingVersion: 1,
      itemVersion: 1,
      ruleVersion: 'flipkart-tyres-v1',
    },
  ];
  const drafts = { ...filters, view: 'drafts' as const };
  assert.deepEqual(actionScope(state, drafts, []), [listingId]);
  assert.deepEqual(actionScope(state, { ...drafts, pack: '1' }, []), []);
  assert.deepEqual(actionScope(state, drafts, ['listing-1']), ['listing-1']);
});
