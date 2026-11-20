import assert from 'node:assert/strict';
import test from 'node:test';
import {
  searchMappingListings,
  suggestedMappingListings,
} from '../../src/client/mapping-search.js';
import { initialState } from '../../src/server/seed.js';
import type { Listing } from '../../src/shared/contracts.js';

const sample = initialState('demo', 'unused');
const apollo = sample.items.find((item) => item.name.startsWith('Apollo'))!;
const bridgestone = sample.items.find((item) => item.name.startsWith('Bridgestone'))!;
const unmapped = sample.listings.find((listing) => listing.itemId === null)!;

test('search finds seller identifiers and available titles, putting exact identifiers first', () => {
  const titleMatch = { ...unmapped, title: 'Product with serial AX-543' };
  const prefix = { ...unmapped, sku: 'AX-543-blue' };
  const exact = {
    ...unmapped,
    sku: ' Ax-543',
    productId: 'FSN123',
    marketplaceListingId: 'LST456',
  };
  const listings = [titleMatch, prefix, exact];
  assert.deepEqual(searchMappingListings(listings, ' AX-543 '), [exact, prefix, titleMatch]);
  assert.deepEqual(searchMappingListings(listings, 'sn12'), [exact]);
  assert.deepEqual(searchMappingListings(listings, 'lst456'), [exact]);
  assert.deepEqual(searchMappingListings(listings, 'serial product'), [titleMatch]);
  assert.deepEqual(searchMappingListings(listings, ''), listings);
  assert.deepEqual(searchMappingListings(listings, 'missing'), []);
  assert.equal(exact.sku, ' Ax-543');
});

test('suggestions distinguish a matching product name from an unrelated unmapped listing', () => {
  assert.deepEqual(suggestedMappingListings([unmapped], apollo), []);
  assert.deepEqual(suggestedMappingListings([unmapped], bridgestone), [unmapped]);
  const unobserved = { ...unmapped, observedAt: null };
  assert.deepEqual(suggestedMappingListings([unobserved], bridgestone), []);
  assert.deepEqual(searchMappingListings([unobserved], 'Sturdo'), [unobserved]);
  assert.deepEqual(suggestedMappingListings([unmapped], { ...bridgestone, name: 'Sturdo' }), [
    unmapped,
  ]);
  assert.deepEqual(suggestedMappingListings([unmapped], { ...apollo, name: 'Sturdo' }), []);
  const listings: Listing[] = [
    { ...unmapped, title: 'Apollo Amazer 195/55 R16' },
    { ...unmapped, title: 'Apollo Alnac 205/55R16' },
    { ...unmapped, title: 'Apollo AlnacPlus 195/55R16' },
    { ...unmapped, title: 'Apollo Alnac', sku: 'ALNAC_205/55R16_2' },
    { ...unmapped, title: 'Apollo Alnac 195/55R16' },
    { ...unmapped, title: 'Apollo Alnac 195/55R16', location: 'Other warehouse' },
  ];
  assert.deepEqual(suggestedMappingListings(listings, apollo), listings.slice(4));
  assert.deepEqual(suggestedMappingListings(listings, { ...apollo, name: 'Apollo Tyres' }), []);
  assert.deepEqual(suggestedMappingListings(listings, { ...apollo, name: '195/55 R16' }), []);
});

test('a distinctive model can match a seller SKU while additional variants still matter', () => {
  const listing = { ...unmapped, title: 'Wireless speaker', sku: 'BT-QX200-WHT' };
  const item = { ...apollo, name: 'Acme QX200', brand: 'Acme', unit: 'pieces' };
  assert.deepEqual(suggestedMappingListings([listing], item), [listing]);
  assert.deepEqual(suggestedMappingListings([listing], { ...item, name: 'Acme QX200 Pro' }), []);
  assert.deepEqual(suggestedMappingListings([listing], { ...item, name: 'Acme QX20' }), []);
});
