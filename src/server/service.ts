import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { TallyClient } from '../adapters/tally.js';
import type { Activity, Review, Snapshot } from '../shared/contracts.js';
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
  diagnostics?: Diagnostics;
  createTallyReader?: TallyReaderFactory;
  timers?: PollingTimers;
}

/** Application commands own inventory transactions; collaborators own external work. */
export class InventoryService {
  readonly diagnostics: Diagnostics;
  private readonly stockRefresh: StockRefresh;
  private readonly polling: PollingLoop;

  constructor(
    readonly store: Store,
    dependencies: InventoryDependencies = {},
  ) {
    this.diagnostics =
      dependencies.diagnostics ?? new Diagnostics(join(dirname(store.file), 'diagnostics.ndjson'));
    const createReader =
      dependencies.createTallyReader ?? ((endpoint) => new TallyClient(endpoint));
    this.stockRefresh = new StockRefresh(store, createReader, this.diagnostics);
    this.polling = new PollingLoop({
      task: () => this.stockRefresh.run(),
      intervalMilliseconds: () => store.read().settings.tallySeconds * 1000,
      enabled: () => store.read().mode === 'live',
      nextRunChanged: (nextPoll) =>
        store.update((state) => {
          state.connection.nextPoll = nextPoll;
        }),
      unexpectedError: (error) => this.diagnostics.error('scheduler', error),
      timers: dependencies.timers,
    });
  }

  snapshot(): Snapshot {
    const state = this.store.read();
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
      const intent = quantity === 0 ? 'keep out of stock' : `allow ${quantity} more sales`;
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

  review(companyId: unknown, ids: unknown): Review {
    const state = this.snapshot();
    const rows = requireListings(state, companyId, ids).map((listing) => {
      const draft = state.proposals.find((row) => row.listingId === listing.id);
      let problem: string | null = null;
      try {
        requireStockSource(state, listing);
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        problem = error.message;
      }
      if (!draft) problem = 'Calculate or save a proposal first.';
      else if (draft.stale) problem = 'Source, mapping or policy changed. Review a fresh proposal.';
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
      };
    });
    // Capture exact destinations; neither a later filter nor a new row enlarges this review.
    return {
      id: randomUUID(),
      companyId: String(companyId),
      createdAt: new Date().toISOString(),
      rows,
      publishingEnabled: false,
    };
  }

  mapping(input: Record<string, unknown>): Snapshot {
    this.store.update((state) => {
      const listing = state.listings.find((row) => row.id === input.listingId);
      const item = state.items.find((row) => row.id === input.itemId);
      if (!listing || !item || listing.itemId)
        throw new InputError('Choose an existing unmapped listing and stock item.');
      if (input.confirmPackEvidence !== true || !listing.verified || !listing.packSize)
        throw new InputError('Verified pack evidence is required.');
      listing.itemId = item.id;
      listing.version++;
      recordActivity(
        state,
        'mapping-added',
        `${listing.sku} mapped to ${item.name}. No source products created.`,
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
    return this.snapshot();
  }

  backup(): { path: string; verified: true } {
    return createBackup(this.store);
  }

  async refresh(companyId?: unknown): Promise<Snapshot> {
    const selectedCompany =
      companyId === undefined ? undefined : requireCompany(this.snapshot(), companyId);
    await this.polling.runNow(() => this.stockRefresh.run(selectedCompany?.id));
    return this.snapshot();
  }

  start(): void {
    this.polling.start();
  }
  stop(): void {
    this.polling.stop();
  }
  async idle(): Promise<void> {
    await this.polling.idle();
  }
}
