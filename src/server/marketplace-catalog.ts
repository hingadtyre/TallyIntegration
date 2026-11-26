import { randomUUID } from 'node:crypto';
import type { Listing, Snapshot } from '../shared/contracts.js';
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

export function cataloguesOverlap(
  previous: MarketplaceListing[],
  incoming: MarketplaceListing[],
): boolean {
  const known = new Map(previous.map((row) => [row.id, row]));
  return incoming.some((row) => {
    const old = known.get(row.id);
    return old?.sku === row.sku && old.productId === row.productId;
  });
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
      .map((row) => {
        const item = state.items.find((entry) => entry.id === row.itemId);
        const companyId = item?.companyId;
        return {
          listingId: row.id,
          listingVersion: row.version,
          locationId: row.location,
          companyId,
          ...(item?.keepBackUnits && { keepBackUnits: item.keepBackUnits }),
          companyName:
            state.companies.find((company) => company.id === companyId)?.name ?? 'Not mapped',
          policy: row.policy,
          remaining: row.remaining,
          paused: row.paused,
          automationStatus: row.automationStatus,
          ...(row.proposalIssue && { proposalIssue: row.proposalIssue }),
        };
      }),
  };
}

export function markPackageCountsUnavailable(state: Snapshot, accountId?: string): void {
  for (const row of state.listings) {
    if ((!accountId || row.accountId === accountId) && row.packageAvailable) {
      row.packageAvailable = false;
      if (row.packSource !== 'manual') row.version++;
    }
  }
}

function observePackageCount(row: Listing, listing: MarketplaceListing): boolean {
  const count = listing.packageCount;
  const available =
    typeof count === 'number' && Number.isSafeInteger(count) && count > 0 && !!listing.observedAt;
  const changed = row.packageAvailable !== available || (available && row.packageCount !== count);
  if (available) {
    row.packageCount = count;
    row.packageObservedAt = listing.observedAt;
    if (row.packSource === 'packages' && row.packSize !== count) {
      row.verified = false;
      row.packEvidence = `Flipkart package count changed from ${row.packSize} to ${count}. Review Set of.`;
    }
  }
  row.packageAvailable = available;
  // Parcel-only changes do not invalidate proposals using a manual multiplier.
  return changed && row.packSource !== 'manual';
}

/** Both screens refer to the same account/SKU/location; refresh never grants a mapping. */
export function updateInventoryObservations(
  state: Snapshot,
  listing: MarketplaceListing,
  quantityOnlyChanges?: string[],
): void {
  const skuRows = state.listings.filter(
    (row) => row.accountId === listing.accountId && row.sku === listing.sku,
  );
  const pending = skuRows.find((row) => row.skuMappingId === listing.id && !row.location);
  if (listing.locations.length && pending && !pending.itemId) {
    state.listings = state.listings.filter((row) => row !== pending);
  }
  if (!listing.locations.length || pending?.itemId) {
    const retained = skuRows.filter(
      (row) => row.skuMappingId === listing.id && (!listing.locations.length || !row.location),
    );
    if (!retained.length && !listing.locations.length) {
      retained.push({
        id: randomUUID(),
        accountId: listing.accountId,
        sku: listing.sku,
        title: listing.title,
        skuMappingId: listing.id,
        location: '',
        itemId: null,
        packSize: null,
        packEvidence: 'Pack evidence has not been verified.',
        verified: false,
        observed: null,
        observedAt: null,
        policy: 'auto',
        remaining: null,
        paused: false,
        version: 1,
      });
      state.listings.push(retained[0]);
    }
    for (const row of retained) {
      row.title = listing.title;
      const packChanged = observePackageCount(row, listing);
      if (row.observed !== null || packChanged) row.version++;
      row.observed = null;
      row.observedAt = null;
    }
  }
  for (const location of listing.locations) {
    const existing = state.listings.find(
      (row) =>
        row.accountId === listing.accountId &&
        row.sku === listing.sku &&
        row.location === location.id,
    );
    if (existing) {
      existing.title = listing.title;
      const packChanged = observePackageCount(existing, listing);
      if (existing.observed !== location.quantity || packChanged) existing.version++;
      if (
        !packChanged &&
        existing.observed !== null &&
        location.quantity !== null &&
        existing.observed !== location.quantity
      )
        quantityOnlyChanges?.push(existing.id);
      existing.observed = location.quantity;
      existing.observedAt = listing.observedAt;
      if (
        location.quantity !== null &&
        location.quantity > 0 &&
        !existing.paused &&
        existing.verified &&
        existing.policy === 'limited' &&
        existing.remaining === 0
      ) {
        const item = state.items.find((row) => row.id === existing.itemId);
        if (
          item &&
          state.companies.some((company) => company.id === item.companyId && company.automation)
        )
          existing.syncPendingItemVersion = item.version;
      }
    } else {
      const added: Listing = {
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
      };
      observePackageCount(added, listing);
      state.listings.push(added);
    }
  }
}

export function pickupChoices(
  listings: MarketplaceListing[],
  target: MarketplaceListing,
): string[] {
  if (!target.observedAt) return [];
  const sources = target.locations.length
    ? [target]
    : listings.filter((row) => row.accountId === target.accountId && row.observedAt);
  return [
    ...new Set(
      sources.flatMap((row) =>
        row.locations.filter((loc) => loc.status === 'ENABLED').map((loc) => loc.id),
      ),
    ),
  ].sort();
}

export function hasConfirmedPickup(row: Listing, remote: MarketplaceListing): boolean {
  return (
    !!row.itemId &&
    !!row.location &&
    row.skuMappingId === remote.id &&
    row.accountId === remote.accountId &&
    row.sku === remote.sku &&
    !!remote.observedAt &&
    remote.locations.length === 0
  );
}

/** The order fixes the destination before the seller chooses a Tally item. */
export function verifyOrderMapping(
  market: MarketplaceData,
  listing: Listing,
  companyId: string,
  location: unknown,
  orderSource: unknown,
  existingPickup = false,
): string {
  if (!orderSource || typeof orderSource !== 'object')
    throw new InputError('Choose an order from Order matching.');
  const source = orderSource as Record<string, unknown>;
  const matches = market.listings.filter(
    (row) => row.accountId === listing.accountId && row.sku === listing.sku,
  );
  const [remote] = matches;
  if (
    (!existingPickup && listing.itemId !== null && !!listing.location) ||
    source.companyId !== companyId ||
    source.accountId !== listing.accountId ||
    typeof location !== 'string' ||
    !location ||
    source.locationId !== location ||
    matches.length !== 1 ||
    !remote.observedAt ||
    source.listingId !== remote.id ||
    (listing.skuMappingId && listing.skuMappingId !== remote.id) ||
    !(
      remote.locations.some((entry) => entry.id === location) ||
      (existingPickup && hasConfirmedPickup(listing, remote)) ||
      (listing.skuMappingId === remote.id &&
        pickupChoices(market.listings, remote).includes(location))
    )
  )
    throw new InputError(
      'The order listing, seller, pickup location or Tally company changed. Reopen the order mapping.',
      409,
    );
  return remote.id;
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
      const sample: MarketplaceListing = {
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
        packageCount: rows[0].packSize,
        observedAt: at,
        version: 1,
        locations: rows.map((row) => ({
          id: row.location,
          quantity: row.observed,
          status: 'ENABLED',
        })),
      };
      data.listings.push(sample);
      for (const row of rows) observePackageCount(row, sample);
    }
  }
}
