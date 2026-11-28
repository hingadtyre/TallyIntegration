import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { TallyClient } from '../adapters/tally.js';
import { availableForMarketplaces } from '../domain/stock-policy.js';
import { billingOnlyMapping } from '../shared/contracts.js';
import { draftStockLimitIssue } from '../shared/marketplace-contracts.js';
import type {
  Activity,
  CalculationResult,
  Listing,
  InventoryPublishResult,
  InventoryPublishRow,
  InventoryRefreshResult,
  Proposal,
  Review,
  Snapshot,
} from '../shared/contracts.js';
import type { MarketplaceService } from './marketplace-service.js';
import { isVerifiedSale } from '../shared/stock-coverage.js';
import { coverageIssue } from './stock-availability.js';
import { checkManualKeepBack } from './marketplace-keep-back.js';
import { pickupChoices, verifyOrderMapping } from './marketplace-catalog.js';
import { checkCalculationStock, proposalInputs, saveCalculation } from './inventory-calculation.js';
import { inventoryTarget, type CalculatedReview } from './inventory-publication.js';
import { AutomationReviews, indexAutomationCatalog } from './automation-preview.js';
import { recordActivity } from './activity.js';
import { createBackup } from './backups.js';
import { Diagnostics } from './diagnostics.js';
import { PollingLoop, type PollingTimers } from './polling.js';
import {
  describeReviewPolicy,
  desiredStock,
  isStaleProposal,
  prepareProposal,
  requireStockSource,
} from './proposals.js';
import { saveSettings } from './settings.js';
import { StockRefresh, type TallyReaderFactory } from './stock-refresh.js';
import { stockConfiguration } from './stock-configuration.js';
import type { Store } from './store.js';
import {
  hasCurrentTallyObservation,
  InputError,
  requireCompany,
  requireListings,
  requireWholeNumber,
} from './validation.js';

export { InputError } from './validation.js';

interface InventoryDependencies {
  marketplaces?: MarketplaceService;
  diagnostics?: Diagnostics;
  createTallyReader?: TallyReaderFactory;
  timers?: PollingTimers;
}

interface StockPass {
  ordersChecked: number;
  orderFailures: number;
  updates: Map<string, InventoryPublishRow>;
}

function describeStockPass(pass: StockPass) {
  const messages = [];
  if (pass.orderFailures) messages.push('Marketplace order check incomplete. See Activity.');
  else if (pass.ordersChecked) messages.push('Checked marketplace orders for stock reservations.');
  else messages.push('Order tracking for stock is off.');

  const rows = [...pass.updates.values()];
  const confirmed = rows.filter((row) => row.status === 'confirmed').length;
  const unchanged = rows.filter((row) => row.status === 'unchanged').length;
  const attention = rows.length - confirmed - unchanged;
  if (confirmed)
    messages.push(
      `${confirmed} stock ${confirmed === 1 ? 'update confirmed' : 'updates confirmed'}.`,
    );
  if (unchanged) messages.push(`${unchanged} already at the calculated stock.`);
  if (attention)
    messages.push(
      `${attention} stock ${attention === 1 ? 'update needs' : 'updates need'} attention. See Activity.`,
    );
  if (!rows.length) messages.push('No eligible stock updates were queued.');
  return { message: messages.join(' '), partial: pass.orderFailures > 0 || attention > 0 };
}

/** Application commands own inventory transactions; collaborators own external work. */
export class InventoryService {
  readonly diagnostics: Diagnostics;
  private readonly stockRefresh: StockRefresh;
  private readonly inventoryRefreshes = new Set<Promise<InventoryRefreshResult>>();
  private readonly polling: PollingLoop;
  private readonly catalogPolling: PollingLoop;
  private readonly orderPolling: PollingLoop;
  private readonly draftPolling: PollingLoop;
  private readonly draftClock: () => number;
  private readonly blockedDrafts = new Map<string, { inputs: string; retryAt: number }>();
  private readonly publishingBatches = new WeakSet<object>();
  private readonly pendingOrderWakes = new Map<string, object | undefined>();
  private orderWake: Promise<void> | null = null;
  private unsubscribeOrders?: () => void;
  private readonly marketplaces?: MarketplaceService;
  readonly automationReviews: AutomationReviews;
  private readonly reviews = new Map<
    string,
    {
      review: Review;
      drafts: Proposal[];
      calculated: Map<string, CalculatedReview>;
    }
  >();

  constructor(
    readonly store: Store,
    dependencies: InventoryDependencies = {},
  ) {
    this.diagnostics =
      dependencies.diagnostics ?? new Diagnostics(join(dirname(store.file), 'diagnostics.ndjson'));
    this.marketplaces = dependencies.marketplaces;
    this.draftClock = () => dependencies.timers?.now() ?? Date.now();
    this.automationReviews = new AutomationReviews(store, this.marketplaces);
    const createReader =
      dependencies.createTallyReader ?? ((endpoint) => new TallyClient(endpoint));
    this.stockRefresh = new StockRefresh(store, createReader, this.diagnostics);
    this.polling = new PollingLoop({
      task: () => this.refreshAndSync(),
      intervalMilliseconds: () => store.read().settings.tallySeconds * 1000,
      enabled: () => store.read().mode === 'live',
      nextRunChanged: (nextPoll) =>
        store.update((state) => {
          state.connection.nextPoll = nextPoll;
        }),
      unexpectedError: (error) => this.diagnostics.error('scheduler', error),
      timers: dependencies.timers,
    });
    this.catalogPolling = new PollingLoop({
      task: () => this.marketplaces?.refreshInventoryAccounts() ?? Promise.resolve(true),
      intervalMilliseconds: () => store.read().settings.catalogSeconds * 1000,
      enabled: () => !!this.marketplaces && store.read().mode === 'live',
      nextRunChanged: () => {},
      unexpectedError: (error) => this.diagnostics.error('catalog-refresh', error),
      timers: dependencies.timers,
    });
    this.orderPolling = new PollingLoop({
      task: async () => (await this.syncPending(undefined, true)).orderFailures === 0,
      intervalMilliseconds: () => store.read().settings.marketplaceSeconds * 1000,
      enabled: () => !!this.marketplaces && store.read().mode === 'live',
      nextRunChanged: () => {},
      unexpectedError: (error) => this.diagnostics.error('order-sync', error),
      timers: dependencies.timers,
    });
    this.draftPolling = new PollingLoop({
      task: () => this.refreshStaleDrafts(this.draftClock()),
      intervalMilliseconds: () => 15_000,
      enabled: () => true,
      nextRunChanged: () => {},
      unexpectedError: (error) => this.diagnostics.error('draft-refresh', error),
      timers: dependencies.timers,
    });
  }

  snapshot(): Snapshot {
    const state = this.store.read();
    state.publishingEnabled = !!this.marketplaces;
    const market = this.store.readMarketplace();
    const catalog = indexAutomationCatalog(market);
    for (const row of state.listings) {
      const matches = catalog.listingsFor(row);
      if (matches.length !== 1) continue;
      const [listing] = matches;
      if (!listing.observedAt) continue;
      if (row.skuMappingId === listing.id && (!row.location || !listing.locations.length)) {
        if (!row.location) row.pickupChoices = pickupChoices(market.listings, listing);
      } else if (
        !row.observedAt ||
        !listing.locations.some((location) => location.id === row.location)
      ) {
        continue;
      }
      row.productId = listing.productId;
      row.marketplaceListingId = listing.id;
      if (state.mode === 'live' && listing.productUrl) row.productUrl = listing.productUrl;
    }
    this.marketplaces?.describeAutomation(state, market, state.listings, catalog);
    for (const company of state.companies) {
      const from = this.store.readStockTrackingStart(company.id);
      if (from) company.stockTrackingFrom = from;
    }
    if (state.mode === 'live') {
      const visibleAccounts = new Set(market.accounts.map((account) => account.id));
      // Older releases saved a placeholder seller before any account was added.
      // Hide unused records from the selector without deleting names or history.
      for (const listing of state.listings) visibleAccounts.add(listing.accountId);
      state.accounts = state.accounts.filter((account) => visibleAccounts.has(account.id));
    }
    state.proposals.forEach((draft) => {
      draft.stale = isStaleProposal(state, draft);
    });
    return state;
  }

  log(
    operation: string,
    message: string,
    level: Activity['level'] = 'info',
    requestId?: string,
  ): void {
    this.diagnostics.write(operation, message, level, requestId);
  }

  logs(): string {
    return this.diagnostics.read();
  }

  calculate(companyId: unknown, ids: unknown, zero = false): Snapshot {
    const state = this.store.read();
    const selected = requireListings(state, companyId, ids);
    saveCalculation(this.store, state, String(companyId), selected, {
      zero,
      strict: zero || selected.length === 1,
    });
    if (zero) for (const row of selected) this.marketplaces?.supersedeInventoryReview(row.id);
    return this.snapshot();
  }

  async calculateAvailable(
    companyId: unknown,
    ids: unknown,
    readOnly = false,
  ): Promise<CalculationResult> {
    const state = this.store.read();
    const selected = requireListings(state, companyId, ids);
    const calculation = await this.calculateListings(state, String(companyId), selected, {
      readOnly,
    });
    return { ...this.snapshot(), calculation };
  }

  private async calculateListings(
    state: Snapshot,
    companyId: string,
    selected: Listing[],
    options: { readOnly: boolean; refreshStale?: boolean },
  ) {
    const batch = {};
    const marketplaces = this.marketplaces;
    const sources =
      marketplaces && this.store.readStockCoverage(companyId)
        ? await checkCalculationStock(state, selected, (itemId) =>
            marketplaces.availableStock(companyId, itemId, batch, options.readOnly),
          )
        : undefined;
    return saveCalculation(this.store, state, companyId, selected, {
      sources,
      refreshStale: options.refreshStale,
    });
  }

  /** Refresh saved calculations, including paused destinations and companies with sync off. */
  private async refreshStaleDrafts(now: number): Promise<boolean> {
    const state = this.store.read();
    const stale = new Set(
      state.proposals
        .filter((draft) => !draft.edited && isStaleProposal(state, draft))
        .map((draft) => draft.listingId),
    );
    for (const row of state.listings) {
      if (row.orderProposalPending) stale.add(row.id);
    }
    for (const id of this.blockedDrafts.keys()) {
      if (!stale.has(id)) this.blockedDrafts.delete(id);
    }
    if (!stale.size) return true;
    const companies = new Map(state.items.map((item) => [item.id, item.companyId]));
    for (const company of state.companies) {
      const selected = state.listings.filter((row) => {
        if (!stale.has(row.id) || !row.itemId || companies.get(row.itemId) !== company.id)
          return false;
        const block = this.blockedDrafts.get(row.id);
        return !block || now >= block.retryAt || block.inputs !== proposalInputs(state, row);
      });
      if (!selected.length) continue;
      await this.refreshListingDrafts(state, company.id, selected, now);
    }
    return true;
  }

  private async refreshListingDrafts(
    state: Snapshot,
    companyId: string,
    selected: Listing[],
    now: number,
  ) {
    const rows = await this.calculateListings(state, companyId, selected, {
      readOnly: true,
      refreshStale: true,
    });
    for (const row of rows) {
      if (row.status === 'blocked') {
        const listing = selected.find((listing) => listing.id === row.listingId)!;
        this.blockedDrafts.set(row.listingId, {
          inputs: proposalInputs(state, listing),
          retryAt: now + 120_000,
        });
      } else {
        this.blockedDrafts.delete(row.listingId);
      }
    }
  }

  edit(
    companyId: unknown,
    listingId: unknown,
    value: unknown,
    listingVersion?: unknown,
    previousManualQuantity?: unknown,
  ): Snapshot {
    this.store.update((state) => {
      const listing = requireListings(state, companyId, [listingId])[0];
      if (listingVersion !== undefined && listing.version !== listingVersion)
        throw new InputError(
          'The listing changed. Review the current mapping and re-enter your draft.',
          409,
        );
      const quantity = requireWholeNumber(value, 'Proposed quantity');
      if (previousManualQuantity !== undefined) {
        const saved = state.proposals.find(
          (proposal) => proposal.listingId === listing.id && proposal.edited,
        );
        if (previousManualQuantity !== (saved?.quantity ?? null))
          throw new InputError(
            'The saved draft changed. Check the latest draft before entering a quantity.',
            409,
          );
      }
      if (quantity > desiredStock(state, listing, 'manual-ceiling')) {
        throw new InputError(
          'Proposed stock exceeds the normal calculation for the available complete packs.',
        );
      }
      const draft = prepareProposal(state, listing, quantity);
      if (!listing.orderProposalPending) delete listing.proposalIssue;
      state.proposals = [...state.proposals.filter((row) => row.listingId !== listing.id), draft];
      const intent =
        quantity === 0 ? 'review zero and pause Tally sync' : `review ${quantity} listing units`;
      recordActivity(state, 'edit-proposal', `Draft saved: ${intent}. Active policy unchanged.`, {
        companyId: String(companyId),
        listingId: listing.id,
      });
    });
    this.marketplaces?.supersedeInventoryReview(String(listingId));
    return this.snapshot();
  }

  async inventoryReservations(companyId: unknown) {
    const company = requireCompany(this.store.read(), companyId);
    if (!this.marketplaces || company.stockIssue)
      throw new InputError('Reservation check needed.', 409);
    return this.marketplaces.inventoryReservations(company.id);
  }

  async previewKeepBack(companyId: unknown, itemId: unknown) {
    const state = this.store.read();
    const company = requireCompany(state, companyId);
    const item = state.items.find((row) => row.id === itemId && row.companyId === company.id);
    if (!item) throw new InputError('Select a stock item in this Tally company.');
    if (!this.marketplaces) throw new InputError('Order verification is unavailable.', 409);
    if (item.keepBackPreviousUnit !== undefined) {
      const reservations = (await this.inventoryReservations(company.id))[item.id];
      if (!reservations || reservations.itemVersion !== item.version)
        throw new InputError(
          'Refresh this stock item and check its order reservations again.',
          409,
        );
      return {
        physical: reservations.physical,
        reservedUnits: reservations.units,
        itemVersion: item.version,
      };
    }
    const evidence = await this.marketplaces.availableStock(company.id, item.id, undefined, true);
    evidence.verify();
    return {
      physical: evidence.physical,
      reservedUnits: evidence.reservedUnits,
      itemVersion: evidence.itemVersion,
    };
  }

  setKeepBack(companyId: unknown, itemId: unknown, itemVersion: unknown, units: unknown): Snapshot {
    if (
      typeof units !== 'number' ||
      !Number.isFinite(units) ||
      units < 0 ||
      units > Number.MAX_SAFE_INTEGER
    ) {
      throw new InputError('Enter a valid keep-back quantity of zero or more.');
    }
    if (typeof itemVersion !== 'number' || !Number.isSafeInteger(itemVersion) || itemVersion < 0) {
      throw new InputError('The saved stock item version is required.');
    }
    this.store.update((state) => {
      const company = requireCompany(state, companyId);
      const item = state.items.find((row) => row.id === itemId && row.companyId === company.id);
      if (!item) throw new InputError('Select a stock item in this Tally company.');
      if (item.keepBackUnits === units && item.keepBackPreviousUnit === undefined) return;
      if (
        item.keepBackPreviousUnit !== undefined &&
        (!item.observedAt ||
          !item.unit ||
          company.stockIssue ||
          !hasCurrentTallyObservation(state, company, item.observedAt))
      )
        throw new InputError(
          'Refresh the Tally item and its current unit before confirming the quantity to keep back.',
          409,
        );
      if (item.version !== itemVersion) {
        throw new InputError(
          'The stock item changed. Refresh it before saving the keep-back quantity.',
          409,
        );
      }
      item.keepBackUnits = units;
      delete item.keepBackPreviousUnit;
      item.version++;
      for (const row of state.listings)
        if (row.itemId === item.id) this.marketplaces?.supersedeInventoryReview(row.id);
      if (company.automation) {
        for (const listing of state.listings) {
          if (listing.itemId === item.id && listing.verified && !listing.paused) {
            listing.syncPendingItemVersion = item.version;
          }
        }
      }
      recordActivity(
        state,
        'item-keep-back',
        `${item.name}: ${units} ${item.unit} kept back from marketplaces.`,
        { companyId: company.id },
      );
    });
    this.draftPolling.wake();
    return this.snapshot();
  }

  async pause(
    companyId: unknown,
    ids: unknown,
    paused: unknown,
    listingVersion?: unknown,
  ): Promise<Snapshot> {
    if (typeof paused !== 'boolean') throw new InputError('Pause must be true or false.');
    const resumed = new Set<string>();
    this.store.update((state) => {
      const listings = requireListings(state, companyId, ids);
      if (
        listingVersion !== undefined &&
        (listings.length !== 1 || listings[0].version !== listingVersion)
      )
        throw new InputError(
          'The listing changed. Refresh before changing its Tally sync setting.',
          409,
        );
      for (const listing of listings) {
        if (listing.paused !== paused) {
          listing.paused = paused;
          if (paused) {
            delete listing.proposalIssue;
          } else {
            // If the app closes mid-check, the missing draft still has an explanation.
            listing.proposalIssue = 'Stock verification is incomplete.';
            resumed.add(listing.id);
          }
          listing.orderSyncPending = null;
          listing.version++;
          const item = state.items.find((row) => row.id === listing.itemId);
          const company = state.companies.find((row) => row.id === companyId);
          listing.syncPendingItemVersion =
            !paused && company?.automation && listing.verified ? (item?.version ?? null) : null;
        }
        const action = paused
          ? 'automatic publication paused'
          : 'pause removed; stock will be checked before publishing';
        recordActivity(
          state,
          paused ? 'pause' : 'resume',
          `${listing.sku}: ${action}. Stock policy retained.`,
          { companyId: String(companyId), listingId: listing.id },
        );
      }
      if (resumed.size)
        state.proposals = state.proposals.filter((draft) => !resumed.has(draft.listingId));
    });
    if (resumed.size) return this.calculateAvailable(companyId, [...resumed], true);
    return this.snapshot();
  }

  automation(companyId: unknown, enabled: unknown): Snapshot {
    if (typeof enabled !== 'boolean')
      throw new InputError('Choose whether to enable automatic stock updates.');
    this.store.update((state) => {
      const company = requireCompany(state, companyId);
      if (company.automation === enabled) return;
      this.automationReviews.companySettingChanged(company.id);
      company.automation = enabled;
      for (const listing of state.listings) {
        const item = state.items.find(
          (row) => row.id === listing.itemId && row.companyId === company.id,
        );
        if (item) {
          listing.orderSyncPending = null;
          listing.syncPendingItemVersion =
            enabled && !listing.paused && listing.verified ? item.version : null;
        }
      }
      recordActivity(
        state,
        'automation',
        `${company.name}: automatic Inventory updates ${enabled ? 'enabled' : 'disabled'}.`,
        { companyId: company.id },
      );
    });
    return this.snapshot();
  }

  review(companyId: unknown, ids: unknown): Review {
    const state = this.snapshot();
    const market = this.marketplaces ? this.store.readMarketplace() : null;
    const calculated = new Map<string, CalculatedReview>();
    const rows = requireListings(state, companyId, ids).map((listing) => {
      const draft = state.proposals.find((row) => row.listingId === listing.id);
      let problem: string | null = null;
      let oneTimeProblem: string | null | undefined;
      try {
        requireStockSource(state, listing);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        problem = error.message;
      }
      const limitIssue = draft && draftStockLimitIssue(draft.quantity);
      if (!draft) problem = 'Calculate or save a proposal first.';
      else if (limitIssue) problem = limitIssue;
      else if (draft.stale) problem = 'Source, mapping or policy changed. Review a fresh proposal.';
      else if (market && !problem) {
        const destination = market.listings.find(
          (row) => row.accountId === listing.accountId && row.sku === listing.sku,
        );
        if (!destination) problem = 'Refresh listings to verify this listing and pickup location.';
        else {
          const intent = {
            companyId: String(companyId),
            listingId: listing.id,
            itemVersion: draft.itemVersion,
            listingVersion: draft.listingVersion,
            draft,
          };
          const check = (positiveEdits: 'allowance' | 'once') => {
            try {
              inventoryTarget(state, { ...intent, positiveEdits }, destination);
              return null;
            } catch (error) {
              if (!(error instanceof InputError)) throw error;
              return error.message;
            }
          };
          problem = check('allowance');
          if (!problem && !draft.edited && this.marketplaces)
            calculated.set(
              listing.id,
              this.marketplaces.captureCalculatedReview(state, listing, destination),
            );
          if (draft.edited && draft.quantity > 0) oneTimeProblem = check('once');
        }
      }
      const seller = state.accounts.find((row) => row.id === listing.accountId);
      return {
        listingId: listing.id,
        sku: listing.sku,
        account: seller?.name ?? 'Unknown account',
        marketplace: seller?.marketplace,
        location: listing.location,
        quantity: draft?.quantity ?? null,
        observed: listing.observed,
        policy: describeReviewPolicy(listing, draft),
        paused: listing.paused,
        stale: draft?.stale ?? false,
        problem,
        ...(draft?.edited &&
          draft.quantity > 0 && {
            oneTimeProblem: oneTimeProblem === undefined ? problem : oneTimeProblem,
          }),
      };
    });
    // Capture exact destinations; neither a later filter nor a new row enlarges this review.
    const review: Review = {
      id: randomUUID(),
      companyId: String(companyId),
      createdAt: new Date().toISOString(),
      rows,
      publishingEnabled: !!this.marketplaces,
    };
    if (this.marketplaces) {
      const ids = new Set(rows.map((row) => row.listingId));
      for (const [key, value] of this.reviews)
        if (Date.now() - Date.parse(value.review.createdAt) > 900_000 || this.reviews.size >= 50)
          this.reviews.delete(key);
      this.reviews.set(review.id, {
        review,
        drafts: state.proposals.filter((row) => ids.has(row.listingId)),
        calculated,
      });
    }
    return review;
  }

  async prepareReview(companyId: unknown, ids: unknown): Promise<Review> {
    const review = this.review(companyId, ids);
    const marketplaces = this.marketplaces;
    const manualRows = review.rows.filter(
      (row) => row.oneTimeProblem !== undefined && (!row.problem || !row.oneTimeProblem),
    );
    if (!marketplaces || !manualRows.length) return review;
    const state = this.store.read();
    const catalog = indexAutomationCatalog(this.store.readMarketplace());
    const batch = {};
    for (const row of manualRows) {
      const mapped = state.listings.find((listing) => listing.id === row.listingId);
      if (!mapped || !state.items.find((item) => item.id === mapped.itemId)?.keepBackUnits)
        continue;
      const [destination] = catalog.listingsFor(mapped);
      if (!destination || row.quantity === null) continue;
      const checked = await checkManualKeepBack(state, destination, row.location, (company, item) =>
        marketplaces.availableStock(company, item, batch, true),
      );
      if (
        checked &&
        (checked.review.completePacks === null || row.quantity > checked.review.completePacks)
      )
        row.keepBackWarning = checked.review;
    }
    return review;
  }

  async publish(
    reviewId: unknown,
    positiveEdits: unknown = 'allowance',
    keepBackOverrides: unknown = [],
  ): Promise<InventoryPublishResult> {
    if (positiveEdits !== 'allowance' && positiveEdits !== 'once')
      throw new InputError('Choose a sales allowance or Update once for positive manual edits.');
    if (!this.marketplaces)
      throw new InputError('Inventory publishing is unavailable in this runtime.', 409);
    const captured = typeof reviewId === 'string' ? this.reviews.get(reviewId) : undefined;
    if (!captured || Date.now() - Date.parse(captured.review.createdAt) > 900_000)
      throw new InputError('Open a fresh Inventory review before publishing.', 409);
    const confirmed = new Set(Array.isArray(keepBackOverrides) ? keepBackOverrides : []);
    this.reviews.delete(captured.review.id);
    const rows: InventoryPublishResult['rows'] = [];
    const batch = {};
    for (const row of captured.review.rows) {
      const draft = captured.drafts.find((entry) => entry.listingId === row.listingId);
      let problem =
        positiveEdits === 'once' && row.oneTimeProblem !== undefined
          ? row.oneTimeProblem
          : row.problem;
      if (!problem && row.keepBackWarning && !confirmed.has(row.listingId))
        problem = 'Confirm the keep-back warning for this listing before publishing.';
      if (!draft || problem) {
        rows.push({
          listingId: row.listingId,
          sku: row.sku,
          status: 'blocked',
          message: problem ?? 'A current proposal is required.',
        });
        continue;
      }
      rows.push(
        await this.marketplaces.publishInventory(
          {
            companyId: captured.review.companyId,
            listingId: row.listingId,
            itemVersion: draft.itemVersion,
            listingVersion: draft.listingVersion,
            positiveEdits,
            draft,
            calculatedReview: captured.calculated.get(row.listingId),
            ...(row.keepBackWarning && {
              keepBackConfirmation: {
                reviewKey: row.keepBackWarning.reviewKey,
                quantity: draft.quantity,
              },
            }),
          },
          batch,
        ),
      );
    }
    return { rows };
  }

  private saveMapping(input: Record<string, unknown>): void {
    this.store.updateMapping(input.listingId, (market, state, baselines) => {
      const listing = state.listings.find((row) => row.id === input.listingId);
      const item = state.items.find((row) => row.id === input.itemId);
      if (!listing || !item || (listing.itemId && listing.itemId !== item.id))
        throw new InputError(
          'Choose an existing unmapped listing or its currently mapped Tally item.',
        );
      if (input.confirmPackEvidence !== true)
        throw new InputError('Verified pack evidence is required.');
      const editing = listing.itemId !== null;
      const editingBillingMapping = editing && billingOnlyMapping(listing) && !input.orderSource;
      const billingOnly = input.sourceScope === null;
      if (
        billingOnly &&
        ((!input.orderSource && !editingBillingMapping) ||
          input.keepPaused !== true ||
          !input.packSource ||
          input.expectedUnit !== item.unit)
      )
        throw new InputError('Confirm the order, Tally item and Set of for billing.');
      if (
        input.keepPaused !== undefined &&
        (typeof input.keepPaused !== 'boolean' ||
          (editing && listing.location && !(editingBillingMapping && billingOnly)))
      )
        throw new InputError('Choose the pause setting when adding a new listing mapping.');
      if (input.orderSource !== undefined) {
        const location = listing.location || input.pickupLocation;
        const remoteId = verifyOrderMapping(
          market,
          listing,
          item.companyId,
          location,
          input.orderSource,
        );
        const { orderItemId } = input.orderSource as { orderItemId?: unknown };
        if (orderItemId !== undefined || billingOnly) {
          const from = this.store.readBillingTrackingStart(item.companyId);
          if (!from || typeof orderItemId !== 'string' || !orderItemId)
            throw new InputError('Refresh tracked orders and choose the listing again.', 409);
          const saved = this.store.readBillingOrders(
            item.companyId,
            listing.accountId,
            from,
            new Date().toISOString(),
            orderItemId,
          );
          const baseline = baselines.find((entry) => entry.coverage.companyId === item.companyId);
          const stock = baseline?.coverage;
          const receipt = stock?.orders.find(
            (entry) =>
              entry.accountId === listing.accountId &&
              entry.order.orderItemId === orderItemId &&
              entry.order.orderDate >= from,
          );
          const orders = [
            ...saved.map((entry) => entry.order),
            ...(receipt ? [receipt.order] : []),
          ];
          if (
            !orders.length ||
            orders.some(
              (o) =>
                !isVerifiedSale(o) ||
                o.sku !== listing.sku ||
                o.listingId !== remoteId ||
                o.locationId !== location,
            )
          )
            throw new InputError(
              'The tracked sale or its listing changed. Refresh tracked orders.',
              409,
            );
          if (
            !billingOnly &&
            (!baseline?.current ||
              !stock ||
              orders.some((o) => o.orderDate < stock.from) ||
              saved.some((entry) => entry.group !== 'standard' && entry.group !== 'selfShip') ||
              coverageIssue(stock, stock.signature, Date.now()))
          )
            throw new InputError(
              'The stock tracking setup changed. Refresh tracked orders before mapping.',
              409,
            );
        }
        if (billingOnly) listing.skuMappingId = remoteId;
      } else if (editingBillingMapping) {
        verifyOrderMapping(
          market,
          listing,
          item.companyId,
          listing.location,
          {
            companyId: item.companyId,
            accountId: listing.accountId,
            listingId: listing.skuMappingId,
            locationId: listing.location,
          },
          true,
        );
      }
      if (input.keepPaused === true) listing.paused = true;
      let pickupChanged = false;
      if (!listing.location || input.pickupLocation !== undefined) {
        const remote = market.listings.find(
          (row) =>
            row.id === listing.skuMappingId &&
            row.accountId === listing.accountId &&
            row.sku === listing.sku,
        );
        if (
          listing.location ||
          !remote?.observedAt ||
          input.packSource === undefined ||
          typeof input.pickupLocation !== 'string'
        )
          throw new InputError('Refresh the imported listing and review its pickup location.', 409);
        const choice = input.pickupLocation;
        if (choice) {
          if (!pickupChoices(market.listings, remote).includes(choice))
            throw new InputError('Choose a current pickup location for this seller.', 409);
          const other = state.listings.find(
            (row) =>
              row.accountId === listing.accountId &&
              row.sku === listing.sku &&
              row.location === choice,
          );
          if (other) {
            if (
              other.itemId ||
              other.paused ||
              other.policy !== 'auto' ||
              other.remaining !== null ||
              state.proposals.some((p) => p.listingId === other.id)
            )
              throw new InputError(
                'This pickup location already has a mapping or stock policy.',
                409,
              );
            state.listings = state.listings.filter((row) => row !== other);
          }
          listing.location = choice;
          const location = remote.locations.find((loc) => loc.id === choice);
          listing.observed = location?.quantity ?? null;
          listing.observedAt = location ? remote.observedAt : null;
          pickupChanged = true;
        }
      }
      if (input.packSource !== undefined) {
        if (input.expectedUnit !== undefined && input.expectedUnit !== item.unit)
          throw new InputError(
            'The Tally base unit changed. Review the units per sale again.',
            409,
          );
        if (listing.version !== input.listingVersion)
          throw new InputError(
            'This listing changed. Reopen its Set of choice and confirm the latest values.',
            409,
          );
        if (input.packSource !== 'packages' && input.packSource !== 'manual')
          throw new InputError('Choose a valid Set of source.');
        if (
          (input.sourceScope !== 'company' && input.sourceScope !== null) ||
          typeof input.tyreFloor !== 'boolean'
        )
          throw new InputError(
            'Confirm the company stock source and the advertising rule for this location.',
          );
        const size = requireWholeNumber(input.packSize, 'Set of', 1, Number.MAX_SAFE_INTEGER);
        if (
          input.packSource === 'packages' &&
          (!listing.packageAvailable || size !== listing.packageCount)
        )
          throw new InputError('Refresh the reported package count before using it.', 409);
        // Reopening and saving an unchanged mapping is not a stock change. A sale
        // on Flipkart may still be waiting to reach Tally.
        const sameConversion =
          editing &&
          !pickupChanged &&
          listing.verified &&
          listing.packSource === input.packSource &&
          listing.packSize === size &&
          listing.sourceScope === input.sourceScope;
        if (sameConversion && listing.tyreFloor === input.tyreFloor) return;
        listing.packSource = input.packSource;
        listing.packSize = size;
        if (!sameConversion) listing.packConfirmedAt = new Date().toISOString();
        const units = `${size} Tally ${size === 1 ? 'unit' : 'units'} per sale`;
        listing.packEvidence =
          input.packSource === 'packages'
            ? `Confirmed ${units} using the reported package count.`
            : `Seller confirmed ${units}.`;
        listing.verified = true;
        listing.sourceScope = input.sourceScope;
        listing.tyreFloor = input.tyreFloor;
        listing.syncPendingItemVersion =
          !listing.paused &&
          state.companies.some((company) => company.id === item.companyId && company.automation)
            ? item.version
            : null;
      } else if (editing || !listing.verified || !listing.packSize) {
        throw new InputError(
          editing
            ? 'This listing is already mapped. Choose Set of to edit it.'
            : 'Verified pack evidence is required.',
        );
      }
      listing.itemId = item.id;
      listing.orderSyncPending = null;
      listing.version++;
      recordActivity(
        state,
        editing ? 'mapping-updated' : 'mapping-added',
        `${listing.sku} mapped to ${item.name}. Set of ${listing.packSize}.`,
        { companyId: item.companyId, listingId: listing.id },
      );
    });
  }

  mapping(input: Record<string, unknown>): Snapshot {
    this.saveMapping(input);
    this.draftPolling.wake();
    return this.snapshot();
  }

  async mapAndCalculate(input: Record<string, unknown>): Promise<Snapshot> {
    this.saveMapping(input);
    const state = this.store.read();
    const listing = state.listings.find((row) => row.id === input.listingId);
    const item = state.items.find((row) => row.id === listing?.itemId);
    if (listing?.orderProposalPending && item)
      await this.refreshListingDrafts(state, item.companyId, [listing], this.draftClock());
    this.draftPolling.wake();
    return this.snapshot();
  }

  remove(
    companyId: unknown,
    listingId: unknown,
    leaveRemoteStock: unknown,
    listingVersion?: unknown,
  ): Snapshot {
    if (leaveRemoteStock !== true)
      throw new InputError(
        'Zero-and-verify removal needs a connected publishing integration. Choose explicitly to leave remote stock unchanged.',
      );
    this.store.update((state) => {
      const listing = requireListings(state, companyId, [listingId])[0];
      if (listingVersion !== undefined && listing.version !== listingVersion)
        throw new InputError(
          'The listing changed. Reopen the current mapping before removing it.',
          409,
        );
      listing.itemId = null;
      delete listing.proposalIssue;
      delete listing.orderProposalPending;
      listing.orderSyncPending = null;
      listing.syncPendingItemVersion = null;
      if (listing.packSource) {
        listing.packSource = null;
        listing.packSize = null;
        listing.packConfirmedAt = null;
        listing.packEvidence = 'Confirm Set of for the next Tally item.';
        listing.verified = false;
        listing.sourceScope = null;
        listing.tyreFloor = false;
      }
      listing.version++;
      state.proposals = state.proposals.filter((row) => row.listingId !== listing.id);
      recordActivity(
        state,
        'mapping-removed',
        `${listing.sku} unlinked. Remote stock was left unchanged.`,
        { companyId: String(companyId), listingId: listing.id },
      );
    });
    return this.snapshot();
  }

  changeSettings(changes: unknown): Snapshot {
    const current = this.store.read().settings;
    if (
      !changes ||
      typeof changes !== 'object' ||
      Array.isArray(changes) ||
      !Object.keys(changes).length ||
      Object.keys(changes).some((key) => !Object.hasOwn(current, key))
    )
      throw new InputError('Choose at least one valid setting to change.');
    return this.settings({ ...current, ...changes });
  }

  settings(input: unknown): Snapshot {
    const sourceChanged = saveSettings(this.store, input);
    if (sourceChanged) {
      this.stockRefresh.sourceChanged();
      for (const listing of this.store.read().listings)
        this.marketplaces?.supersedeInventoryReview(listing.id);
    }
    this.polling.settingsChanged();
    this.catalogPolling.settingsChanged();
    this.orderPolling.settingsChanged();
    return this.snapshot();
  }

  backup(): { path: string; verified: true } {
    return createBackup(this.store);
  }

  async refresh(companyId?: unknown): Promise<Snapshot> {
    const selectedCompany =
      companyId === undefined ? undefined : requireCompany(this.snapshot(), companyId);
    await this.polling.runNow(() => this.refreshAndSync(selectedCompany?.id, true));
    return this.snapshot();
  }

  async refreshInventory(
    companyId?: unknown,
    accountId?: unknown,
  ): Promise<InventoryRefreshResult> {
    const state = this.snapshot();
    // Before the first company is discovered, Refresh can read Tally without operating on
    // another company's reservations or queued updates.
    const company =
      companyId === undefined && !state.companies.length
        ? undefined
        : requireCompany(state, companyId);
    const accounts = new Set(
      company
        ? stockConfiguration(
            state,
            this.store.readMarketplace(),
            this.store.readBilling(),
            company.id,
          ).accounts
        : [],
    );
    if (accountId !== undefined) {
      const account = state.accounts.find((row) => row.id === accountId);
      if (!account) throw new InputError('Select a valid seller account.');
      accounts.add(account.id);
    }
    const run = this.refreshInventorySources(company?.id, accounts);
    this.inventoryRefreshes.add(run);
    try {
      return await run;
    } finally {
      this.inventoryRefreshes.delete(run);
    }
  }

  private async refreshInventorySources(
    companyId: string | undefined,
    accounts: ReadonlySet<string>,
  ): Promise<InventoryRefreshResult> {
    const marketplaces = this.marketplaces;
    const catalogues = marketplaces ? await marketplaces.refreshInventoryCatalogues(accounts) : [];
    const messages: string[] = [];
    let partial = false;
    if (!marketplaces) {
      messages.push('Marketplace checks are unavailable.');
      partial = true;
    } else if (!catalogues.length) {
      messages.push('No participating sellers to refresh.');
    } else {
      const refreshed = catalogues.filter((row) => row.status === 'refreshed');
      const failed = catalogues.filter((row) => row.status === 'failed');
      const skipped = catalogues.filter((row) => row.status === 'skipped');
      if (refreshed.length)
        messages.push(`Refreshed listings for ${refreshed.map((row) => row.name).join(', ')}.`);
      if (failed.length)
        messages.push(
          `Could not refresh listings for ${failed.map((row) => row.name).join(', ')}.`,
        );
      if (skipped.length)
        messages.push(
          `Skipped listings for ${skipped.map((row) => row.name).join(', ')}. Check the seller connection.`,
        );
      partial = failed.length > 0 || skipped.length > 0;
    }
    await this.polling.runScoped(async () => {
      const tallyOk = await this.stockRefresh.run(companyId);
      messages.unshift(this.store.read().connection.message);
      if (!tallyOk) partial = true;
      if (companyId && marketplaces) {
        await this.orderPolling.runScoped(async () => {
          const pass = await this.syncPending(companyId, true);
          const report = describeStockPass(pass);
          messages.push(report.message);
          if (report.partial) partial = true;
        });
      }
    });
    return { ...this.snapshot(), refresh: { message: messages.join(' '), partial } };
  }

  private async refreshAndSync(companyId?: string, checkOrders = false): Promise<boolean> {
    const success = await this.stockRefresh.run(companyId);
    if (!this.marketplaces || (!success && !checkOrders)) return success;
    await this.syncPending(companyId, checkOrders);
    return success;
  }

  private async syncPending(
    companyId: string | undefined,
    checkOrders: boolean,
    batch = {},
  ): Promise<StockPass> {
    this.publishingBatches.add(batch);
    try {
      return await this.runStockPass(companyId, checkOrders, batch);
    } finally {
      this.publishingBatches.delete(batch);
    }
  }

  private async runStockPass(companyId: string | undefined, checkOrders: boolean, batch: object) {
    const pass: StockPass = { ordersChecked: 0, orderFailures: 0, updates: new Map() };
    if (!this.marketplaces) return pass;
    if (checkOrders) {
      // Known zero quantities can proceed before reading order history.
      await this.publishPending(companyId, batch, pass.updates, true);
      const state = this.store.read();
      for (const company of state.companies) {
        if ((companyId && companyId !== company.id) || !this.store.readStockCoverage(company.id))
          continue;
        const key = 'orders:' + company.id;
        try {
          await this.marketplaces.checkStockOrders(company.id, batch);
          pass.ordersChecked++;
          this.marketplaces.blockedSyncReasons.delete(key);
        } catch (error) {
          const reason =
            error instanceof InputError ? error.message : 'Check the seller connection and retry.';
          pass.orderFailures++;
          if (this.marketplaces.blockedSyncReasons.get(key) !== reason) {
            this.marketplaces.blockedSyncReasons.set(key, reason);
            this.store.update((current) =>
              recordActivity(
                current,
                'order-sync-blocked',
                `${company.name}: shared-stock order check waiting. ${reason}`,
                { companyId: company.id, level: 'warning' },
              ),
            );
          }
        }
      }
    }
    await this.publishPending(companyId, batch, pass.updates, false);
    // A calculated Tally publication can itself discover orders for another
    // item. Pick up those destinations in this pass, without retrying failures.
    if (pass.updates.size) await this.publishPending(companyId, batch, pass.updates, false);
    return pass;
  }

  private async publishPending(
    companyId: string | undefined,
    batch: object,
    attempted: Map<string, InventoryPublishRow>,
    zeroOnly: boolean,
  ): Promise<void> {
    if (!this.marketplaces) return;
    const state = this.store.read();
    const work = [];
    for (const listing of state.listings) {
      if (
        attempted.has(listing.id) ||
        listing.paused ||
        !listing.verified ||
        (listing.syncPendingItemVersion == null && !listing.orderSyncPending)
      )
        continue;
      const item = state.items.find((row) => row.id === listing.itemId);
      if (
        !item ||
        (companyId && item.companyId !== companyId) ||
        !state.companies.some((row) => row.id === item.companyId && row.automation)
      )
        continue;
      // An exhausted allowance or a balance below one pack already targets zero.
      const zero =
        (listing.policy === 'limited' && listing.remaining === 0) ||
        (listing.packSize !== null &&
          item.physical !== null &&
          availableForMarketplaces(item.physical, 0, item.keepBackUnits) < listing.packSize);
      if (!zeroOnly || zero) work.push({ listing, item, zero });
    }
    work.sort((a, b) => Number(b.zero) - Number(a.zero));
    for (const { listing, item } of work) {
      const orderOnly = listing.syncPendingItemVersion == null ? listing.orderSyncPending : null;
      const result = await this.marketplaces.publishInventory(
        {
          companyId: item.companyId,
          listingId: listing.id,
          itemVersion: listing.syncPendingItemVersion ?? item.version,
          listingVersion: listing.version,
          ...(orderOnly && { orderOnly }),
        },
        batch,
      );
      attempted.set(listing.id, result);
      if (result.status !== 'blocked') {
        this.marketplaces.blockedSyncReasons.delete(listing.id);
        continue;
      }
      if (this.marketplaces.blockedSyncReasons.get(listing.id) === result.message) continue;
      this.marketplaces.blockedSyncReasons.set(listing.id, result.message);
      const message = `${listing.sku}: automatic stock update waiting. ${result.message}`;
      this.store.update((current) => {
        recordActivity(current, 'inventory-sync-blocked', message, {
          companyId: item.companyId,
          listingId: listing.id,
          level: 'warning',
        });
      });
      this.diagnostics.write('inventory-sync', message, 'warning');
    }
  }

  private wakeForOrders() {
    if (this.orderWake || !this.unsubscribeOrders || !this.pendingOrderWakes.size) return;
    // Let the action that found the sale finish its local review/save. An
    // independent background check must never hold the caller's seller queue.
    this.orderWake = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        while (this.unsubscribeOrders && this.pendingOrderWakes.size) {
          const [id, batch] = this.pendingOrderWakes.entries().next().value!;
          this.pendingOrderWakes.delete(id);
          await this.syncPending(id, false, batch);
        }
      })
      .catch((error) => this.diagnostics.error('order-sync', error))
      .finally(() => {
        this.orderWake = null;
        this.wakeForOrders();
      });
  }

  start(): void {
    this.unsubscribeOrders ??= this.marketplaces?.onStockOrdersPending((id, batch) => {
      if (batch && this.publishingBatches.has(batch)) return;
      this.pendingOrderWakes.set(id, batch);
      this.wakeForOrders();
    });
    this.catalogPolling.start();
    this.orderPolling.start();
    if (this.marketplaces && this.store.read().mode === 'live')
      void this.catalogPolling
        .runNow()
        .catch((error) => this.diagnostics.error('catalog-refresh', error));
    this.polling.start();
    this.draftPolling.start();
    this.draftPolling.wake();
  }
  stop(): void {
    this.unsubscribeOrders?.();
    this.unsubscribeOrders = undefined;
    this.pendingOrderWakes.clear();
    this.polling.stop();
    this.catalogPolling.stop();
    this.orderPolling.stop();
    this.draftPolling.stop();
  }
  async idle(): Promise<void> {
    await Promise.allSettled(this.inventoryRefreshes);
    await Promise.all([
      this.polling.idle(),
      this.catalogPolling.idle(),
      this.orderPolling.idle(),
      this.draftPolling.idle(),
    ]);
    while (this.orderWake) await this.orderWake;
  }
}
