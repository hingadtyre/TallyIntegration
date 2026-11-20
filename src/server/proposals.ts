import { calculateStock } from '../domain/stock-policy.js';
import type { Listing, Proposal, Snapshot, StockItem } from '../shared/contracts.js';
import { InputError } from './validation.js';

function ruleVersion(state: Snapshot, listing: Listing): string {
  const useTyreFloor = listing.tyreFloor ?? state.mode === 'demo';
  return useTyreFloor ? 'flipkart-tyres-v1' : 'complete-packs-v1';
}

export function requireStockSource(
  state: Snapshot,
  listing: Listing,
): { item: StockItem; physical: number; packSize: number } {
  const item = state.items.find((row) => row.id === listing.itemId);
  if (!item || item.physical === null || !item.observedAt)
    throw new InputError('Refresh valid source stock before calculating.');
  if (!listing.verified || !listing.packSize)
    throw new InputError('Verify the mapping and pack size first.');
  if (
    listing.packSource === 'packages' &&
    (!listing.packageAvailable || listing.packageCount !== listing.packSize)
  )
    throw new InputError(
      'Refresh the Flipkart package count and review Set of before calculating.',
    );
  const observedAt = Date.parse(item.observedAt);
  const maximumAge = Math.max(120_000, state.settings.tallySeconds * 3000);
  const stale = !Number.isFinite(observedAt) || Date.now() - observedAt > maximumAge;
  if (
    state.mode === 'live' &&
    (state.connection.tally !== 'online' ||
      stale ||
      !state.companies.find((company) => company.id === item.companyId)?.lastSuccess)
  ) {
    throw new InputError('Tally stock is stale. Refresh before reviewing changes.');
  }
  return { item, physical: item.physical, packSize: listing.packSize };
}

export function desiredStock(
  state: Snapshot,
  listing: Listing,
  policy: 'current' | 'normal' = 'current',
  availableUnits?: number,
): number {
  const source = requireStockSource(state, listing);
  return calculateStock({
    physical: availableUnits ?? source.physical,
    packSize: source.packSize,
    tyreFloor: ruleVersion(state, listing) === 'flipkart-tyres-v1',
    policy:
      policy === 'normal'
        ? { mode: 'auto', remaining: null }
        : { mode: listing.policy, remaining: listing.remaining },
  }).desired;
}

export function prepareProposal(
  state: Snapshot,
  listing: Listing,
  editedQuantity?: number,
  availableUnits?: number,
): Proposal {
  const { item } = requireStockSource(state, listing);
  const calculated = desiredStock(state, listing, 'current', availableUnits);
  return {
    listingId: listing.id,
    quantity: editedQuantity ?? calculated,
    calculated,
    edited: editedQuantity !== undefined,
    itemVersion: item.version,
    listingVersion: listing.version,
    ruleVersion: ruleVersion(state, listing),
    createdAt: new Date().toISOString(),
    stale: false,
  };
}

export function isStaleProposal(state: Snapshot, draft: Proposal): boolean {
  const listing = state.listings.find((row) => row.id === draft.listingId);
  const item = state.items.find((row) => row.id === listing?.itemId);
  return (
    !listing ||
    !item ||
    draft.itemVersion !== item.version ||
    draft.listingVersion !== listing.version ||
    draft.ruleVersion !== ruleVersion(state, listing)
  );
}

export function describeReviewPolicy(listing: Listing, draft?: Proposal): string {
  if (draft?.edited)
    return draft.quantity === 0 ? 'Kept out of stock' : `Allow ${draft.quantity} more sales`;
  if (listing.policy === 'limited') return `Limited sales · ${listing.remaining} remaining`;
  if (listing.policy === 'hold') return 'Kept out of stock';
  return 'Auto';
}
