import { useEffect, useRef, useState } from 'react';
import type { BillLookup, BillingRow } from '../../shared/billing-contracts.js';
import { errorMessage, requestJson } from '../api.js';
import { Modal } from '../components.js';
import { formatIndiaDay } from '../format.js';
import { fieldLabels } from './BillingSetup.js';

export type BillTarget = Pick<BillingRow, 'orderItemId' | 'orderId' | 'sku'> & {
  previewId?: string;
};

export function FindTallyBill({
  companyId,
  accountId,
  order,
  ledgerName,
  onClose,
  onRefreshOrder,
  onSaved,
}: {
  companyId: string;
  accountId: string;
  order: BillTarget;
  ledgerName: string;
  onClose: () => void;
  onRefreshOrder: () => void;
  onSaved: () => void;
}) {
  const [billNumber, setBillNumber] = useState('');
  const [lookup, setLookup] = useState<BillLookup | null>(null);
  const [billId, setBillId] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<'search' | 'save' | null>(null);
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const bill = lookup?.bills.find((candidate) => candidate.id === billId);
  const ready = lookup && bill && bill.issue === null && (!bill.referenceMismatch || accepted);

  async function search() {
    if (pending.current || !billNumber.trim()) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy('search');
    setError('');
    setLookup(null);
    setBillId('');
    setAccepted(false);
    try {
      const result = await requestJson<BillLookup>(
        '/billing/find-bill',
        {
          companyId,
          accountId,
          orderItemId: order.orderItemId,
          ...(order.previewId && { previewId: order.previewId }),
          billNumber: billNumber.trim(),
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setLookup(result);
        if (result.bills.length === 1) setBillId(result.bills[0].id);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(null);
      }
    }
  }
  async function link() {
    if (pending.current || !ready) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy('save');
    setError('');
    try {
      await requestJson<{ saved: true }>(
        '/billing/link-bill',
        {
          companyId,
          accountId,
          orderItemId: order.orderItemId,
          billId: bill.id,
          reviewId: lookup.reviewId,
          acceptReferenceMismatch: bill.referenceMismatch && accepted,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) onSaved();
    } catch (cause) {
      if (!controller.signal.aborted) {
        setLookup(null);
        setAccepted(false);
        setError(errorMessage(cause));
      }
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null;
        setBusy(null);
      }
    }
  }

  return (
    <Modal
      title="Find Tally bill"
      wide
      onClose={() => {
        if (busy !== 'save') onClose();
      }}
    >
      <p className="modal-intro">
        <strong>{order.orderItemId}</strong> · {order.sku}
        <br />
        Order {order.orderId} · Sales ledger {lookup?.ledgerName ?? ledgerName}
      </p>
      <form
        className="billing-form"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="field">
          <span>Exact Tally bill number</span>
          <input
            required
            value={billNumber}
            disabled={!!busy}
            onChange={(event) => {
              setBillNumber(event.target.value);
              setLookup(null);
              setAccepted(false);
              setError('');
            }}
          />
        </label>
        <div className="billing-actions">
          <button
            type="submit"
            className="button secondary"
            disabled={!!busy || !billNumber.trim()}
          >
            {busy === 'search'
              ? 'Checking Tally…'
              : lookup || error
                ? 'Recheck bill'
                : 'Search bills'}
          </button>
        </div>
      </form>
      {error && (
        <div className="message error" role="alert">
          {error}
        </div>
      )}
      {lookup && lookup.bills.length === 0 && (
        <p role="status">
          No sales bill with this number was found for this order in {lookup.ledgerName}. Check the
          number, ledger and voucher date in Tally, then recheck.
        </p>
      )}
      {lookup && lookup.bills.length > 1 && (
        <label className="field">
          <span>Matching Tally vouchers</span>
          <select
            value={billId}
            disabled={!!busy}
            onChange={(event) => {
              setBillId(event.target.value);
              setAccepted(false);
            }}
          >
            <option value="">Choose a voucher</option>
            {lookup.bills.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.number} · {formatIndiaDay(candidate.date)} · Tally voucher ID{' '}
                {candidate.id}
              </option>
            ))}
          </select>
        </label>
      )}
      {lookup && bill && (
        <>
          <div className="table-scroll">
            <table className="billing-table" aria-label="Order and bill comparison">
              <thead>
                <tr>
                  <th scope="col">Compare</th>
                  <th scope="col">Flipkart order</th>
                  <th scope="col">Tally sales bill</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Identifier</th>
                  <td data-label="Flipkart order">{lookup.orderItemId}</td>
                  <td data-label="Tally sales bill">
                    {bill.number}
                    <small>Voucher ID {bill.id}</small>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Date in India</th>
                  <td data-label="Order date">{formatIndiaDay(lookup.orderDate)}</td>
                  <td data-label="Bill date">{formatIndiaDay(bill.date)}</td>
                </tr>
                <tr>
                  <th scope="row">Stock item and quantity</th>
                  <td data-label="Flipkart order">
                    {lookup.itemName} · {lookup.baseUnits ?? 'Unknown'} {lookup.unit}
                  </td>
                  <td data-label="Tally sales bill">
                    {bill.lines.length
                      ? bill.lines.map((line, index) => (
                          <div key={index}>
                            {line.itemName} · {line.quantity} {line.unit}
                          </div>
                        ))
                      : 'No stock lines'}
                  </td>
                </tr>
                {lookup.field !== 'manual' && (
                  <tr>
                    <th scope="row">{fieldLabels[lookup.field]}</th>
                    <td data-label="Expected reference">
                      {lookup.expectedReference || 'Unavailable'}
                    </td>
                    <td data-label="Recorded reference">{bill.recordedReference || 'Blank'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {bill.issue ? (
            <p role="alert" className="message error">
              {bill.issue}
            </p>
          ) : (
            bill.referenceMismatch && (
              <label>
                <input
                  type="checkbox"
                  checked={accepted}
                  disabled={!!busy}
                  onChange={(event) => setAccepted(event.target.checked)}
                />{' '}
                I checked the different references and confirm this bill belongs to this order item.
              </label>
            )
          )}
          <div className="modal-actions">
            <button
              className="button primary"
              disabled={!!busy || !ready}
              onClick={() => void link()}
            >
              {busy === 'save' ? 'Linking bill…' : 'Confirm bill link'}
            </button>
          </div>
        </>
      )}
      {(error || bill?.issue) && (
        <button className="text-button" disabled={!!busy} onClick={onRefreshOrder}>
          {order.previewId ? 'Close and refresh preview' : 'Close and refresh tracked orders'}
        </button>
      )}
    </Modal>
  );
}
