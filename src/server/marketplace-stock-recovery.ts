import { randomUUID } from 'node:crypto';
import type { MarketplaceStockRecoveryReview } from '../shared/marketplace-recovery.js';
import type { MarketplaceListing } from '../shared/marketplace-contracts.js';
import { findMarketplaceListing } from './marketplace-catalog.js';
import {
  MarketplacePublication,
  recoverableStockChange,
  sameListingIdentity,
  type ListingTransport,
} from './marketplace-publication.js';
import { desiredStock, requireStockSource } from './proposals.js';
import type { Store } from './store.js';
import { InputError } from './validation.js';

type Availability = (
  companyId: string,
  itemId: string,
) => Promise<{ available: number; verify: () => void }>;
type ReviewObservation = {
  listing: MarketplaceListing;
  observed: number;
  quantity: number;
  locationId: string;
  version: string;
  verify: () => void;
};
type ReviewSession = { id: string; version: string; expires: number; verify: () => void };

export class MarketplaceStockRecovery {
  private readonly sessions = new Map<string, ReviewSession>();
  constructor(
    private readonly store: Store,
    private readonly client: ListingTransport,
    private readonly publisher: MarketplacePublication,
    private readonly available: Availability,
  ) {}

  private inputs(accountId: string, changeId: string) {
    const data = this.store.readMarketplace();
    const { old, edit } = recoverableStockChange(data.changes, accountId, changeId);
    const listing = findMarketplaceListing(data, accountId, old.listingId);
    if (!listing.observedAt || listing.sku !== old.sku)
      throw new InputError(
        'Refresh the seller account to verify the original listing identity.',
        409,
      );
    const state = this.store.read();
    const matches = state.listings.filter(
      (row) =>
        row.accountId === accountId && row.sku === listing.sku && row.location === edit.locationId,
    );
    if (matches.length !== 1 || !matches[0].itemId)
      throw new InputError(
        'Verify the Tally stock mapping for this listing and location in Inventory before recovery.',
        409,
      );
    const mapping = matches[0];
    const { item } = requireStockSource(state, mapping);
    if (state.mode === 'live' && mapping.sourceScope !== 'company')
      throw new InputError(
        'Confirm which Tally company supplies this listing before recovery.',
        409,
      );
    const version = JSON.stringify([
      old.id,
      old.stockRequestFinality,
      old.updatedAt,
      listing.id,
      listing.version,
      listing.productId,
      listing.sellerId,
      mapping.id,
      mapping.version,
      mapping.itemId,
      mapping.policy,
      mapping.remaining,
      mapping.paused,
      mapping.packSize,
      mapping.tyreFloor,
      item.companyId,
      item.version,
    ]);
    return { state, listing, mapping, item, version, locationId: edit.locationId };
  }

  private async observe(
    accountId: string,
    changeId: string,
    token: string | null,
    verifySeller: () => void,
  ): Promise<ReviewObservation> {
    verifySeller();
    const input = this.inputs(accountId, changeId);
    const evidence = await this.available(input.item.companyId, input.item.id);
    const current =
      token === null
        ? { ...input.listing, observedAt: new Date().toISOString() }
        : await this.client.getListing(token, input.listing, { requireCurrentStatus: true });
    if (!sameListingIdentity(input.listing, current) || current.status !== 'ACTIVE')
      throw new InputError(
        'The original active Flipkart listing could not be verified. Refresh the seller account.',
        409,
      );
    const destination = current.locations.filter((loc) => loc.id === input.locationId);
    if (
      destination.length !== 1 ||
      destination[0].status !== 'ENABLED' ||
      destination[0].quantity === null
    )
      throw new InputError(
        'Flipkart must verify the enabled stock location and its current quantity before recovery.',
        409,
      );
    if (input.mapping.packSource === 'packages' && current.packageCount !== input.mapping.packSize)
      throw new InputError('The current Flipkart package count needs review in Inventory.', 409);
    const observed = destination[0].quantity;
    const quantity = desiredStock(input.state, input.mapping, 'current', evidence.available);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 5000)
      throw new InputError('The calculated quantity is outside the allowed stock range.', 409);
    if (input.state.mode === 'live' && input.mapping.policy === 'limited' && quantity > 0)
      throw new InputError(
        'Positive stock under Limited sales requires verified allowance accounting.',
        409,
      );
    const verify = () => {
      verifySeller();
      evidence.verify();
      if (this.inputs(accountId, changeId).version !== input.version)
        throw new InputError(
          'The stock setup or listing changed during recovery. Review the current stock again.',
          409,
        );
    };
    verify();
    return {
      listing: current,
      observed,
      quantity,
      locationId: input.locationId,
      version: JSON.stringify([input.version, observed, quantity]),
      verify,
    };
  }

  async review(
    accountId: string,
    changeId: string,
    token: string | null,
    verifySeller: () => void,
  ): Promise<MarketplaceStockRecoveryReview> {
    for (const [key, review] of this.sessions)
      if (review.expires <= Date.now()) this.sessions.delete(key);
    const checked = await this.observe(accountId, changeId, token, verifySeller);
    const reviewId = randomUUID();
    this.sessions.set(JSON.stringify([accountId, changeId]), {
      id: reviewId,
      version: checked.version,
      expires: Date.now() + 120_000,
      verify: checked.verify,
    });
    return {
      reviewId,
      sku: checked.listing.sku,
      locationId: checked.locationId,
      observed: checked.observed,
      quantity: checked.quantity,
    };
  }

  async approve(
    accountId: string,
    changeId: string,
    reviewId: string,
    token: string | null,
    verifySeller: () => void,
  ) {
    const key = JSON.stringify([accountId, changeId]);
    const review = this.sessions.get(key);
    if (!review || review.id !== reviewId || review.expires <= Date.now())
      throw new InputError(
        'This recovery review expired or changed. Review the current stock again.',
        409,
      );
    this.sessions.delete(key);
    review.verify();
    const fresh = await this.observe(accountId, changeId, token, verifySeller);
    if (fresh.version !== review.version)
      throw new InputError(
        'The current or calculated stock changed. Review the new quantity before approving.',
        409,
      );
    const verify = () => {
      if (review.expires <= Date.now())
        throw new InputError('This recovery review expired. Review the current stock again.', 409);
      review.verify();
      fresh.verify();
    };
    return this.publisher.recoverStock(
      accountId,
      changeId,
      fresh.listing,
      fresh.quantity,
      token,
      verify,
    );
  }
}
