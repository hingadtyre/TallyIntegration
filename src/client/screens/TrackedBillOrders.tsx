import { useEffect, useState } from 'react';
import type {
  BillingReport,
  TrackedBillHistory,
  TrackedBillOrder,
} from '../../shared/billing-contracts.js';
import { errorMessage, requestJson } from '../api.js';
import type { BillTarget } from './FindTallyBill.js';

const orderDay = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeZone: 'Asia/Kolkata',
});

export interface TrackedBillScope {
  companyId: string;
  accountId: string;
  revision: number;
  onFind: (order: BillTarget) => void;
  onRelease: (order: TrackedBillOrder) => void;
}

export function useTrackedBillHistory(scope: TrackedBillScope | undefined, open: boolean) {
  const companyId = scope?.companyId;
  const accountId = scope?.accountId;
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    history?: TrackedBillHistory;
    error?: string;
  } | null>(null);
  const key = JSON.stringify([companyId, accountId, scope?.revision, reload]);
  useEffect(() => {
    if (!open || !companyId || !accountId) {
      setResult(null);
      return;
    }
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
    return () => controller.abort();
  }, [open, key, companyId, accountId]);
  const current = result?.key === key ? result : null;
  return { current, refresh: () => setReload((value) => value + 1) };
}

export function TrackedBillOrders({
  scope,
  report,
  busy,
  open,
  onToggle,
  history,
}: {
  scope: TrackedBillScope;
  report: BillingReport | null;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  history: ReturnType<typeof useTrackedBillHistory>;
}) {
  const { current, refresh } = history;
  const previewIds = new Set(report?.rows.map((row) => row.orderItemId));
  const orders = current?.history?.orders.filter((order) => !previewIds.has(order.orderItemId));
  return (
    <section className="panel billing-results">
      <div className="panel-heading">
        <div>
          <h2>Other tracked orders</h2>
          <p>
            Review unresolved orders and manual bill matches for this seller outside the displayed
            preview.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? 'Hide other tracked orders' : 'Show other tracked orders'}
        </button>
      </div>
      {open && (
        <>
          {!current && <p role="status">Checking tracked orders…</p>}
          {current?.error && <p role="alert">{current.error}</p>}
          {orders &&
            (orders.length ? (
              <div className="table-scroll">
                <table className="billing-table" aria-label="Other tracked orders">
                  <thead>
                    <tr>
                      <th>Flipkart order item</th>
                      <th>Billing status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.orderItemId}>
                        <td>
                          <strong>{order.orderItemId}</strong>
                          <small>Order ID {order.orderId}</small>
                          <small>
                            {order.sku} · {orderDay.format(new Date(order.orderDate))}
                          </small>
                        </td>
                        <td data-label="Billing status">
                          {order.reason}
                          {order.manualBillId && (
                            <small>
                              {order.manualBillNumber
                                ? 'Bill ' +
                                  order.manualBillNumber +
                                  (order.manualBillDate ? ' · ' + order.manualBillDate : '')
                                : 'Linked Tally voucher ' + order.manualBillId}
                            </small>
                          )}
                        </td>
                        <td data-label="Action">
                          {order.manualBillId && order.linkToken ? (
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => scope.onRelease(order)}
                            >
                              Release manual match
                            </button>
                          ) : (
                            !order.manualBillId &&
                            (order.status === 'reserved' || order.status === 'review') && (
                              <button
                                className="text-button"
                                disabled={busy}
                                onClick={() => scope.onFind(order)}
                              >
                                Find Tally bill
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p role="status">
                No other tracked orders need a bill review or have a manual match.
              </p>
            ))}
          {current && (
            <div className="billing-filters">
              <button className="button secondary" disabled={busy} onClick={refresh}>
                Refresh other tracked orders
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
