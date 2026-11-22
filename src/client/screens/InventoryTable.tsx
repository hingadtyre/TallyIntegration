import type { Listing, Proposal, Snapshot, StockItem } from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { Icon, ResumeSyncButton } from '../components.js';
import {
  formatDateTime as time,
  formatQuantity as quantity,
  formatPolicy as policyLabel,
} from '../format.js';
import { isLowStock } from '../selectors.js';
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
  onEditPack,
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
  onEditPack: (listing: Listing) => void;
  onSave: (listing: Listing, quantity: number) => Promise<ActionResult<Snapshot>>;
  onPause: (listing: Listing) => void;
  onReview: (listing: Listing) => void;
  onHistory: (listing: Listing) => void;
  onRemove: (listing: Listing) => void;
  onDirty: (listingId: string, dirty: boolean) => void;
}) {
  const low = isLowStock(item);
  return (
    <>
      <tr className="parent-row">
        <td colSpan={7}>
          <div className="stock-group">
            {listings.length > 0 ? (
              <button
                className="expand-button"
                onClick={onToggleCollapse}
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${item.name}`}
              >
                <Icon name="chevron" className={collapsed ? '' : 'expanded'} />
              </button>
            ) : (
              <span className="stock-group-icon">
                <Icon name="box" />
              </span>
            )}
            <div className="stock-group-name">
              <div className="item-name">{item.name}</div>
              <div className="item-meta">
                {item.brand && <span>{item.brand}</span>}
                <span>
                  {listings.length
                    ? `${listings.length} matching listing${listings.length === 1 ? '' : 's'}`
                    : 'No mapped listing'}
                </span>
              </div>
            </div>
            <div className="group-stock">
              <span>Tally stock</span>
              <strong>
                {quantity(item.physical)} {item.unit || 'base units'}
              </strong>
              {low && <small>Low stock</small>}
            </div>
            <span className="parent-observation">Observed {time(item.observedAt)}</span>
            <button className="text-button map-button" disabled={busy} onClick={onMap}>
              <Icon name="plus" /> Map listing
            </button>
          </div>
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
                    {accountName} · {listing.location || 'Pickup location pending'}
                  </small>
                </div>
              </div>
            </td>
            <td data-label="Set of">
              <button
                className={`pack-tag ${listing.verified ? '' : 'unverified'}`}
                title={listing.packEvidence.replace(
                  /\b1 Tally units per sale\b/,
                  '1 Tally unit per sale',
                )}
                aria-label={`Edit Set of for ${listing.sku} at ${listing.location || 'pending pickup location'}`}
                disabled={busy}
                onClick={() => onEditPack(listing)}
              >
                {listing.packSize === null ? 'Unknown' : `Set of ${listing.packSize}`}{' '}
                <Icon name="edit" />
              </button>
              {listing.packSource && (
                <small>{listing.packSource === 'packages' ? 'Package count' : 'Custom'}</small>
              )}
              {!listing.verified && <small className="text-amber">Review needed</small>}
              {listing.packSource === 'packages' &&
                listing.packageAvailable &&
                listing.packSize !== listing.packageCount && (
                  <small className="text-amber">
                    Packages changed from {listing.packSize} to {listing.packageCount}
                  </small>
                )}
              {listing.packSource === 'manual' && listing.packageAvailable && (
                <small>Flipkart packages: {listing.packageCount}</small>
              )}
              {listing.packageAvailable === false && (
                <small title={`Last successful check: ${time(listing.packageObservedAt)}`}>
                  Package count unavailable
                </small>
              )}
            </td>
            <td className="observed-cell" data-label="Observed stock">
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
            <td data-label="Proposed stock">
              <QuantityEditor
                key={`${listing.id}:${proposals.get(listing.id)?.createdAt ?? 'new'}:${proposals.get(listing.id)?.listingVersion ?? listing.proposalIssue ?? ''}`}
                listing={listing}
                proposal={proposals.get(listing.id)}
                disabled={busy}
                onSave={(amount) => onSave(listing, amount)}
                onDirty={onDirty}
              />
            </td>
            <td data-label="Policy & automation">
              {(!listing.paused || listing.policy === 'limited') && (
                <span className={`policy-pill policy-${listing.policy}`}>
                  <span className="status-dot" />
                  {policyLabel(listing)}
                </span>
              )}
              {listing.paused ? (
                <ResumeSyncButton
                  sku={listing.sku}
                  location={listing.location}
                  disabled={busy}
                  onResume={() => onPause(listing)}
                />
              ) : (
                <>
                  <small>{listing.automationStatus ?? 'Stockbridge status unavailable'}</small>
                  <button
                    className="automation-button"
                    disabled={busy}
                    onClick={() => onPause(listing)}
                    title="Pause automatic stock updates at this location."
                  >
                    <Icon name="pause" />
                    Pause automation
                  </button>
                </>
              )}
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
    </>
  );
}
