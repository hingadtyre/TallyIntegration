import assert from 'node:assert/strict';
import test from 'node:test';
import { actionScope, inventoryGroups, type InventoryFilters } from '../src/client/selectors.js';
import { initialState } from '../src/server/seed.js';
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
