import { useEffect, useId, useState, type FormEvent } from 'react';
import { availableForMarketplaces } from '../../domain/stock-policy.js';
import type {
  ItemReservations,
  Listing,
  SellerAccount,
  StockItem,
} from '../../shared/contracts.js';
import { ReservationDetails } from './InventoryReservations.js';
import { requestJson, type ActionResult } from '../api.js';
import { formatQuantity } from '../format.js';

interface OrderCheck {
  itemVersion: number;
  physical: number;
  reservedUnits: number;
}

export function KeepBackEditor({
  item,
  reservations,
  accounts,
  busy,
  syncOn,
  allListings,
  demo,
  onDirty,
  onSave,
}: {
  item: StockItem;
  reservations?: ItemReservations;
  accounts: Map<string, SellerAccount>;
  busy: boolean;
  syncOn: boolean;
  allListings: Listing[];
  demo: boolean;
  onDirty: (id: string, dirty: boolean) => void;
  onSave: (quantity: number, version: number) => Promise<ActionResult<unknown>>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<{ text: string; version: number } | null>(null);
  const [check, setCheck] = useState<OrderCheck | 'unavailable' | null>(null);
  const [error, setError] = useState('');
  const editing = draft !== null;
  const saved = item.keepBackUnits ?? 0;
  const needsUnitReview = item.keepBackPreviousUnit !== undefined;
  const value = draft?.text ?? (needsUnitReview ? '' : String(saved));
  const amount = Number(value);
  const valid =
    value.trim() !== '' &&
    Number.isFinite(amount) &&
    amount >= 0 &&
    amount <= Number.MAX_SAFE_INTEGER;
  const changed = draft !== null && draft.version !== item.version;
  const verified =
    editing && typeof check === 'object' && check?.itemVersion === item.version ? check : null;
  const physical = verified?.physical ?? item.physical;
  const unit = item.unit || 'units';
  const afterKeepBack =
    valid && physical !== null ? availableForMarketplaces(physical, 0, amount) : null;
  const available =
    valid && verified
      ? availableForMarketplaces(verified.physical, verified.reservedUnits, amount)
      : null;

  useEffect(() => {
    if (!editing) return;
    const editId = `keep-back:${item.id}`;
    onDirty(editId, true);
    const controller = new AbortController();
    requestJson<OrderCheck>(
      '/items/keep-back/preview',
      { companyId: item.companyId, itemId: item.id },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setCheck(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCheck('unavailable');
      });
    return () => {
      controller.abort();
      onDirty(editId, false);
    };
  }, [editing, item.companyId, item.id, item.version, onDirty]);

  function reset() {
    setDraft(null);
    setCheck(null);
    setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy || !valid || changed) return;
    const result = await onSave(amount, draft.version);
    if (result.ok) reset();
    else setError(result.error);
  }
  const mappedListings = editing ? allListings.filter((listing) => listing.itemId === item.id) : [];
  const floorSize =
    verified &&
    available !== null &&
    mappedListings.find((listing) => {
      if (!listing.verified || !(listing.tyreFloor ?? demo) || !listing.packSize) return false;
      const packs = Math.floor(available / listing.packSize);
      return packs > 0 && packs < 5;
    })?.packSize;
  return (
    <form className="keep-back-editor" onSubmit={save}>
      <div className="keep-back-field">
        <label htmlFor={id}>Keep back from marketplaces</label>
        <div className="keep-back-input">
          <input
            id={id}
            type="number"
            min="0"
            max={Number.MAX_SAFE_INTEGER}
            step="any"
            inputMode="decimal"
            value={value}
            aria-label={`Keep back from marketplaces for ${item.name}`}
            aria-describedby={`${id}-balance`}
            aria-invalid={editing && !valid}
            data-unsaved={editing || undefined}
            disabled={busy}
            onChange={(event) => {
              const text = event.currentTarget.value;
              if (text === (needsUnitReview ? '' : String(saved))) reset();
              else {
                setDraft({ text, version: draft?.version ?? item.version });
                setError('');
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') reset();
            }}
          />
          <span>{unit}</span>
        </div>
      </div>
      <div
        className="keep-back-balance"
        id={`${id}-balance`}
        aria-live={editing ? 'polite' : 'off'}
      >
        {needsUnitReview && (
          <p className="text-amber">
            {item.keepBackPreviousUnit
              ? `You previously kept back ${formatQuantity(saved)} ${item.keepBackPreviousUnit}.`
              : `Your saved quantity is ${formatQuantity(saved)}. Its original unit is unknown.`}{' '}
            Enter the quantity to keep back in {unit}.
          </p>
        )}
        {!editing && needsUnitReview ? null : !editing && reservations && item.physical !== null ? (
          <>
            <span>Available for marketplaces</span>
            <div>
              <strong>
                {formatQuantity(availableForMarketplaces(item.physical, reservations.units, saved))}{' '}
                {unit}
              </strong>
              <ReservationDetails balance={reservations} accounts={accounts} unit={unit} />
            </div>
          </>
        ) : (
          <>
            <span>After keep-back</span>
            <div>
              <strong>
                {afterKeepBack === null ? '-' : `${formatQuantity(afterKeepBack)} ${unit}`}
              </strong>
              {!editing && <small>Reservation check needed</small>}
            </div>
          </>
        )}
      </div>
      {editing && (
        <div className="keep-back-edit-details">
          {verified ? (
            <div aria-live="polite">
              <p>
                <strong>Available for marketplaces</strong>
                {' · '}
                <strong>{available === null ? '—' : `${formatQuantity(available)} ${unit}`}</strong>
              </p>
              <p>
                {formatQuantity(verified.physical)} in Tally −{' '}
                {valid ? formatQuantity(amount) : '…'} kept back −{' '}
                {formatQuantity(verified.reservedUnits)} reserved for orders.
              </p>
            </div>
          ) : (
            <p>
              {check === null
                ? 'Checking unbilled orders…'
                : 'Order reservations need a fresh check before marketplace stock can be confirmed.'}
            </p>
          )}
          {floorSize && available !== null && (
            <p>
              Set of {floorSize} can supply {Math.floor(available / floorSize)} complete{' '}
              {Math.floor(available / floorSize) === 1 ? 'set' : 'sets'}. The tyre minimum
              advertises 5 before any sales allowance.
            </p>
          )}
          <p>
            {!mappedListings.length
              ? 'This value will apply when you map a marketplace listing to this item.'
              : !syncOn
                ? 'Stockbridge rechecks calculated drafts after you save. Company sync is off, so review any changes you want to publish.'
                : mappedListings.every((listing) => listing.paused)
                  ? 'Stockbridge rechecks calculated drafts after you save. All mapped listings are paused, so automatic updates wait until you resume sync.'
                  : 'Eligible listings use this value on the next sync.'}
          </p>
          {(!valid || changed || error) && (
            <p className="text-danger" role="alert">
              {changed
                ? 'This item changed. Cancel to see its latest stock and re-enter the amount.'
                : !valid
                  ? amount > Number.MAX_SAFE_INTEGER
                    ? 'This quantity is too large. Enter a smaller number.'
                    : 'Enter a quantity of 0 or more.'
                  : error}
            </p>
          )}
          <div className="keep-back-actions">
            <button className="button primary" type="submit" disabled={busy || !valid || changed}>
              Save
            </button>
            <button className="text-button" type="button" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
