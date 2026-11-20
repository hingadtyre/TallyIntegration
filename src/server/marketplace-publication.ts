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
import {
  activateInventoryIntent,
  inventoryTarget,
  type InventoryIntent,
} from './inventory-publication.js';

export type ListingTransport = Pick<
  FlipkartListingsClient,
  'listListings' | 'getListing' | 'updatePrice' | 'updateStock'
>;

type PendingStockSync = {
  listingId: string;
  listingVersion: number;
  itemVersion: number;
  tallyPending: boolean;
  orderPending?: string | null;
};
type InventoryEvidence = { available?: number; verify: () => void };

export function blocksListing(change: MarketplaceChange, accountId: string, listingId: string) {
  return (
    change.accountId === accountId &&
    change.listingId === listingId &&
    ['pending', 'sending', 'checking', 'uncertain'].includes(change.state)
  );
}

export function sameListingIdentity(a: MarketplaceListing, b: MarketplaceListing) {
  return (
    a.accountId === b.accountId &&
    a.id === b.id &&
    a.productId === b.productId &&
    a.sellerId === b.sellerId &&
    a.sku === b.sku
  );
}

export function recoverableStockChange(
  changes: MarketplaceChange[],
  accountId: string,
  id: string,
) {
  const old = changes.find((c) => c.accountId === accountId && c.id === id);
  if (!old || old.edit.kind !== 'stock' || old.state !== 'uncertain')
    throw new InputError('This stock update is no longer awaiting recovery in this account.', 409);
  if (!old.stockRequestFinality)
    throw new InputError(
      'Flipkart has not established whether the earlier request can still take effect. The listing remains blocked; contact seller support with this update’s details.',
      409,
    );
  if (changes.some((c) => c !== old && blocksListing(c, accountId, old.listingId)))
    throw new InputError(
      'Another unresolved update also affects this listing. Check its history before continuing.',
      409,
    );
  return { old, edit: old.edit };
}

function parseEdit(input: unknown): MarketplaceEdit {
  if (!input || typeof input !== 'object') throw new InputError('Choose a stock or price edit.');
  const edit = input as Record<string, unknown>;
  if (edit.kind === 'stock') {
    if (edit.automation !== undefined && edit.automation !== 'once' && edit.automation !== 'pause')
      throw new InputError('Invalid Tally synchronization setting.');
    return {
      kind: 'stock',
      locationId: requireText(edit.locationId, 'Location'),
      quantity: requireWholeNumber(edit.quantity, 'Stock', 0, 5000),
      automation: 'once',
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

export function automaticRetryAt(
  changes: MarketplaceChange[],
  listing: MarketplaceListing,
  edit: MarketplaceEdit,
): number {
  if (edit.kind !== 'stock') return 0;
  let failures = 0;
  let rejectedAt = 0;
  // Newest first. A different target quantity supersedes the rejected one, so
  // a newly required zero never waits for backoff on an earlier positive value.
  for (const change of changes) {
    if (
      change.accountId !== listing.accountId ||
      change.listingId !== listing.id ||
      change.edit.kind !== 'stock' ||
      change.edit.locationId !== edit.locationId
    )
      continue;
    if (change.state !== 'failed' || change.edit.quantity !== edit.quantity) break;
    if (failures === 0) rejectedAt = Date.parse(change.updatedAt);
    if (++failures >= 6) break;
  }
  return failures ? rejectedAt + Math.min(30_000 * 2 ** (failures - 1), 600_000) : 0;
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
    rejectedWork: PendingStockSync[] = [],
    finality?: 'completed',
  ): MarketplaceChange {
    return this.store.updateMarketplace((data, state) => {
      const change = data.changes.find((row) => row.id === id)!;
      change.state = status;
      if (change.edit.kind === 'stock' && status === 'sending') delete change.stockRequestFinality;
      if (change.edit.kind === 'stock' && finality) change.stockRequestFinality = finality;
      change.message = message;
      change.updatedAt = new Date().toISOString();
      for (const work of rejectedWork) {
        // A rejected stock edit cannot supersede work for the same Tally balance.
        // A subsequent mapping, pause or newer balance takes precedence.
        const row = state.listings.find((entry) => entry.id === work.listingId);
        const item = state.items.find((entry) => entry.id === row?.itemId);
        if (
          row &&
          row.version === work.listingVersion &&
          row.verified &&
          !row.paused &&
          item?.version === work.itemVersion &&
          state.companies.some((company) => company.id === item.companyId && company.automation)
        ) {
          // An order can arrive while a full stock increase is in flight.
          // Its reduction-only check cannot replace that rejected Tally work.
          if (work.tallyPending && row.syncPendingItemVersion == null)
            row.syncPendingItemVersion = item.version;
          if (work.orderPending && row.orderSyncPending == null)
            row.orderSyncPending = work.orderPending;
        }
      }
      recordActivity(state, `marketplace-${status}`, `${change.sku}: ${message}`, {
        level: status === 'failed' || status === 'uncertain' ? 'warning' : 'info',
      });
      return { ...change };
    });
  }

  apply(
    accountId: string,
    input: Record<string, unknown>,
    token: string | null,
  ): Promise<MarketplaceApplyResult>;
  apply(
    accountId: string,
    input: Record<string, unknown>,
    token: string | null,
    intent: InventoryIntent,
    evidence?: InventoryEvidence,
  ): Promise<MarketplaceApplyResult | null>;
  async apply(
    accountId: string,
    input: Record<string, unknown>,
    token: string | null,
    intent?: InventoryIntent,
    evidence?: InventoryEvidence,
  ): Promise<MarketplaceApplyResult | null> {
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
    if (!intent) validateStockPolicy(this.store.read(), listing, edit);
    // A later Apply must not conceal an unconfirmed outcome for this listing.
    if (data.changes.some((c) => blocksListing(c, accountId, listing.id)))
      throw new InputError(
        'Check the previous update result before applying another edit to this listing.',
        409,
      );
    const checkBackoff = () => {
      if (Date.now() < automaticRetryAt(data.changes, listing, edit))
        throw new InputError(
          'Flipkart rejected the previous stock update. An upcoming stock check will retry after backoff.',
          409,
        );
    };
    if (intent && !intent.draft && !intent.orderOnly) checkBackoff();
    const before =
      token === null
        ? listing
        : await this.client.getListing(token, listing, { requireCurrentStatus: !!intent });
    if (
      before.id !== listing.id ||
      before.accountId !== accountId ||
      before.sellerId !== listing.sellerId ||
      before.productId !== listing.productId ||
      before.sku !== listing.sku
    )
      throw new InputError(
        'Flipkart returned a different listing identity. Refresh the account.',
        409,
      );
    if (intent) {
      const target = inventoryTarget(this.store.read(), intent, before, evidence?.available);
      if (
        target.listing.packSource === 'packages' &&
        before.packageCount !== target.listing.packSize
      ) {
        this.saveObservation(before);
        throw new InputError(
          'Flipkart package count changed or is unavailable. Review Set of before publishing.',
          409,
        );
      }
      if (
        edit.kind !== 'stock' ||
        (!intent.orderOnly && target.quantity !== edit.quantity) ||
        target.listing.location !== edit.locationId ||
        before.locations.find((l) => l.id === edit.locationId)?.quantity == null
      )
        throw new InputError(
          'The stock target changed or its current quantity is unavailable. Refresh and review.',
          409,
        );
      if (intent.orderOnly) {
        edit.quantity = target.quantity;
        // A read may turn the update into a no-op or change the quantity that
        // would actually be sent. Apply backoff only to that final write.
        if (!matchesEdit(before, edit)) checkBackoff();
      }
    }
    // Verified order-triggered updates can only lower the fresh remote quantity.
    // A sale changing the current stock is expected; a changed destination is not.
    const orderStockDrift =
      intent?.orderOnly &&
      edit.kind === 'stock' &&
      listing.locations.find((loc) => loc.id === edit.locationId)?.status ===
        before.locations.find((loc) => loc.id === edit.locationId)?.status;
    const baselineMatches = intent?.trial
      ? before.locations.find((location) => location.id === intent.trial!.location)?.quantity ===
        intent.trial.observed
      : sameBaseline(listing, before, edit);
    if (!orderStockDrift && !baselineMatches) {
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
      ...(edit.kind === 'stock' && { stockRequestFinality: 'not-sent' as const }),
      message: 'Update prepared.',
      createdAt: at,
      updatedAt: at,
    };
    // The guard reads persisted billing evidence. Run it outside the transaction,
    // with no asynchronous gap before recording a write or consuming a no-op.
    evidence?.verify();
    const consumedWork = this.store.updateMarketplace((current, state) => {
      const latest = findMarketplaceListing(current, accountId, listing.id);
      if (current.changes.some((c) => blocksListing(c, accountId, listing.id)))
        throw new InputError(
          'Check the previous update result before applying another edit to this listing.',
          409,
        );
      if (latest.version !== version)
        throw new InputError('The listing changed. Refresh before applying.', 409);
      const destinations = edit.kind === 'stock' ? policyRows(state, latest, edit.locationId) : [];
      // Older clients sent an automation choice. The mapping at the moment of Apply
      // determines whether this direct edit locks a destination.
      if (!intent && edit.kind === 'stock')
        edit.automation = destinations.some((row) => row.itemId !== null) ? 'pause' : 'once';
      // Capture the automatic work an Inventory publication would supersede. An edited
      // zero also activates a hold that needs correction if Flipkart rejects it.
      const pending =
        intent && edit.kind === 'stock'
          ? destinations.flatMap((row) => {
              const tallyVersion =
                row.syncPendingItemVersion ??
                (intent?.draft?.edited && edit.quantity === 0 ? intent.itemVersion : null);
              const itemVersion =
                tallyVersion ??
                (row.orderSyncPending
                  ? state.items.find((item) => item.id === row.itemId)?.version
                  : null);
              return itemVersion == null
                ? []
                : [
                    {
                      row,
                      itemVersion,
                      tallyPending: tallyVersion != null,
                      orderPending: row.orderSyncPending,
                    },
                  ];
            })
          : [];
      if (intent) {
        const target = inventoryTarget(state, intent, before, evidence?.available);
        if (
          edit.kind !== 'stock' ||
          target.quantity !== edit.quantity ||
          target.listing.location !== edit.locationId
        )
          throw new InputError('The stock target changed. Review the new calculation.', 409);
        activateInventoryIntent(state, intent, target.listing);
        if (matchesEdit(before, edit)) {
          if (intent.orderOnly || intent.trial) {
            const updated = { ...before, version: latest.version + 1 };
            current.listings[current.listings.indexOf(latest)] = updated;
            updateInventoryObservations(state, updated);
          }
          recordActivity(
            state,
            'inventory-confirmed',
            `${listing.sku}: confirmed current stock ${target.quantity}; no write needed.`,
            { companyId: intent.companyId, listingId: intent.listingId },
          );
          return null;
        }
      } else {
        validateStockPolicy(state, latest, edit);
        for (const row of destinations) {
          row.syncPendingItemVersion = null;
          row.orderSyncPending = null;
          if (row.itemId !== null) {
            row.paused = true;
            row.version++;
          }
        }
      }
      current.changes.unshift(change);
      recordActivity(
        state,
        intent ? 'inventory-publish' : 'marketplace-apply',
        `${listing.sku}: ${edit.kind} update requested${edit.kind === 'stock' && edit.automation === 'pause' ? '; Tally synchronization paused' : ''}.`,
      );
      return pending.map(({ row, itemVersion, tallyPending, orderPending }) => ({
        listingId: row.id,
        listingVersion: row.version,
        itemVersion,
        tallyPending,
        orderPending,
      }));
    });
    if (consumedWork === null) return null;
    return this.dispatch(change, token, before, expected, consumedWork);
  }

  private async dispatch(
    change: MarketplaceChange,
    token: string | null,
    before: MarketplaceListing,
    expected: MarketplaceListing,
    consumedWork: PendingStockSync[],
  ) {
    const { accountId, edit } = change;
    this.finish(change.id, 'sending', 'Applying update.');
    try {
      if (token !== null) {
        if (edit.kind === 'stock')
          await this.client.updateStock(token, before, edit.locationId, edit.quantity);
        else await this.client.updatePrice(token, before, expected.mrp!, expected.sellingPrice!);
      }
    } catch (error) {
      if (error instanceof FlipkartListingError && !error.uncertain) {
        const failed = this.finish(change.id, 'failed', error.message, consumedWork);
        return {
          change: failed,
          listing: listingView(
            findMarketplaceListing(this.store.readMarketplace(), accountId, before.id),
            this.store.read(),
          ),
        };
      }
      const checking = this.finish(
        change.id,
        'checking',
        'The submission result is uncertain. Checking current values.',
      );
      return this.observe(checking, token, before);
    }
    // The adapter returns only after validating the SKU's terminal result. Save
    // this before readback, so a lost readback or restart cannot erase the proof.
    const completed = this.finish(
      change.id,
      'checking',
      'Update submitted. Checking current values.',
      [],
      'completed',
    );
    return this.observe(completed, token, token === null ? expected : before);
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
      if (!sameListingIdentity(fallback, listing))
        throw new InputError('The listing identity changed.', 409);
      const matches = matchesEdit(listing, change.edit);
      this.saveObservation(listing);
      confirmed =
        matches && (change.edit.kind !== 'stock' || change.stockRequestFinality === 'completed');
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
        : 'Flipkart has not confirmed the stock or price outcome. Check result before making another change.',
    );
    return {
      change: result,
      listing: listingView(
        findMarketplaceListing(this.store.readMarketplace(), change.accountId, change.listingId),
        this.store.read(),
      ),
    };
  }

  /** Recording the seller's recovery decision and a replacement intention in
   * one transaction prevents a restart from leaving an unprotected destination. */
  async recoverStock(
    accountId: string,
    changeId: string,
    before: MarketplaceListing,
    quantity: number,
    token: string | null,
    verify: () => void,
  ): Promise<MarketplaceApplyResult> {
    verify();
    const decision = this.store.updateMarketplace((data, state) => {
      const { old, edit: original } = recoverableStockChange(data.changes, accountId, changeId);
      const local = findMarketplaceListing(data, accountId, old.listingId);
      if (
        local.version !== before.version ||
        !sameListingIdentity(local, before) ||
        local.sku !== old.sku
      )
        throw new InputError('The listing changed. Review the current stock again.', 409);
      const edit: MarketplaceEdit = {
        kind: 'stock',
        locationId: original.locationId,
        quantity,
        automation: 'once',
      };
      validateStockPolicy(state, before, edit);
      const observed = { ...before, version: local.version + 1 };
      data.listings[data.listings.indexOf(local)] = observed;
      updateInventoryObservations(state, observed);
      const pending: PendingStockSync[] = [];
      for (const row of policyRows(state, observed, edit.locationId)) {
        const item = state.items.find((entry) => entry.id === row.itemId);
        if (item && (row.syncPendingItemVersion != null || row.orderSyncPending))
          pending.push({
            listingId: row.id,
            listingVersion: row.version,
            itemVersion: item.version,
            tallyPending: row.syncPendingItemVersion != null,
            orderPending: row.orderSyncPending,
          });
        row.syncPendingItemVersion = null;
        row.orderSyncPending = null;
      }
      const at = new Date().toISOString();
      const same = matchesEdit(before, edit);
      old.state = 'reconciled';
      old.updatedAt = at;
      const outcome =
        old.stockRequestFinality === 'not-sent'
          ? 'The earlier request was never sent.'
          : 'The earlier request finished; its stock outcome was not verified.';
      old.message =
        outcome +
        ' ' +
        (same
          ? `The seller verified current stock ${quantity}. No new update was needed.`
          : `The seller approved a separate stock update of ${quantity}.`);
      recordActivity(state, 'stock-recovery', old.sku + ': ' + old.message);
      if (same) return { original: old, replacement: null, observed, pending };
      const replacement: MarketplaceChange = {
        id: randomUUID(),
        accountId,
        listingId: local.id,
        sku: local.sku,
        edit,
        state: 'pending',
        stockRequestFinality: 'not-sent',
        message: `Fresh stock approved after reviewing update ${old.id}.`,
        createdAt: at,
        updatedAt: at,
      };
      data.changes.unshift(replacement);
      return { original: old, replacement, observed, pending };
    });
    if (!decision.replacement)
      return {
        change: decision.original,
        listing: listingView(decision.observed, this.store.read()),
      };
    return this.dispatch(
      decision.replacement,
      token,
      decision.observed,
      expectedListing(decision.observed, decision.replacement.edit),
      decision.pending,
    );
  }

  async reconcile(
    accountId: string,
    changeId: string,
    token: string | null,
  ): Promise<MarketplaceApplyResult> {
    const data = this.store.readMarketplace();
    const change = data.changes.find((row) => row.accountId === accountId && row.id === changeId);
    if (!change) throw new InputError('Update not found in this account.', 404);
    if (change.state === 'confirmed' || change.state === 'failed' || change.state === 'reconciled')
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
