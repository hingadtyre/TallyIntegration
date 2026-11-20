import type { Listing, Proposal, Snapshot } from '../shared/contracts.js';
import type { MarketplaceListing } from '../shared/marketplace-contracts.js';
import { desiredStock, isStaleProposal, requireStockSource } from './proposals.js';
import { InputError } from './validation.js';

/** The review belongs to this server session. The saved proposal supplies the quantity. */
export interface InventoryIntent {
  companyId: string;
  listingId: string;
  itemVersion: number;
  listingVersion: number;
  draft?: Proposal;
  positiveEdits?: 'allowance' | 'once';
  /** Receipt authorizing a decrease-only check when there is no Tally change. */
  orderOnly?: string;
  /** A seller-reviewed calculated update while company automation is off. */
  trial?: {
    marketplaceId: string;
    productId: string;
    sellerId: string | null;
    location: string;
    observed: number;
    quantity: number;
  };
}

export function inventoryTarget(
  state: Snapshot,
  intent: InventoryIntent,
  marketplace: MarketplaceListing,
  availableUnits?: number,
): { listing: Listing; quantity: number } {
  const listing = state.listings.find((row) => row.id === intent.listingId);
  if (!listing || listing.accountId !== marketplace.accountId || listing.sku !== marketplace.sku)
    throw new InputError('The mapped listing changed. Review the current destination.', 409);
  const company = state.companies.find((row) => row.id === intent.companyId);
  const { item } = requireStockSource(state, listing);
  if (!company || company.id !== item.companyId || item.version !== intent.itemVersion)
    throw new InputError('Tally stock or the mapping changed. Recalculate the current stock.', 409);
  if (listing.version !== intent.listingVersion)
    throw new InputError('The mapped listing changed. Review the current value.', 409);
  if (state.mode === 'live' && listing.sourceScope !== 'company')
    throw new InputError(
      'Confirm which Tally stock supplies this location before publishing.',
      409,
    );
  if (
    marketplace.status !== 'ACTIVE' ||
    !marketplace.locations.some(
      (location) => location.id === listing.location && location.status === 'ENABLED',
    )
  )
    throw new InputError(
      'Only an active listing with an enabled stock location can be updated.',
      409,
    );
  const draft = intent.draft;
  if (intent.trial) {
    if (
      company.automation ||
      listing.paused ||
      intent.trial.marketplaceId !== marketplace.id ||
      intent.trial.productId !== marketplace.productId ||
      intent.trial.sellerId !== marketplace.sellerId ||
      intent.trial.location !== listing.location
    )
      throw new InputError(
        'This listing or its automation changed. Preview the company again.',
        409,
      );
  } else if (!draft) {
    const current = intent.orderOnly
      ? listing.orderSyncPending === intent.orderOnly && listing.syncPendingItemVersion == null
      : listing.syncPendingItemVersion === item.version;
    if (!company.automation || listing.paused || !current)
      throw new InputError('This automatic update is no longer current.', 409);
  } else {
    const current = state.proposals.find((row) => row.listingId === listing.id);
    if (
      !current ||
      isStaleProposal(state, draft) ||
      current.createdAt !== draft.createdAt ||
      current.quantity !== draft.quantity ||
      current.edited !== draft.edited ||
      current.listingVersion !== draft.listingVersion ||
      current.itemVersion !== draft.itemVersion ||
      current.ruleVersion !== draft.ruleVersion
    )
      throw new InputError('The reviewed proposal changed. Calculate and review it again.', 409);
  }
  let quantity = draft?.quantity ?? desiredStock(state, listing, 'current', availableUnits);
  if (intent.trial && quantity !== intent.trial.quantity)
    throw new InputError(
      'The calculated stock changed. Preview the new quantity before trying this listing.',
      409,
    );
  if (intent.orderOnly) {
    const observed = marketplace.locations.find((loc) => loc.id === listing.location)?.quantity;
    if (observed == null)
      throw new InputError(
        'Refresh the current marketplace stock before checking a shared sale.',
        409,
      );
    quantity = Math.min(quantity, observed);
  }
  if (draft && !draft.edited && availableUnits !== undefined) {
    const availableQuantity = desiredStock(state, listing, 'current', availableUnits);
    if (quantity !== availableQuantity)
      throw new InputError(
        `This review shows ${quantity}. After allowing for unbilled orders, the listing quantity is ${availableQuantity}. Calculate again in Inventory and review the new quantity.`,
        409,
      );
  }
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 5000)
    throw new InputError('Calculated stock must be a whole number between 0 and 5000.', 409);
  if (draft?.edited && quantity > desiredStock(state, listing, 'normal'))
    throw new InputError('The edited quantity exceeds the current calculated stock.', 409);
  const updateOnce = draft?.edited && quantity > 0 && intent.positiveEdits === 'once';
  if (updateOnce && listing.policy !== 'auto')
    throw new InputError(
      'Update once requires Auto. The existing hold or sales allowance still applies.',
      409,
    );
  if (
    state.mode === 'live' &&
    quantity > 0 &&
    !updateOnce &&
    (draft?.edited || listing.policy === 'limited')
  )
    throw new InputError(
      'Positive sales allowances require verified order reconciliation. For an Auto listing, choose Update once to publish this quantity.',
      409,
    );
  return { listing, quantity };
}

/** Called in the same transaction that records an attempt, or confirms a no-op. */
export function activateInventoryIntent(
  state: Snapshot,
  intent: InventoryIntent,
  listing: Listing,
): void {
  if (intent.trial) return;
  if (intent.draft?.edited && (intent.draft.quantity === 0 || intent.positiveEdits !== 'once')) {
    listing.policy = intent.draft.quantity === 0 ? 'hold' : 'limited';
    listing.remaining = intent.draft.quantity;
    listing.version++;
  }
  if (intent.draft) state.proposals = state.proposals.filter((row) => row.listingId !== listing.id);
  listing.syncPendingItemVersion = null;
  listing.orderSyncPending = null;
}
