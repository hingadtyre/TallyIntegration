import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { TallyClient } from '../adapters/tally.js';
import type {
  Activity,
  CalculationResult,
  InventoryPublishResult,
  Proposal,
  Review,
  Snapshot,
} from '../shared/contracts.js';
import type { MarketplaceService } from './marketplace-service.js';
import { checkCalculationStock, saveCalculation } from './inventory-calculation.js';
import { inventoryTarget } from './inventory-publication.js';
import { AutomationReviews } from './automation-preview.js';
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
import type { Store } from './store.js';
import { InputError, requireCompany, requireListings, requireWholeNumber } from './validation.js';

export { InputError } from './validation.js';

interface InventoryDependencies {
  marketplaces?: MarketplaceService;
  diagnostics?: Diagnostics;
  createTallyReader?: TallyReaderFactory;
  timers?: PollingTimers;
}

/** Application commands own inventory transactions; collaborators own external work. */
export class InventoryService {
  readonly diagnostics: Diagnostics;
  private readonly stockRefresh: StockRefresh;
  private readonly polling: PollingLoop;
  private readonly catalogPolling: PollingLoop;
  private readonly orderPolling: PollingLoop;
  private readonly publishingBatches = new WeakSet<object>();
  private readonly pendingOrderWakes = new Map<string, object | undefined>();
  private orderWake: Promise<void> | null = null;
  private unsubscribeOrders?: () => void;
  private readonly marketplaces?: MarketplaceService;
  readonly automationReviews: AutomationReviews;
  private readonly reviews = new Map<string, { review: Review; drafts: Proposal[] }>();

  constructor(
    readonly store: Store,
    dependencies: InventoryDependencies = {},
  ) {
    this.diagnostics =
      dependencies.diagnostics ?? new Diagnostics(join(dirname(store.file), 'diagnostics.ndjson'));
    this.marketplaces = dependencies.marketplaces;
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
      task: () => this.syncPending(undefined, true),
      intervalMilliseconds: () => store.read().settings.marketplaceSeconds * 1000,
      enabled: () => !!this.marketplaces && store.read().mode === 'live',
      nextRunChanged: () => {},
      unexpectedError: (error) => this.diagnostics.error('order-sync', error),
      timers: dependencies.timers,
    });
  }

  snapshot(): Snapshot {
    const state = this.store.read();
    state.publishingEnabled = !!this.marketplaces;
    const market =
      this.marketplaces || state.mode === 'live' ? this.store.readMarketplace() : undefined;
    if (market) this.marketplaces?.describeAutomation(state, market);
    if (state.mode === 'live') {
      const visibleAccounts = new Set(market?.accounts.map((account) => account.id));
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
    return this.snapshot();
  }

  async calculateAvailable(companyId: unknown, ids: unknown): Promise<CalculationResult> {
    const state = this.store.read();
    const selected = requireListings(state, companyId, ids);
    const sources =
      this.marketplaces && this.store.readStockCoverage(String(companyId))
        ? await checkCalculationStock(state, selected, String(companyId), this.marketplaces)
        : undefined;
    const calculation = saveCalculation(this.store, state, String(companyId), selected, {
      sources,
    });
    return { ...this.snapshot(), calculation };
  }

  edit(companyId: unknown, listingId: unknown, value: unknown): Snapshot {
    this.store.update((state) => {
      const listing = requireListings(state, companyId, [listingId])[0];
      const quantity = requireWholeNumber(value, 'Proposed quantity');
      if (quantity > desiredStock(state, listing, 'normal')) {
        throw new InputError(
          'Proposed stock exceeds the normal calculation for the available complete packs.',
        );
      }
      const draft = prepareProposal(state, listing, quantity);
      state.proposals = [...state.proposals.filter((row) => row.listingId !== listing.id), draft];
      const intent = quantity === 0 ? 'keep out of stock' : `review ${quantity} listing units`;
      recordActivity(state, 'edit-proposal', `Draft saved: ${intent}. Active policy unchanged.`, {
        companyId: String(companyId),
        listingId: listing.id,
      });
    });
    return this.snapshot();
  }

  pause(companyId: unknown, ids: unknown, paused: unknown): Snapshot {
    if (typeof paused !== 'boolean') throw new InputError('Pause must be true or false.');
    this.store.update((state) => {
      for (const listing of requireListings(state, companyId, ids)) {
        if (listing.paused !== paused) {
          listing.paused = paused;
          listing.orderSyncPending = null;
          listing.version++;
          const item = state.items.find((row) => row.id === listing.itemId);
          const company = state.companies.find((row) => row.id === companyId);
          listing.syncPendingItemVersion =
            !paused && company?.automation && listing.verified ? (item?.version ?? null) : null;
        }
        const action = paused
          ? 'automatic publication paused'
          : 'pause removed; fresh validation required before publishing';
        recordActivity(
          state,
          paused ? 'pause' : 'resume',
          `${listing.sku}: ${action}. Stock policy retained.`,
          { companyId: String(companyId), listingId: listing.id },
        );
      }
    });
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
      if (!draft) problem = 'Calculate or save a proposal first.';
      else if (draft.stale) problem = 'Source, mapping or policy changed. Review a fresh proposal.';
      else if (market && !problem) {
        const destination = market.listings.find(
          (row) => row.accountId === listing.accountId && row.sku === listing.sku,
        );
        if (!destination) problem = 'Refresh listings to verify this Flipkart destination.';
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
          if (draft.edited && draft.quantity > 0) oneTimeProblem = check('once');
        }
      }
      return {
        listingId: listing.id,
        sku: listing.sku,
        account:
          state.accounts.find((row) => row.id === listing.accountId)?.name ?? 'Unknown account',
        location: listing.location,
        quantity: draft?.quantity ?? null,
        observed: listing.observed,
        policy: describeReviewPolicy(listing, draft),
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
      });
    }
    return review;
  }

  async publish(
    reviewId: unknown,
    positiveEdits: unknown = 'allowance',
  ): Promise<InventoryPublishResult> {
    if (positiveEdits !== 'allowance' && positiveEdits !== 'once')
      throw new InputError('Choose a sales allowance or Update once for positive manual edits.');
    if (!this.marketplaces)
      throw new InputError('Inventory publishing is unavailable in this runtime.', 409);
    const captured = typeof reviewId === 'string' ? this.reviews.get(reviewId) : undefined;
    if (!captured || Date.now() - Date.parse(captured.review.createdAt) > 900_000)
      throw new InputError('Open a fresh Inventory review before publishing.', 409);
    this.reviews.delete(captured.review.id);
    const rows: InventoryPublishResult['rows'] = [];
    const batch = {};
    for (const row of captured.review.rows) {
      const draft = captured.drafts.find((entry) => entry.listingId === row.listingId);
      const problem =
        positiveEdits === 'once' && row.oneTimeProblem !== undefined
          ? row.oneTimeProblem
          : row.problem;
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
          },
          batch,
        ),
      );
    }
    return { rows };
  }

  mapping(input: Record<string, unknown>): Snapshot {
    this.store.update((state) => {
      const listing = state.listings.find((row) => row.id === input.listingId);
      const item = state.items.find((row) => row.id === input.itemId);
      if (!listing || !item || (listing.itemId && listing.itemId !== item.id))
        throw new InputError(
          'Choose an existing unmapped listing or its currently mapped Tally item.',
        );
      if (input.confirmPackEvidence !== true)
        throw new InputError('Verified pack evidence is required.');
      const editing = listing.itemId !== null;
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
        if (input.sourceScope !== 'company' || typeof input.tyreFloor !== 'boolean')
          throw new InputError(
            'Confirm the company stock source and the advertising rule for this location.',
          );
        const size = requireWholeNumber(input.packSize, 'Set of', 1, Number.MAX_SAFE_INTEGER);
        if (
          input.packSource === 'packages' &&
          (!listing.packageAvailable || size !== listing.packageCount)
        )
          throw new InputError('Refresh the actual Flipkart package count before using it.', 409);
        // Reopening and saving an unchanged mapping is not a stock change. A sale
        // on Flipkart may still be waiting to reach Tally.
        const sameConversion =
          editing &&
          listing.verified &&
          listing.packSource === input.packSource &&
          listing.packSize === size &&
          listing.sourceScope === input.sourceScope;
        if (sameConversion && listing.tyreFloor === input.tyreFloor) return;
        listing.packSource = input.packSource;
        listing.packSize = size;
        if (!sameConversion) listing.packConfirmedAt = new Date().toISOString();
        listing.packEvidence =
          input.packSource === 'packages'
            ? `Confirmed ${size} Tally units per sale using Flipkart's package count.`
            : `Seller confirmed ${size} Tally units per sale.`;
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
    return this.snapshot();
  }

  remove(companyId: unknown, listingId: unknown, leaveRemoteStock: unknown): Snapshot {
    if (leaveRemoteStock !== true)
      throw new InputError(
        'Zero-and-verify removal needs a connected publishing integration. Choose explicitly to leave remote stock unchanged.',
      );
    this.store.update((state) => {
      const listing = requireListings(state, companyId, [listingId])[0];
      listing.itemId = null;
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

  settings(input: unknown): Snapshot {
    const sourceChanged = saveSettings(this.store, input);
    if (sourceChanged) this.stockRefresh.sourceChanged();
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
  ): Promise<boolean> {
    this.publishingBatches.add(batch);
    try {
      return await this.runStockPass(companyId, checkOrders, batch);
    } finally {
      this.publishingBatches.delete(batch);
    }
  }

  private async runStockPass(companyId: string | undefined, checkOrders: boolean, batch: object) {
    if (!this.marketplaces) return true;
    const attempted = new Set<string>();
    let success = true;
    if (checkOrders) {
      // Existing holds and physical zeros can proceed before reading order history.
      await this.publishPending(companyId, batch, attempted, true);
      const state = this.store.read();
      for (const company of state.companies) {
        if (
          !company.automation ||
          (companyId && companyId !== company.id) ||
          !this.store.readStockCoverage(company.id)
        )
          continue;
        const key = 'orders:' + company.id;
        try {
          await this.marketplaces.checkStockOrders(company.id, batch);
          this.marketplaces.blockedSyncReasons.delete(key);
        } catch (error) {
          success = false;
          const reason =
            error instanceof InputError ? error.message : 'Check the Flipkart account and retry.';
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
    await this.publishPending(companyId, batch, attempted, false);
    // A calculated Tally publication can itself discover orders for another
    // item. Pick up those destinations in this pass, without retrying failures.
    if (attempted.size) await this.publishPending(companyId, batch, attempted, false);
    return success;
  }

  private async publishPending(
    companyId: string | undefined,
    batch: object,
    attempted: Set<string>,
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
      // A hold or a Tally balance below one complete pack can already be
      // taken offline while other destinations wait for their order history.
      const zero =
        listing.policy === 'hold' ||
        (listing.policy === 'limited' && listing.remaining === 0) ||
        (listing.packSize !== null && item.physical !== null && item.physical < listing.packSize);
      if (!zeroOnly || zero) work.push({ listing, item, zero });
    }
    work.sort((a, b) => Number(b.zero) - Number(a.zero));
    for (const { listing, item } of work) {
      attempted.add(listing.id);
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
  }
  stop(): void {
    this.unsubscribeOrders?.();
    this.unsubscribeOrders = undefined;
    this.pendingOrderWakes.clear();
    this.polling.stop();
    this.catalogPolling.stop();
    this.orderPolling.stop();
  }
  async idle(): Promise<void> {
    await Promise.all([this.polling.idle(), this.catalogPolling.idle(), this.orderPolling.idle()]);
    while (this.orderWake) await this.orderWake;
  }
}
