import { useMemo, useState } from 'react';
import type { BilledOrderItem, BillingReport } from '../../shared/billing-contracts.js';
import type { useTrackedBillHistory } from './TrackedBillOrders.js';

const indiaDate = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeZone: 'Asia/Kolkata',
});
const pageSize = 50;

export function BilledOrders({
  report,
  trackingFrom,
  history,
  busy,
}: {
  report: BillingReport | null;
  trackingFrom?: string;
  history: ReturnType<typeof useTrackedBillHistory>;
  busy: boolean;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const { current, refresh } = history;
  function changeQuery(value: string) {
    setQuery(value);
    setLimit(pageSize);
  }
  const tracked = current?.history?.billed;
  const ordered = useMemo(() => {
    const byOrderItem = new Map<string, BilledOrderItem>();
    const start = trackingFrom ? Date.parse(trackingFrom) : undefined;
    for (const row of report?.rows ?? []) {
      if (row.status !== 'matched' || !row.bill) continue;
      // The company-wide check can find competing claims beyond the seller's preview.
      if (start !== undefined && (!row.orderDate || Date.parse(row.orderDate) >= start)) continue;
      byOrderItem.set(row.orderItemId, {
        orderId: row.orderId,
        orderItemId: row.orderItemId,
        orderDate: row.orderDate ?? '',
        sku: row.sku,
        bill: row.bill,
        method: row.manualBillId === row.bill.id ? 'seller-confirmed' : 'automatic',
      });
    }
    for (const order of tracked ?? []) byOrderItem.set(order.orderItemId, order);
    return [...byOrderItem.values()].sort(
      (a, b) =>
        b.orderDate.localeCompare(a.orderDate) || a.orderItemId.localeCompare(b.orderItemId),
    );
  }, [report, tracked, trackingFrom]);
  const search = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      !search
        ? ordered
        : ordered.filter((row) =>
            [row.orderId, row.orderItemId, row.bill.number].some((value) =>
              value.toLowerCase().includes(search),
            ),
          ),
    [ordered, search],
  );
  return (
    <>
      <div className="billing-filters">
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
        {trackingFrom && (
          <button className="button secondary" disabled={busy || !current} onClick={refresh}>
            Refresh billed orders
          </button>
        )}
      </div>
      {trackingFrom && !current && (
        <p role="status" className="billing-filters">
          Checking billed orders since tracking started…
        </p>
      )}
      {trackingFrom && current?.error && (
        <p role="alert" className="message error">
          Could not check billed orders since tracking started. {current.error}
        </p>
      )}
      {matches.length > 0 ? (
        <>
          <p className="billing-filters">
            {matches.length > limit ? 'Showing ' + limit + ' of ' : ''}
            {matches.length} billed order {matches.length === 1 ? 'item' : 'items'}
          </p>
          <div className="table-scroll">
            <table className="billing-table" aria-label="Billed order items">
              <thead>
                <tr>
                  <th>Flipkart order item</th>
                  <th>SKU</th>
                  <th>Tally bill</th>
                  <th>Match method</th>
                </tr>
              </thead>
              <tbody>
                {matches.slice(0, limit).map((row) => (
                  <tr key={row.orderItemId}>
                    <td>
                      <strong>{row.orderItemId}</strong>
                      <small>Order ID {row.orderId}</small>
                      {row.orderDate && (
                        <small>Ordered {indiaDate.format(new Date(row.orderDate))}</small>
                      )}
                    </td>
                    <td data-label="SKU">{row.sku}</td>
                    <td data-label="Tally bill">
                      <strong>{row.bill.number}</strong>
                      <small>{row.bill.date}</small>
                    </td>
                    <td data-label="Match method">
                      {row.method === 'seller-confirmed' ? 'Seller-confirmed' : 'Automatic'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {matches.length > limit && (
            <div className="billing-filters">
              <button
                className="button secondary"
                onClick={() => setLimit((value) => value + pageSize)}
              >
                Show more billed orders
              </button>
            </div>
          )}
        </>
      ) : (
        (!trackingFrom || current?.history) && (
          <p className="billing-filters" role="status">
            {search
              ? 'No billed order items match your search.'
              : 'No billed order items were found.'}
          </p>
        )
      )}
    </>
  );
}
