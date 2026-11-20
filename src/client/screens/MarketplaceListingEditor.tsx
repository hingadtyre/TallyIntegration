import { useRef, useState } from 'react';
import type {
  MarketplaceApplyResult,
  MarketplaceChange,
  MarketplaceListingView,
} from '../../shared/marketplace-contracts.js';
import { errorMessage, RequestError } from '../api.js';
import { Icon, Modal } from '../components.js';
import { marketplaceApi } from '../marketplace-api.js';
import { StockRecoveryAction } from './MarketplaceStockRecovery.js';

export type MarketplaceEditorTarget = { listing: MarketplaceListingView } & (
  { kind: 'stock'; locationId: string } | { kind: 'price'; field: 'mrp' | 'sellingPrice' }
);

export const changeLabels: Record<MarketplaceChange['state'], string> = {
  pending: 'Waiting to apply',
  sending: 'Applying',
  checking: 'Checking result',
  confirmed: 'Updated',
  failed: 'Failed',
  uncertain: 'Result uncertain',
  reconciled: 'Recovery approved',
};

export function MarketplaceListingEditor({
  target,
  demo,
  onResult,
  onClose,
  onOpenInventory,
  onPolicyUpdated,
  onPending,
  knownChangeIds,
  onFailure,
  onReviewRecovery,
}: {
  target: MarketplaceEditorTarget;
  demo: boolean;
  onResult: (result: MarketplaceApplyResult) => void;
  onClose: () => void;
  onOpenInventory: () => void;
  onPolicyUpdated: (listing: MarketplaceListingView) => void;
  onPending: (pending: boolean) => void;
  knownChangeIds: string[];
  onFailure: (message: string, uncertain: boolean) => void;
  onReviewRecovery: (change: MarketplaceChange) => void;
}) {
  const [listing, setListing] = useState(target.listing);
  const [policyConfirmation, setPolicyConfirmation] = useState(false);
  const previousChanges = useRef(new Set(knownChangeIds));
  const [lostResponse, setLostResponse] = useState(false);
  const original =
    target.kind === 'stock'
      ? listing.locations.find((location) => location.id === target.locationId)?.quantity
      : listing[target.field];
  const policy =
    target.kind === 'stock'
      ? listing.stockPolicies.find((value) => value.locationId === target.locationId)
      : undefined;
  const label =
    target.kind === 'stock' ? 'Stock' : target.field === 'mrp' ? 'MRP' : 'Selling price';
  const [value, setValue] = useState(original == null ? '' : String(original));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [change, setChange] = useState<MarketplaceChange | null>(null);
  const [currentVersion, setCurrentVersion] = useState(listing.version);
  const submitting = useRef(false);
  const quantity = Number(value);
  const valid =
    listing.observedAt !== null &&
    value.trim() !== '' &&
    Number.isFinite(quantity) &&
    quantity >= 0 &&
    (target.kind !== 'stock' || Number.isSafeInteger(quantity));
  const conflict =
    policy?.policy === 'limited' &&
    valid &&
    quantity > 0 &&
    (!demo || policy.remaining === null || quantity > policy.remaining);
  const needsReconcile =
    !!change && ['pending', 'sending', 'checking', 'uncertain'].includes(change.state);
  const finished = change?.state === 'confirmed' || change?.state === 'reconciled';
  async function apply(reconcile = false) {
    if (submitting.current || (!reconcile && (lostResponse || !valid || conflict))) return;
    submitting.current = true;
    setPending(true);
    onPending(true);
    setError('');
    try {
      const result =
        reconcile && change
          ? await marketplaceApi.reconcile(listing.accountId, change.id)
          : await marketplaceApi.apply({
              accountId: listing.accountId,
              listingId: listing.id,
              version: currentVersion,
              edit:
                target.kind === 'stock'
                  ? {
                      kind: 'stock',
                      locationId: target.locationId,
                      quantity,
                    }
                  : { kind: 'price', field: target.field, value: quantity },
            });
      setChange(result.change);
      setListing(result.listing);
      setCurrentVersion(result.listing.version);
      onResult(result);
    } catch (failure) {
      const message = errorMessage(failure);
      const uncertain = !(failure instanceof RequestError) || failure.status >= 500;
      setError(message);
      onFailure(message, uncertain);
      if (uncertain) setLostResponse(true);
    } finally {
      submitting.current = false;
      setPending(false);
      onPending(false);
    }
  }
  async function recover() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      const saved = await marketplaceApi.listings(listing.accountId, listing.sku, '', 1);
      const current = saved.listings.find((item) => item.id === listing.id);
      const recorded = saved.changes.find((item) => {
        if (item.listingId !== listing.id || previousChanges.current.has(item.id)) return false;
        return target.kind === 'stock'
          ? item.edit.kind === 'stock' &&
              item.edit.locationId === target.locationId &&
              item.edit.quantity === quantity
          : item.edit.kind === 'price' &&
              item.edit.field === target.field &&
              item.edit.value === quantity;
      });
      if (!recorded || !current) {
        setError(
          'No saved result was found. Refresh this account’s listings before deciding whether to submit again.',
        );
        return;
      }
      setChange(recorded);
      setListing(current);
      setCurrentVersion(current.version);
      setLostResponse(false);
      setError('');
      onResult({ change: recorded, listing: current });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  async function changePolicy() {
    if (submitting.current || target.kind !== 'stock') return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const next = await marketplaceApi.policy({
        accountId: listing.accountId,
        listingId: listing.id,
        locationId: target.locationId,
        version: currentVersion,
        policy: 'auto',
        confirmed: true,
      });
      setListing(next);
      setCurrentVersion(next.version);
      setPolicyConfirmation(false);
      onPolicyUpdated(next);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  return (
    <Modal title={`Edit ${label.toLowerCase()}`} onClose={onClose}>
      <div className="marketplace-editor">
        <p>
          <strong>{listing.title}</strong>
          <br />
          {listing.sku}
          {target.kind === 'stock' && ` · ${target.locationId}`}
        </p>
        <p className="marketplace-help">
          Current observed {label.toLowerCase()}: <strong>{original ?? 'Not available'}</strong>
        </p>
        {!listing.observedAt && (
          <p className="marketplace-error" role="alert">
            Refresh required. There is no current observation for this listing.
          </p>
        )}
        <label className="field">
          <span>{label}</span>
          <input
            type="number"
            min="0"
            step={target.kind === 'stock' ? '1' : '0.01'}
            value={value}
            disabled={pending || lostResponse || needsReconcile || finished}
            onChange={(event) => {
              setValue(event.target.value);
              setChange(null);
            }}
          />
        </label>
        {policy && (
          <div className="marketplace-policy">
            {policy.companyId && (
              <strong className="sync-lock-label">
                <Icon name="lock" />
                {policy.paused ? 'Tally sync paused' : 'Applying stock pauses Tally sync'}
              </strong>
            )}
            <p>
              {policy.companyName}
              {!policy.paused && ` · ${policy.automationStatus ?? 'Status unavailable'}`}
              {policy.policy === 'limited' && ` · ${policy.remaining ?? 'Unknown'} sales remaining`}
            </p>
            {policy.companyId && (
              <p>
                Flipkart sales still reduce stock. Stockbridge skips automatic updates for this
                location, including updates to zero, until you choose Resume sync.
              </p>
            )}
          </div>
        )}
        {target.kind === 'price' && (
          <p className="marketplace-help">
            Only this price field changes. The other price is preserved from a fresh read. Stock
            automation stays unchanged.
          </p>
        )}
        {conflict && (
          <div className="marketplace-error" role="alert">
            <p>
              {!demo
                ? 'Live sales allowance reconciliation is not yet available. Positive stock cannot be applied under Limited sales. Explicitly change the stock policy first.'
                : 'This quantity exceeds or cannot be checked against the remaining sales allowance. Change its stock policy first.'}
            </p>
            <button
              className="text-button"
              disabled={pending}
              onClick={() => setPolicyConfirmation(true)}
            >
              Change stock policy
            </button>
          </div>
        )}
        {policyConfirmation && (
          <section
            className="marketplace-policy-confirmation"
            aria-label="Confirm stock policy change"
          >
            <h3>Return to automatic stock policy?</h3>
            <p>
              This removes the sales allowance at this location. Review the quantity and choose
              Apply to update stock.
            </p>
            <button
              className="button secondary"
              disabled={pending}
              onClick={() => setPolicyConfirmation(false)}
            >
              Keep current policy
            </button>
            <button
              className="button primary"
              disabled={pending}
              onClick={() => void changePolicy()}
            >
              Confirm automatic policy
            </button>
            <button className="text-button" disabled={pending} onClick={onOpenInventory}>
              Open Inventory
            </button>
          </section>
        )}
        {error && (
          <p className="marketplace-error" role="alert">
            {error}
          </p>
        )}
        {lostResponse && (
          <p className="marketplace-help">
            The response was lost, so this edit may have reached Flipkart. Reload its saved result
            before submitting anything again.
          </p>
        )}
        {change && (
          <div role="status" className={`marketplace-result result-${change.state}`}>
            <strong>{changeLabels[change.state]}</strong>
            <p>{change.message}</p>
            <StockRecoveryAction
              change={change}
              disabled={pending || lostResponse}
              onReview={onReviewRecovery}
            />
          </div>
        )}
        {demo && (
          <p className="marketplace-help">
            Sample simulation only. Apply does not contact Flipkart.
          </p>
        )}
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            {finished ? 'Done' : pending ? 'Close' : 'Cancel'}
          </button>
          {lostResponse ? (
            <button className="button primary" disabled={pending} onClick={() => void recover()}>
              {pending ? 'Reloading result…' : 'Reload saved result'}
            </button>
          ) : needsReconcile ? (
            <button className="button primary" disabled={pending} onClick={() => void apply(true)}>
              {pending ? 'Checking result…' : 'Check result'}
            </button>
          ) : (
            !finished && (
              <button
                className="button primary"
                disabled={pending || !valid || !!conflict}
                onClick={() => void apply()}
              >
                {pending
                  ? 'Applying…'
                  : policy?.companyId && !policy.paused
                    ? 'Apply and pause sync'
                    : 'Apply'}
              </button>
            )
          )}
        </div>
      </div>
    </Modal>
  );
}
