import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import type {
  BilledOrderItem,
  BillingFulfilment,
  TrackedBillHistory,
  TrackedBillOrder,
} from '../../shared/billing-contracts.js';
import { errorMessage, RequestError, requestJson } from '../api.js';
import { formatIndiaDay } from '../format.js';
import type { BillTarget } from './FindTallyBill.js';

const checkedThrough = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Kolkata',
});
const pageSize = 50;

const fulfilmentLabels: Record<BillingFulfilment, string> = {
  standard: 'Standard',
  selfShip: 'Self-ship',
  express: 'Express',
  smart: 'Smart',
  fbf: 'Fulfilment by Flipkart',
};

const statusLabel: Record<TrackedBillOrder['status'], string> = {
  matched: 'Billed',
  reserved: 'No matched bill',
  unmatched: 'No matched bill',
  review: 'Needs review',
  cancelled: 'Cancelled',
  unmapped: 'Needs mapping',
};

export interface TrackedBillScope {
  companyId: string;
  accountId: string;
  revision: number;
  headingRef?: Ref<HTMLHeadingElement>;
  onTrackingDateChanged?: (from: string) => void;
  onFind: (order: BillTarget, trigger: HTMLButtonElement) => void;
  onRelease: (order: TrackedBillOrder) => void;
  renderMapping?: (order: TrackedBillOrder, disabled: boolean) => ReactNode;
}

function useTrackedBillHistory({ companyId, accountId, revision }: TrackedBillScope) {
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    history?: TrackedBillHistory;
    error?: string;
    retrying?: BillingFulfilment;
    retryError?: string;
  } | null>(null);
  const retryRequest = useRef<AbortController | null>(null);
  const key = JSON.stringify([companyId, accountId, revision, reload]);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<TrackedBillHistory>(
      '/billing/tracked-bills',
      { companyId, accountId },
      controller.signal,
    )
      .then((history) => {
        if (!controller.signal.aborted) setResult({ key, history });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: errorMessage(cause) });
      });
    return () => {
      controller.abort();
      retryRequest.current?.abort();
      retryRequest.current = null;
    };
  }, [key, companyId, accountId]);
  const current = result?.key === key ? result : null;
  async function retry(group: BillingFulfilment) {
    const check = current?.history?.check;
    if (
      !check ||
      retryRequest.current ||
      !check.groups.some((g) => g.group === group && (g.count === null || g.error))
    )
      return;
    const controller = new AbortController();
    retryRequest.current = controller;
    setResult({ key, history: current.history, retrying: group });
    try {
      const history = await requestJson<TrackedBillHistory>(
        '/billing/tracked-bills',
        { companyId, accountId, checkId: check.id, retryGroup: group },
        controller.signal,
      );
      if (!controller.signal.aborted) setResult({ key, history });
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof RequestError && [401, 403, 404, 409, 410].includes(cause.status)) {
        setResult({ key, error: errorMessage(cause) });
      } else {
        setResult({ key, history: current.history, retryError: errorMessage(cause) });
      }
    } finally {
      if (retryRequest.current === controller) retryRequest.current = null;
    }
  }
  return { current, retry, refresh: () => setReload((value) => value + 1) };
}

type OrderFilter = 'all' | 'unresolved' | 'billed';

function emptyResultMessage(filter: OrderFilter, search: string, partial: boolean) {
  if (search)
    return partial
      ? 'No matches for this search in the completed checks.'
      : 'No order items match your search.';
  if (filter === 'all')
    return partial
      ? 'No order items are available from the completed checks.'
      : 'No tracked orders for this seller since the starting date.';
  const suffix = partial ? ' in the completed checks.' : '.';
  return 'No ' + filter + ' order items were found' + suffix;
}

export function TrackedBillOrders({
  scope,
  trackingFrom,
  busy,
}: {
  scope: TrackedBillScope;
  trackingFrom?: string;
  busy: boolean;
}) {
  const { current, retry, refresh } = useTrackedBillHistory(scope);
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const check = current?.history?.check;
  const missingCounts = check?.groups.some((group) => group.count === null);
  const checkedFrom = check?.from;
  const displayedFrom = checkedFrom ?? trackingFrom;
  const { onTrackingDateChanged } = scope;
  useEffect(() => {
    if (checkedFrom && checkedFrom !== trackingFrom) onTrackingDateChanged?.(checkedFrom);
  }, [checkedFrom, trackingFrom, onTrackingDateChanged]);
  const locked = busy || !!current?.retrying;
  const orders = current?.history?.orders;
  const billed = current?.history?.billed;
  const matches = useMemo(() => new Map(billed?.map((row) => [row.orderItemId, row])), [billed]);
  const search = query.trim().toLowerCase();
  const visibleOrders = useMemo(
    () =>
      orders?.filter((order) => {
        const bill = matches.get(order.orderItemId)?.bill;
        if (filter === 'billed' && !bill) return false;
        if (filter === 'unresolved' && (bill || order.status === 'cancelled')) return false;
        return (
          !search ||
          [order.orderId, order.orderItemId, bill?.number ?? order.manualBillNumber].some((value) =>
            value?.toLowerCase().includes(search),
          )
        );
      }),
    [orders, matches, search, filter],
  );

  function changeQuery(value: string) {
    setQuery(value);
    setLimit(pageSize);
  }

  return (
    <section className="panel billing-results">
      <div className="panel-heading">
        <div>
          <h2 ref={scope.headingRef} tabIndex={-1}>
            Tracked orders
          </h2>
          <p>
            Flipkart orders for this seller since{' '}
            {displayedFrom ? formatIndiaDay(displayedFrom) + ' (India)' : 'tracking started'}.
          </p>
        </div>
        <button className="button secondary" disabled={locked || !current} onClick={refresh}>
          Refresh tracked orders
        </button>
      </div>
      {check && (
        <div className="fulfilment-check">
          <p role="status">
            <strong>
              {check.complete
                ? 'Fulfilment check · Complete'
                : missingCounts
                  ? 'Fulfilment check · Incomplete'
                  : 'Order counts complete · Bill checks incomplete'}
            </strong>
            {' · '}
            {formatIndiaDay(check.from)} through {checkedThrough.format(new Date(check.to))} (India)
          </p>
          <dl aria-label="Order item counts by fulfilment type">
            {check.groups.map(({ group, count, error }) => (
              <div key={group}>
                <dt>{fulfilmentLabels[group]}</dt>
                <dd>{count ?? 'Unknown'}</dd>
                {(count === null || error) && (
                  <dd>
                    {error && <small>{error}</small>}
                    <button
                      type="button"
                      className="text-button"
                      disabled={locked}
                      onClick={() => void retry(group)}
                    >
                      {current?.retrying === group
                        ? 'Checking ' + fulfilmentLabels[group] + ' orders…'
                        : 'Retry ' +
                          fulfilmentLabels[group] +
                          (count === null ? ' orders' : ' checks')}
                    </button>
                  </dd>
                )}
              </div>
            ))}
          </dl>
          {current?.retryError && <p role="alert">{current.retryError}</p>}
        </div>
      )}
      <div className="billing-filters">
        <label className="field">
          <span>Order status</span>
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value as OrderFilter);
              setLimit(pageSize);
            }}
          >
            <option value="all">All</option>
            <option value="unresolved">Unresolved</option>
            <option value="billed">Billed</option>
          </select>
        </label>
        <label className="field">
          <span>Search by bill or order number</span>
          <input
            type="search"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            placeholder="Bill number, order ID or order item ID"
          />
        </label>
        {query && (
          <button className="text-button" onClick={() => changeQuery('')}>
            Clear search
          </button>
        )}
      </div>
      {!current && <p role="status">Checking tracked orders…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {visibleOrders &&
        (visibleOrders.length ? (
          <>
            <p>
              Showing {visibleOrders.length > limit && `${limit} of `}
              {visibleOrders.length} tracked order {visibleOrders.length === 1 ? 'item' : 'items'}
            </p>
            <div className="table-scroll">
              <table className="billing-table tracked-orders-table" aria-label="Tracked orders">
                <thead>
                  <tr>
                    <th>Flipkart order item</th>
                    <th>Billing status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.slice(0, limit).map((order) => (
                    <TrackedOrderRow
                      key={order.orderItemId}
                      order={order}
                      match={matches.get(order.orderItemId)}
                      scope={scope}
                      locked={locked}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {visibleOrders.length > limit && (
              <div className="billing-filters">
                <button
                  className="button secondary"
                  onClick={() => setLimit((value) => value + pageSize)}
                >
                  Show more tracked orders
                </button>
              </div>
            )}
          </>
        ) : (
          <p role="status">
            {emptyResultMessage(
              filter,
              search,
              filter === 'all' && !search ? !!missingCounts : check?.complete === false,
            )}
          </p>
        ))}
    </section>
  );
}

function TrackedOrderRow({
  order,
  match,
  scope,
  locked,
}: {
  order: TrackedBillOrder;
  match: BilledOrderItem | undefined;
  scope: TrackedBillScope;
  locked: boolean;
}) {
  return (
    <tr>
      <td>
        <strong>{order.orderItemId}</strong>
        <small>Order ID {order.orderId}</small>
        <small>
          {order.sku} · {formatIndiaDay(order.orderDate)}
        </small>
        {order.fulfilment && <small>{fulfilmentLabels[order.fulfilment]}</small>}
      </td>
      <td data-label="Billing status">
        <strong>{statusLabel[order.status]}</strong>
        {match && (
          <>
            <small>
              Bill <span>{match.bill.number}</span> · <span>{formatIndiaDay(match.bill.date)}</span>
            </small>
            <small>{match.method === 'seller-confirmed' ? 'Seller-confirmed' : 'Automatic'}</small>
          </>
        )}
        <small>{order.reason}</small>
        {!match && order.manualBillId && (
          <small>
            {order.manualBillNumber
              ? 'Previously linked bill ' + order.manualBillNumber
              : 'Previously linked Tally voucher ' + order.manualBillId}
          </small>
        )}
      </td>
      <td data-label="Action">
        {order.status === 'unmapped' && scope.renderMapping?.(order, locked)}
        {order.manualBillId && order.linkToken ? (
          <button className="text-button" disabled={locked} onClick={() => scope.onRelease(order)}>
            Release manual match
          </button>
        ) : (
          order.canFindBill && (
            <button
              className="text-button"
              disabled={locked}
              onClick={(event) => scope.onFind(order, event.currentTarget)}
            >
              Find Tally bill
            </button>
          )
        )}
      </td>
    </tr>
  );
}
