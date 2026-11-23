import { randomUUID } from 'node:crypto';
import { hasConfirmedPickup } from './marketplace-catalog.js';
import type { AutomationPreview, AutomationPreviewRow } from '../shared/automation.js';
import type { Listing, Snapshot, StockItem } from '../shared/contracts.js';
import type { MarketplaceListing } from '../shared/marketplace-contracts.js';
import { fingerprint } from './billing-matcher.js';
import type { InventoryIntent } from './inventory-publication.js';
import { automaticRetryAt, blocksListing } from './marketplace-publication.js';
import type { MarketplaceService } from './marketplace-service.js';
import { desiredStock, requireStockSource } from './proposals.js';
import type { MarketplaceData } from './storage/marketplace-records.js';
import type { Store } from './store.js';
import { InputError, requireCompany } from './validation.js';

function waiting(message: string): never {
  throw new InputError(message, 409);
}

function checkLocation(listing: Listing, remote: MarketplaceListing): number | null {
  if (!listing.location) waiting('Choose a pickup location in Edit Set of before publishing.');
  if (listing.packSource === 'packages' && listing.packSize !== remote.packageCount)
    waiting('Review Set of. The Flipkart package count changed or is unavailable.');
  if (remote.status === 'ACTIVE' && hasConfirmedPickup(listing, remote)) return null;
  const locations = remote.locations.filter((location) => location.id === listing.location);
  if (remote.status !== 'ACTIVE' || locations.length !== 1 || locations[0].status !== 'ENABLED')
    waiting('Verify the active Flipkart listing and its enabled stock location.');
  if (locations[0].quantity === null || !remote.observedAt)
    waiting('Refresh Flipkart to verify the stock at this location.');
  return locations[0].quantity;
}

function groupByKey<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

/** One immutable read per pass. Preserve duplicate SKUs and newest-first history. */
export function indexAutomationCatalog(market: MarketplaceData) {
  const sellerKey = (accountId: string, id: string) => JSON.stringify([accountId, id]);
  const listings = groupByKey(market.listings, (row) => sellerKey(row.accountId, row.sku));
  const changes = groupByKey(market.changes, (row) => sellerKey(row.accountId, row.listingId));
  return {
    listingsFor: (row: Listing) => listings.get(sellerKey(row.accountId, row.sku)) ?? [],
    changesFor: (row: MarketplaceListing) => changes.get(sellerKey(row.accountId, row.id)) ?? [],
  };
}

/** Common checks shared by the dashboard and company preview before fresh external reads. */
export function checkAutomationDestination(
  state: Snapshot,
  listing: Listing,
  catalog: ReturnType<typeof indexAutomationCatalog>,
  sellerVerified: boolean,
  item: StockItem,
): MarketplaceListing {
  requireStockSource(state, listing, item);
  if (state.mode === 'live' && listing.sourceScope !== 'company')
    waiting('Confirm which Tally stock supplies this location.');
  if (!sellerVerified) waiting('Refresh the seller account to verify its identity.');
  const matches = catalog.listingsFor(listing);
  if (matches.length !== 1 || !matches[0].observedAt)
    waiting('Refresh the seller account to verify a unique Flipkart listing for this SKU.');
  const remote = matches[0];
  if (
    catalog.changesFor(remote).some((change) => blocksListing(change, remote.accountId, remote.id))
  )
    waiting('Check the previous update result before publishing this listing.');
  checkLocation(listing, remote);
  return remote;
}

function mappedDestinations(state: Snapshot, companyId: string, onlyListingId?: string) {
  const items = new Map(
    state.items.filter((item) => item.companyId === companyId).map((item) => [item.id, item]),
  );
  return state.listings
    .flatMap((listing) => {
      if (onlyListingId && listing.id !== onlyListingId) return [];
      const item = items.get(listing.itemId ?? '');
      return item ? [{ listing, item }] : [];
    })
    .sort((a, b) => a.listing.id.localeCompare(b.listing.id));
}

function inputIsFresh(state: Snapshot, listing: Listing, item: StockItem) {
  try {
    requireStockSource(state, listing, item);
    return true;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    return false;
  }
}

type ReviewedTrial = { intent: InventoryIntent; verify: () => void };
type CheckedPreview = {
  preview: AutomationPreview;
  versions: Map<string, string>;
  trials: Map<string, ReviewedTrial>;
  verifyScope: (listingId?: string) => void;
  verify: () => void;
};

/** Reviews live only for this server session. Either approval consumes its review. */
export class AutomationReviews {
  private readonly sessions = new Map<string, CheckedPreview>();
  private readonly companyRevision = new Map<string, number>();
  constructor(
    private readonly store: Store,
    private readonly market?: MarketplaceService,
  ) {}

  companySettingChanged(companyId: string) {
    this.companyRevision.set(companyId, (this.companyRevision.get(companyId) ?? 0) + 1);
    for (const [id, review] of this.sessions)
      if (review.preview.companyId === companyId) this.sessions.delete(id);
  }

  private capture(companyId: unknown, onlyListingId?: string) {
    const state = this.store.read();
    const company = requireCompany(state, companyId);
    if (company.automation) waiting('Automatic updates are already on. Refresh Inventory.');
    const market = this.store.readMarketplace();
    const catalog = indexAutomationCatalog(market);
    const mappings = mappedDestinations(state, company.id, onlyListingId);
    const versions = new Map(
      mappings.map(({ listing, item }) => {
        const records = catalog.listingsFor(listing);
        return [
          listing.id,
          fingerprint([
            state.settings.tallyUrl,
            company.name,
            company.stockIssue,
            !!company.lastSuccess,
            inputIsFresh(state, listing, item),
            item.id,
            item.externalId,
            item.version,
            item.unit,
            item.physical,
            listing.version,
            listing.accountId,
            listing.sku,
            listing.location,
            listing.packSource,
            listing.packSize,
            listing.packConfirmedAt,
            listing.sourceScope,
            listing.verified,
            listing.tyreFloor,
            listing.paused,
            !!listing.orderProposalPending,
            listing.policy,
            listing.remaining,
            listing.packSource === 'packages' && [listing.packageAvailable, listing.packageCount],
            market.accounts.find((a) => a.id === listing.accountId)?.sellerId,
            this.market?.catalogVerified(listing.accountId),
            records.map((r) => [
              r.id,
              r.productId,
              r.sellerId,
              !!r.observedAt,
              r.status,
              r.locations.find((loc) => loc.id === listing.location),
              catalog
                .changesFor(r)
                .filter((change) => blocksListing(change, r.accountId, r.id))
                .map((c) => c.id),
            ]),
          ]),
        ] as const;
      }),
    );
    return {
      state,
      company,
      catalog,
      mappings,
      versions,
      revision: this.companyRevision.get(company.id),
    };
  }

  private async check(companyId: unknown): Promise<CheckedPreview> {
    const input = this.capture(companyId);
    const rows: AutomationPreviewRow[] = [];
    const trials = new Map<string, ReviewedTrial>();
    const guards = new Set<() => void>();
    const batch = {};
    const remoteReads = new Map<
      string,
      ReturnType<MarketplaceService['observeAutomationListing']>
    >();
    const availableReads = new Map<string, ReturnType<MarketplaceService['availableStock']>>();
    const checkOrders =
      input.state.mode === 'live' || !!this.store.readStockCoverage(input.company.id);
    for (const { listing, item } of input.mappings) {
      const row: AutomationPreviewRow = {
        listingId: listing.id,
        sku: listing.sku,
        location: listing.location,
        itemName: item.name,
        accountId: listing.accountId,
        account:
          input.state.accounts.find((a) => a.id === listing.accountId)?.name ?? listing.accountId,
        observed: listing.observedAt ? listing.observed : null,
        proposed: null,
        status: listing.paused ? 'paused' : 'waiting',
        reason: null,
      };
      rows.push(row);
      if (listing.paused) {
        row.reason = 'Paused by the seller. No automatic update will be sent.';
        continue;
      }
      try {
        if (!this.market)
          waiting('Marketplace stock publication is unavailable in this workspace.');
        const remote = checkAutomationDestination(
          input.state,
          listing,
          input.catalog,
          this.market.catalogVerified(listing.accountId),
          item,
        );
        const key = JSON.stringify([remote.accountId, remote.id]);
        if (!remoteReads.has(key))
          remoteReads.set(key, this.market.observeAutomationListing(remote));
        const { current, verify } = await remoteReads.get(key)!;
        guards.add(verify);
        const observed = checkLocation(listing, current);
        row.observed = observed;
        let quantity = desiredStock(input.state, listing, 'current', undefined, item);
        if (checkOrders && (listing.orderProposalPending || quantity > 0)) {
          if (!availableReads.has(item.id))
            availableReads.set(
              item.id,
              this.market.availableStock(input.company.id, item.id, batch, true),
            );
          const evidence = await availableReads.get(item.id)!;
          guards.add(evidence.verify);
          quantity = desiredStock(input.state, listing, 'current', evidence.available, item);
        }
        if (quantity > 5000 || !Number.isSafeInteger(quantity) || quantity < 0)
          waiting('The calculated stock is outside the allowed range.');
        if (input.state.mode === 'live' && listing.policy === 'limited' && quantity > 0)
          waiting('Positive stock under Limited sales requires verified allowance accounting.');
        if (
          Date.now() <
          automaticRetryAt(input.catalog.changesFor(remote), remote, {
            kind: 'stock',
            locationId: listing.location,
            quantity,
            automation: 'once',
          })
        )
          waiting(
            'A previous stock update was rejected. An upcoming stock check will retry after backoff.',
          );
        row.proposed = quantity;
        row.status = 'ready';
        const intent: InventoryIntent = {
          companyId: input.company.id,
          listingId: listing.id,
          listingVersion: listing.version,
          itemVersion: item.version,
          trial: {
            marketplaceId: current.id,
            productId: current.productId,
            sellerId: current.sellerId,
            location: listing.location,
            observed,
            quantity,
          },
        };
        trials.set(listing.id, { intent, verify });
      } catch (error) {
        row.reason =
          error instanceof InputError
            ? error.message
            : 'Could not verify current stock. Check the seller connection and try again.';
      }
    }
    const verifyScope = (listingId?: string) => {
      const current = this.capture(input.company.id, listingId);
      const changed = listingId
        ? current.versions.get(listingId) !== input.versions.get(listingId)
        : fingerprint([...current.versions]) !== fingerprint([...input.versions]);
      if (current.revision !== input.revision || changed)
        waiting('The company mappings or stock evidence changed. Preview the company again.');
    };
    const verify = () => {
      verifyScope();
      for (const guard of guards) guard();
    };
    verify();
    return {
      preview: {
        id: randomUUID(),
        companyId: input.company.id,
        companyName: input.company.name,
        createdAt: new Date().toISOString(),
        rows,
      },
      versions: input.versions,
      trials,
      verifyScope,
      verify,
    };
  }

  async preview(companyId: unknown): Promise<AutomationPreview> {
    const checked = await this.check(companyId);
    for (const [id, value] of this.sessions)
      if (this.expired(value) || this.sessions.size >= 50) this.sessions.delete(id);
    this.sessions.set(checked.preview.id, checked);
    return checked.preview;
  }

  private expired(value: CheckedPreview) {
    return Date.now() - Date.parse(value.preview.createdAt) >= 120_000;
  }

  private consume(companyId: unknown, id: unknown) {
    const old = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!old || old.preview.companyId !== companyId || this.expired(old))
      waiting('Open a fresh company preview before confirming this action.');
    this.sessions.delete(old.preview.id);
    return old;
  }

  async enable(companyId: unknown, id: unknown, enable: () => Snapshot) {
    const old = this.consume(companyId, id);
    old.verify();
    const current = await this.check(companyId);
    if (
      this.expired(old) ||
      fingerprint(current.preview.rows) !== fingerprint(old.preview.rows) ||
      fingerprint([...current.versions]) !== fingerprint([...old.versions])
    )
      waiting('The company scope or stock changed. Preview the company again before enabling.');
    current.verify();
    return enable();
  }

  async trial(companyId: unknown, id: unknown, listingId: unknown) {
    const old = this.consume(companyId, id);
    const trial = typeof listingId === 'string' && old.trials.get(listingId);
    if (!this.market || !trial) waiting('Choose a ready listing from this company preview.');
    // Publication obtains fresh shared-stock evidence for this item. Other items
    // in the company remain outside the scope of the single approved destination.
    const verifyTrial = () => {
      if (this.expired(old)) waiting('The company preview expired. Review the listing again.');
      old.verifyScope(trial.intent.listingId);
      trial.verify();
    };
    verifyTrial();
    return this.market.publishInventory(trial.intent, undefined, verifyTrial);
  }
}
