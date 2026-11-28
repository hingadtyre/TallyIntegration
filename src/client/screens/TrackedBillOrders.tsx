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
import {
  ExactOrderLookup,
  fulfilmentLabels,
  indiaTimestamp,
  marketplaceStatusLabel,
} from './MarketplaceOrderLookup.js';

const pageSize = 50;

const statusLabel: Record<TrackedBillOrder['status'], string> = {
  matched: 'Billed',
  reserved: 'No matched bill',
  unmatched: 'No matched bill',
  review: 'Needs review',
  cancelled: 'No matched bill',
  received: 'Received back and sellable',
  accounted: 'Previously billed',
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
  onReceive?: (order: TrackedBillOrder) => void;
  renderDateEditor?: (from: string, disabled: boolean) => ReactNode;
  renderMapping?: (order: TrackedBillOrder, disabled: boolean) => ReactNode;
}

function useTrackedBillHistory(
  { companyId, accountId, revision }: TrackedBillScope,
  trackingFrom?: string,
) {
  const initialFrom = useRef(trackingFrom);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    history?: TrackedBillHistory;
    error?: string;
    retrying?: BillingFulfilment;
    retryError?: string;
    fallbackFrom?: string;
  } | null>(null);
  const retryRequest = useRef<AbortController | null>(null);
  const lastRead = useRef<{ scope: string; history: TrackedBillHistory } | null>(null);
  const sellerScope = JSON.stringify([companyId, accountId]);
  const key = JSON.stringify([companyId, accountId, revision, reload]);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<TrackedBillHistory>(
      '/billing/tracked-bills',
      { companyId, accountId },
      controller.signal,
    )
      .then((history) => {
        if (!controller.signal.aborted) {
          lastRead.current = { scope: sellerScope, history };
          setResult({ key, history });
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const temporary = !(cause instanceof RequestError) || cause.status >= 500;
        const previous =
          temporary && lastRead.current?.scope === sellerScope
            ? lastRead.current.history
            : undefined;
        if (!previous) {
          lastRead.current = null;
          setResult({ key, error: errorMessage(cause) });
          return;
        }
        setResult({
          key,
          error: errorMessage(cause),
          fallbackFrom: previous.check?.from ?? initialFrom.current,
          history: {
            orders: previous.orders.map((order) => ({
              ...order,
              status: 'review',
              savedOnly: true,
              reason: 'Bill check incomplete.',
              canFindBill: false,
              reserved: undefined,
              returnReceipt: undefined,
              mapping: undefined,
              linkToken: undefined,
            })),
            billed: [],
            check: previous.check && {
              ...previous.check,
              complete: false,
              billingIssue: undefined,
              groups: previous.check.groups.map(({ group }) => ({ group, count: null })),
            },
          },
        });
      });
    return () => {
      controller.abort();
      retryRequest.current?.abort();
      retryRequest.current = null;
    };
  }, [key, companyId, accountId, sellerScope]);
  const current =
    result?.key !== key
      ? null
      : result.error && result.history && result.fallbackFrom !== trackingFrom
        ? { ...result, history: undefined }
        : result;
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
      if (!controller.signal.aborted) {
        lastRead.current = { scope: sellerScope, history };
        setResult({ key, history });
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof RequestError && [401, 403, 404, 409, 410].includes(cause.status)) {
        lastRead.current = null;
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

function matchesSearch(order: TrackedBillOrder, bill: BilledOrderItem | undefined, search: string) {
  return [order.orderId, order.orderItemId, bill?.bill.number ?? order.manualBillNumber].some(
    (value) => value?.toLowerCase().includes(search),
  );
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
  const { current, retry, refresh } = useTrackedBillHistory(scope, trackingFrom);
  const [filter, setFilter] = useState<OrderFilter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const check = current?.history?.check;
  const missingCounts = check?.groups.some((group) => group.count === null);
  const verifiedSubtotal = current?.history?.orders.filter((order) => !order.savedOnly).length;
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
        if (
          filter === 'unresolved' &&
          (bill || ['cancelled', 'received', 'accounted'].includes(order.status))
        )
          return false;
        return !search || matchesSearch(order, matches.get(order.orderItemId), search);
      }),
    [orders, matches, search, filter],
  );
  const savedCount = visibleOrders?.filter((order) => order.savedOnly).length ?? 0;

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
          {displayedFrom && scope.renderDateEditor ? (
            scope.renderDateEditor(displayedFrom, !!current?.retrying)
          ) : (
            <p>
              {displayedFrom
                ? 'Orders placed since ' + formatIndiaDay(displayedFrom) + ' (India)'
                : 'Orders for this seller since tracking started.'}
            </p>
          )}
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
            {!current?.error && (
              <>
                {' '}
                · Orders placed {formatIndiaDay(check.from)} through {indiaTimestamp(check.to)}
              </>
            )}
          </p>
          {!check.complete && check.lastCompleteAt && (
            <p>Last complete check {indiaTimestamp(check.lastCompleteAt)}</p>
          )}
          {check.billingIssue && <p role="alert">{check.billingIssue}</p>}
          {missingCounts &&
            (check.groups.some(({ count }) => count !== null) ? (
              <p>
                {verifiedSubtotal} order {verifiedSubtotal === 1 ? 'item' : 'items'} across the
                verified fulfilment types for this seller. The current total is unknown.
              </p>
            ) : (
              <p>The current order total for this seller is unknown.</p>
            ))}
          <dl aria-label="Order item counts by fulfilment type">
            {check.groups.map(({ group, count, error }) => (
              <div key={group}>
                <dt>{fulfilmentLabels[group]}</dt>
                <dd>{count ?? 'Unknown'}</dd>
                {!current?.error && (count === null || error) && (
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
      {current?.error && !check && <p>Current fulfilment counts are unknown.</p>}
      {visibleOrders &&
        (visibleOrders.length ? (
          <>
            <p>
              Showing {visibleOrders.length > limit && `${limit} of `}
              {visibleOrders.length} tracked order {visibleOrders.length === 1 ? 'item' : 'items'}
              {(check?.complete === false || savedCount > 0 || current?.error) && (
                <>
                  {' '}
                  in this view · {visibleOrders.length - savedCount} observed in this check ·{' '}
                  {savedCount} saved from earlier checks
                </>
              )}
            </p>
            <div className="table-scroll">
              <table className="billing-table tracked-orders-table" aria-label="Tracked orders">
                <thead>
                  <tr>
                    <th>Order item</th>
                    <th>Marketplace status</th>
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
            {current?.error && !search
              ? 'No saved order items in this view.'
              : emptyResultMessage(
                  filter,
                  search,
                  filter === 'all' && !search ? !!missingCounts : check?.complete === false,
                )}
          </p>
        ))}
      {search &&
        current &&
        !orders?.some((order) => matchesSearch(order, matches.get(order.orderItemId), search)) && (
          <ExactOrderLookup
            key={JSON.stringify([query.trim(), scope.revision, check?.id])}
            companyId={scope.companyId}
            accountId={scope.accountId}
            orderId={query.trim()}
          />
        )}
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
      <td data-label="Marketplace status">
        <strong>{marketplaceStatusLabel(order.marketplaceStatus, order.marketplaceHold)}</strong>
        {order.marketplaceStatus && order.statusVerifiedAt && (
          <small>Last verified {indiaTimestamp(order.statusVerifiedAt)}</small>
        )}
        {order.savedOnly && <small>Saved order item · unseen in this check</small>}
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
        {order.reserved && (
          <small>
            {order.reserved.quantity} {order.reserved.unit} reserved
          </small>
        )}
        {!match && order.manualBillId && (
          <small>
            {order.manualBillNumber
              ? 'Previously linked bill ' + order.manualBillNumber
              : 'Previously linked Tally voucher ' + order.manualBillId}
          </small>
        )}
      </td>
      <td data-label="Action">
        {order.returnReceipt && scope.onReceive && (
          <button
            className="text-button"
            disabled={locked}
            onClick={() => scope.onReceive?.(order)}
          >
            Received back and sellable
          </button>
        )}
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
