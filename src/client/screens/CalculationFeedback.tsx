import type { CalculationRow, Snapshot, StockItem } from '../../shared/contracts.js';

export function CalculationFeedback({
  rows,
  state,
  busy,
  onFixPack,
}: {
  rows: CalculationRow[];
  state: Snapshot;
  busy: boolean;
  onFixPack: (item: StockItem, listingId: string) => void;
}) {
  const ready = rows.filter((row) => row.status === 'ready').length;
  const preserved = rows.filter((row) => row.status === 'preserved').length;
  const blocked = rows.filter((row) => row.status === 'blocked');
  const packOnly = blocked.every((row) => row.fix === 'pack');
  const summary = [`${ready} draft${ready === 1 ? '' : 's'} ready`];
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
            const listing = state.listings.find((entry) => entry.id === row.listingId);
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
