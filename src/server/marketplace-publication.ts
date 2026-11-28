import { randomUUID } from 'node:crypto';
import {
  FlipkartListingError,
  type FlipkartListingsClient,
} from '../adapters/flipkart-listings.js';
import type { Snapshot } from '../shared/contracts.js';
import {
  isKnownMarketplaceLocationStatus,
  marketplaceEditLimits,
  type MarketplaceApplyResult,
  type MarketplaceChange,
  type MarketplaceEdit,
  type MarketplaceListing,
} from '../shared/marketplace-contracts.js';
import { marketplaceName } from '../shared/marketplaces.js';
import { recordActivity } from './activity.js';
import {
  checkManualKeepBack,
  keepBackSource,
  type CheckedAvailability,
} from './marketplace-keep-back.js';
import {
  findMarketplaceListing,
  hasConfirmedPickup,
  listingView,
  updateInventoryObservations,
} from './marketplace-catalog.js';
import type { Store } from './store.js';
import { isStaleProposal, prepareProposal } from './proposals.js';
import { InputError, requireText, requireWholeNumber } from './validation.js';
import {
  activateInventoryIntent,
  inventoryTarget,
  type InventoryIntent,
} from './inventory-publication.js';

function publicationDestination(state: Snapshot, change: MarketplaceChange) {
  const seller = state.accounts.find((account) => account.id === change.accountId);
  return [
    marketplaceName(seller?.marketplace),
    seller?.name ?? change.accountId,
    change.sku,
    change.edit.kind === 'stock' ? change.edit.locationId : undefined,
  ]
    .filter(Boolean)
    .join(' - ');
}

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
type PublicationEvidence = {
  available?: number;
  verify: () => void;
  keepBack?: Awaited<ReturnType<typeof checkManualKeepBack>>;
};
type RecheckedQuantity = { latestQuantity: number; alreadyCurrent: boolean };
type ReviewedResume = { intent: InventoryIntent; evidence?: PublicationEvidence };

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
      'The marketplace has not established whether the earlier request can still take effect. The listing remains blocked; contact seller support with this update’s details.',
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
      quantity: requireWholeNumber(
        edit.quantity,
        'Stock',
        marketplaceEditLimits.stock.min,
        marketplaceEditLimits.stock.max,
      ),
      automation: 'once',
    };
  }
  if (edit.kind === 'price' && (edit.field === 'mrp' || edit.field === 'sellingPrice'))
    return {
      kind: 'price',
      field: edit.field,
      value: requireWholeNumber(
        edit.value,
        'Price',
        marketplaceEditLimits.price.min,
        marketplaceEditLimits.price.max,
      ),
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
  const location = listing.locations.find((row) => row.id === edit.locationId);
  if (!location || location.quantity === null)
    throw new InputError(
      'Refresh the listing to obtain a known stock quantity for this location.',
      409,
    );
  if (!isKnownMarketplaceLocationStatus(location.status))
    throw new InputError('Refresh the listing to verify this stock location’s status.', 409);
  for (const row of policyRows(state, listing, edit.locationId)) {
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
  if (edit.kind === 'stock') {
    const location = result.locations.find((location) => location.id === edit.locationId);
    if (location) location.quantity = edit.quantity;
    else result.locations.push({ id: edit.locationId, status: 'ENABLED', quantity: edit.quantity });
  } else result[edit.field] = edit.value;
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
  private readonly observationRevisions = new Map<string, number>();

  /** Called after a successful transaction, only for numeric observation changes. */
  recordQuantityChanges(ids: string[]) {
    for (const id of ids)
      this.observationRevisions.set(id, (this.observationRevisions.get(id) ?? 0) + 1);
  }

  setupVersion(listing: { id: string; version: number }) {
    return listing.version - (this.observationRevisions.get(listing.id) ?? 0);
  }

  constructor(
    private readonly store: Store,
    private readonly client: ListingTransport,
    private readonly availableStock?: CheckedAvailability,
  ) {}

  checkKeepBack(accountId: string, input: Record<string, unknown>) {
    const listing = findMarketplaceListing(
      this.store.readMarketplace(),
      accountId,
      requireText(input.listingId, 'Listing'),
    );
    const location = requireText(input.locationId, 'Location');
    const state = this.store.read();
    if (!keepBackSource(state, listing, location)) return null;
    if (
      listing.version !== input.version ||
      !listing.locations.some((entry) => entry.id === location)
    )
      throw new InputError(
        'This listing has changed. Refresh the seller’s listings and reopen this stock editor.',
        409,
      );
    return checkManualKeepBack(state, listing, location, this.availableStock);
  }

  checkDirectEdit(accountId: string, input: Record<string, unknown>) {
    const edit = parseEdit(input.edit);
    if (edit.kind !== 'stock' || edit.quantity === 0) return null;
    return this.checkKeepBack(accountId, { ...input, locationId: edit.locationId });
  }

  private saveObservation(listing: MarketplaceListing, resume?: ReviewedResume): boolean {
    const quantityChanges: string[] = [];
    const resumed = this.store.updateMarketplace((data, state) => {
      const current = findMarketplaceListing(data, listing.accountId, listing.id);
      let resumed = false;
      if (resume) {
        // Check the saved draft and destination in the same transaction that resumes it.
        // Validate against the version before recording our own numeric observation.
        try {
          const target = inventoryTarget(state, resume.intent, listing, resume.evidence?.available);
          if (
            target.quantity === resume.intent.draft?.quantity &&
            (target.listing.packSource !== 'packages' ||
              listing.packageCount === target.listing.packSize)
          ) {
            activateInventoryIntent(state, resume.intent, target.listing);
            resumed = true;
          }
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
        }
      }
      const updated = { ...listing, version: current.version + 1 };
      data.listings[data.listings.indexOf(current)] = updated;
      updateInventoryObservations(state, updated, quantityChanges);
      return resumed;
    });
    this.recordQuantityChanges(quantityChanges);
    return resumed;
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
      recordActivity(
        state,
        `marketplace-${status}`,
        `${publicationDestination(state, change)}: ${message}`,
        {
          level: status === 'failed' || status === 'uncertain' ? 'warning' : 'info',
        },
      );
      return { ...change };
    });
  }

  apply(
    accountId: string,
    input: Record<string, unknown>,
    token: string | null,
    intent?: undefined,
    evidence?: PublicationEvidence,
  ): Promise<MarketplaceApplyResult>;
  apply(
    accountId: string,
    input: Record<string, unknown>,
    token: string | null,
    intent: InventoryIntent & { calculatedReview?: undefined },
    evidence?: PublicationEvidence,
  ): Promise<MarketplaceApplyResult | null>;
  apply(
    accountId: string,
    input: Record<string, unknown>,
    token: string | null,
    intent: InventoryIntent,
    evidence?: PublicationEvidence,
  ): Promise<MarketplaceApplyResult | RecheckedQuantity | null>;
  async apply(
    accountId: string,
    input: Record<string, unknown>,
    token: string | null,
    intent?: InventoryIntent,
    evidence?: PublicationEvidence,
  ): Promise<MarketplaceApplyResult | RecheckedQuantity | null> {
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
    const requestId = input.requestId;
    if (
      requestId !== undefined &&
      (typeof requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId))
    )
      throw new InputError('Invalid marketplace request ID.');
    // A later Apply must not conceal an unconfirmed outcome for this listing.
    if (data.changes.some((c) => blocksListing(c, accountId, listing.id)))
      throw new InputError(
        'Check the previous update result before applying another edit to this listing.',
        409,
      );
    const checkBackoff = () => {
      if (Date.now() < automaticRetryAt(data.changes, listing, edit))
        throw new InputError(
          'The marketplace rejected the previous stock update. An upcoming stock check will retry after backoff.',
          409,
        );
    };
    if (intent && !intent.draft && !intent.orderOnly) checkBackoff();
    // Check orders and bills first. The final remote stock read must still catch
    // a sale that arrived while the seller's keep-back was being checked.
    const manualPositive =
      (!intent || intent.draft?.edited) && edit.kind === 'stock' && edit.quantity > 0;
    const keepBack =
      manualPositive && evidence?.keepBack === undefined
        ? await checkManualKeepBack(
            this.store.read(),
            listing,
            edit.locationId,
            this.availableStock,
          )
        : evidence?.keepBack;
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
        'The marketplace returned a different listing identity. Refresh the account.',
        409,
      );
    let firstPickupWrite = false;
    if (intent) {
      const target = inventoryTarget(this.store.read(), intent, before, evidence?.available);
      firstPickupWrite = hasConfirmedPickup(target.listing, before);
      if (
        target.listing.packSource === 'packages' &&
        before.packageCount !== target.listing.packSize
      ) {
        this.saveObservation(before);
        throw new InputError(
          'Reported package count changed or is unavailable. Review Set of before publishing.',
          409,
        );
      }
      if (
        edit.kind !== 'stock' ||
        (!intent.orderOnly && target.quantity !== edit.quantity) ||
        target.listing.location !== edit.locationId ||
        (!firstPickupWrite &&
          before.locations.find((l) => l.id === edit.locationId)?.quantity == null)
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
      ? (before.locations.find((location) => location.id === intent.trial!.location)?.quantity ??
          null) === intent.trial.observed
      : sameBaseline(listing, before, edit);
    const calculatedReview = intent?.calculatedReview;
    const remoteQuantity =
      edit.kind === 'stock'
        ? (before.locations.find((location) => location.id === edit.locationId)?.quantity ?? null)
        : null;
    const reviewedBaselineChanged =
      calculatedReview &&
      (calculatedReview.observed !== remoteQuantity ||
        intent.draft?.listingVersion !== intent.listingVersion);
    const quantityChanged =
      calculatedReview && edit.kind === 'stock' && intent.draft?.quantity !== edit.quantity;
    const alreadyCurrent = !!intent?.draft && matchesEdit(before, edit);
    const resume =
      calculatedReview && intent.draft?.resumeOnPublish ? { intent, evidence } : undefined;
    if (
      !orderStockDrift &&
      !alreadyCurrent &&
      !quantityChanged &&
      (!baselineMatches || reviewedBaselineChanged)
    ) {
      this.saveObservation(before);
      throw new InputError(
        'The listing changed since this editor was opened. Refresh and review the latest value.',
        409,
      );
    }
    if (keepBack?.usesPackageCount && listing.packageCount !== before.packageCount) {
      this.saveObservation(before);
      throw new InputError(
        'The reported package count changed. Refresh the listing and review its Set of before applying.',
        409,
      );
    }
    if (
      keepBack &&
      edit.kind === 'stock' &&
      (keepBack.review.completePacks === null || edit.quantity > keepBack.review.completePacks)
    ) {
      const confirmation = intent?.keepBackConfirmation ?? input.keepBackConfirmation;
      if (
        !confirmation ||
        typeof confirmation !== 'object' ||
        !('reviewKey' in confirmation) ||
        confirmation.reviewKey !== keepBack.review.reviewKey ||
        !('quantity' in confirmation) ||
        confirmation.quantity !== edit.quantity
      )
        throw new InputError(
          'Review the current Keep back from marketplaces warning and confirm this quantity before applying.',
          409,
        );
    }
    const expected = expectedListing(before, edit);
    const at = new Date().toISOString();
    const change: MarketplaceChange = {
      id: requestId ?? randomUUID(),
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
    keepBack?.verify?.();
    const quantityChanges: string[] = [];
    const consumedWork = this.store.updateMarketplace((current, state) => {
      const latest = findMarketplaceListing(current, accountId, listing.id);
      if (current.changes.some((attempt) => attempt.id === change.id))
        throw new InputError('This update was already recorded. Reload its saved result.', 409);
      if (current.changes.some((c) => blocksListing(c, accountId, listing.id)))
        throw new InputError(
          'Check the previous update result before applying another edit to this listing.',
          409,
        );
      if (latest.version !== version)
        throw new InputError('The listing changed. Refresh before applying.', 409);
      const destinations = edit.kind === 'stock' ? policyRows(state, latest, edit.locationId) : [];
      if (
        manualPositive &&
        edit.kind === 'stock' &&
        keepBackSource(state, latest, edit.locationId)?.version !== keepBack?.version
      )
        throw new InputError(
          'The keep-back setting or stock mapping changed. Review the current stock before applying.',
          409,
        );
      // Older clients sent an automation choice. The mapping at the moment of Apply
      // determines whether this direct edit locks a destination.
      if (!intent && edit.kind === 'stock')
        edit.automation = destinations.some((row) => row.itemId !== null) ? 'pause' : 'once';
      if (intent?.draft?.edited && edit.kind === 'stock') edit.automation = 'pause';
      // Only an unlocked Inventory publication can leave automatic work to retry.
      const pending =
        intent && edit.kind === 'stock' && edit.automation !== 'pause'
          ? destinations.flatMap((row) => {
              const tallyVersion = row.syncPendingItemVersion;
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
        const saved =
          calculatedReview && state.proposals.find((row) => row.listingId === intent.listingId);
        const newerWork =
          saved &&
          (reviewedBaselineChanged ||
            saved.createdAt !== intent.draft?.createdAt ||
            intent.itemVersion !== intent.draft?.itemVersion ||
            saved.stale ||
            (target.listing.syncPendingItemVersion != null &&
              target.listing.syncPendingItemVersion !== calculatedReview.syncPendingItemVersion) ||
            (target.listing.orderSyncPending != null &&
              target.listing.orderSyncPending !== calculatedReview.orderSyncPending));
        if (saved && (quantityChanged || (alreadyCurrent && newerWork && !resume))) {
          // Refresh the saved calculation only. This review cannot consume a newer sync
          // marker or authorize dispatch of any quantity the seller has not seen.
          if (!sameBaseline(latest, before, edit)) {
            const updated = { ...before, version: latest.version + 1 };
            current.listings[current.listings.indexOf(latest)] = updated;
            updateInventoryObservations(state, updated, quantityChanges);
          }
          if (saved.quantity !== target.quantity || isStaleProposal(state, saved))
            Object.assign(
              saved,
              prepareProposal(state, target.listing, undefined, evidence?.available),
            );
          delete target.listing.proposalIssue;
          return { latestQuantity: target.quantity, alreadyCurrent: alreadyCurrent && !resume };
        }
        const matched = matchesEdit(before, edit);
        // A resumable draft and its pause stay in place across the remote write,
        // including timeouts and restarts. A fresh confirmation consumes both.
        if (!resume || matched) activateInventoryIntent(state, intent, target.listing);
        if (matched) {
          if (intent.orderOnly || intent.trial || !sameBaseline(latest, before, edit)) {
            const updated = { ...before, version: latest.version + 1 };
            current.listings[current.listings.indexOf(latest)] = updated;
            updateInventoryObservations(state, updated, quantityChanges);
          }
          recordActivity(
            state,
            'inventory-confirmed',
            `${publicationDestination(state, change)}: confirmed current stock ${target.quantity}; no write needed.`,
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
            delete row.proposalIssue;
            row.version++;
          }
        }
        if (edit.kind === 'stock' && edit.quantity === 0 && matchesEdit(before, edit)) {
          const observed = { ...before, version: latest.version + 1 };
          current.listings[current.listings.indexOf(latest)] = observed;
          updateInventoryObservations(state, observed);
          change.state = 'confirmed';
          delete change.stockRequestFinality;
          change.message =
            edit.automation === 'pause'
              ? 'Stock is already zero. Tally sync paused for this location.'
              : 'Stock is already zero.';
          current.changes.unshift(change);
          recordActivity(
            state,
            'marketplace-confirmed',
            `${publicationDestination(state, change)}: ${change.message}`,
          );
          return null;
        }
      }
      current.changes.unshift(change);
      recordActivity(
        state,
        intent ? 'inventory-publish' : 'marketplace-apply',
        `${publicationDestination(state, change)}: ${edit.kind} update requested${edit.kind === 'stock' && edit.automation === 'pause' ? '; Tally synchronization paused' : ''}.`,
      );
      return pending.map(({ row, itemVersion, tallyPending, orderPending }) => ({
        listingId: row.id,
        listingVersion: row.version,
        itemVersion,
        tallyPending,
        orderPending,
      }));
    });
    this.recordQuantityChanges(quantityChanges);
    if (consumedWork === null) {
      if (intent) return null;
      return {
        change,
        listing: listingView(
          findMarketplaceListing(this.store.readMarketplace(), accountId, listing.id),
          this.store.read(),
        ),
      };
    }
    if ('latestQuantity' in consumedWork) return consumedWork;
    return this.dispatch(change, token, before, expected, consumedWork, firstPickupWrite, resume);
  }

  private async dispatch(
    change: MarketplaceChange,
    token: string | null,
    before: MarketplaceListing,
    expected: MarketplaceListing,
    consumedWork: PendingStockSync[],
    firstPickupWrite = false,
    resume?: ReviewedResume,
  ) {
    const { accountId, edit } = change;
    this.finish(change.id, 'sending', 'Applying update.');
    try {
      if (token !== null) {
        if (edit.kind === 'stock')
          await this.client.updateStock(
            token,
            before,
            edit.locationId,
            edit.quantity,
            firstPickupWrite,
          );
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
    return this.observe(completed, token, token === null ? expected : before, resume);
  }

  private async observe(
    change: MarketplaceChange,
    token: string | null,
    fallback: MarketplaceListing,
    resume?: ReviewedResume,
  ): Promise<MarketplaceApplyResult> {
    let confirmed = false;
    let resumeMessage = '';
    try {
      const listing =
        token === null
          ? { ...fallback, observedAt: new Date().toISOString() }
          : await this.client.getListing(token, fallback, { requireCurrentStatus: !!resume });
      if (!sameListingIdentity(fallback, listing))
        throw new InputError('The listing identity changed.', 409);
      const matches = matchesEdit(listing, change.edit);
      const verified =
        matches && (change.edit.kind !== 'stock' || change.stockRequestFinality === 'completed');
      let eligibleResume = verified ? resume : undefined;
      try {
        eligibleResume?.evidence?.verify();
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        eligibleResume = undefined;
      }
      const resumed = this.saveObservation(listing, eligibleResume);
      if (verified && resume)
        resumeMessage = resumed
          ? ' Tally sync resumed for this location.'
          : ' The review changed during publication. Its requested sync change was skipped.';
      confirmed = verified;
    } catch {
      // A read failure cannot prove that the preceding write failed.
    }
    const result = this.finish(
      change.id,
      confirmed ? 'confirmed' : 'uncertain',
      confirmed
        ? (token === null
            ? 'Sample value updated. No marketplace was contacted.'
            : 'Updated value confirmed by a fresh listing check.') + resumeMessage
        : 'The marketplace has not confirmed the stock or price outcome. Check result before making another change.',
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
      recordActivity(
        state,
        'stock-recovery',
        publicationDestination(state, old) + ': ' + old.message,
      );
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
