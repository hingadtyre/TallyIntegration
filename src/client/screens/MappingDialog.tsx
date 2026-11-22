import { useState, type FormEvent } from 'react';
import type { Listing, MappingInput, Snapshot, StockItem } from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { Icon, Modal } from '../components.js';
import { formatDateTime } from '../format.js';
import { MappingListingPicker } from './MappingListingPicker.js';

export type SaveMapping = (mapping: MappingInput) => Promise<ActionResult<Snapshot>>;

export function MappingDialog({
  item,
  state,
  accountId,
  editListingId,
  busy,
  onClose,
  onSave,
}: {
  item: StockItem;
  state: Snapshot;
  accountId: string;
  editListingId?: string;
  busy: boolean;
  onClose: () => void;
  onSave: SaveMapping;
}) {
  const [selectedId, setSelectedId] = useState(editListingId ?? '');
  const skuMappings = new Set(
    state.listings
      .filter((row) => row.accountId === accountId && row.skuMappingId)
      .map((row) => row.sku),
  );
  const listings = state.listings.filter((listing) =>
    editListingId
      ? listing.id === editListingId &&
        listing.itemId === item.id &&
        (!accountId || listing.accountId === accountId)
      : Boolean(accountId) &&
        listing.accountId === accountId &&
        listing.itemId === null &&
        (!skuMappings.has(listing.sku) || !!listing.marketplaceListingId),
  );
  const listing = listings.find((entry) => entry.id === selectedId);
  const company = state.companies.find((entry) => entry.id === item.companyId);
  const companyName = company?.name ?? item.companyId;
  const title = editListingId ? 'Edit Set of' : 'Map an existing listing';

  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="modal-intro">
        {companyName} · <strong>{item.name}</strong> · {item.unit || 'base units'}
      </p>
      {editListingId ? (
        listing && (
          <p>
            <strong className="sku">{listing.sku}</strong> · {listing.title}
          </p>
        )
      ) : !accountId ? (
        <div className="empty-state compact-empty">
          <Icon name="marketplaces" />
          <h3>Choose a seller account</h3>
          <p>Select a Flipkart seller account in Inventory to see its listings.</p>
        </div>
      ) : listings.length > 0 ? (
        <MappingListingPicker
          key={JSON.stringify([accountId, item.id])}
          listings={listings}
          item={item}
          accountName={
            state.accounts.find((account) => account.id === accountId)?.name ?? accountId
          }
          selected={listing}
          onChoose={setSelectedId}
          busy={busy}
        />
      ) : (
        <div className="empty-state compact-empty">
          <Icon name="connections" />
          <h3>No unmapped listings available</h3>
          <p>Refresh this seller account's listings in Marketplaces.</p>
        </div>
      )}
      {listing ? (
        <PackForm
          key={JSON.stringify([
            listing.id,
            listing.version,
            item.id,
            item.unit,
            company?.automation,
          ])}
          listing={listing}
          item={item}
          company={companyName}
          companySync={!!company?.automation}
          busy={busy}
          onClose={onClose}
          onSave={onSave}
        />
      ) : (
        <div className="modal-actions">
          <button className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled>
            Save mapping
          </button>
        </div>
      )}
    </Modal>
  );
}

export function PackForm({
  listing,
  item,
  company,
  companySync,
  busy,
  onSave,
  onClose,
  order,
}: {
  listing: Listing;
  item: StockItem;
  company: string;
  companySync: boolean;
  busy: boolean;
  onSave: SaveMapping;
  onClose: () => void;
  order?: {
    accountId: string;
    marketplaceListingId: string;
    location: string;
  };
}) {
  const packages = listing.packageAvailable ? (listing.packageCount ?? null) : null;
  const changed =
    listing.packSource === 'packages' &&
    listing.packSize != null &&
    packages != null &&
    listing.packSize !== packages;
  const [source, setSource] = useState<'packages' | 'manual'>(
    listing.packSource ?? (packages != null && listing.packSize == null ? 'packages' : 'manual'),
  );
  const [customSize, setCustomSize] = useState(listing.packSize?.toString() ?? '');
  const [tyreFloor, setTyreFloor] = useState(listing.tyreFloor === true);
  const [confirmedSize, setConfirmedSize] = useState<number | null>(null);
  const [error, setError] = useState('');
  const choices = listing.pickupChoices ?? [];
  const [pickup, setPickup] = useState(order?.location ?? (choices.length === 1 ? choices[0] : ''));
  const [keepPaused, setKeepPaused] = useState(listing.paused);
  const size = source === 'packages' ? packages : Number(customSize);
  const valid = size !== null && Number.isSafeInteger(size) && size > 0;
  const confirmed = valid && confirmedSize === size;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !valid || !confirmed) return;
    setError('');
    const result = await onSave({
      listingId: listing.id,
      ...(!listing.location && { pickupLocation: pickup }),
      itemId: item.id,
      confirmPackEvidence: true,
      expectedUnit: item.unit,
      packSource: source,
      packSize: size,
      listingVersion: listing.version,
      ...(order && {
        orderSource: {
          listingId: order.marketplaceListingId,
          locationId: order.location,
          companyId: item.companyId,
          accountId: order.accountId,
        },
      }),
      ...((order || !listing.itemId) && keepPaused && { keepPaused: true }),
      sourceScope: 'company',
      tyreFloor,
    });
    if (result.ok) onClose();
    else setError(result.error);
  }
  return (
    <form onSubmit={(event) => void save(event)}>
      <fieldset className="pack-fields" disabled={busy}>
        <legend>Set of</legend>
        <p>How many {item.unit || 'Tally units'} of this item does one sale consume?</p>
        {!listing.location && !order && (
          <label className="field">
            <span>Flipkart pickup location</span>
            <select
              value={pickup}
              onChange={(event) => {
                setPickup(event.target.value);
                setConfirmedSize(null);
              }}
            >
              <option value="">Choose later</option>
              {choices.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <small>
              You can save the mapping now. Stock updates use the pickup location you confirm for
              this seller.
            </small>
          </label>
        )}
        {changed && (
          <p className="message warning" role="status">
            Flipkart package count changed from {listing.packSize} to {packages}. Review this
            mapping before publishing.
          </p>
        )}
        {packages === null && (
          <p className="text-amber">
            Package count unavailable.
            {listing.packageObservedAt &&
              ` Last observed count: ${listing.packageCount}. Checked ${formatDateTime(listing.packageObservedAt)}.`}
          </p>
        )}
        <label className="checkbox-label">
          <input
            type="radio"
            name="pack-source"
            checked={source === 'packages'}
            disabled={packages === null}
            onChange={() => {
              setSource('packages');
              setConfirmedSize(null);
            }}
          />
          <span>
            {changed
              ? `Use ${packages} (current package count)`
              : `Use package count${packages === null ? '' : ` (${packages})`}`}
          </span>
        </label>
        <label className="checkbox-label">
          <input
            type="radio"
            name="pack-source"
            checked={source === 'manual'}
            onChange={() => {
              setSource('manual');
              setConfirmedSize(null);
            }}
          />
          <span>
            {changed
              ? `Keep ${listing.packSize} as my own value or enter a number`
              : 'Enter a number'}
          </span>
        </label>
        {source === 'manual' && (
          <label className="field">
            <span>Tally units per sale</span>
            <input
              type="number"
              min="1"
              step="1"
              required
              value={customSize}
              onChange={(event) => {
                setCustomSize(event.target.value);
                setConfirmedSize(null);
              }}
            />
          </label>
        )}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={tyreFloor}
            onChange={(event) => {
              setTyreFloor(event.target.checked);
              setConfirmedSize(null);
            }}
          />
          <span>
            Apply the Flipkart tyre minimum of 5 when at least one complete set is available. Zero
            complete sets means zero stock.
          </span>
        </label>
        {(order || !listing.itemId) && (
          <>
            {listing.paused ? (
              <p>Stock updates are paused for this location. You can resume sync in Inventory.</p>
            ) : (
              <>
                <p>
                  {companySync
                    ? 'Company sync is on. This location can receive stock updates once its orders and stock have been checked.'
                    : 'Company sync is off. This location can join when you enable company sync.'}
                </p>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={keepPaused}
                    onChange={(event) => setKeepPaused(event.target.checked)}
                  />
                  <span>Keep this listing paused</span>
                </label>
              </>
            )}
          </>
        )}
        <label className="checkbox-label mapping-confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={!valid}
            onChange={(event) => setConfirmedSize(event.target.checked ? size : null)}
          />
          <span>
            I confirm the item and Set of value
            {listing.location || pickup ? (
              <>
                , and that the full stock of this item in <strong>{company}</strong> supplies{' '}
                <strong>{listing.location || pickup}</strong>
              </>
            ) : (
              <>
                {' '}
                for <strong>{company}</strong>. Stock updates will wait for a pickup location
              </>
            )}
            .{order && ' This Set of applies to the orders being checked.'}
          </span>
        </label>
      </fieldset>
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button className="button primary" disabled={busy || !confirmed || !valid}>
          {order
            ? 'Save mapping and check orders'
            : listing.itemId
              ? 'Save Set of'
              : 'Save mapping'}
        </button>
      </div>
    </form>
  );
}
