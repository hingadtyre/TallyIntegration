import type { CalculationRow, Listing, Snapshot } from '../shared/contracts.js';
import { startTrackingMessage } from '../shared/stock-coverage.js';
import { recordActivity } from './activity.js';
import type { MarketplaceService } from './marketplace-service.js';
import { desiredStock, isStaleProposal, prepareProposal, requireStockSource } from './proposals.js';
import type { Store } from './store.js';
import { InputError } from './validation.js';

type CheckedStock = Awaited<ReturnType<MarketplaceService['availableStock']>>;
type ItemEvidence = Map<string, CheckedStock | InputError>;

function proposalInputs(state: Snapshot, listing: Listing): string {
  return JSON.stringify([
    listing.version,
    listing.itemId,
    state.items.find((item) => item.id === listing.itemId)?.version,
    state.proposals.find((draft) => draft.listingId === listing.id),
  ]);
}

/** An unavailable item can block several pack sizes. A company-wide order check is shared. */
export async function checkCalculationStock(
  state: Snapshot,
  listings: Listing[],
  companyId: string,
  marketplaces: MarketplaceService,
  readOnly: boolean,
): Promise<ItemEvidence> {
  const sources: ItemEvidence = new Map();
  const batch = {};
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
      sources.set(itemId, await marketplaces.availableStock(companyId, itemId, batch, readOnly));
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      sources.set(itemId, error);
    }
  }
  return sources;
}

export function saveCalculation(
  store: Store,
  initial: Snapshot,
  companyId: string,
  selected: Listing[],
  options: { zero?: boolean; strict?: boolean; sources?: ItemEvidence } = {},
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
  return store.update((state) => {
    const rows: CalculationRow[] = [];
    for (const original of selected) {
      const listing = state.listings.find((row) => row.id === original.id);
      try {
        if (!listing || proposalInputs(initial, original) !== proposalInputs(state, listing))
          throw new InputError(
            'Stock, mapping or a selected draft changed during calculation. Calculate again.',
            409,
          );
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
          desiredStock(state, listing) > 0
        )
          throw new InputError(startTrackingMessage, 409);
        let available: number | undefined;
        if (options.sources && desiredStock(state, listing) > 0) {
          const source = options.sources.get(listing.itemId!);
          if (source instanceof InputError) throw source;
          if (!source) throw new InputError('The available stock changed. Calculate again.', 409);
          available = source.available;
        }
        const draft = prepareProposal(state, listing, options.zero ? 0 : undefined, available);
        state.proposals = [...state.proposals.filter((p) => p.listingId !== listing.id), draft];
        delete listing.proposalIssue;
        rows.push({ listingId: listing.id, status: 'ready' });
      } catch (error) {
        if (!(error instanceof InputError) || options.strict) throw error;
        if (listing?.proposalIssue && listing.version === original.version)
          listing.proposalIssue = error.message;
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
