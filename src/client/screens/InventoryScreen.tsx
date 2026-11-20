import { useCallback, useState } from 'react';
import type { AutomationPreview } from '../../shared/automation.js';
import type {
  CalculationRow,
  Listing,
  Review,
  Snapshot,
  StockItem,
} from '../../shared/contracts.js';
import { actionScope, inventoryGroups } from '../selectors.js';
import { Icon, Stat } from '../components.js';
import { formatCompanyStockIssue, formatDateTime as time } from '../format.js';
import type { Workspace } from '../useWorkspace.js';
import { ItemRows } from './InventoryTable.js';
import { HistoryDialog, RemoveMappingDialog, ReviewDialog } from './InventoryDialogs.js';
import { MappingDialog } from './MappingDialog.js';
import { AutomationDialog } from './AutomationDialog.js';
import { CalculationFeedback } from './CalculationFeedback.js';

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
  const [automationReview, setAutomationReview] = useState<{
    preview: AutomationPreview;
    trial: boolean;
  } | null>(null);
  const [mapping, setMapping] = useState<{ item: StockItem; listingId?: string } | null>(null);
  const [removeListing, setRemoveListing] = useState<Listing | null>(null);
  const [historyListing, setHistoryListing] = useState<Listing | null>(null);
  const [lastCalculation, setLastCalculation] = useState<{
    scope: string;
    rows: CalculationRow[];
  } | null>(null);

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
  const scopeKey = JSON.stringify([companyId, accountId, [...scope].sort()]);
  const proposals = new Map(state.proposals.map((proposal) => [proposal.listingId, proposal]));
  const calculation =
    lastCalculation?.scope === scopeKey
      ? lastCalculation.rows.filter(
          (row) => row.status === 'blocked' || proposals.has(row.listingId),
        )
      : null;
  const blockedIds = new Set(
    calculation?.filter((row) => row.status === 'blocked').map((row) => row.listingId),
  );
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
  const reviewIds = calculation
    ? calculation.filter((row) => row.status !== 'blocked').map((row) => row.listingId)
    : scope;
  const scopedProposalCount = reviewIds.filter((id) => proposals.has(id)).length;
  const draftCount = companyListings.filter((listing) => proposals.has(listing.id)).length;
  const brandOptions = [...new Set(companyItems.map((item) => item.brand).filter(Boolean))].sort();
  const packOptions = [
    ...new Set(
      companyListings
        .map((listing) => listing.packSize)
        .filter((value): value is number => value !== null),
    ),
  ].sort((a, b) => a - b);

  async function openReview(ids: string[] = reviewIds) {
    if (dirtyListings.length) return;
    const result = await workspace.prepareReview(companyId, ids);
    if (result.ok) setReview(result.value);
  }
  async function calculate() {
    setLastCalculation(null);
    const result = await workspace.calculate(companyId, scope);
    if (result.ok) setLastCalculation({ scope: scopeKey, rows: result.value });
  }
  async function togglePause(listing: Listing) {
    const result = await mutate(
      '/pause',
      {
        companyId,
        listingIds: [listing.id],
        listingVersion: listing.version,
        paused: !listing.paused,
      },
      listing.paused ? 'Unlocking listing and calculating proposed stock' : 'Pausing Tally sync',
      listing.paused
        ? (snapshot) => {
            const draft = snapshot.proposals.find((row) => row.listingId === listing.id);
            return draft && !draft.stale && !draft.edited
              ? `${listing.sku} unlocked. Proposed stock recalculated to ${draft.quantity}.`
              : `${listing.sku} unlocked. See the listing for the calculation result.`;
          }
        : 'Tally sync paused at this location until you choose Resume sync.',
    );
    if (listing.paused && result.ok) setLastCalculation(null);
  }
  function toggleSelection(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }
  async function openAutomation(trial: boolean) {
    const result = await workspace.previewAutomation(companyId);
    if (result.ok) setAutomationReview({ preview: result.value, trial });
  }
  function disableAutomation() {
    setAutomationReview(null);
    void mutate(
      '/automation',
      { companyId, enabled: false },
      'Saving company automation',
      'Automatic stock updates turned off for this company.',
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
      <div className="page-heading inventory-heading">
        <h1>Inventory</h1>
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => void workspace.refreshTally(companyId || undefined)}
        >
          <Icon name="refresh" className={busy === 'Refreshing Tally' ? 'spin' : ''} />
          {busy === 'Refreshing Tally' ? 'Refreshing…' : 'Refresh Tally'}
        </button>
      </div>
      <div className="stat-grid inventory-summary">
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
            <span>Flipkart seller</span>
            <select
              aria-label="Seller account"
              value={accountId}
              onChange={(event) => changeAccount(event.target.value)}
            >
              {!state.accounts.length && <option value="">No seller account</option>}
              {state.accounts.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {company && (
          <div className="company-sync">
            <div>
              <strong>Automatic stock updates · {company.automation ? 'On' : 'Off'}</strong>
              <small>
                {state.mode === 'demo' ? 'Simulates updates' : 'Updates Flipkart stock'} for
                eligible listings across all seller accounts for {company.name}. Checks include
                Tally stock changes and verified Flipkart sales that reduce shared stock.
              </small>
            </div>
            <div className="company-sync-actions">
              {!company.automation && (
                <button
                  className="button secondary compact"
                  disabled={!!busy}
                  onClick={() => void openAutomation(true)}
                >
                  Try one listing
                </button>
              )}
              <button
                className="button secondary compact"
                disabled={!!busy}
                onClick={() =>
                  company.automation ? disableAutomation() : void openAutomation(false)
                }
              >
                {company.automation ? 'Turn off automatic updates' : 'Review automatic updates'}
              </button>
            </div>
          </div>
        )}
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
              onClick={() => void calculate()}
            >
              <Icon name="refresh" />
              Calculate
            </button>
            <button
              className="button secondary compact"
              disabled={!!busy || !scope.length || dirtyListings.length > 0}
              onClick={async () => {
                const result = await mutate(
                  '/zero',
                  { companyId, listingIds: scope },
                  'Preparing zero stock',
                  'Zero-stock drafts saved. Review and publish to pause Tally sync for these locations.',
                );
                if (result.ok) setLastCalculation(null);
              }}
            >
              <span className="zero-symbol">0</span>Set to zero
            </button>
            <button
              className="button primary compact"
              disabled={!!busy || !scopedProposalCount || dirtyListings.length > 0}
              onClick={() => void openReview()}
            >
              {blockedIds.size > 0 && scopedProposalCount
                ? 'Review ready drafts'
                : 'Review changes'}
              {scopedProposalCount > 0 && (
                <span className="button-count">{scopedProposalCount}</span>
              )}
              <Icon name="arrow" />
            </button>
          </div>
        </div>
        {!!calculation?.length && (
          <CalculationFeedback
            rows={calculation}
            state={state}
            busy={!!busy}
            onFixPack={(item, listingId) => setMapping({ item, listingId })}
          />
        )}
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
                  <th>Set of</th>
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
                    onMap={() => setMapping({ item })}
                    onEditPack={(listing) => setMapping({ item, listingId: listing.id })}
                    onSave={async (listing, amount) => {
                      const result = await mutate(
                        '/proposals',
                        { companyId, listingId: listing.id, quantity: amount },
                        'Saving draft',
                        'Draft saved. Review and publish when ready.',
                      );
                      if (result.ok) setLastCalculation(null);
                      return result;
                    }}
                    onPause={(listing) => void togglePause(listing)}
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
            {company?.stockIssue && `${formatCompanyStockIssue(company.stockIssue)}. `}
            Last successful Tally read: {time(company?.lastSuccess)}
          </span>
        </div>
      </section>
      <div className="info-strip">
        <Icon name="info" />
        <p>
          <strong>Review saved proposals before publishing.</strong>{' '}
          {state.mode === 'demo'
            ? 'This sample workspace simulates stock updates.'
            : 'Publishing updates stock on Flipkart for the reviewed destinations.'}
        </p>
      </div>
      {review && (
        <ReviewDialog
          state={state}
          review={review}
          onClose={() => setReview(null)}
          onPublish={workspace.publishReview}
        />
      )}
      {automationReview && !company?.automation && (
        <AutomationDialog
          initial={automationReview.preview}
          startWithTrial={automationReview.trial}
          demo={state.mode === 'demo'}
          workspace={workspace}
          onClose={() => setAutomationReview(null)}
        />
      )}
      {mapping && (
        <MappingDialog
          item={state.items.find((item) => item.id === mapping.item.id) ?? mapping.item}
          editListingId={mapping.listingId}
          state={state}
          accountId={accountId}
          busy={!!busy}
          onClose={() => setMapping(null)}
          onSave={async (input) => {
            const saved = await mutate(
              '/mappings',
              input,
              'Saving mapping',
              'Mapping and Set of saved.',
            );
            if (
              saved.ok &&
              calculation?.some((row) => row.listingId === input.listingId && row.fix === 'pack')
            ) {
              const checked = await workspace.calculate(companyId, [input.listingId]);
              if (checked.ok)
                setLastCalculation((previous) =>
                  previous?.scope === scopeKey
                    ? {
                        ...previous,
                        rows: previous.rows.map((row) =>
                          row.listingId === input.listingId ? checked.value[0] : row,
                        ),
                      }
                    : previous,
                );
            }
            return saved;
          }}
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
