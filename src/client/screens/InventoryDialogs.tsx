import { useState } from 'react';
import type { Activity, Listing, Review, Snapshot, StockItem } from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { ActivityList, Icon, Modal } from '../components.js';
import { formatDateTime, formatQuantity } from '../format.js';

export function ReviewDialog({
  state,
  review,
  onClose,
}: {
  state: Snapshot;
  review: Review;
  onClose: () => void;
}) {
  const companyName =
    state.companies.find((company) => company.id === review.companyId)?.name ?? review.companyId;
  return (
    <Modal title="Review proposed stock" wide onClose={onClose}>
      <div className="review-summary">
        <div>
          <small>Tally company</small>
          <strong>{companyName}</strong>
        </div>
        <div>
          <small>Captured scope</small>
          <strong>{review.rows.length} listing destinations</strong>
        </div>
        <div>
          <small>Prepared</small>
          <strong>{formatDateTime(review.createdAt)}</strong>
        </div>
      </div>
      <p className="modal-intro">
        This review contains only the captured destinations. Positive edited quantities grant
        additional sales; zero keeps that listing out of stock when published.
      </p>
      <div className="review-table-wrap">
        <table className="review-table">
          <thead>
            <tr>
              <th>Listing / destination</th>
              <th>Observed</th>
              <th>Proposed</th>
              <th>Resulting policy</th>
            </tr>
          </thead>
          <tbody>
            {review.rows.map((row) => (
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
                <td>{formatQuantity(row.observed)}</td>
                <td className="review-quantity">{formatQuantity(row.quantity)}</td>
                <td>{row.policy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="message information">
        <Icon name="info" />
        <span>
          Publishing is unavailable while the live connections are being verified. This review has
          not changed any marketplace stock or active policy.
        </span>
      </div>
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Back to inventory
        </button>
        <button className="button primary" disabled>
          Publish unavailable
        </button>
      </div>
    </Modal>
  );
}

export function MappingDialog({
  item,
  state,
  accountId,
  busy,
  onClose,
  onSave,
}: {
  item: StockItem;
  state: Snapshot;
  accountId: string;
  busy: boolean;
  onClose: () => void;
  onSave: (listingId: string) => Promise<ActionResult<Snapshot>>;
}) {
  const listings = state.listings.filter(
    (listing) => listing.itemId === null && (!accountId || listing.accountId === accountId),
  );
  const [listingId, setListingId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const listing = listings.find((value) => value.id === listingId);

  async function saveMapping() {
    setError('');
    const result = await onSave(listingId);
    if (result.ok) onClose();
    else setError(result.error);
  }

  return (
    <Modal title="Map an existing listing" onClose={onClose}>
      <p className="modal-intro">
        Connect a marketplace listing to <strong>{item.name}</strong>. This creates an association
        in this app only.
      </p>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {!listings.length ? (
        <div className="empty-state compact-empty">
          <Icon name="connections" />
          <h3>No unmapped listings available</h3>
          <p>
            Import the seller account's listings after API authorization. A new marketplace product
            is never created here.
          </p>
        </div>
      ) : (
        <>
          <label className="field">
            <span>Existing marketplace listing</span>
            <select
              value={listingId}
              onChange={(event) => {
                setListingId(event.target.value);
                setConfirmed(false);
                setError('');
              }}
            >
              <option value="">Choose a listing</option>
              {listings.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.sku} - {value.title}
                </option>
              ))}
            </select>
          </label>
          {listing && (
            <>
              <dl className="connection-details mapping-evidence">
                <div>
                  <dt>Pack size</dt>
                  <dd>
                    {listing.packSize === null
                      ? 'Unknown - mapping blocked'
                      : `Set of ${listing.packSize}`}
                  </dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd>{listing.packEvidence || 'No verified evidence available'}</dd>
                </div>
                <div>
                  <dt>Inventory location</dt>
                  <dd>{listing.location}</dd>
                </div>
              </dl>
              <label className="checkbox-label mapping-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  disabled={!listing.verified || listing.packSize === null}
                />
                <span>
                  I checked the physical product, base unit and pack evidence. They match this Tally
                  item.
                </span>
              </label>
              {!listing.verified && (
                <p className="text-amber">
                  The listing's pack metadata must be verified before mapping.
                </p>
              )}
            </>
          )}
        </>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={busy || !listing || !confirmed || !listing.verified}
          onClick={() => void saveMapping()}
        >
          Save mapping
        </button>
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
          The usual “set stock to zero, verify, then unlink” action requires live publication and is
          unavailable. You can explicitly leave marketplace stock unchanged and remove only this
          app's mapping.
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
