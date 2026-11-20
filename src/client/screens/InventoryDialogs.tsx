import { useState } from 'react';
import type {
  Activity,
  InventoryPublishResult,
  Listing,
  Review,
  Snapshot,
} from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { ActivityList, Icon, Modal } from '../components.js';
import { formatDateTime, formatQuantity } from '../format.js';

export function ReviewDialog({
  state,
  review,
  onClose,
  onPublish,
}: {
  state: Snapshot;
  review: Review;
  onClose: () => void;
  onPublish: (
    reviewId: string,
    positiveEdits?: 'once' | 'allowance',
  ) => Promise<ActionResult<InventoryPublishResult>>;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<InventoryPublishResult | null>(null);
  const [error, setError] = useState('');
  const [positiveEdits, setPositiveEdits] = useState<'once' | 'allowance' | undefined>(
    state.mode === 'demo' ? 'allowance' : undefined,
  );
  const hasPositiveEdits = review.rows.some((row) => row.oneTimeProblem !== undefined);
  const rows = review.rows.map((row) => {
    if (row.oneTimeProblem === undefined || positiveEdits === 'allowance') return row;
    if (!positiveEdits)
      return {
        ...row,
        problem: row.oneTimeProblem || 'Choose how to publish positive edits.',
        policy: 'Awaiting choice',
      };
    return {
      ...row,
      problem: row.oneTimeProblem,
      policy: row.oneTimeProblem ? 'Update once unavailable' : 'Auto · update once',
    };
  });
  const outcomes = new Map(result?.rows.map((entry) => [entry.listingId, entry]));
  const eligible = rows.filter((row) => !row.problem && !row.stale && row.quantity !== null);
  const canPublish =
    review.publishingEnabled &&
    eligible.length > 0 &&
    (!hasPositiveEdits || !!positiveEdits) &&
    !pending &&
    !result &&
    !error;
  async function publish() {
    if (!canPublish) return;
    setPending(true);
    const outcome = await onPublish(review.id, hasPositiveEdits ? positiveEdits : undefined);
    setPending(false);
    if (outcome.ok) setResult(outcome.value);
    else setError(outcome.error);
  }
  const companyName =
    state.companies.find((company) => company.id === review.companyId)?.name ?? review.companyId;
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
          <strong>{companyName}</strong>
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
      <p className="modal-intro">
        {state.mode === 'demo'
          ? 'This sample publication uses local data.'
          : 'Publishing sends the eligible quantities below to Flipkart.'}{' '}
        An edited zero keeps that listing out of stock.
      </p>
      {hasPositiveEdits && (
        <fieldset className="pack-fields" disabled={pending || !!result || !!error}>
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
              Tally stock change can replace it and a verified Flipkart sale can lower it.
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
              <th scope="col">Proposed</th>
              <th scope="col">Resulting policy</th>
              {result && <th scope="col">Publication result</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.listingId}>
                <td>
                  <strong className="sku">{row.sku}</strong>
                  <small>
                    {row.account} · {row.location}
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
                  {formatQuantity(row.observed)}
                </td>
                <td className="review-quantity">
                  <span className="review-cell-label" aria-hidden="true">
                    Proposed
                  </span>
                  {formatQuantity(row.quantity)}
                </td>
                <td>
                  <span className="review-cell-label" aria-hidden="true">
                    Resulting policy
                  </span>
                  {row.policy}
                </td>
                {result && (
                  <td>
                    <span className="review-cell-label" aria-hidden="true">
                      Publication result
                    </span>
                    <strong>{outcomes.get(row.listingId)?.status ?? 'Unknown'}</strong>
                    <small>{outcomes.get(row.listingId)?.message}</small>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p className="message error" role="alert">
          {error} Check Activity and the latest marketplace stock before preparing another review.
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
      </div>
    </Modal>
  );
}

export function RemoveMappingDialog({
  listing,
  busy,
  onClose,
  onRemove,
}: {
  listing: Listing;
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
