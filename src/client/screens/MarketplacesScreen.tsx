import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/contracts.js';
import type {
  MarketplaceAccount,
  MarketplaceApplyResult,
  MarketplaceChange,
  MarketplaceListingStatus,
  MarketplaceListingView,
  MarketplacePage,
} from '../../shared/marketplace-contracts.js';
import { errorMessage, requestJson } from '../api.js';
import { Icon, ResumeSyncButton } from '../components.js';
import { formatDateTime as time } from '../format.js';
import { marketplaceApi } from '../marketplace-api.js';
import { MarketplaceAccountForm } from './MarketplaceAccountForm.js';
import { MarketplaceStockRecovery, StockRecoveryAction } from './MarketplaceStockRecovery.js';
import {
  MarketplaceListingEditor,
  changeLabels,
  type MarketplaceEditorTarget,
} from './MarketplaceListingEditor.js';

const statuses: Array<{ value: MarketplaceListingStatus | ''; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'READY_FOR_ACTIVATION', label: 'Ready for activation' },
  { value: 'ARCHIVED', label: 'Archived' },
  { value: 'INACTIVATED_BY_FLIPKART', label: 'Inactivated by Flipkart' },
];
const connectionLabels = {
  'not-configured': 'Not configured',
  verified: 'Credentials verified',
  'needs-attention': 'Needs attention',
  unavailable: 'Unavailable',
};
const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});

export function MarketplacesScreen({
  mode,
  onOpenInventory,
}: {
  mode: Snapshot['mode'];
  onOpenInventory: () => void;
}) {
  const [accounts, setAccounts] = useState<MarketplaceAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<'add' | MarketplaceAccount | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void marketplaceApi
      .accounts(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setAccounts(result.accounts);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadAttempt]);
  function updateAccount(account: MarketplaceAccount) {
    setAccounts((current) =>
      current.some((item) => item.id === account.id)
        ? current.map((item) => (item.id === account.id ? account : item))
        : [...current, account],
    );
  }
  const account = accounts.find((item) => item.id === selected);
  return (
    <section className="marketplaces-screen">
      {account ? (
        <MarketplaceListings
          key={account.id}
          account={account}
          demo={mode === 'demo'}
          onBack={() => setSelected(null)}
          onAccountUpdated={updateAccount}
          onOpenInventory={onOpenInventory}
        />
      ) : (
        <>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR SELLER ACCOUNTS</div>
              <h1>Marketplaces</h1>
              <p>Manage each seller account’s listings, prices and stock.</p>
            </div>
            <button className="button primary" disabled={loading} onClick={() => setForm('add')}>
              <Icon name="plus" />
              Add account
            </button>
          </div>
          {loading && <p role="status">Loading marketplace accounts…</p>}
          {error && (
            <div className="message error" role="alert">
              <span>{error}</span>
              <button
                className="button secondary"
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                Retry accounts
              </button>
            </div>
          )}
          {!loading && !error && !accounts.length && (
            <div className="panel marketplace-empty">
              <Icon name="box" />
              <h2>Add your first marketplace account</h2>
              <p>Connect Flipkart to view its listings. A Tally company is not required.</p>
            </div>
          )}
          <div className="marketplace-account-grid">
            {accounts.map((item) => (
              <MarketplaceAccountTile
                key={item.id}
                account={item}
                demo={mode === 'demo'}
                onOpen={() => setSelected(item.id)}
                onCredentials={() => setForm(item)}
                onUpdated={updateAccount}
              />
            ))}
            <button
              className="marketplace-add-tile"
              aria-label="Add another marketplace account"
              disabled={loading}
              onClick={() => setForm('add')}
            >
              <Icon name="plus" />
              <strong>Add account</strong>
              <span>Connect another seller account</span>
            </button>
          </div>
        </>
      )}
      {form && (
        <MarketplaceAccountForm
          account={form === 'add' ? undefined : form}
          demo={mode === 'demo'}
          onClose={() => setForm(null)}
          onSaved={(next) => {
            updateAccount(next);
            setForm(null);
          }}
        />
      )}
    </section>
  );
}

function MarketplaceAccountTile({
  account,
  demo,
  onOpen,
  onCredentials,
  onUpdated,
}: {
  account: MarketplaceAccount;
  demo: boolean;
  onOpen: () => void;
  onCredentials: () => void;
  onUpdated: (account: MarketplaceAccount) => void;
}) {
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const running = useRef(false);
  async function connect(action: 'check' | 'disconnect') {
    if (running.current) return;
    running.current = true;
    setPending(action);
    setError('');
    try {
      onUpdated(await marketplaceApi.connection({ accountId: account.id, action }));
    } catch (failure) {
      setError(errorMessage(failure));
      if (action === 'check')
        onUpdated({
          ...account,
          connection: {
            ...account.connection,
            state: 'needs-attention',
            message: 'Saved access could not be verified. Check again or update the credentials.',
          },
        });
    } finally {
      setPending('');
      running.current = false;
    }
  }
  return (
    <article className="panel marketplace-account" aria-label={account.name} aria-busy={!!pending}>
      <div className="connection-card-top">
        <div className="service-logo flipkart-logo">F</div>
        <span
          className={`badge ${account.connection.state === 'verified' ? 'badge-green' : 'badge-amber'}`}
        >
          {demo ? 'Sample account' : connectionLabels[account.connection.state]}
        </span>
      </div>
      <h2>{account.name}</h2>
      <div className="marketplace-account-provider">Flipkart</div>
      <p>{account.connection.message}</p>
      {account.catalogImportError && (
        <p className="marketplace-error" role="alert">
          {account.catalogImportError} Choose Open listings, then Refresh listings to retry.
        </p>
      )}
      <dl className="connection-details">
        <div>
          <dt>Seller identity</dt>
          <dd>
            {account.sellerId ??
              (account.catalogOwnershipVerified
                ? 'Listing ownership verified · Flipkart did not supply a seller ID'
                : 'Not yet verified')}
          </dd>
        </div>
        <div>
          <dt>Last refresh</dt>
          <dd>{time(account.lastRefreshedAt)}</dd>
        </div>
      </dl>
      {error && (
        <p className="marketplace-error" role="alert">
          {error}
        </p>
      )}
      <button className="button primary marketplace-open" onClick={onOpen}>
        Open listings <Icon name="arrow" />
      </button>
      <div className="marketplace-account-actions">
        <button
          className="text-button"
          disabled={!!pending || demo}
          onClick={() => void connect('check')}
        >
          {pending === 'check' ? 'Checking…' : 'Check connection'}
        </button>
        {!demo && (
          <button className="text-button" disabled={!!pending} onClick={onCredentials}>
            Update credentials
          </button>
        )}
        <button
          className="text-button"
          disabled={!!pending || demo}
          onClick={() => void connect('disconnect')}
        >
          {pending === 'disconnect' ? 'Disconnecting…' : 'Disconnect locally'}
        </button>
      </div>
    </article>
  );
}

interface ResumedProposal {
  listingId: string;
  version: number;
  quantity: number;
}

function MarketplaceListings({
  account,
  demo,
  onBack,
  onAccountUpdated,
  onOpenInventory,
}: {
  account: MarketplaceAccount;
  demo: boolean;
  onBack: () => void;
  onAccountUpdated: (account: MarketplaceAccount) => void;
  onOpenInventory: () => void;
}) {
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState<{
    search: string;
    status: MarketplaceListingStatus | '';
    page: number;
  }>({ search: '', status: '', page: 1 });
  const [data, setData] = useState<MarketplacePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [editor, setEditor] = useState<MarketplaceEditorTarget | null>(null);
  const [recovery, setRecovery] = useState<MarketplaceChange | null>(null);
  const [pendingListings, setPendingListings] = useState<string[]>([]);
  const [resumeResult, setResumeResult] = useState<ResumedProposal | null>(null);
  const [rowErrors, setRowErrors] = useState<
    Record<string, { message: string; uncertain: boolean }>
  >({});
  const alive = useRef(true);
  const request = useRef(0);
  const readInFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++request.current;
    readInFlight.current = true;
    setLoading(true);
    setError('');
    void marketplaceApi
      .listings(account.id, query.search, query.status, query.page, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && generation === request.current) {
          setData(result);
          setRowErrors({});
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && generation === request.current)
          setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted && generation === request.current) {
          readInFlight.current = false;
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [account.id, query, revision]);
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError('');
    try {
      const result = await marketplaceApi.refresh(account.id);
      if (!alive.current) return;
      onAccountUpdated(result.account);
      setRevision((value) => value + 1);
    } catch (failure) {
      if (alive.current) setError(errorMessage(failure));
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }
  function updateListing(listing: MarketplaceListingView) {
    if (!alive.current || listing.accountId !== account.id) return;
    request.current++;
    // Keep the current filters authoritative after invalidating their in-flight read.
    if (readInFlight.current) setRevision((value) => value + 1);
    setData(
      (current) =>
        current && {
          ...current,
          listings: current.listings.map((item) => (item.id === listing.id ? listing : item)),
        },
    );
  }
  function applyResult(result: MarketplaceApplyResult) {
    if (!alive.current || result.change.accountId !== account.id) return;
    // Older reads cannot replace an edit result that arrived while that read was in flight.
    updateListing(result.listing);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[result.listing.id];
      return next;
    });
    setData(
      (current) =>
        current && {
          ...current,
          changes: [
            result.change,
            ...current.changes.filter((item) => item.id !== result.change.id),
          ],
        },
    );
  }
  function setListingPending(id: string, pending: boolean) {
    if (alive.current)
      setPendingListings((current) =>
        pending ? [...current, id] : current.filter((value) => value !== id),
      );
  }
  function openRecovery(change: MarketplaceChange) {
    setEditor(null);
    setRecovery(change);
  }
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <button className="text-button marketplace-back" onClick={onBack}>
        ← All marketplace accounts
      </button>
      <div className="page-heading">
        <div>
          <div className="eyebrow">FLIPKART · {demo ? 'SAMPLE ACCOUNT' : 'SELLER ACCOUNT'}</div>
          <h1>{account.name}</h1>
          <p>All marketplace listings, including those without a Tally mapping.</p>
        </div>
        <button
          className="button secondary"
          disabled={refreshing || loading}
          onClick={() => void refresh()}
        >
          <Icon name="refresh" />
          {refreshing ? 'Refreshing listings…' : 'Refresh listings'}
        </button>
      </div>
      <div className="marketplace-refresh-note">
        <span
          className={`badge ${account.connection.state === 'verified' ? 'badge-green' : 'badge-amber'}`}
        >
          {demo ? 'Sample simulation' : connectionLabels[account.connection.state]}
        </span>
        <span>
          Last successful refresh: {time(data?.lastRefreshedAt ?? account.lastRefreshedAt)}
        </span>
      </div>
      {error && (
        <div className="message error" role="alert">
          <span>{error}</span>
          <button className="button secondary" onClick={() => setRevision((value) => value + 1)}>
            Retry listings
          </button>
        </div>
      )}
      <section className="panel marketplace-listings" aria-label="Marketplace listings">
        <div className="marketplace-filters">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setQuery((current) => ({ ...current, search: searchText.trim(), page: 1 }));
            }}
          >
            <label className="search-input">
              <Icon name="search" />
              <input
                aria-label="Search marketplace listings"
                placeholder="Search title, SKU or product ID"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
            </label>
            <button className="button secondary" type="submit">
              Search
            </button>
          </form>
          <label className="marketplace-status-filter">
            <span>Status</span>
            <select
              aria-label="Listing status"
              value={query.status}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  status: event.target.value as MarketplaceListingStatus | '',
                  page: 1,
                }))
              }
            >
              {statuses.map((status) => (
                <option key={status.value} value={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading ? (
          <p className="marketplace-loading" role="status">
            Loading listings…
          </p>
        ) : data?.listings.length ? (
          <div className="marketplace-table-scroll">
            <table className="marketplace-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Flipkart status</th>
                  <th>MRP</th>
                  <th>Selling price</th>
                  <th>Shipping packages</th>
                  <th>Stock by location</th>
                  <th>Settlement</th>
                </tr>
              </thead>
              <tbody>
                {data.listings.map((listing) => (
                  <MarketplaceListingRow
                    key={listing.id}
                    listing={listing}
                    changes={data.changes.filter((change) => change.listingId === listing.id)}
                    pending={pendingListings.includes(listing.id)}
                    failure={rowErrors[listing.id]}
                    onReload={() => setRevision((value) => value + 1)}
                    resumeResult={resumeResult}
                    onResumeCalculated={setResumeResult}
                    onEdit={setEditor}
                    onResult={applyResult}
                    onReviewRecovery={openRecovery}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="marketplace-empty">
            <h2>No listings to show</h2>
            <p>
              {query.search || query.status
                ? 'Try a different search or status filter.'
                : 'Refresh listings to load this seller account’s marketplace catalogue.'}
            </p>
          </div>
        )}
        <div className="table-footer">
          <span>{data ? `${data.total} matching listings` : 'No observations loaded'}</span>
          <div className="marketplace-pagination">
            <button
              className="button secondary"
              disabled={loading || query.page <= 1}
              onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}
            >
              Previous
            </button>
            <span>
              Page {query.page} of {totalPages}
            </span>
            <button
              className="button secondary"
              disabled={loading || query.page >= totalPages}
              onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}
            >
              Next
            </button>
          </div>
        </div>
      </section>
      {editor && (
        <MarketplaceListingEditor
          target={editor}
          demo={demo}
          onResult={applyResult}
          onReviewRecovery={openRecovery}
          onClose={() => setEditor(null)}
          onOpenInventory={onOpenInventory}
          onPolicyUpdated={updateListing}
          knownChangeIds={data?.changes.map((change) => change.id) ?? []}
          onFailure={(message, uncertain) => {
            if (alive.current)
              setRowErrors((current) => ({
                ...current,
                [editor.listing.id]: { message, uncertain },
              }));
          }}
          onPending={(pending) => setListingPending(editor.listing.id, pending)}
        />
      )}
      {recovery && (
        <MarketplaceStockRecovery
          key={recovery.id}
          change={recovery}
          accountName={account.name}
          onClose={() => setRecovery(null)}
          onResult={applyResult}
          onPending={(pending) => setListingPending(recovery.listingId, pending)}
          onReload={() => {
            if (alive.current) setRevision((value) => value + 1);
          }}
        />
      )}
    </>
  );
}

function MarketplaceListingRow({
  listing,
  changes,
  pending,
  failure,
  onReload,
  resumeResult,
  onResumeCalculated,
  onEdit,
  onResult,
  onReviewRecovery,
}: {
  listing: MarketplaceListingView;
  changes: MarketplaceChange[];
  pending: boolean;
  failure?: { message: string; uncertain: boolean };
  onReload: () => void;
  resumeResult: ResumedProposal | null;
  onResumeCalculated: (result: ResumedProposal) => void;
  onEdit: (target: MarketplaceEditorTarget) => void;
  onResult: (result: MarketplaceApplyResult) => void;
  onReviewRecovery: (change: MarketplaceChange) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [resuming, setResuming] = useState(false);
  const unresolved = changes.find((change) =>
    ['pending', 'sending', 'checking', 'uncertain'].includes(change.state),
  );
  const latest =
    unresolved ?? [...changes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  async function resume(policy: MarketplaceListingView['stockPolicies'][number]) {
    if (resuming || !policy.companyId) return;
    setResuming(true);
    setError('');
    try {
      const snapshot = await requestJson<Snapshot>('/pause', {
        companyId: policy.companyId,
        listingIds: [policy.listingId],
        listingVersion: policy.listingVersion,
        paused: false,
      });
      const destination = snapshot.listings.find((row) => row.id === policy.listingId);
      const draft = snapshot.proposals.find((row) => row.listingId === policy.listingId);
      if (destination && !destination.paused && draft && !draft.edited && !draft.stale)
        onResumeCalculated({
          listingId: destination.id,
          version: destination.version,
          quantity: draft.quantity,
        });
      onReload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setResuming(false);
    }
  }
  async function reconcile() {
    if (!unresolved || checking) return;
    setChecking(true);
    setError('');
    try {
      onResult(await marketplaceApi.reconcile(listing.accountId, unresolved.id));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setChecking(false);
    }
  }
  return (
    <tr>
      <td>
        <div className="marketplace-product">
          {listing.imageUrl ? (
            <img src={listing.imageUrl} alt="" loading="lazy" />
          ) : (
            <span className="marketplace-product-placeholder">
              <Icon name="box" />
            </span>
          )}
          <div>
            <strong>{listing.title}</strong>
            <span>{listing.sku}</span>
            <small>Product: {listing.productId}</small>
            <small>
              {listing.observedAt
                ? `Observed: ${time(listing.observedAt)}`
                : 'Refresh required: no current observation'}
            </small>
          </div>
        </div>
        {pending && (
          <p className="marketplace-result" role="status">
            Applying…
          </p>
        )}
        {latest && !pending && (
          <div className={`marketplace-result result-${latest.state}`} role="status">
            <strong>{changeLabels[latest.state]}</strong>
            <span>{latest.message}</span>
            {unresolved && (
              <>
                <button
                  className="text-button"
                  disabled={checking}
                  onClick={() => void reconcile()}
                >
                  {checking ? 'Checking result…' : 'Check result'}
                </button>
                <StockRecoveryAction
                  change={unresolved}
                  disabled={checking}
                  onReview={onReviewRecovery}
                />
              </>
            )}
          </div>
        )}
        {error && (
          <p className="marketplace-error" role="alert">
            {error}{' '}
            <button
              className="text-button"
              onClick={() => {
                setError('');
                onReload();
              }}
            >
              Reload listings
            </button>
          </p>
        )}
        {failure && (
          <div className="marketplace-error" role="alert">
            <p>{failure.message}</p>
            {failure.uncertain && (
              <button className="text-button" onClick={onReload}>
                Reload saved result
              </button>
            )}
          </div>
        )}
      </td>
      <td>
        <span className={`badge ${listing.status === 'ACTIVE' ? 'badge-green' : 'badge-amber'}`}>
          {statuses.find((status) => status.value === listing.status)?.label ?? listing.status}
        </span>
      </td>
      {(['mrp', 'sellingPrice'] as const).map((field) => (
        <td key={field}>
          <button
            className="marketplace-value"
            disabled={
              !!unresolved || pending || resuming || !!failure?.uncertain || !listing.observedAt
            }
            aria-label={`Edit ${field === 'mrp' ? 'MRP' : 'selling price'} for ${listing.sku}`}
            onClick={() => onEdit({ listing, kind: 'price', field })}
          >
            <span>{listing[field] == null ? 'Not available' : money.format(listing[field])}</span>
            <span aria-hidden="true">✎</span>
          </button>
        </td>
      ))}
      <td>
        {listing.observedAt && listing.packageCount != null ? listing.packageCount : 'Unavailable'}
      </td>
      <td>
        <div className="marketplace-locations">
          {listing.locations.length === 0 && <span>Flipkart supplied no stock location.</span>}
          {listing.locations.map((location) => {
            const policy = listing.stockPolicies.find((item) => item.locationId === location.id);
            return (
              <div key={location.id}>
                <span>
                  {location.id} · {location.status}
                </span>
                <button
                  className="marketplace-value"
                  disabled={
                    !!unresolved ||
                    pending ||
                    resuming ||
                    !!failure?.uncertain ||
                    !listing.observedAt
                  }
                  aria-label={`Edit stock for ${listing.sku} at ${location.id}`}
                  onClick={() => onEdit({ listing, kind: 'stock', locationId: location.id })}
                >
                  <strong>{location.quantity ?? 'Not available'}</strong>
                  <span aria-hidden="true">✎</span>
                </button>
                <small>
                  {policy?.companyName ?? 'Not mapped to Tally'}
                  {policy?.policy === 'limited' && ` · ${policy.remaining ?? '?'} sales remaining`}
                </small>
                {policy?.paused && policy.companyId ? (
                  <ResumeSyncButton
                    sku={listing.sku}
                    location={location.id}
                    disabled={pending || checking || resuming}
                    onResume={() => void resume(policy)}
                  />
                ) : (
                  policy && (
                    <small>
                      Stockbridge ·{' '}
                      {policy.automationStatus ?? (policy.paused ? 'Paused' : 'Status unavailable')}
                    </small>
                  )
                )}
                {policy &&
                  !policy.paused &&
                  (policy.proposalIssue ? (
                    <small className="text-amber" role="status">
                      Last calculation could not verify stock. {policy.proposalIssue} Use Calculate
                      in Inventory to retry.
                    </small>
                  ) : resumeResult?.listingId === policy.listingId &&
                    resumeResult.version === policy.listingVersion ? (
                    <small role="status">Proposed stock on resume: {resumeResult.quantity}</small>
                  ) : null)}
              </div>
            );
          })}
        </div>
      </td>
      <td>
        <a
          className="text-button"
          href="https://seller.flipkart.com/"
          target="_blank"
          rel="noreferrer"
        >
          Open in Flipkart ↗
        </a>
        <small className="marketplace-help">View settlement in Seller Hub</small>
      </td>
    </tr>
  );
}
