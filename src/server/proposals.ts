import { calculateStock } from '../domain/stock-policy.js';
import type { Listing, Proposal, Snapshot, StockItem } from '../shared/contracts.js';
import { InputError } from './validation.js';

const RULE_VERSION = 'flipkart-tyres-v1';

export function requireStockSource(
  state: Snapshot,
  listing: Listing,
): { item: StockItem; physical: number; packSize: number } {
  const item = state.items.find((row) => row.id === listing.itemId);
  if (!item || item.physical === null || !item.observedAt)
    throw new InputError('Refresh valid source stock before calculating.');
  if (!listing.verified || !listing.packSize)
    throw new InputError('Verify the mapping and pack size first.');
  const observedAt = Date.parse(item.observedAt);
  const maximumAge = Math.max(120_000, state.settings.tallySeconds * 3000);
  const stale = !Number.isFinite(observedAt) || Date.now() - observedAt > maximumAge;
  if (state.mode === 'live' && (state.connection.tally !== 'online' || stale)) {
    throw new InputError('Tally stock is stale. Refresh before reviewing changes.');
  }
  return { item, physical: item.physical, packSize: listing.packSize };
}

export function desiredStock(
  state: Snapshot,
  listing: Listing,
  policy: 'current' | 'normal' = 'current',
): number {
  const source = requireStockSource(state, listing);
  return calculateStock({
    physical: source.physical,
    packSize: source.packSize,
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
): Proposal {
  const { item } = requireStockSource(state, listing);
  const calculated = desiredStock(state, listing);
  return {
    listingId: listing.id,
    quantity: editedQuantity ?? calculated,
    calculated,
    edited: editedQuantity !== undefined,
    itemVersion: item.version,
    listingVersion: listing.version,
    ruleVersion: RULE_VERSION,
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
    draft.ruleVersion !== RULE_VERSION
  );
}

export function describeReviewPolicy(listing: Listing, draft?: Proposal): string {
  if (draft?.edited)
    return draft.quantity === 0 ? 'Kept out of stock' : `Allow ${draft.quantity} more sales`;
  if (listing.policy === 'limited') return `Limited sales · ${listing.remaining} remaining`;
  if (listing.policy === 'hold') return 'Kept out of stock';
  return 'Auto';
}
