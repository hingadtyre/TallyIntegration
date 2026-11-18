import { randomUUID } from 'node:crypto';
import {
  FlipkartListingError,
  type FlipkartListingsClient,
} from '../adapters/flipkart-listings.js';
import type { Snapshot } from '../shared/contracts.js';
import type {
  MarketplaceApplyResult,
  MarketplaceChange,
  MarketplaceEdit,
  MarketplaceListing,
} from '../shared/marketplace-contracts.js';
import { recordActivity } from './activity.js';
import {
  findMarketplaceListing,
  listingView,
  updateInventoryObservations,
} from './marketplace-catalog.js';
import type { Store } from './store.js';
import { InputError, requireText, requireWholeNumber } from './validation.js';

export type ListingTransport = Pick<
  FlipkartListingsClient,
  'listListings' | 'getListing' | 'updatePrice' | 'updateStock'
>;

function parseEdit(input: unknown): MarketplaceEdit {
  if (!input || typeof input !== 'object') throw new InputError('Choose a stock or price edit.');
  const edit = input as Record<string, unknown>;
  if (edit.kind === 'stock') {
    if (edit.automation !== 'once' && edit.automation !== 'pause')
      throw new InputError('Choose how this edit affects Tally synchronization.');
    return {
      kind: 'stock',
      locationId: requireText(edit.locationId, 'Location'),
      quantity: requireWholeNumber(edit.quantity, 'Stock', 0, 5000),
      automation: edit.automation,
    };
  }
  if (edit.kind === 'price' && (edit.field === 'mrp' || edit.field === 'sellingPrice'))
    return {
      kind: 'price',
      field: edit.field,
      value: requireWholeNumber(edit.value, 'Price', 1, 100_000_000),
    };
  throw new InputError('Choose a stock or price edit.');
}

function policyRows(state: Snapshot, listing: MarketplaceListing, locationId: string) {
  return state.listings.filter(
    (row) =>
      row.accountId === listing.accountId && row.sku === listing.sku && row.location === locationId,
  );
}

function validateStockPolicy(
  state: Snapshot,
  listing: MarketplaceListing,
  edit: MarketplaceEdit,
): void {
  if (edit.kind !== 'stock') return;
  if (
    !listing.locations.some(
      (location) => location.id === edit.locationId && location.quantity !== null,
    )
  )
    throw new InputError(
      'Refresh the listing to obtain a known stock quantity for this location.',
      409,
    );
  for (const row of policyRows(state, listing, edit.locationId)) {
    if (row.policy === 'hold' && edit.quantity > 0)
      throw new InputError(
        'This listing is kept out of stock. Change stock policy explicitly before applying positive stock.',
        409,
      );
    if (row.policy === 'limited' && (row.remaining === null || edit.quantity > row.remaining))
      throw new InputError(
        'This quantity exceeds the remaining sales allowance. Change stock policy explicitly first.',
        409,
      );
    if (state.mode === 'live' && row.policy === 'limited' && edit.quantity > 0)
      throw new InputError(
        'Limited sales needs verified order reconciliation before positive stock can be updated. Use zero or explicitly return this listing to automatic policy.',
        409,
      );
  }
}

function expectedListing(listing: MarketplaceListing, edit: MarketplaceEdit): MarketplaceListing {
  const result = structuredClone(listing);
  if (edit.kind === 'stock')
    result.locations.find((location) => location.id === edit.locationId)!.quantity = edit.quantity;
  else result[edit.field] = edit.value;
  if (
    edit.kind === 'price' &&
    (result.mrp === null || result.sellingPrice === null || result.sellingPrice > result.mrp)
  )
    throw new InputError(
      'Use a known selling price no greater than the MRP. Refresh prices before applying.',
      409,
    );
  return result;
}

function matchesEdit(listing: MarketplaceListing, edit: MarketplaceEdit): boolean {
  return edit.kind === 'stock'
    ? listing.locations.find((row) => row.id === edit.locationId)?.quantity === edit.quantity
    : listing[edit.field] === edit.value;
}

function sameBaseline(
  before: MarketplaceListing,
  after: MarketplaceListing,
  edit: MarketplaceEdit,
): boolean {
  if (
    before.productId !== after.productId ||
    before.sku !== after.sku ||
    before.sellerId !== after.sellerId
  )
    return false;
  return edit.kind === 'stock'
    ? before.locations.find((row) => row.id === edit.locationId)?.quantity ===
        after.locations.find((row) => row.id === edit.locationId)?.quantity &&
        before.locations.find((row) => row.id === edit.locationId)?.status ===
          after.locations.find((row) => row.id === edit.locationId)?.status
    : before.mrp === after.mrp && before.sellingPrice === after.sellingPrice;
}

/** Durable attempts never replay an uncertain absolute stock write after a restart. */
export class MarketplacePublication {
  constructor(
    private readonly store: Store,
    private readonly client: ListingTransport,
  ) {}

  private saveObservation(listing: MarketplaceListing): MarketplaceListing {
    return this.store.updateMarketplace((data, state) => {
      const current = findMarketplaceListing(data, listing.accountId, listing.id);
      const updated = { ...listing, version: current.version + 1 };
      data.listings[data.listings.indexOf(current)] = updated;
      updateInventoryObservations(state, updated);
      return updated;
    });
  }

  private finish(
    id: string,
    status: MarketplaceChange['state'],
    message: string,
  ): MarketplaceChange {
    return this.store.updateMarketplace((data, state) => {
      const change = data.changes.find((row) => row.id === id)!;
      change.state = status;
      change.message = message;
      change.updatedAt = new Date().toISOString();
      recordActivity(state, `marketplace-${status}`, `${change.sku}: ${message}`, {
        level: status === 'failed' || status === 'uncertain' ? 'warning' : 'info',
      });
      return { ...change };
    });
  }

  async apply(
    accountId: string,
    input: Record<string, unknown>,
    token: string | null,
  ): Promise<MarketplaceApplyResult> {
    const data = this.store.readMarketplace();
    const listing = findMarketplaceListing(
      data,
      accountId,
      requireText(input.listingId, 'Listing'),
    );
    const version = requireWholeNumber(input.version, 'Listing version');
    if (listing.version !== version || !listing.observedAt)
      throw new InputError('This listing has changed. Refresh and review the current value.', 409);
    const edit = parseEdit(input.edit);
    validateStockPolicy(this.store.read(), listing, edit);
    // A later Apply must not conceal an unconfirmed outcome for this listing.
    if (
      data.changes.some(
        (row) =>
          row.accountId === accountId &&
          row.listingId === listing.id &&
          ['pending', 'sending', 'checking', 'uncertain'].includes(row.state),
      )
    )
      throw new InputError(
        'Check the previous update result before applying another edit to this listing.',
        409,
      );
    const before = token === null ? listing : await this.client.getListing(token, listing);
    if (!sameBaseline(listing, before, edit)) {
      this.saveObservation(before);
      throw new InputError(
        'Flipkart changed since this editor was opened. Refresh and review the latest value.',
        409,
      );
    }
    const expected = expectedListing(before, edit);
    const at = new Date().toISOString();
    const change: MarketplaceChange = {
      id: randomUUID(),
      accountId,
      listingId: listing.id,
      sku: listing.sku,
      edit,
      state: 'pending',
      message: 'Update prepared.',
      createdAt: at,
      updatedAt: at,
    };
    this.store.updateMarketplace((current, state) => {
      const latest = findMarketplaceListing(current, accountId, listing.id);
      if (latest.version !== version)
        throw new InputError('The listing changed. Refresh before applying.', 409);
      validateStockPolicy(state, latest, edit);
      if (edit.kind === 'stock' && edit.automation === 'pause') {
        for (const row of policyRows(state, latest, edit.locationId)) {
          row.paused = true;
          row.version++;
        }
      }
      current.changes.unshift(change);
      recordActivity(
        state,
        'marketplace-apply',
        `${listing.sku}: ${edit.kind} update requested${edit.kind === 'stock' && edit.automation === 'pause' ? '; Tally synchronization paused' : ''}.`,
      );
    });
    this.finish(change.id, 'sending', 'Applying update.');
    try {
      if (token !== null) {
        if (edit.kind === 'stock')
          await this.client.updateStock(token, before, edit.locationId, edit.quantity);
        else await this.client.updatePrice(token, before, expected.mrp!, expected.sellingPrice!);
      }
    } catch (error) {
      if (error instanceof FlipkartListingError && !error.uncertain) {
        const failed = this.finish(change.id, 'failed', error.message);
        return {
          change: failed,
          listing: listingView(
            findMarketplaceListing(this.store.readMarketplace(), accountId, listing.id),
            this.store.read(),
          ),
        };
      }
      this.finish(
        change.id,
        'checking',
        'The submission result is uncertain. Checking current values.',
      );
      return this.observe(change, token, before);
    }
    this.finish(change.id, 'checking', 'Update submitted. Checking current values.');
    return this.observe(change, token, token === null ? expected : before);
  }

  private async observe(
    change: MarketplaceChange,
    token: string | null,
    fallback: MarketplaceListing,
  ): Promise<MarketplaceApplyResult> {
    let confirmed = false;
    try {
      const listing =
        token === null
          ? { ...fallback, observedAt: new Date().toISOString() }
          : await this.client.getListing(token, fallback);
      const matches = matchesEdit(listing, change.edit);
      this.saveObservation(listing);
      confirmed = matches;
    } catch {
      // A read failure cannot prove that the preceding write failed.
    }
    const result = this.finish(
      change.id,
      confirmed ? 'confirmed' : 'uncertain',
      confirmed
        ? token === null
          ? 'Sample value updated. No marketplace was contacted.'
          : 'Updated value confirmed by a fresh Flipkart read.'
        : 'Flipkart has not confirmed this value. Check result before making another change; do not blindly retry.',
    );
    return {
      change: result,
      listing: listingView(
        findMarketplaceListing(this.store.readMarketplace(), change.accountId, change.listingId),
        this.store.read(),
      ),
    };
  }

  async reconcile(
    accountId: string,
    changeId: string,
    token: string | null,
  ): Promise<MarketplaceApplyResult> {
    const data = this.store.readMarketplace();
    const change = data.changes.find((row) => row.accountId === accountId && row.id === changeId);
    if (!change) throw new InputError('Update not found in this account.', 404);
    if (change.state === 'confirmed' || change.state === 'failed')
      return {
        change,
        listing: listingView(
          findMarketplaceListing(data, accountId, change.listingId),
          this.store.read(),
        ),
      };
    return this.observe(change, token, findMarketplaceListing(data, accountId, change.listingId));
  }
}
