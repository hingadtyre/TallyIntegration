import { useState, type FormEvent } from 'react';
import type { Listing, MappingInput, Snapshot, StockItem } from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { Icon, Modal } from '../components.js';
import { formatDateTime } from '../format.js';
import { MappingListingPicker } from './MappingListingPicker.js';

type SaveMapping = (mapping: MappingInput) => Promise<ActionResult<Snapshot>>;

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
  const listings = state.listings.filter((listing) =>
    editListingId
      ? listing.id === editListingId &&
        listing.itemId === item.id &&
        (!accountId || listing.accountId === accountId)
      : Boolean(accountId) && listing.accountId === accountId && listing.itemId === null,
  );
  const listing = listings.find((entry) => entry.id === selectedId);
  const company =
    state.companies.find((entry) => entry.id === item.companyId)?.name ?? item.companyId;
  const title = editListingId ? 'Edit Set of' : 'Map an existing listing';

  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="modal-intro">
        {company} · <strong>{item.name}</strong> · {item.unit || 'base units'}
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
          key={JSON.stringify([listing.id, listing.version, item.id, item.unit])}
          listing={listing}
          item={item}
          company={company}
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

function PackForm({
  listing,
  item,
  company,
  busy,
  onSave,
  onClose,
}: {
  listing: Listing;
  item: StockItem;
  company: string;
  busy: boolean;
  onSave: SaveMapping;
  onClose: () => void;
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
  const size = source === 'packages' ? packages : Number(customSize);
  const valid = size !== null && Number.isSafeInteger(size) && size > 0;
  const confirmed = valid && confirmedSize === size;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !valid || !confirmed) return;
    setError('');
    const result = await onSave({
      listingId: listing.id,
      itemId: item.id,
      confirmPackEvidence: true,
      expectedUnit: item.unit,
      packSource: source,
      packSize: size,
      listingVersion: listing.version,
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
        <label className="checkbox-label mapping-confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={!valid}
            onChange={(event) => setConfirmedSize(event.target.checked ? size : null)}
          />
          <span>
            I confirm the item and Set of value, and that the full stock of this item in{' '}
            <strong>{company}</strong> supplies <strong>{listing.location}</strong>.
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
          {listing.itemId ? 'Save Set of' : 'Save mapping'}
        </button>
      </div>
    </form>
  );
}
