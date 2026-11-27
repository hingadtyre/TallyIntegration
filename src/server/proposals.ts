import { availableForMarketplaces, calculateStock } from '../domain/stock-policy.js';
import {
  billingOnlyMapping,
  type Listing,
  type Proposal,
  type Snapshot,
  type StockItem,
} from '../shared/contracts.js';
import { InputError, isRecentObservation } from './validation.js';

function ruleVersion(state: Snapshot, listing: Listing): string {
  const useTyreFloor = listing.tyreFloor ?? state.mode === 'demo';
  return useTyreFloor ? 'flipkart-tyres-v1' : 'complete-packs-v1';
}

export function requireStockSource(
  state: Snapshot,
  listing: Listing,
  item = state.items.find((row) => row.id === listing.itemId),
): { item: StockItem; physical: number; packSize: number } {
  if (billingOnlyMapping(listing))
    throw new InputError(
      'Confirm the stock source in Inventory before calculating stock for this listing.',
    );
  if (!item || item.id !== listing.itemId || item.physical === null || !item.observedAt)
    throw new InputError('Refresh valid source stock before calculating.');
  if (!listing.verified || !listing.packSize)
    throw new InputError('Verify the mapping and pack size first.');
  if (
    listing.packSource === 'packages' &&
    (!listing.packageAvailable || listing.packageCount !== listing.packSize)
  )
    throw new InputError(
      'Refresh the reported package count and review Set of before calculating.',
    );
  const maximumAge = Math.max(120_000, state.settings.tallySeconds * 3000);
  const stale = !isRecentObservation(item.observedAt, maximumAge);
  const company = state.companies.find((row) => row.id === item.companyId);
  if (
    state.mode === 'live' &&
    (state.connection.tally !== 'online' || stale || !company?.lastSuccess || company.stockIssue)
  ) {
    throw new InputError('Tally stock is stale. Refresh before reviewing changes.');
  }
  return { item, physical: item.physical, packSize: listing.packSize };
}

export function desiredStock(
  state: Snapshot,
  listing: Listing,
  policy: 'current' | 'manual-ceiling' = 'current',
  availableUnits?: number,
  item?: StockItem,
): number {
  const source = requireStockSource(state, listing, item);
  // Manual Inventory edits retain their original upper bound from Tally. Overriding
  // the lower, verified keep-back availability requires a separate confirmation.
  const manualCeiling = policy === 'manual-ceiling';
  const physical = manualCeiling
    ? source.physical
    : (availableUnits ?? availableForMarketplaces(source.physical, 0, source.item.keepBackUnits));
  return calculateStock({
    physical,
    packSize: source.packSize,
    tyreFloor: ruleVersion(state, listing) === 'flipkart-tyres-v1',
    policy: manualCeiling
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
    draft.stale ||
    !listing ||
    !item ||
    draft.itemVersion !== item.version ||
    draft.listingVersion !== listing.version ||
    draft.ruleVersion !== ruleVersion(state, listing)
  );
}

/** Save the need for fresh order and bill evidence, including for paused listings. */
export function queueOrderProposal(state: Snapshot, listing: Listing) {
  if (state.proposals.some((draft) => draft.listingId === listing.id)) return;
  listing.orderProposalPending = true;
}

export function invalidateReservationDrafts(state: Snapshot, itemIds: Set<string>): void {
  const destinations = new Set(
    state.listings.filter((row) => row.itemId && itemIds.has(row.itemId)).map((row) => row.id),
  );
  for (const draft of state.proposals) {
    if (!draft.edited && destinations.has(draft.listingId)) draft.stale = true;
  }
}

export function describeReviewPolicy(listing: Listing, draft?: Proposal): string {
  const paused = listing.paused || (draft?.edited && draft.quantity === 0);
  if (draft?.edited && draft.quantity > 0)
    return `${paused ? 'Tally sync paused · ' : ''}Allow ${draft.quantity} more sales`;
  if (listing.policy === 'limited')
    return paused
      ? `Tally sync paused · ${listing.remaining} ${listing.remaining === 1 ? 'sale' : 'sales'} remaining`
      : `Limited sales · ${listing.remaining} remaining`;
  return paused ? 'Tally sync paused' : 'Auto';
}
