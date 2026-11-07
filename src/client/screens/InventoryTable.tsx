import type { Listing, Proposal, Snapshot, StockItem } from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { Icon } from '../components.js';
import {
  formatDateTime as time,
  formatQuantity as quantity,
  formatPolicy as policyLabel,
} from '../format.js';
import { QuantityEditor } from './QuantityEditor.js';
export function ItemRows({
  item,
  listings,
  collapsed,
  selected,
  proposals,
  busy,
  accountName,
  onToggleCollapse,
  onSelect,
  onMap,
  onSave,
  onPause,
  onReview,
  onHistory,
  onRemove,
  onDirty,
}: {
  item: StockItem;
  listings: Listing[];
  collapsed: boolean;
  selected: string[];
  proposals: Map<string, Proposal>;
  busy: boolean;
  accountName: string;
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onMap: () => void;
  onSave: (listing: Listing, quantity: number) => Promise<ActionResult<Snapshot>>;
  onPause: (listing: Listing) => void;
  onReview: (listing: Listing) => void;
  onHistory: (listing: Listing) => void;
  onRemove: (listing: Listing) => void;
  onDirty: (listingId: string, dirty: boolean) => void;
}) {
  const low = item.physical !== null && item.physical <= item.lowStockThreshold;
  return (
    <>
      <tr className="parent-row">
        <td className="select-column">
          <button
            className="expand-button"
            disabled={!listings.length}
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${item.name}`}
          >
            <Icon name="chevron" className={collapsed ? '' : 'expanded'} />
          </button>
        </td>
        <td>
          <div className="item-name">{item.name}</div>
          <div className="item-meta">
            {item.brand && <span>{item.brand}</span>}
            <span>
              {listings.length
                ? `${listings.length} matching listing${listings.length === 1 ? '' : 's'}`
                : 'No mapped listing'}
            </span>
          </div>
        </td>
        <td className={`physical-cell ${low ? 'low-stock' : ''}`}>
          <strong>{quantity(item.physical)}</strong>
          <span>{item.unit || 'base units'}</span>
          {low && <small>Low stock</small>}
        </td>
        <td colSpan={4}>
          <span className="parent-observation">Observed {time(item.observedAt)}</span>
        </td>
        <td>
          <button className="text-button map-button" disabled={busy} onClick={onMap}>
            <Icon name="plus" />
            Map listing
          </button>
        </td>
      </tr>
      {!collapsed &&
        listings.map((listing) => (
          <tr
            className={`listing-row ${selected.includes(listing.id) ? 'row-selected' : ''}`}
            key={listing.id}
          >
            <td className="select-column">
              <input
                type="checkbox"
                aria-label={`Select ${listing.sku}`}
                checked={selected.includes(listing.id)}
                onChange={() => onSelect(listing.id)}
              />
            </td>
            <td>
              <div className="listing-identity">
                <span className="branch-line" />
                <div>
                  <span className="sku">{listing.sku}</span>
                  <p className="listing-title" title={listing.title}>
                    {listing.title}
                  </p>
                  <small>
                    {accountName} · {listing.location}
                  </small>
                </div>
              </div>
            </td>
            <td
              className="shared-stock-cell"
              title="Uses the full physical stock of the parent Tally item"
            >
              ↳ shared
            </td>
            <td>
              <span
                className={`pack-tag ${listing.verified ? '' : 'unverified'}`}
                title={listing.packEvidence}
              >
                {listing.packSize === null ? 'Unknown' : `Set of ${listing.packSize}`}
              </span>
              {!listing.verified && <small className="text-amber">Needs verification</small>}
            </td>
            <td className="observed-cell">
              <strong>{quantity(listing.observed)}</strong>
              <small title={time(listing.observedAt)}>
                {listing.observedAt
                  ? new Date(listing.observedAt).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'Not observed'}
              </small>
            </td>
            <td>
              <QuantityEditor
                key={`${listing.id}:${proposals.get(listing.id)?.createdAt ?? 'new'}`}
                listing={listing}
                proposal={proposals.get(listing.id)}
                disabled={busy}
                onSave={(amount) => onSave(listing, amount)}
                onDirty={onDirty}
              />
            </td>
            <td>
              <span className={`policy-pill policy-${listing.policy}`}>
                <span className="status-dot" />
                {policyLabel(listing)}
              </span>
              <button
                className={`automation-button ${listing.paused ? 'is-paused' : ''}`}
                disabled={busy}
                onClick={() => onPause(listing)}
                title={
                  listing.paused
                    ? 'Resume automatic publication with the current policy'
                    : 'Pause all automatic publication; preserve the current policy'
                }
              >
                <Icon name={listing.paused ? 'play' : 'pause'} />
                {listing.paused ? 'Paused · resume' : 'Pause automation'}
              </button>
            </td>
            <td>
              <details className="row-menu">
                <summary aria-label={`Actions for ${listing.sku}`}>•••</summary>
                <div>
                  <button
                    disabled={busy || !proposals.has(listing.id)}
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      onReview(listing);
                    }}
                  >
                    Review proposal
                  </button>
                  <button
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      onHistory(listing);
                    }}
                  >
                    View history
                  </button>
                  <button
                    className="text-danger"
                    disabled={busy}
                    onClick={(event) => {
                      event.currentTarget.closest('details')?.removeAttribute('open');
                      onRemove(listing);
                    }}
                  >
                    Remove mapping
                  </button>
                </div>
              </details>
            </td>
          </tr>
        ))}
      {!collapsed && !listings.length && (
        <tr className="unmapped-row">
          <td />
          <td colSpan={7}>
            This Tally item is visible even without a marketplace listing.{' '}
            <button className="text-button" onClick={onMap} disabled={busy}>
              Map an existing listing
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
