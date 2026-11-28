import { useState } from 'react';
import type {
  DraftEditBaseline,
  ItemReservations,
  Listing,
  Proposal,
  SellerAccount,
  Snapshot,
  StockItem,
} from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { Icon, ResumeSyncButton } from '../components.js';
import {
  formatDateTime as time,
  formatQuantity as quantity,
  formatPolicy as policyLabel,
} from '../format.js';
import { isLowStock } from '../selectors.js';
import { QuantityEditor } from './QuantityEditor.js';
import { KeepBackEditor } from './KeepBackEditor.js';
import { MarketplaceSeller } from '../MarketplaceSeller.js';
import { marketplaceName } from '../../shared/marketplaces.js';

function compareListingRows(a: Listing, b: Listing): number {
  if (a.packSize !== b.packSize) return (a.packSize ?? Infinity) - (b.packSize ?? Infinity);
  return a.sku.localeCompare(b.sku) || a.location.localeCompare(b.location);
}

export function ItemRows({
  item,
  listings,
  visibleListings,
  visibleItem,
  dirtyListings,
  collapsed,
  selected,
  proposals,
  reviewDraftIds,
  busy,
  accounts,
  reservations,
  allListings,
  demo,
  syncOn,
  onSaveKeepBack,
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
  visibleListings: Set<string>;
  visibleItem: boolean;
  dirtyListings: string[];
  collapsed: boolean;
  selected: string[];
  proposals: Map<string, Proposal>;
  reviewDraftIds: Set<string>;
  busy: boolean;
  accounts: Map<string, SellerAccount>;
  reservations?: ItemReservations;
  allListings: Listing[];
  demo: boolean;
  syncOn: boolean;
  onSaveKeepBack: (quantity: number, version: number) => Promise<ActionResult<Snapshot>>;
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onMap: () => void;
  onEditPack: (listing: Listing) => void;
  onSave: (
    listing: Listing,
    quantity: number,
    baseline: DraftEditBaseline,
  ) => Promise<ActionResult<Snapshot>>;
  onPause: (listing: Listing) => Promise<boolean>;
  onReview: (listing: Listing) => void;
  onHistory: (listing: Listing) => void;
  onRemove: (listing: Listing) => void;
  onDirty: (listingId: string, dirty: boolean) => void;
}) {
  const [localResumes, setLocalResumes] = useState<Record<string, number>>({});
  async function resume(listing: Listing) {
    if (await onPause(listing))
      setLocalResumes((previous) => ({
        ...previous,
        [listing.id]: (previous[listing.id] ?? 0) + 1,
      }));
  }
  const low = isLowStock(item);
  const matchingListings = listings.filter((listing) => visibleListings.has(listing.id)).length;
  return (
    <>
      <tr className="parent-row" hidden={!visibleItem}>
        <td colSpan={7}>
          <div className="stock-group">
            {matchingListings > 0 ? (
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
                  {matchingListings
                    ? `${matchingListings} matching listing${matchingListings === 1 ? '' : 's'}`
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
              <span className="parent-observation">Observed {time(item.observedAt)}</span>
            </div>
            <KeepBackEditor
              item={item}
              accounts={accounts}
              reservations={
                reservations?.itemVersion === item.version &&
                reservations.physical === item.physical
                  ? reservations
                  : undefined
              }
              busy={busy}
              syncOn={syncOn}
              allListings={allListings}
              demo={demo}
              onDirty={onDirty}
              onSave={onSaveKeepBack}
            />
            <button className="text-button map-button" disabled={busy} onClick={onMap}>
              <Icon name="plus" /> Map listing
            </button>
          </div>
        </td>
      </tr>
      {listings
        .filter((listing) => !collapsed || dirtyListings.includes(listing.id))
        .sort(compareListingRows)
        .map((listing) => (
          <tr
            hidden={collapsed || !visibleListings.has(listing.id)}
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
                  {!demo && listing.productUrl && (
                    <a
                      className="icon-button listing-product-link"
                      href={listing.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`View ${listing.sku} on ${marketplaceName(accounts.get(listing.accountId)?.marketplace) ?? 'the marketplace'} (opens in a new tab)`}
                      title={`View product on ${marketplaceName(accounts.get(listing.accountId)?.marketplace) ?? 'the marketplace'} (opens in a new tab)`}
                    >
                      <Icon name="external-link" />
                    </a>
                  )}
                  <p className="listing-title" title={listing.title}>
                    {listing.title}
                  </p>
                  <small>
                    <MarketplaceSeller account={accounts.get(listing.accountId)} /> ·{' '}
                    {listing.location || 'Pickup location pending'}
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
                <small>Reported packages: {listing.packageCount}</small>
              )}
              {listing.packageAvailable === false && (
                <small title={`Last successful check: ${time(listing.packageObservedAt)}`}>
                  Package count unavailable
                </small>
              )}
            </td>
            <td className="observed-cell" data-label="Observed stock">
              <strong>{quantity(listing.observedAt ? listing.observed : null)}</strong>
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
                key={localResumes[listing.id] ?? 0}
                listing={listing}
                proposal={proposals.get(listing.id)}
                disabled={busy}
                onSave={(amount, baseline) => onSave(listing, amount, baseline)}
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
                  onResume={() => void resume(listing)}
                />
              ) : (
                <>
                  <small>{listing.automationStatus ?? 'Stockbridge status unavailable'}</small>
                  <button
                    className="automation-button"
                    disabled={busy}
                    onClick={() => void onPause(listing)}
                    title="Pause automatic stock updates at this location."
                  >
                    <Icon name="pause" />
                    Pause automation
                  </button>
                </>
              )}
            </td>
            <td>
              <details className="row-menu" name="inventory-row-actions">
                <summary aria-label={`Actions for ${listing.sku}`}>•••</summary>
                <div>
                  <button
                    disabled={busy || !!dirtyListings.length || !reviewDraftIds.has(listing.id)}
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
                    disabled={busy || dirtyListings.includes(listing.id)}
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
