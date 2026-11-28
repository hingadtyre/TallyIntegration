import type { CalculationRow, Snapshot, StockItem } from '../../shared/contracts.js';
import { formatStockMatches } from '../format.js';

export function CalculationFeedback({
  rows,
  reviewDraftIds,
  state,
  busy,
  onFixPack,
}: {
  rows: CalculationRow[];
  reviewDraftIds: Set<string>;
  state: Snapshot;
  busy: boolean;
  onFixPack: (item: StockItem, listingId: string) => void;
}) {
  const listings = new Map(state.listings.map((listing) => [listing.id, listing]));
  const ready = rows.filter((row) => row.status === 'ready');
  const matched = ready.filter((row) => !reviewDraftIds.has(row.listingId)).length;
  const unchecked = rows.filter((row) => {
    if (row.status === 'blocked') return false;
    const listing = listings.get(row.listingId);
    return listing && (listing.observed === null || !listing.observedAt);
  }).length;
  const preserved = rows.filter((row) => row.status === 'preserved').length;
  const blocked = rows.filter((row) => row.status === 'blocked');
  const packOnly = blocked.every((row) => row.fix === 'pack');
  const summary: string[] = [];
  if (matched) summary.push(formatStockMatches(matched));
  const toPublish = ready.length + preserved - matched - unchecked;
  if (matched || unchecked) {
    if (toPublish || !unchecked) summary.push(`${toPublish} to publish`);
  } else {
    summary.push(`${ready.length} draft${ready.length === 1 ? '' : 's'} ready`);
  }
  if (unchecked)
    summary.push(`${unchecked} ${unchecked === 1 ? 'needs' : 'need'} a Flipkart check`);
  if (preserved) summary.push(`${preserved} edited draft${preserved === 1 ? '' : 's'} kept`);
  if (blocked.length)
    summary.push(
      `${blocked.length} listing${blocked.length === 1 ? ' needs' : 's need'} ${packOnly ? 'Set of confirmation' : 'attention'}`,
    );
  return (
    <section className="calculation-results" aria-label="Calculation results">
      <strong role="status">{summary.join(' · ')}</strong>
      {blocked.length > 0 && (
        <ul>
          {blocked.map((row) => {
            const listing = listings.get(row.listingId);
            const item = state.items.find((entry) => entry.id === listing?.itemId);
            const account = state.accounts.find((entry) => entry.id === listing?.accountId);
            return (
              <li key={row.listingId}>
                <strong>
                  {listing
                    ? [account?.name, listing.sku, listing.location].filter(Boolean).join(' · ')
                    : row.listingId}
                </strong>
                {' — '}
                {row.reason}
                {row.fix === 'pack' && item && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    aria-label={`Fix Set of for ${listing?.sku} at ${listing?.location}`}
                    onClick={() => onFixPack(item, row.listingId)}
                  >
                    Fix Set of
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
