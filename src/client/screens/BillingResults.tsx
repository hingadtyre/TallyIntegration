import { useState } from 'react';
import type { BillingReport, BillingRow } from '../../shared/billing-contracts.js';
import { formatDateTime, formatUnits } from '../format.js';
import { BilledOrders } from './BilledOrders.js';
import {
  TrackedBillOrders,
  useTrackedBillHistory,
  type TrackedBillScope,
} from './TrackedBillOrders.js';

const saleDate = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeZone: 'Asia/Kolkata',
});

const statusLabel: Record<BillingRow['status'], string> = {
  matched: 'Billed',
  review: 'Needs review',
  unmatched: 'No matched bill',
  unmapped: 'Check mapping',
};

interface Actions {
  confirmed: boolean;
  busy: boolean;
  onMatch: (orderItemId: string, billId: string) => void;
  onUnmatch: (orderItemId: string) => void;
  onFindBill?: (row: BillingRow) => void;
}

export function BillingResults({
  report,
  trackingFrom,
  tracking,
  ...actions
}: Actions & { report: BillingReport | null; trackingFrom?: string; tracking?: TrackedBillScope }) {
  const [filter, setFilter] = useState<'all' | 'unresolved' | 'billed'>('all');
  const [otherOpen, setOtherOpen] = useState(false);
  const history = useTrackedBillHistory(tracking, otherOpen || filter === 'billed');
  const unresolved = report?.rows.filter((row) => row.status !== 'matched') ?? [];
  const rows = filter === 'unresolved' ? unresolved : (report?.rows ?? []);
  if (!report && !tracking) return null;
  return (
    <>
      <section className="panel billing-results">
        <div className="panel-heading">
          <div>
            <h2>Order items and bills</h2>
            {filter === 'billed' ? (
              <p>
                {tracking && trackingFrom
                  ? 'Billed order items for this seller since ' +
                    saleDate.format(new Date(trackingFrom)) +
                    ' (India), plus any earlier billed items in the selected preview.'
                  : 'Billed order items for this seller in the selected preview period.'}
              </p>
            ) : (
              report && (
                <>
                  <p>
                    {saleDate.format(new Date(report.from))} through{' '}
                    {saleDate.format(new Date(report.to))} (India) · Checked{' '}
                    {formatDateTime(report.checkedAt)}
                  </p>
                  <p>
                    This preview covers recent seller-fulfilled standard and self-ship orders
                    returned for the selected period and sales bills from the selected ledger.
                  </p>
                  {report.period === 'tracking' &&
                    trackingFrom &&
                    Date.parse(report.from) > Date.parse(trackingFrom) && (
                      <p>
                        Company tracking started on {saleDate.format(new Date(trackingFrom))}. This
                        preview shows the most recent 30 Indian calendar days.
                      </p>
                    )}
                </>
              )
            )}
          </div>
        </div>
        <div className="billing-filters">
          {filter !== 'billed' && report && (
            <strong>
              {report.rows.length - unresolved.length} matched · {unresolved.length} unresolved
            </strong>
          )}
          <label className="field">
            <span>Order status</span>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as typeof filter)}
            >
              <option value="all">All</option>
              <option value="unresolved">Unresolved</option>
              <option value="billed">Billed</option>
            </select>
          </label>
        </div>
        {filter === 'billed' ? (
          <BilledOrders
            report={report}
            trackingFrom={tracking ? trackingFrom : undefined}
            history={history}
            busy={actions.busy}
          />
        ) : !report ? (
          <p className="billing-filters">The selected order preview is unavailable.</p>
        ) : report.rows.length === 0 ? (
          <div className="empty-state compact-empty">
            <h3>No order items in this preview</h3>
            <p>
              Check the selected seller and period, or refresh after an order appears in Flipkart.
            </p>
          </div>
        ) : (
          <>
            {rows.length > 0 ? (
              <div className="table-scroll">
                <table className="billing-table" aria-label="Order and bill matches">
                  <thead>
                    <tr>
                      <th>Flipkart order item</th>
                      <th>Item and stock</th>
                      <th>Tally bill</th>
                    </tr>
                  </thead>
                  <tbody key={report.previewId}>
                    {rows.map((row) => (
                      <OrderRow
                        key={row.orderItemId}
                        row={row}
                        showInvoice={
                          report.rule.reference === 'invoiceNumber' &&
                          report.rule.field !== 'manual'
                        }
                        {...actions}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="billing-filters">
                All order items in this preview have a matched bill.
              </p>
            )}
          </>
        )}
      </section>
      {report && report.stock.length > 0 && (
        <section className="panel billing-results">
          <div className="panel-heading">
            <div>
              <h2>Available stock preview</h2>
              <p>
                This preview subtracts the units kept back for each item and its unbilled orders for
                the selected seller and period. Automatic updates check all covered sellers from the
                company’s tracking start date.
              </p>
            </div>
          </div>
          <div className="table-scroll">
            <table className="billing-table" aria-label="Available stock preview">
              <thead>
                <tr>
                  <th>Tally item</th>
                  <th>Physical stock</th>
                  <th>Keep back from marketplaces</th>
                  <th>Units without a matched bill</th>
                  <th>Preview available</th>
                </tr>
              </thead>
              <tbody>
                {report.stock.map((item, index) => (
                  <tr key={index}>
                    <td>
                      {item.name}
                      <small>{item.unit}</small>
                    </td>
                    <td data-label="Physical stock">{item.physical ?? 'Unknown'}</td>
                    <td data-label="Keep back from marketplaces">{item.keepBackUnits}</td>
                    <td data-label="Units without a matched bill">
                      {item.unmatchedUnits ?? 'Unknown'}
                    </td>
                    <td data-label="Preview available">
                      <strong>{item.previewAvailable ?? 'Unknown'}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {tracking && (
        <TrackedBillOrders
          scope={tracking}
          report={report}
          busy={actions.busy}
          open={otherOpen}
          onToggle={() => setOtherOpen(!otherOpen)}
          history={history}
        />
      )}
    </>
  );
}

function OrderRow({
  row,
  showInvoice,
  busy,
  confirmed,
  onMatch,
  onUnmatch,
  onFindBill,
}: { row: BillingRow; showInvoice: boolean } & Actions) {
  const [selectedBill, setSelectedBill] = useState('');
  const candidate = row.candidates.find((bill) => bill.id === selectedBill);
  const labels = new Set<string>();
  const duplicateLabels = new Set<string>();
  const choices = row.candidates.map((bill) => {
    const label = bill.number + ' · ' + bill.date;
    if (labels.has(label)) duplicateLabels.add(label);
    labels.add(label);
    return { id: bill.id, label };
  });
  return (
    <tr>
      <td>
        <strong>{row.orderItemId}</strong>
        <small>Order ID {row.orderId}</small>
        {row.orderDate && <small>Ordered {saleDate.format(new Date(row.orderDate))}</small>}
        {showInvoice && (
          <small>
            {row.referenceValue
              ? 'Invoice number ' + row.referenceValue
              : 'Invoice number unavailable'}
          </small>
        )}
      </td>
      <td data-label="Item and stock">
        <strong>{row.sku}</strong>
        <small>
          {formatUnits(row.quantity, 'listing')} ·{' '}
          {row.baseUnits === null ? 'Tally units unknown' : formatUnits(row.baseUnits, 'Tally')}
        </small>
        <small>{row.location}</small>
      </td>
      <td data-label="Tally bill">
        <strong>{statusLabel[row.status]}</strong>
        {row.bill && (
          <small>
            Bill {row.bill.number} · {row.bill.date}
          </small>
        )}
        <small>{row.reason}</small>
        {confirmed && row.manualBillId ? (
          <button
            className="text-button"
            disabled={busy}
            onClick={() => onUnmatch(row.orderItemId)}
          >
            Release manual match
          </button>
        ) : (
          confirmed &&
          row.status !== 'matched' &&
          row.candidates.length > 0 && (
            <div className="billing-choice">
              <select
                aria-label={'Choose bill for ' + row.orderItemId}
                value={candidate?.id ?? ''}
                disabled={busy}
                onChange={(event) => setSelectedBill(event.target.value)}
              >
                <option value="">Choose a bill</option>
                {choices.map((bill) => (
                  <option key={bill.id} value={bill.id}>
                    {bill.label}
                    {duplicateLabels.has(bill.label) && ' · Tally voucher ID ' + bill.id}
                  </option>
                ))}
              </select>
              <button
                className="button secondary compact"
                disabled={busy || !candidate}
                onClick={() => candidate && onMatch(row.orderItemId, candidate.id)}
              >
                Confirm bill match
              </button>
            </div>
          )
        )}
        {confirmed &&
          onFindBill &&
          (row.status === 'review' || row.status === 'unmatched') &&
          row.baseUnits !== null &&
          !row.manualBillId && (
            <button className="text-button" disabled={busy} onClick={() => onFindBill(row)}>
              Find Tally bill
            </button>
          )}
      </td>
    </tr>
  );
}
