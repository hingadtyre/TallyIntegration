import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../shared/contracts.js';
import type {
  MarketplaceListing,
  MarketplaceListingView,
} from '../shared/marketplace-contracts.js';
import type { MarketplaceData } from './storage/marketplace-records.js';
import { InputError } from './validation.js';

export function findMarketplaceListing(
  data: MarketplaceData,
  accountId: string,
  listingId: string,
): MarketplaceListing {
  const listing = data.listings.find((row) => row.accountId === accountId && row.id === listingId);
  if (!listing)
    throw new InputError('This listing is not in the selected account. Refresh listings.', 404);
  return listing;
}

export function listingView(listing: MarketplaceListing, state: Snapshot): MarketplaceListingView {
  return {
    ...listing,
    stockPolicies: state.listings
      .filter(
        (row) =>
          row.accountId === listing.accountId &&
          row.sku === listing.sku &&
          (row.itemId !== null || row.policy !== 'auto' || row.paused),
      )
      .map((row) => ({
        listingId: row.id,
        locationId: row.location,
        companyName:
          state.companies.find(
            (company) =>
              company.id === state.items.find((item) => item.id === row.itemId)?.companyId,
          )?.name ?? 'Not mapped',
        policy: row.policy,
        remaining: row.remaining,
        paused: row.paused,
      })),
  };
}

/** Both screens refer to the same account/SKU/location; refresh never grants a mapping. */
export function updateInventoryObservations(state: Snapshot, listing: MarketplaceListing): void {
  for (const location of listing.locations) {
    const existing = state.listings.find(
      (row) =>
        row.accountId === listing.accountId &&
        row.sku === listing.sku &&
        row.location === location.id,
    );
    if (existing) {
      existing.title = listing.title;
      if (existing.observed !== location.quantity) existing.version++;
      existing.observed = location.quantity;
      existing.observedAt = listing.observedAt;
    } else {
      state.listings.push({
        id: randomUUID(),
        accountId: listing.accountId,
        sku: listing.sku,
        title: listing.title,
        location: location.id,
        itemId: null,
        packSize: null,
        packEvidence: 'Pack evidence has not been verified.',
        verified: false,
        observed: location.quantity,
        observedAt: listing.observedAt,
        policy: 'auto',
        remaining: null,
        paused: false,
        version: 1,
      });
    }
  }
}

export function seedSampleMarketplace(data: MarketplaceData, state: Snapshot): void {
  if (state.mode !== 'demo' || data.accounts.length) return;
  for (const account of state.accounts) {
    const at = new Date().toISOString();
    data.accounts.push({
      id: account.id,
      name: account.name,
      sellerId: `sample-${account.id}`,
      lastRefreshedAt: at,
    });
    const skus = new Set(
      state.listings.filter((row) => row.accountId === account.id).map((row) => row.sku),
    );
    for (const sku of skus) {
      const rows = state.listings.filter((row) => row.accountId === account.id && row.sku === sku);
      data.listings.push({
        id: `sample-${rows[0].id}`,
        accountId: account.id,
        sellerId: `sample-${account.id}`,
        productId: `sample-product-${rows[0].id}`,
        sku,
        title: rows[0].title,
        imageUrl: null,
        status: 'ACTIVE',
        mrp: 6000,
        sellingPrice: 5000,
        observedAt: at,
        version: 1,
        locations: rows.map((row) => ({
          id: row.location,
          quantity: row.observed,
          status: 'ENABLED',
        })),
      });
    }
  }
}
