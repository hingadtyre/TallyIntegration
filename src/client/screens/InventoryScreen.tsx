import { useCallback, useState } from 'react';
import type { Listing, Review, Snapshot, StockItem } from '../../shared/contracts.js';
import { actionScope, inventoryGroups } from '../selectors.js';
import { Icon, Stat } from '../components.js';
import { formatDateTime as time } from '../format.js';
import type { Workspace } from '../useWorkspace.js';
import { ItemRows } from './InventoryTable.js';
import {
  HistoryDialog,
  MappingDialog,
  RemoveMappingDialog,
  ReviewDialog,
} from './InventoryDialogs.js';

interface InventoryScreenProps {
  state: Snapshot;
  companyId: string;
  accountId: string;
  workspace: Workspace;
  onAccountChange: (id: string) => void;
  onOpenConnections: () => void;
}

/** App keys this screen by company: switching company clears only inventory view state. */
export function InventoryScreen({
  state,
  companyId,
  accountId,
  workspace,
  onAccountChange,
  onOpenConnections,
}: InventoryScreenProps) {
  const { busy, mutate } = workspace;
  const [query, setQuery] = useState('');
  const [brand, setBrand] = useState('');
  const [pack, setPack] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [dirtyListings, setDirtyListings] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [mappingItem, setMappingItem] = useState<StockItem | null>(null);
  const [removeListing, setRemoveListing] = useState<Listing | null>(null);
  const [historyListing, setHistoryListing] = useState<Listing | null>(null);

  const markDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyListings((current) => {
      if (dirty) return current.includes(id) ? current : [...current, id];
      return current.includes(id) ? current.filter((value) => value !== id) : current;
    });
  }, []);
  function changeAccount(id: string) {
    setSelected([]);
    onAccountChange(id);
  }
  const filters = { companyId, accountId, query, brand, pack };
  const groups = inventoryGroups(state, filters);
  const scope = actionScope(state, filters, selected);
  const company = state.companies.find((value) => value.id === companyId);
  const account = state.accounts.find((value) => value.id === accountId);
  const companyItems = state.items.filter((item) => item.companyId === companyId);
  const companyItemIds = new Set(companyItems.map((item) => item.id));
  const companyListings = state.listings.filter(
    (listing) =>
      listing.itemId !== null &&
      companyItemIds.has(listing.itemId) &&
      (!accountId || listing.accountId === accountId),
  );
  const lowStock = companyItems.filter(
    (item) => item.physical !== null && item.physical <= item.lowStockThreshold,
  ).length;
  const visibleIds = groups.flatMap((group) => group.listings.map((listing) => listing.id));
  const hiddenSelected = selected.filter((id) => !visibleIds.includes(id)).length;
  const proposals = new Map(state.proposals.map((proposal) => [proposal.listingId, proposal]));
  const scopedProposalCount = scope.filter((id) => proposals.has(id)).length;
  const draftCount = companyListings.filter((listing) => proposals.has(listing.id)).length;
  const brandOptions = [...new Set(companyItems.map((item) => item.brand).filter(Boolean))].sort();
  const packOptions = [
    ...new Set(
      companyListings
        .map((listing) => listing.packSize)
        .filter((value): value is number => value !== null),
    ),
  ].sort((a, b) => a - b);

  async function openReview(ids: string[] = scope) {
    if (dirtyListings.length) return;
    const result = await workspace.prepareReview(companyId, ids);
    if (result.ok) setReview(result.value);
  }
  function toggleSelection(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }
  function toggleAll() {
    setSelected((current) =>
      visibleIds.every((id) => current.includes(id))
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])],
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR STOCK, CONNECTED</div>
          <h1>Inventory</h1>
          <p>One view of Tally stock and the listings it supplies.</p>
        </div>
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => void workspace.refreshTally(companyId || undefined)}
        >
          <Icon name="refresh" className={busy === 'Refreshing Tally' ? 'spin' : ''} />
          {busy === 'Refreshing Tally' ? 'Refreshing…' : 'Refresh Tally'}
        </button>
      </div>
      <div className="stat-grid">
        <Stat label="Tally stock items" value={companyItems.length} detail="In this company" />
        <Stat
          label="Mapped listings"
          value={companyListings.length}
          detail={account?.name || 'Across seller accounts'}
        />
        <Stat
          label="Low physical stock"
          value={lowStock}
          detail="Based on each item's threshold"
          warm={lowStock > 0}
        />
        <Stat label="Saved proposals" value={draftCount} detail="Awaiting review · nothing sent" />
      </div>
      <section className="inventory-panel" aria-label="Inventory table">
        {dirtyListings.length > 0 && (
          <div className="draft-reminder" role="status">
            {dirtyListings.length} unsaved quantity edit{dirtyListings.length === 1 ? '' : 's'}.
            Save each row using its checkmark before reviewing.
          </div>
        )}
        <div className="panel-heading">
          <div className="panel-title">
            <h2>Stock & listings</h2>
            <span className="count-badge">{groups.length} items</span>
          </div>
          <label className="account-select">
            <span>Destination</span>
            <select
              aria-label="Seller account"
              value={accountId}
              onChange={(event) => changeAccount(event.target.value)}
            >
              {!state.accounts.length && <option value="">No seller account</option>}
              {state.accounts.map((value) => (
                <option key={value.id} value={value.id}>
                  Flipkart · {value.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="filters">
          <label className="search-input">
            <Icon name="search" />
            <input
              aria-label="Search stock items and listings"
              placeholder="Search item, title or SKU…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                className="icon-button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <Icon name="close" />
              </button>
            )}
          </label>
          <select
            aria-label="Filter by brand"
            value={brand}
            onChange={(event) => setBrand(event.target.value)}
          >
            <option value="">All brands</option>
            {brandOptions.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            aria-label="Filter by pack size"
            value={pack}
            onChange={(event) => setPack(event.target.value)}
          >
            <option value="">All pack sizes</option>
            {packOptions.map((value) => (
              <option key={value} value={value}>
                Set of {value}
              </option>
            ))}
          </select>
          {(query || brand || pack) && (
            <button
              className="text-button"
              onClick={() => {
                setQuery('');
                setBrand('');
                setPack('');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <div className="scope-bar">
          <div>
            <strong>
              {selected.length
                ? `${scope.length} selected listings`
                : `${scope.length} filtered listings`}
            </strong>
            <span>
              {selected.length
                ? hiddenSelected
                  ? ` · ${hiddenSelected} hidden by filters`
                  : ' · selection takes priority'
                : ' · all matching rows'}
              {selected.length > 0 && (
                <>
                  {' '}
                  ·{' '}
                  <button className="text-button" onClick={() => setSelected([])}>
                    Clear selection
                  </button>
                </>
              )}
            </span>
          </div>
          <div className="bulk-actions">
            <button
              className="button secondary compact"
              disabled={!!busy || !scope.length || dirtyListings.length > 0}
              onClick={() =>
                void mutate(
                  '/calculate',
                  { companyId, listingIds: scope },
                  'Calculating',
                  'Proposals calculated. Your edited drafts were preserved.',
                )
              }
            >
              <Icon name="refresh" />
              Calculate
            </button>
            <button
              className="button secondary compact"
              disabled={!!busy || !scope.length || dirtyListings.length > 0}
              onClick={() =>
                void mutate(
                  '/zero',
                  { companyId, listingIds: scope },
                  'Preparing zero stock',
                  'Zero-stock drafts saved. Active policies and marketplace stock are unchanged.',
                )
              }
            >
              <span className="zero-symbol">0</span>Set to zero
            </button>
            <button
              className="button primary compact"
              disabled={!!busy || !scopedProposalCount || dirtyListings.length > 0}
              onClick={() => void openReview()}
            >
              Review changes
              {scopedProposalCount > 0 && (
                <span className="button-count">{scopedProposalCount}</span>
              )}
              <Icon name="arrow" />
            </button>
          </div>
        </div>
        {companyItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <Icon name="box" />
            </div>
            <h3>{companyId ? 'No stock items imported yet' : 'Start with your Tally company'}</h3>
            <p>
              Open Tally with the company you want to use, enable its local connection, then
              refresh. All stock items will appear here, including items without a marketplace
              listing.
            </p>
            <button className="button secondary" onClick={() => onOpenConnections()}>
              View connections
              <Icon name="arrow" />
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className="empty-state">
            <Icon name="search" />
            <h3>No matching items</h3>
            <p>Try another name, brand or pack size.</p>
            <button
              className="text-button"
              onClick={() => {
                setQuery('');
                setBrand('');
                setPack('');
              }}
            >
              Reset filters
            </button>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="inventory-table">
              <thead>
                <tr>
                  <th className="select-column">
                    <input
                      type="checkbox"
                      aria-label="Select all filtered listings"
                      checked={
                        visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))
                      }
                      disabled={!visibleIds.length}
                      onChange={toggleAll}
                    />
                  </th>
                  <th>Stock item / mapped listing</th>
                  <th className="number-column">Tally stock</th>
                  <th>Pack</th>
                  <th className="number-column">Observed stock</th>
                  <th>Proposed stock</th>
                  <th>Policy & automation</th>
                  <th className="actions-heading">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(({ item, listings }) => (
                  <ItemRows
                    key={item.id}
                    item={item}
                    listings={listings}
                    collapsed={collapsed.includes(item.id)}
                    selected={selected}
                    proposals={proposals}
                    busy={!!busy}
                    accountName={account?.name || 'Flipkart'}
                    onToggleCollapse={() =>
                      setCollapsed((current) =>
                        current.includes(item.id)
                          ? current.filter((id) => id !== item.id)
                          : [...current, item.id],
                      )
                    }
                    onSelect={toggleSelection}
                    onMap={() => setMappingItem(item)}
                    onSave={(listing, amount) =>
                      mutate(
                        '/proposals',
                        { companyId, listingId: listing.id, quantity: amount },
                        'Saving draft',
                        'Draft saved. Review it before publication; the active policy has not changed.',
                      )
                    }
                    onPause={(listing) =>
                      void mutate(
                        '/pause',
                        { companyId, listingIds: [listing.id], paused: !listing.paused },
                        'Saving automation setting',
                        listing.paused
                          ? 'Pause removed. Marketplace publication is still unavailable in this milestone.'
                          : 'Automatic publication paused for this listing. Its underlying stock policy is preserved.',
                      )
                    }
                    onReview={(listing) => void openReview([listing.id])}
                    onHistory={setHistoryListing}
                    onRemove={setRemoveListing}
                    onDirty={markDirty}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-footer">
          <span>
            <span className="status-dot" />
            Last Tally observation: {time(company?.lastSuccess)}
          </span>
          <span>Pack sizes are verified source values</span>
        </div>
      </section>
      <div className="info-strip">
        <Icon name="info" />
        <p>
          <strong>Review before you publish.</strong> Calculations and edits are saved as drafts.
          Marketplace publishing is not available in this version.
        </p>
      </div>
      {review && <ReviewDialog state={state} review={review} onClose={() => setReview(null)} />}
      {mappingItem && (
        <MappingDialog
          item={mappingItem}
          state={state}
          accountId={accountId}
          busy={!!busy}
          onClose={() => setMappingItem(null)}
          onSave={(listingId) =>
            mutate(
              '/mappings',
              { listingId, itemId: mappingItem.id, confirmPackEvidence: true },
              'Saving mapping',
              'Mapping saved locally. No Tally product or marketplace listing was created.',
            )
          }
        />
      )}
      {removeListing && (
        <RemoveMappingDialog
          listing={removeListing}
          busy={!!busy}
          onClose={() => setRemoveListing(null)}
          onRemove={() =>
            mutate(
              '/mappings/remove',
              { companyId, listingId: removeListing.id, leaveRemoteStock: true },
              'Removing mapping',
              'Mapping removed. Marketplace stock was left unchanged.',
            )
          }
        />
      )}
      {historyListing && (
        <HistoryDialog
          listing={historyListing}
          events={state.activity}
          onClose={() => setHistoryListing(null)}
        />
      )}
    </>
  );
}
