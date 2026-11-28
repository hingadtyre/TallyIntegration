import { MarketplaceSeller } from '../MarketplaceSeller.js';
import { useState } from 'react';
import type {
  Activity,
  InventoryPublishResult,
  Listing,
  Review,
  SellerAccount,
  Snapshot,
} from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { ActivityList, Icon, Modal } from '../components.js';
import { formatDateTime, formatQuantity, formatStockMatches } from '../format.js';

function publicationSummary(result: InventoryPublishResult) {
  const counts = {
    confirmed: 0,
    'already matched': 0,
    'changed since review': 0,
    blocked: 0,
    failed: 0,
    uncertain: 0,
  };
  for (const row of result.rows) {
    if (row.status === 'blocked' && row.latestQuantity !== undefined)
      counts['changed since review']++;
    else if (row.status === 'unchanged') counts['already matched']++;
    else counts[row.status]++;
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(' · ');
}

export function ReviewDialog({
  state,
  review,
  onClose,
  onPublish,
  onDiscard,
  onReviewLatest,
}: {
  state: Snapshot;
  review: Review;
  onClose: () => void;
  onPublish: (
    reviewId: string,
    keepBackOverrides?: string[],
  ) => Promise<ActionResult<InventoryPublishResult>>;
  onDiscard: (reviewId: string, listingId: string) => Promise<ActionResult<Review>>;
  onReviewLatest: (listingIds: string[]) => Promise<ActionResult<Review>>;
}) {
  const [pending, setPending] = useState<'publish' | 'discard' | 'review' | null>(null);
  const [result, setResult] = useState<InventoryPublishResult | null>(null);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const rows = review.rows;
  const outcomes = new Map(result?.rows.map((entry) => [entry.listingId, entry]));
  const changed = review.rows.flatMap((row) => {
    const outcome = outcomes.get(row.listingId);
    return outcome?.status === 'blocked' && outcome.latestQuantity !== undefined ? [outcome] : [];
  });
  const eligible = rows.filter((row) => !row.problem && !row.stale && row.quantity !== null);
  const warnings = eligible.flatMap((row) =>
    row.keepBackWarning ? [{ row, warning: row.keepBackWarning }] : [],
  );
  const canPublish =
    review.publishingEnabled &&
    eligible.length > 0 &&
    warnings.every(({ row }) => confirmed.includes(row.listingId)) &&
    !pending &&
    !result &&
    !error;
  async function publish() {
    if (!canPublish) return;
    setPending('publish');
    const outcome = await onPublish(
      review.id,
      warnings.length ? warnings.map(({ row }) => row.listingId) : undefined,
    );
    setPending(null);
    if (outcome.ok) setResult(outcome.value);
    else
      setError(
        outcome.error +
          ' Check Activity and the latest marketplace stock before preparing another review.',
      );
  }
  async function discard(listingId: string) {
    if (pending || result || error) return;
    setPending('discard');
    const next = await onDiscard(review.id, listingId);
    if (!next.ok) setError(next.error + ' Return to Inventory to review the latest proposals.');
    setPending(null);
  }
  async function reviewLatest() {
    if (pending || !changed.length) return;
    setError('');
    setPending('review');
    const next = await onReviewLatest(changed.map((row) => row.listingId));
    setPending(null);
    if (!next.ok) setError(next.error);
  }
  const company = state.companies.find((entry) => entry.id === review.companyId);
  const currentListings = changed.length
    ? new Map(state.listings.map((listing) => [listing.id, listing]))
    : null;
  if (!rows.length) {
    return (
      <Modal title="Review proposed stock" onClose={onClose}>
        <p className="modal-intro" role="status">
          {review.matchedCount
            ? formatStockMatches(review.matchedCount)
            : 'No proposals left in this review'}{' '}
          · 0 to publish
        </p>
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Back to inventory
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      title={result ? 'Stock publication results' : 'Review proposed stock'}
      wide
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <div className="review-summary">
        <div>
          <small>Tally company</small>
          <strong>{company?.name ?? review.companyId}</strong>
        </div>
        <div>
          <small>Captured scope</small>
          <strong>
            {review.rows.length} listing destination{review.rows.length === 1 ? '' : 's'}
          </strong>
        </div>
        <div>
          <small>Prepared</small>
          <strong>{formatDateTime(review.createdAt)}</strong>
        </div>
      </div>
      {!!review.matchedCount && !result && (
        <p className="modal-intro" role="status">
          <strong>{formatStockMatches(review.matchedCount)}</strong>
        </p>
      )}
      {result ? (
        <p className="modal-intro" role="status">
          <strong>{publicationSummary(result) || 'No publication results returned.'}</strong>
        </p>
      ) : (
        <p className="modal-intro">
          {state.mode === 'demo'
            ? 'This sample publication uses local data.'
            : 'Publishing sends eligible quantities to the reviewed listings.'}{' '}
          Discard a proposal to remove it from Inventory. Publish applies the quantities and sync
          changes shown below and skips calculations that have changed since review.
        </p>
      )}
      <div className="review-table-wrap stock-review">
        <table className="review-table">
          <thead>
            <tr>
              <th scope="col">Listing / destination</th>
              <th scope="col">Observed</th>
              <th scope="col">{result ? 'Reviewed' : 'Proposed'}</th>
              <th scope="col">{result ? 'Reviewed policy' : 'After publishing'}</th>
              <th scope="col">{result ? 'Publication result' : 'Action'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const outcome = outcomes.get(row.listingId);
              const current = currentListings?.get(row.listingId);
              return (
                <tr key={row.listingId}>
                  <td>
                    <strong className="sku">{row.sku}</strong>
                    <small>
                      <MarketplaceSeller
                        account={{ name: row.account, marketplace: row.marketplace }}
                      />{' '}
                      · {row.location}
                    </small>
                    {(row.problem || row.stale) && (
                      <small className="text-danger">
                        {row.problem || 'Source values changed. Recalculate and review again.'}
                      </small>
                    )}
                  </td>
                  <td>
                    <span className="review-cell-label" aria-hidden="true">
                      Observed
                    </span>
                    {row.observed === null
                      ? 'Needs a Flipkart stock check'
                      : formatQuantity(row.observed)}
                  </td>
                  <td className="review-quantity">
                    <span className="review-cell-label" aria-hidden="true">
                      {result ? 'Reviewed' : 'Proposed'}
                    </span>
                    {formatQuantity(row.quantity)}
                  </td>
                  <td>
                    <span className="review-cell-label" aria-hidden="true">
                      {result ? 'Reviewed policy' : 'After publishing'}
                    </span>
                    {row.policy}
                  </td>
                  {!result && (
                    <td>
                      {row.canDiscard && (
                        <button
                          className="text-button"
                          type="button"
                          aria-label={`Discard proposal for ${row.sku} at ${row.location}`}
                          disabled={!!pending || !!error}
                          onClick={() => void discard(row.listingId)}
                        >
                          Discard proposal
                        </button>
                      )}
                    </td>
                  )}
                  {result && (
                    <td>
                      <span className="review-cell-label" aria-hidden="true">
                        Publication result
                      </span>
                      <strong>
                        {outcome?.latestQuantity !== undefined
                          ? 'Changed since review'
                          : (outcome?.status ?? 'Unknown')}
                      </strong>
                      {outcome?.latestQuantity !== undefined && (
                        <small>
                          Latest calculated stock: {formatQuantity(outcome.latestQuantity)}
                        </small>
                      )}
                      <small>{outcome?.message}</small>
                      {outcome?.latestQuantity !== undefined && current && (
                        <small>
                          {current.paused
                            ? 'Tally sync is paused at this location.'
                            : company?.automation === false
                              ? 'Company sync is off.'
                              : `Automatic updates · ${current.automationStatus ?? 'Stock check status unavailable'}`}
                        </small>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!result && warnings.length > 0 && (
        <fieldset className="pack-fields" disabled={!!pending || !!error}>
          <legend>Confirm manual stock override</legend>
          {warnings.map(({ row, warning }) => {
            const held = formatQuantity(warning.keepBackUnits) + ' ' + warning.unit;
            return (
              <label key={row.listingId} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={confirmed.includes(row.listingId)}
                  onChange={(event) =>
                    setConfirmed(
                      event.target.checked
                        ? [...confirmed, row.listingId]
                        : confirmed.filter((id) => id !== row.listingId),
                    )
                  }
                />
                <span>
                  <strong>
                    Publish {formatQuantity(row.quantity)} for {row.sku} at {row.location}.
                  </strong>{' '}
                  {warning.completePacks === null
                    ? 'Available packs could not be verified after keeping back ' + held + '.'
                    : 'After keeping back ' +
                      held +
                      ', this listing has ' +
                      formatQuantity(warning.completePacks) +
                      ' complete ' +
                      (warning.completePacks === 1 ? 'pack' : 'packs') +
                      ' available.'}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        {pending === 'discard' && <span role="status">Discarding proposal…</span>}
        <button className="button secondary" onClick={onClose} disabled={!!pending}>
          Back to inventory
        </button>
        {!result && (
          <button className="button primary" disabled={!canPublish} onClick={() => void publish()}>
            {pending === 'publish'
              ? 'Publishing…'
              : !review.publishingEnabled
                ? 'Publish unavailable'
                : `Publish ${eligible.length} eligible ${eligible.length === 1 ? 'listing' : 'listings'}`}
          </button>
        )}
        {changed.length > 0 && (
          <button
            className="button primary"
            disabled={!!pending}
            onClick={() => void reviewLatest()}
          >
            {pending
              ? 'Preparing review…'
              : changed.length === 1
                ? `Review latest quantity (${changed[0].latestQuantity})`
                : `Review latest quantities (${changed.length} listings)`}
          </button>
        )}
      </div>
    </Modal>
  );
}

export function RemoveMappingDialog({
  listing,
  account,
  busy,
  onClose,
  onRemove,
}: {
  listing: Listing;
  account?: SellerAccount;
  busy: boolean;
  onClose: () => void;
  onRemove: () => Promise<ActionResult<Snapshot>>;
}) {
  const [error, setError] = useState('');
  async function removeMapping() {
    setError('');
    const result = await onRemove();
    if (result.ok) onClose();
    else setError(result.error);
  }

  return (
    <Modal title="Remove stock mapping" onClose={onClose}>
      <p className="modal-intro">
        Unlink <strong className="sku">{listing.sku}</strong> from its Tally stock item.
        <br />
        <MarketplaceSeller account={account} /> - {listing.location || 'Pickup location pending'}
      </p>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <div className="message information">
        <Icon name="info" />
        <span>
          Removing this mapping leaves the listing at its current marketplace quantity. To take it
          out of stock first, publish zero and check the result before unlinking.
        </span>
      </div>
      <p className="muted-text">This does not delete the Tally item or marketplace listing.</p>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Keep mapping
        </button>
        <button className="button danger" disabled={busy} onClick={() => void removeMapping()}>
          Leave stock unchanged & unlink
        </button>
      </div>
    </Modal>
  );
}

export function HistoryDialog({
  listing,
  events,
  onClose,
}: {
  listing: Listing;
  events: Activity[];
  onClose: () => void;
}) {
  return (
    <Modal title={`History · ${listing.sku}`} wide onClose={onClose}>
      <ActivityList events={events.filter((event) => event.listingId === listing.id)} />
    </Modal>
  );
}
