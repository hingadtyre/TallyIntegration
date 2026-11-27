import { MarketplaceSeller } from '../MarketplaceSeller.js';
import { marketplaceName } from '../../shared/marketplaces.js';
import { useEffect, useRef, useState } from 'react';
import type {
  MarketplaceAccount,
  MarketplaceApplyResult,
  MarketplaceChange,
} from '../../shared/marketplace-contracts.js';
import type { MarketplaceStockRecoveryReview } from '../../shared/marketplace-recovery.js';
import { errorMessage, RequestError } from '../api.js';
import { Modal } from '../components.js';
import { marketplaceApi } from '../marketplace-api.js';

export function StockRecoveryAction({
  provider,
  change,
  disabled,
  onReview,
}: {
  change: MarketplaceChange;
  disabled: boolean;
  provider?: string;
  onReview: (change: MarketplaceChange) => void;
}) {
  if (change.state !== 'uncertain' || change.edit.kind !== 'stock') return null;
  if (change.stockRequestFinality !== 'not-sent' && change.stockRequestFinality !== 'completed')
    return (
      <p>
        {provider ?? 'The marketplace'} could still apply the earlier stock update. Check result
        refreshes the observed stock. Contact support if the request stays uncertain.
      </p>
    );
  return (
    <button className="text-button" disabled={disabled} onClick={() => onReview(change)}>
      Review current stock
    </button>
  );
}

export function MarketplaceStockRecovery({
  change,
  account,
  onPending,
  onResult,
  onReload,
  onClose,
}: {
  change: MarketplaceChange;
  account: MarketplaceAccount;
  onPending: (pending: boolean) => void;
  onResult: (result: MarketplaceApplyResult) => void;
  onReload: () => void;
  onClose: () => void;
}) {
  const provider = marketplaceName(account.marketplace);
  const [review, setReview] = useState<MarketplaceStockRecoveryReview | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [lostReply, setLostReply] = useState(false);
  const [result, setResult] = useState<MarketplaceApplyResult | null>(null);
  const submitting = useRef(false);
  const locationId = change.edit.kind === 'stock' ? change.edit.locationId : null;
  useEffect(() => {
    const controller = new AbortController();
    void marketplaceApi
      .reviewStockRecovery(change.accountId, change.id, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        if (next.sku !== change.sku || next.locationId !== locationId) {
          setError(
            'The reviewed listing or location changed. Close this review and refresh the seller’s listings.',
          );
          return;
        }
        setReview(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [change.accountId, change.id, change.sku, locationId, revision]);

  async function approve() {
    if (!review || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    onPending(true);
    try {
      const next = await marketplaceApi.approveStockRecovery(
        change.accountId,
        change.id,
        review.reviewId,
      );
      setResult(next);
      onResult(next);
      onReload();
    } catch (cause) {
      setReview(null);
      setError(errorMessage(cause));
      onReload();
      if (!(cause instanceof RequestError) || cause.status >= 500) {
        setLostReply(true);
      }
    } finally {
      submitting.current = false;
      setSaving(false);
      onPending(false);
    }
  }

  const same = review && review.observed === review.quantity;
  if (change.edit.kind !== 'stock') return null;
  return (
    <Modal title="Review current stock" onClose={onClose}>
      <div className="marketplace-editor">
        <p>
          <strong>
            <MarketplaceSeller account={account} />
          </strong>
          <br />
          {change.sku} · {change.edit.locationId}
        </p>
        {result ? (
          <div className={`marketplace-result result-${result.change.state}`} role="status">
            <strong>
              {result.change.state === 'reconciled'
                ? 'Current stock confirmed'
                : result.change.state === 'confirmed'
                  ? 'Stock updated'
                  : result.change.state === 'failed'
                    ? 'New stock update failed'
                    : 'Check the new stock update'}
            </strong>
            <p>{result.change.message}</p>
          </div>
        ) : (
          <>
            {change.stockRequestFinality === 'not-sent' ? (
              <p>
                The earlier request for {change.edit.quantity} stopped before Stockbridge sent it to
                {provider ?? 'the marketplace'}.
              </p>
            ) : (
              <p>
                {provider ?? 'The marketplace'} has finished processing the earlier request for{' '}
                {change.edit.quantity}.
              </p>
            )}
            {error && (
              <p className="marketplace-error" role="alert">
                {error}
              </p>
            )}
            {lostReply && (
              <p>Reload the saved listing result to see what happened to this approval.</p>
            )}
            {!error && !review && (
              <p role="status">Checking Tally, orders and current listing stock…</p>
            )}
            {review && (
              <>
                <dl className="connection-details">
                  <div>
                    <dt>Current {provider ?? 'listing'} stock</dt>
                    <dd>{review.observed}</dd>
                  </div>
                  <div>
                    <dt>Calculated listing stock</dt>
                    <dd>{review.quantity}</dd>
                  </div>
                </dl>
                <p>
                  {same
                    ? 'The quantities match. Approval closes the earlier attempt without sending a stock update.'
                    : `Approval closes the earlier attempt and sends ${review.quantity} to ${review.locationId} on ${provider ?? 'the marketplace'}.`}
                </p>
              </>
            )}
          </>
        )}
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            {result ? 'Done' : 'Close'}
          </button>
          {lostReply ? (
            <button
              className="button primary"
              onClick={() => {
                onReload();
                onClose();
              }}
            >
              Reload saved result
            </button>
          ) : error ? (
            <button
              className="button secondary"
              onClick={() => {
                setError('');
                setRevision((n) => n + 1);
              }}
            >
              Check current stock again
            </button>
          ) : (
            review &&
            !result && (
              <button className="button primary" disabled={saving} onClick={() => void approve()}>
                {saving
                  ? 'Saving approval…'
                  : same
                    ? `Approve and keep ${review.quantity}`
                    : `Approve and send ${review.quantity}`}
              </button>
            )
          )}
        </div>
      </div>
    </Modal>
  );
}
