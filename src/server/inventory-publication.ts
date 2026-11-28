import { marketplaceEditLimits } from '../shared/marketplace-contracts.js';
import type { Listing, Proposal, Snapshot } from '../shared/contracts.js';
import type { MarketplaceApplyInput, MarketplaceListing } from '../shared/marketplace-contracts.js';
import { desiredStock, isStaleProposal, requireStockSource } from './proposals.js';
import { InputError } from './validation.js';
import { hasConfirmedPickup } from './marketplace-catalog.js';

/** The review's destination and policy stay fixed while physical stock and reservations move. */
export interface CalculatedReview extends Pick<
  Listing,
  'syncPendingItemVersion' | 'orderSyncPending'
> {
  observed: number | null;
  verify: (state: Snapshot, listing: Listing, marketplace: MarketplaceListing) => void;
}

/** The review belongs to this server session. The saved proposal supplies the quantity. */
export interface InventoryIntent {
  companyId: string;
  listingId: string;
  itemVersion: number;
  listingVersion: number;
  draft?: Proposal;
  calculatedReview?: CalculatedReview;
  keepBackConfirmation?: MarketplaceApplyInput['keepBackConfirmation'];
  /** Receipt authorizing a decrease-only check when there is no Tally change. */
  orderOnly?: string;
  /** A seller-reviewed calculated update while company automation is off. */
  trial?: {
    marketplaceId: string;
    productId: string;
    sellerId: string | null;
    location: string;
    observed: number | null;
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
  if (
    !listing ||
    listing.accountId !== marketplace.accountId ||
    listing.sku !== marketplace.sku ||
    (listing.skuMappingId && listing.skuMappingId !== marketplace.id)
  )
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
  if (!listing.location)
    throw new InputError('Choose a pickup location in Edit Set of before publishing.', 409);
  if (
    marketplace.status !== 'ACTIVE' ||
    (!hasConfirmedPickup(listing, marketplace) &&
      !marketplace.locations.some(
        (location) => location.id === listing.location && location.status === 'ENABLED',
      ))
  )
    throw new InputError(
      'Only an active listing with an enabled stock location can be updated.',
      409,
    );
  const draft = intent.draft;
  if (listing.orderProposalPending && !draft?.edited && availableUnits === undefined)
    throw new InputError('Check the mapped order and Tally stock before publishing.', 409);
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
  } else if (intent.calculatedReview) {
    intent.calculatedReview.verify(state, listing, marketplace);
    const current = state.proposals.find((entry) => entry.listingId === listing.id);
    if (
      !current ||
      current.edited ||
      !!current.resumeOnPublish !== !!draft.resumeOnPublish ||
      (draft.resumeOnPublish && !listing.paused)
    )
      throw new InputError('The reviewed draft was replaced or removed. Open a fresh review.', 409);
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
  let quantity =
    (intent.calculatedReview ? undefined : draft?.quantity) ??
    desiredStock(state, listing, 'current', availableUnits);
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
  if (!intent.calculatedReview && draft && !draft.edited && availableUnits !== undefined) {
    const availableQuantity = desiredStock(state, listing, 'current', availableUnits);
    if (quantity !== availableQuantity)
      throw new InputError(
        `This review shows ${quantity}. After allowing for unbilled orders, the listing quantity is ${availableQuantity}. Calculate again in Inventory and review the new quantity.`,
        409,
      );
  }
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > marketplaceEditLimits.stock.max)
    throw new InputError(
      `Calculated stock must be a whole number between 0 and ${marketplaceEditLimits.stock.max}.`,
      409,
    );
  if (draft?.edited && quantity > desiredStock(state, listing, 'manual-ceiling'))
    throw new InputError('The edited quantity exceeds the current calculated stock.', 409);
  if (listing.policy === 'limited') {
    if (quantity > (listing.remaining ?? 0))
      throw new InputError('This quantity exceeds the remaining sales allowance.', 409);
    if (state.mode === 'live' && quantity > 0)
      throw new InputError('Positive sales allowances require verified order reconciliation.', 409);
  }
  return { listing, quantity };
}

/** Consume a manual draft at acceptance, and an explicit resume only on confirmation. */
export function activateInventoryIntent(
  state: Snapshot,
  intent: InventoryIntent,
  listing: Listing,
): void {
  if (intent.trial) return;
  if (intent.draft?.edited) {
    listing.paused = true;
    listing.version++;
  } else if (intent.calculatedReview && intent.draft?.resumeOnPublish) {
    listing.paused = false;
    listing.version++;
  }
  if (intent.draft) state.proposals = state.proposals.filter((row) => row.listingId !== listing.id);
  listing.syncPendingItemVersion = null;
  listing.orderSyncPending = null;
}
