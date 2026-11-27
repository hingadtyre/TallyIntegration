import { useMemo, useState } from 'react';
import type { BilledOrderItem, BillingReport } from '../../shared/billing-contracts.js';
import { formatIndiaDay } from '../format.js';
const pageSize = 50;

export function BilledOrders({ report }: { report: BillingReport }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(pageSize);
  function changeQuery(value: string) {
    setQuery(value);
    setLimit(pageSize);
  }
  const ordered = useMemo(() => {
    const billed: BilledOrderItem[] = [];
    for (const row of report.rows) {
      if (row.status !== 'matched' || !row.bill) continue;
      billed.push({
        orderId: row.orderId,
        orderItemId: row.orderItemId,
        orderDate: row.orderDate ?? '',
        sku: row.sku,
        bill: row.bill,
        method: row.manualBillId === row.bill.id ? 'seller-confirmed' : 'automatic',
      });
    }
    return billed.sort(
      (a, b) =>
        b.orderDate.localeCompare(a.orderDate) || a.orderItemId.localeCompare(b.orderItemId),
    );
  }, [report]);
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
      </div>
      {matches.length > 0 ? (
        <>
          <p>
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
                      {row.orderDate && <small>Ordered {formatIndiaDay(row.orderDate)}</small>}
                    </td>
                    <td data-label="SKU">{row.sku}</td>
                    <td data-label="Tally bill">
                      <strong>{row.bill.number}</strong>
                      <small>{formatIndiaDay(row.bill.date)}</small>
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
        <p role="status">
          {search
            ? 'No billed order items match your search.'
            : 'No billed order items were found.'}
        </p>
      )}
    </>
  );
}
