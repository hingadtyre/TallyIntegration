import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { TallyClient } from '../adapters/tally.js';
import type {
  Activity,
  InventoryPublishResult,
  Proposal,
  Review,
  Snapshot,
} from '../shared/contracts.js';
import type { MarketplaceService } from './marketplace-service.js';
import { inventoryTarget } from './inventory-publication.js';
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
  private readonly marketplaces?: MarketplaceService;
  private readonly reviews = new Map<string, { review: Review; drafts: Proposal[] }>();

  constructor(
    readonly store: Store,
    dependencies: InventoryDependencies = {},
  ) {
    this.diagnostics =
      dependencies.diagnostics ?? new Diagnostics(join(dirname(store.file), 'diagnostics.ndjson'));
    this.marketplaces = dependencies.marketplaces;
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
  }

  snapshot(): Snapshot {
    const state = this.store.read();
    state.publishingEnabled = !!this.marketplaces;
    if (state.mode === 'live') {
      const visibleAccounts = new Set(
        this.store.readMarketplace().accounts.map((account) => account.id),
      );
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
    this.store.update((state) => {
      const listings = requireListings(state, companyId, ids);
      const drafts = listings.map((listing) => {
        if (zero) return prepareProposal(state, listing, 0);
        const editedDraft = state.proposals.find(
          (draft) => draft.listingId === listing.id && draft.edited,
        );
        return editedDraft ?? prepareProposal(state, listing);
      });
      for (const draft of drafts) {
        state.proposals = [
          ...state.proposals.filter((row) => row.listingId !== draft.listingId),
          draft,
        ];
      }
      recordActivity(
        state,
        zero ? 'zero-draft' : 'calculate',
        `${drafts.length} listing proposals prepared. No marketplace changes.`,
        { companyId: String(companyId) },
      );
    });
    return this.snapshot();
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
      company.automation = enabled;
      for (const listing of state.listings) {
        const item = state.items.find(
          (row) => row.id === listing.itemId && row.companyId === company.id,
        );
        if (item)
          listing.syncPendingItemVersion =
            enabled && !listing.paused && listing.verified ? item.version : null;
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
        await this.marketplaces.publishInventory({
          companyId: captured.review.companyId,
          listingId: row.listingId,
          itemVersion: draft.itemVersion,
          listingVersion: draft.listingVersion,
          positiveEdits,
          draft,
        }),
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
        if (
          editing &&
          listing.verified &&
          listing.packSource === input.packSource &&
          listing.packSize === size &&
          listing.sourceScope === input.sourceScope &&
          listing.tyreFloor === input.tyreFloor
        )
          return;
        listing.packSource = input.packSource;
        listing.packSize = size;
        listing.packConfirmedAt = new Date().toISOString();
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
    saveSettings(this.store, input);
    this.polling.settingsChanged();
    this.catalogPolling.settingsChanged();
    return this.snapshot();
  }

  backup(): { path: string; verified: true } {
    return createBackup(this.store);
  }

  async refresh(companyId?: unknown): Promise<Snapshot> {
    const selectedCompany =
      companyId === undefined ? undefined : requireCompany(this.snapshot(), companyId);
    await this.polling.runNow(() => this.refreshAndSync(selectedCompany?.id));
    return this.snapshot();
  }

  private async refreshAndSync(companyId?: string): Promise<boolean> {
    const success = await this.stockRefresh.run(companyId);
    if (!success || !this.marketplaces) return success;
    const state = this.store.read();
    for (const listing of state.listings) {
      if (listing.syncPendingItemVersion == null || listing.paused || !listing.verified) continue;
      const item = state.items.find((row) => row.id === listing.itemId);
      if (
        !item ||
        (companyId && item.companyId !== companyId) ||
        !state.companies.some((row) => row.id === item.companyId && row.automation)
      )
        continue;
      const result = await this.marketplaces.publishInventory({
        companyId: item.companyId,
        listingId: listing.id,
        itemVersion: listing.syncPendingItemVersion,
        listingVersion: listing.version,
      });
      if (result.status === 'blocked')
        this.diagnostics.write('inventory-sync', `${listing.sku}: ${result.message}`, 'warning');
    }
    return success;
  }

  start(): void {
    this.catalogPolling.start();
    if (this.marketplaces && this.store.read().mode === 'live')
      void this.catalogPolling
        .runNow()
        .catch((error) => this.diagnostics.error('catalog-refresh', error));
    this.polling.start();
  }
  stop(): void {
    this.polling.stop();
    this.catalogPolling.stop();
  }
  async idle(): Promise<void> {
    await Promise.all([this.polling.idle(), this.catalogPolling.idle()]);
  }
}
