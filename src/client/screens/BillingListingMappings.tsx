import { useEffect, useState } from 'react';
import type {
  BillingReport,
  PendingListingCheck,
  PendingListingGroup,
  PendingListings,
  PendingOrderResult,
} from '../../shared/billing-contracts.js';
import type { Listing, Snapshot } from '../../shared/contracts.js';
import { errorMessage, requestJson } from '../api.js';
import { Modal } from '../components.js';
import { PackForm, type SaveMapping } from './MappingDialog.js';

type Group = PendingListingGroup & { trackedIds: string[] };
type Destination = Pick<Group, 'listingId' | 'sku' | 'location'>;

function destinationKey({ listingId, sku, location }: Destination) {
  return JSON.stringify([listingId, sku, location]);
}

function listingGroups(tracked: PendingListingGroup[], report: BillingReport | null) {
  const groups = new Map<string, Group>();
  for (const group of tracked) {
    groups.set(destinationKey(group), {
      ...group,
      orderItemIds: [...group.orderItemIds],
      trackedIds: group.orderItemIds,
    });
  }
  for (const row of report?.rows ?? []) {
    if (row.status !== 'unmapped') continue;
    const key = destinationKey(row);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        listingId: row.listingId,
        sku: row.sku,
        location: row.location,
        mapped: false,
        orderItemIds: [row.orderItemId],
        trackedIds: [],
      });
    } else if (!group.orderItemIds.includes(row.orderItemId)) {
      group.orderItemIds.push(row.orderItemId);
    }
  }
  return [...groups.values()];
}

function findDestination(
  inventory: Snapshot,
  accountId: string,
  group: Destination,
): { listing?: Listing; issue?: string } {
  const matches = inventory.listings.filter(
    (row) =>
      row.accountId === accountId &&
      (row.marketplaceListingId ?? row.skuMappingId ?? group.listingId) === group.listingId &&
      row.sku === group.sku &&
      !!group.location &&
      (row.location === group.location ||
        (!row.location && row.pickupChoices?.includes(group.location))),
  );
  if (matches.length <= 1) return { listing: matches[0] };
  // A catalogue refresh can add the observed location beside an older SKU-only mapping.
  const existing = matches.find(
    (row) => !row.location && row.itemId && row.skuMappingId === group.listingId,
  );
  const observed = matches.find((row) => row.location === group.location);
  if (
    matches.length === 2 &&
    existing &&
    observed &&
    !observed.itemId &&
    !observed.paused &&
    observed.policy === 'auto' &&
    observed.remaining === null &&
    !inventory.proposals.some((proposal) => proposal.listingId === observed.id)
  ) {
    return { listing: existing };
  }
  return {
    issue:
      'This pickup has conflicting Inventory records. Review its mappings, stock policy and drafts in Inventory.',
  };
}

const resultLabels: Record<PendingOrderResult['status'], string> = {
  matched: 'Billed in Tally',
  reserved: 'Reserved for this order',
  review: 'Needs review',
  cancelled: 'Cancelled',
  unmapped: 'Needs mapping',
};

export function BillingListingMappings({
  companyId,
  accountId,
  inventory,
  report,
  trackingRevision,
  busy,
  onSaveMapping,
  onRefreshPreview,
}: {
  companyId: string;
  accountId: string;
  inventory: Snapshot;
  report: BillingReport | null;
  trackingRevision: number;
  busy: boolean;
  onSaveMapping: SaveMapping;
  onRefreshPreview: () => Promise<void>;
}) {
  const [pending, setPending] = useState<PendingListings | null>(null);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState('');
  const loadKey = JSON.stringify([
    companyId,
    accountId,
    reload,
    report?.previewId,
    trackingRevision,
  ]);
  const [loadedKey, setLoadedKey] = useState('');
  const loading = loadedKey !== loadKey;
  const [checkError, setCheckError] = useState('');
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<Group | null>(null);
  const [result, setResult] = useState<PendingListingCheck | null>(null);
  const [failed, setFailed] = useState<Group | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function load(savedOnly: boolean) {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await requestJson<PendingListings>(
          '/billing/pending',
          { companyId, accountId, ...(savedOnly && { savedOnly: true }) },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setPending(data);
          if (data.trackingStarted) {
            setSelected((previous) => {
              if (!previous) return null;
              const latest = data.listings.find(
                (group) => !group.mapped && destinationKey(group) === destinationKey(previous),
              );
              return latest ? { ...latest, trackedIds: latest.orderItemIds } : null;
            });
          }
          if (!savedOnly) setLoadError(data.refreshIssue ?? '');
        }
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(errorMessage(cause));
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) setLoadedKey(loadKey);
      }
    }
    void load(false);
    const timer = setInterval(() => void load(true), 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [companyId, accountId, loadKey]);

  const groups = listingGroups(
    pending?.listings ?? [],
    pending?.trackingStarted === false ? report : null,
  );
  const unmapped = groups.filter((group) => !group.mapped);
  const mapped = groups.filter((group) => group.mapped);
  const company = inventory.companies.find((entry) => entry.id === companyId);
  const seller = inventory.accounts.find((entry) => entry.id === accountId)?.name ?? accountId;
  async function check(group: Group) {
    setCheckError('');
    setFailed(null);
    setResult(null);
    setChecking(true);
    try {
      if (group.trackedIds.length) {
        const checked = await requestJson<PendingListingCheck>('/billing/pending/recheck', {
          companyId,
          accountId,
          listingId: group.listingId,
          sku: group.sku,
          location: group.location,
        });
        setResult(checked);
      }
    } catch (cause) {
      setCheckError(errorMessage(cause));
      setFailed(group);
    } finally {
      await onRefreshPreview();
      if (!report) setReload((value) => value + 1);
      setChecking(false);
    }
  }
  function listingTable(rows: Group[], label: string) {
    return (
      <div className="table-scroll">
        <table className="billing-table" aria-label={label}>
          <thead>
            <tr>
              <th>Flipkart listing</th>
              <th>Order items</th>
              <th>Stock mapping</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((group) => {
              const { listing: destination, issue } = findDestination(inventory, accountId, group);
              const mappedHere =
                destination?.itemId &&
                inventory.items.some(
                  (item) => item.id === destination.itemId && item.companyId === companyId,
                );
              return (
                <tr key={destinationKey(group)}>
                  <td>
                    <strong>{group.sku}</strong>
                    <small>
                      {group.location} · Listing ID {group.listingId}
                    </small>
                  </td>
                  <td data-label="Order items">
                    <strong>{group.orderItemIds.length}</strong>
                    <small>
                      {group.trackedIds.length
                        ? `${group.trackedIds.length} tracked since starting stock`
                        : 'Billing preview only'}
                    </small>
                  </td>
                  <td data-label="Stock mapping">
                    {issue ? (
                      <span>{issue}</span>
                    ) : group.mapped || (destination?.location && mappedHere) ? (
                      <button
                        className="button secondary"
                        disabled={busy || checking || loading}
                        onClick={() => void check(group)}
                      >
                        Check orders
                      </button>
                    ) : destination &&
                      (!destination.itemId || (!destination.location && mappedHere)) &&
                      company ? (
                      <button
                        className="button secondary"
                        disabled={busy || checking || loading}
                        onClick={() => setSelected(group)}
                      >
                        {destination.itemId ? 'Confirm order pickup' : 'Map listing'}
                      </button>
                    ) : (
                      <span>
                        {destination?.itemId
                          ? 'Check the Tally company for this mapping.'
                          : 'Refresh this seller’s listings in Marketplaces and verify the listing and pickup location.'}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <section className="panel billing-results">
      <div className="panel-heading">
        <div>
          <h2>Listings from orders</h2>
          <p>{seller} · Map each listing and pickup location once for its order items.</p>
        </div>
        <button
          className="button secondary"
          disabled={busy || checking || loading}
          onClick={() => {
            setReload((value) => value + 1);
          }}
        >
          Refresh tracked listings
        </button>
      </div>
      {!unmapped.length && !loadError && (
        <p role="status">
          {loading
            ? 'Checking tracked listings…'
            : 'No listings need a mapping from the orders checked.'}
        </p>
      )}
      {unmapped.length > 0 && listingTable(unmapped, 'Listings to map')}
      {mapped.length > 0 && (
        <details>
          <summary>Previously mapped listings ({mapped.length})</summary>
          {listingTable(mapped, 'Previously mapped listings')}
        </details>
      )}
      {loadError && <p role="alert">{loadError}</p>}
      {checking && <p role="status">Checking orders and bills…</p>}
      {checkError && (
        <p role="alert">
          {checkError}{' '}
          {failed && (
            <button
              className="text-button"
              disabled={busy || checking}
              onClick={() => void check(failed)}
            >
              Retry order check
            </button>
          )}
        </p>
      )}
      {result && (
        <div aria-live="polite" className="panel-heading">
          <div>
            <h3>
              Order check for {result.sku} · {result.location}
            </h3>
            <p>{checkSummary(result.rows)}</p>
            <details>
              <summary>Order item details</summary>
              <ul>
                {result.rows.map((row) => (
                  <li key={row.orderItemId}>
                    <strong>
                      {row.orderItemId} · {resultLabels[row.status]}
                    </strong>
                    {row.baseUnits !== null && ` · ${tallyUnits(row.baseUnits)}`}
                    <small>{row.reason}</small>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </div>
      )}
      {selected && company && (
        <OrderMappingDialog
          inventory={inventory}
          company={company}
          accountId={accountId}
          seller={seller}
          group={selected}
          onClose={() => setSelected(null)}
          onSave={async (input) => {
            const saved = await onSaveMapping(input);
            if (saved.ok) {
              setSelected(null);
              await check(selected);
            }
            return saved;
          }}
        />
      )}
    </section>
  );
}

function tallyUnits(quantity: number) {
  return `${quantity} Tally unit${quantity === 1 ? '' : 's'}`;
}

function checkSummary(rows: PendingOrderResult[]) {
  const awaiting = rows.filter((row) => row.status === 'reserved');
  const count = (status: PendingOrderResult['status']) =>
    rows.filter((row) => row.status === status).length;
  const reserved = awaiting.every((row) => row.baseUnits !== null)
    ? awaiting.reduce((total, row) => total + row.baseUnits!, 0)
    : null;
  const parts = [
    `${count('matched')} billed`,
    `${awaiting.length} awaiting a bill`,
    reserved === null ? 'Reserved Tally units unknown' : `${tallyUnits(reserved)} reserved`,
  ];
  const review = count('review') + count('unmapped');
  if (review) parts.push(`${review} need review`);
  if (count('cancelled')) parts.push(`${count('cancelled')} cancelled`);
  return parts.join(' · ');
}

function OrderMappingDialog({
  inventory,
  company,
  accountId,
  seller,
  group,
  onClose,
  onSave,
}: {
  inventory: Snapshot;
  company: Snapshot['companies'][number];
  accountId: string;
  seller: string;
  group: Group;
  onClose: () => void;
  onSave: SaveMapping;
}) {
  const [query, setQuery] = useState('');
  const [itemId, setItemId] = useState('');
  const [saving, setSaving] = useState(false);
  const { listing, issue } = findDestination(inventory, accountId, group);
  const items = inventory.items.filter((item) => item.companyId === company.id);
  const filtered = items.filter((item) =>
    item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const item = items.find((entry) => entry.id === (listing?.itemId || itemId));
  return (
    <Modal
      title="Map order listing to Tally"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <p className="modal-intro">
        <strong>{group.sku}</strong> · {seller} · {group.location}
        <br />
        Listing ID {group.listingId}
        {listing?.title && ` · ${listing.title}`}
      </p>
      {!listing || (listing.itemId && (listing.location || !item)) ? (
        <p role="alert">
          {issue ??
            'This listing or its mapping changed. Close this dialog and check the current listing.'}
        </p>
      ) : (
        <>
          {listing.itemId ? (
            <p>
              Mapped Tally item in {company.name}: <strong>{item?.name}</strong>
            </p>
          ) : (
            <>
              <label className="field">
                <span>Search Tally items in {company.name}</span>
                <input
                  type="search"
                  value={query}
                  disabled={saving}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setItemId('');
                  }}
                />
              </label>
              <label className="field">
                <span>Tally stock item</span>
                <select
                  value={itemId}
                  disabled={saving}
                  onChange={(event) => setItemId(event.target.value)}
                >
                  <option value="">Choose a Tally stock item</option>
                  {filtered.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name} · {entry.unit} · {entry.externalId}
                    </option>
                  ))}
                </select>
              </label>
              {!filtered.length && (
                <p role="status">
                  {items.length
                    ? 'No items match this search.'
                    : 'Refresh this company’s stock in Inventory to load its Tally items.'}
                </p>
              )}
            </>
          )}
          {item && (
            <PackForm
              key={JSON.stringify([
                listing.id,
                listing.version,
                item.id,
                item.unit,
                company.automation,
              ])}
              listing={listing}
              item={item}
              company={company.name}
              companySync={company.automation}
              busy={saving}
              onClose={onClose}
              order={{
                accountId,
                marketplaceListingId: group.listingId,
                location: group.location,
              }}
              onSave={async (input) => {
                setSaving(true);
                try {
                  return await onSave(input);
                } finally {
                  setSaving(false);
                }
              }}
            />
          )}
        </>
      )}
    </Modal>
  );
}
