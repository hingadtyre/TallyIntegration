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
  onReviewLatest,
}: {
  state: Snapshot;
  review: Review;
  onClose: () => void;
  onPublish: (
    reviewId: string,
    positiveEdits?: 'once' | 'allowance',
    keepBackOverrides?: string[],
  ) => Promise<ActionResult<InventoryPublishResult>>;
  onReviewLatest: (listingIds: string[]) => Promise<ActionResult<Review>>;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<InventoryPublishResult | null>(null);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [positiveEdits, setPositiveEdits] = useState<'once' | 'allowance' | undefined>(
    state.mode === 'demo' ? 'allowance' : undefined,
  );
  const hasPositiveEdits = review.rows.some(
    (row) =>
      row.oneTimeProblem !== undefined &&
      !row.stale &&
      (!row.oneTimeProblem || (state.mode === 'demo' && !row.problem)),
  );
  const rows = review.rows.map((row) => {
    if (row.oneTimeProblem === undefined || positiveEdits === 'allowance') return row;
    if (!positiveEdits && row.oneTimeProblem) return { ...row, problem: row.oneTimeProblem };
    if (!positiveEdits)
      return {
        ...row,
        problem: 'Choose how to publish positive edits.',
        policy: 'Awaiting choice',
      };
    return {
      ...row,
      problem: row.oneTimeProblem,
      policy: row.oneTimeProblem
        ? 'Update once unavailable'
        : row.paused
          ? 'Tally sync paused · update once'
          : 'Auto · update once',
    };
  });
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
    (!hasPositiveEdits || !!positiveEdits) &&
    !pending &&
    !result &&
    !error;
  async function publish() {
    if (!canPublish) return;
    setPending(true);
    const outcome = await onPublish(
      review.id,
      hasPositiveEdits ? positiveEdits : undefined,
      warnings.length ? warnings.map(({ row }) => row.listingId) : undefined,
    );
    setPending(false);
    if (outcome.ok) setResult(outcome.value);
    else setError(outcome.error);
  }
  async function reviewLatest() {
    if (pending || !changed.length) return;
    setError('');
    setPending(true);
    const next = await onReviewLatest(changed.map((row) => row.listingId));
    setPending(false);
    if (!next.ok) setError(next.error);
  }
  const company = state.companies.find((entry) => entry.id === review.companyId);
  const currentListings = changed.length
    ? new Map(state.listings.map((listing) => [listing.id, listing]))
    : null;
  if (!rows.length && review.matchedCount) {
    return (
      <Modal title="Review proposed stock" onClose={onClose}>
        <p className="modal-intro" role="status">
          {formatStockMatches(review.matchedCount)} · 0 to publish
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
          These quantities stay fixed while Inventory updates. Publish skips calculated quantities
          that have changed.
        </p>
      )}
      {hasPositiveEdits && !result && (
        <fieldset className="pack-fields" disabled={pending || !!error}>
          <legend>Positive stock edits</legend>
          <label className="checkbox-label">
            <input
              type="radio"
              name="positive-edits"
              checked={positiveEdits === 'once'}
              onChange={() => setPositiveEdits('once')}
            />
            <span>
              <strong>Update once</strong> · Set the reviewed quantity. With automatic updates on, a
              Tally stock change can replace it and a verified marketplace sale can lower it.
            </span>
          </label>
          <label className="checkbox-label">
            <input
              type="radio"
              name="positive-edits"
              disabled={state.mode === 'live'}
              checked={positiveEdits === 'allowance'}
              onChange={() => setPositiveEdits('allowance')}
            />
            <span>
              <strong>Allow this many more sales</strong> · Limit future sales to the edited
              quantity.{' '}
              {state.mode === 'live' &&
                'Live sales allowances require order tracking and are unavailable.'}
            </span>
          </label>
        </fieldset>
      )}
      <div className="review-table-wrap stock-review">
        <table className="review-table">
          <thead>
            <tr>
              <th scope="col">Listing / destination</th>
              <th scope="col">Observed</th>
              <th scope="col">{result ? 'Reviewed' : 'Proposed'}</th>
              <th scope="col">{result ? 'Reviewed policy' : 'After publishing'}</th>
              {result && <th scope="col">Publication result</th>}
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
        <fieldset className="pack-fields" disabled={pending || !!error}>
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
          {error}{' '}
          {!result &&
            'Check Activity and the latest marketplace stock before preparing another review.'}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose} disabled={pending}>
          Back to inventory
        </button>
        {!result && (
          <button className="button primary" disabled={!canPublish} onClick={() => void publish()}>
            {pending
              ? 'Publishing…'
              : !review.publishingEnabled
                ? 'Publish unavailable'
                : `Publish ${eligible.length} eligible ${eligible.length === 1 ? 'listing' : 'listings'}`}
          </button>
        )}
        {changed.length > 0 && (
          <button className="button primary" disabled={pending} onClick={() => void reviewLatest()}>
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
