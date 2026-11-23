import type { CalculationRow, Listing, Snapshot } from '../shared/contracts.js';
import { startTrackingMessage } from '../shared/stock-coverage.js';
import { recordActivity } from './activity.js';
import type { MarketplaceService } from './marketplace-service.js';
import { desiredStock, isStaleProposal, prepareProposal, requireStockSource } from './proposals.js';
import type { Store } from './store.js';
import { InputError } from './validation.js';

type CheckedStock = Awaited<ReturnType<MarketplaceService['availableStock']>>;
type ItemEvidence = Map<string, CheckedStock | InputError>;

export function proposalInputs(state: Snapshot, listing: Listing): string {
  const draft = state.proposals.find((proposal) => proposal.listingId === listing.id);
  return JSON.stringify([
    listing.version,
    listing.itemId,
    state.items.find((item) => item.id === listing.itemId)?.version,
    // Reading orders for this calculation can itself mark the old quantity stale.
    // The verified source and every seller-editable draft input are still checked.
    draft && { ...draft, stale: undefined },
  ]);
}

/** An unavailable item can block several pack sizes. A company-wide order check is shared. */
export async function checkCalculationStock(
  state: Snapshot,
  listings: Listing[],
  readItem: (id: string) => Promise<CheckedStock>,
): Promise<ItemEvidence> {
  const sources: ItemEvidence = new Map();
  for (const listing of listings) {
    const itemId = listing.itemId!;
    if (sources.has(itemId) || state.proposals.some((p) => p.listingId === listing.id && p.edited))
      continue;
    // An invalid pack belongs to this listing. Another pack of the same item can still qualify.
    try {
      if (desiredStock(state, listing) === 0) continue;
    } catch (error) {
      if (error instanceof InputError) continue;
      throw error;
    }
    try {
      sources.set(itemId, await readItem(itemId));
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      sources.set(itemId, error);
    }
  }
  return sources;
}

function calculatedDraft(
  state: Snapshot,
  listing: Listing,
  sources?: ItemEvidence,
  zero?: boolean,
) {
  let available: number | undefined;
  if (sources && desiredStock(state, listing) > 0) {
    const source = sources.get(listing.itemId!);
    if (source instanceof InputError) throw source;
    if (!source) throw new InputError('The available stock changed. Calculate again.', 409);
    available = source.available;
  }
  return prepareProposal(state, listing, zero ? 0 : undefined, available);
}

export function saveCalculation(
  store: Store,
  initial: Snapshot,
  companyId: string,
  selected: Listing[],
  options: {
    zero?: boolean;
    strict?: boolean;
    sources?: ItemEvidence;
    refreshStale?: boolean;
  } = {},
): CalculationRow[] {
  // These guards reread SQLite. Verify before taking the snapshot write lock.
  for (const [itemId, source] of options.sources ?? []) {
    if (source instanceof InputError) continue;
    try {
      source.verify();
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      options.sources?.set(itemId, error);
    }
  }
  const unchanged: CalculationRow[] = [];
  if (options.refreshStale) {
    // The scheduled order check often sees the same evidence. Leave the store
    // and outstanding reviews alone when no quantity or displayed status changed.
    selected = selected.filter((listing) => {
      const previous = initial.proposals.find((draft) => draft.listingId === listing.id);
      if (!previous || previous.edited) return false;
      try {
        const draft = calculatedDraft(initial, listing, options.sources);
        if (
          isStaleProposal(initial, previous) ||
          listing.proposalIssue ||
          draft.quantity !== previous.quantity ||
          draft.calculated !== previous.calculated
        )
          return true;
        unchanged.push({ listingId: listing.id, status: 'ready' });
      } catch (error) {
        if (!(error instanceof InputError)) throw error;
        if (!previous.stale || listing.proposalIssue !== error.message) return true;
        unchanged.push({ listingId: listing.id, status: 'blocked', reason: error.message });
      }
      return false;
    });
    if (!selected.length) return unchanged;
  }
  return store.update((state) => {
    const rows: CalculationRow[] = [...unchanged];
    for (const original of selected) {
      const listing = state.listings.find((row) => row.id === original.id);
      const sameInputs =
        listing && proposalInputs(initial, original) === proposalInputs(state, listing);
      try {
        if (!sameInputs) {
          // Another action owns the new draft or mapping. A later pass can inspect it.
          if (options.refreshStale) continue;
          throw new InputError(
            'Stock, mapping or a selected draft changed during calculation. Calculate again.',
            409,
          );
        }
        const edited =
          !options.zero && state.proposals.find((p) => p.listingId === listing.id && p.edited);
        if (edited) {
          requireStockSource(state, listing);
          if (isStaleProposal(state, edited)) {
            rows.push({
              listingId: listing.id,
              status: 'blocked',
              reason:
                'Your edited draft was kept. Stock or setup changed. Check and save the quantity again.',
            });
          } else {
            rows.push({ listingId: listing.id, status: 'preserved' });
          }
          continue;
        }
        // A resumed live listing needs verified availability even before the company
        // has set up order coverage. Keep that requirement on a later Calculate retry.
        if (
          !options.zero &&
          !options.sources &&
          state.mode === 'live' &&
          listing.proposalIssue &&
          !state.proposals.some((draft) => draft.listingId === listing.id) &&
          desiredStock(state, listing) > 0
        )
          throw new InputError(startTrackingMessage, 409);
        const draft = calculatedDraft(state, listing, options.sources, options.zero);
        const previous = state.proposals.find((p) => p.listingId === listing.id);
        if (
          options.refreshStale &&
          previous &&
          previous.quantity === draft.quantity &&
          previous.calculated === draft.calculated &&
          previous.itemVersion === draft.itemVersion &&
          previous.listingVersion === draft.listingVersion &&
          previous.ruleVersion === draft.ruleVersion
        ) {
          previous.stale = false;
        } else {
          state.proposals = [...state.proposals.filter((p) => p.listingId !== listing.id), draft];
        }
        delete listing.proposalIssue;
        rows.push({ listingId: listing.id, status: 'ready' });
      } catch (error) {
        if (!(error instanceof InputError) || options.strict) throw error;
        if (sameInputs) {
          const draft = state.proposals.find((p) => p.listingId === listing.id);
          if (draft && !draft.edited) draft.stale = true;
          if (draft?.stale || listing.proposalIssue) listing.proposalIssue = error.message;
        }
        const needsPack =
          listing &&
          listing.itemId === original.itemId &&
          (!listing.verified ||
            !listing.packSize ||
            (listing.packSource === 'packages' &&
              (!listing.packageAvailable || listing.packageCount !== listing.packSize)));
        rows.push({
          listingId: original.id,
          status: 'blocked',
          reason: error.message,
          ...(needsPack && { fix: 'pack' as const }),
        });
      }
    }
    if (options.refreshStale) return rows;
    const blocked = rows.filter((row) => row.status === 'blocked').length;
    recordActivity(
      state,
      options.zero ? 'zero-draft' : 'calculate',
      `${rows.length - blocked} drafts available for review. ${blocked} listings need attention.`,
      { companyId, level: blocked ? 'warning' : 'info' },
    );
    return rows;
  });
}
