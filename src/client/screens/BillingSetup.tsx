import { useEffect, useState } from 'react';
import type { BillField, BillingRule, OrderReference } from '../../shared/billing-contracts.js';
import { errorMessage, requestJson } from '../api.js';
import { SearchablePicker } from '../SearchablePicker.js';

type LedgerOption = { externalId: string; name: string };

export const fieldLabels: Record<BillField, string> = {
  reference: 'Voucher reference',
  number: 'Voucher number',
  narration: 'Narration',
  manual: 'I match bills manually',
};
export const referenceLabels: Record<OrderReference, string> = {
  orderId: 'Order ID',
  orderItemId: 'Order item ID',
  invoiceNumber: 'Invoice number',
};

export function BillingSetup({
  companyId,
  accountId,
  initialRule,
  busy,
  onPreview,
  onCancel,
}: {
  companyId: string;
  accountId: string;
  initialRule: BillingRule | null;
  busy: boolean;
  onPreview: (input: Pick<BillingRule, 'ledgerId' | 'field' | 'reference'>) => Promise<void>;
  onCancel?: () => void;
}) {
  const [ledgers, setLedgers] = useState<LedgerOption[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [ledgerId, setLedgerId] = useState(initialRule?.ledgerId ?? '');
  const [field, setField] = useState<BillField | ''>(initialRule?.field ?? '');
  const [reference, setReference] = useState<OrderReference | ''>(initialRule?.reference ?? '');
  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ ledgers: LedgerOption[] }>(
      '/billing/ledgers',
      { companyId, accountId },
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setLedgers(data.ledgers);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [companyId, accountId, retry]);
  const selected = ledgers?.find((ledger) => ledger.externalId === ledgerId);
  const ready = selected && field && (field === 'manual' || reference);
  return (
    <form
      className="billing-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) void onPreview({ ledgerId, field, reference: reference || 'orderId' });
      }}
    >
      <p>
        Choose the Tally ledger where you record this seller’s sales. It can be the party ledger on
        the bill or the sales ledger on its stock lines. Payout and fee ledgers serve a different
        purpose.
      </p>
      {error || ledgers?.length === 0 ? (
        <div className="billing-actions">
          {error ? (
            <span role="alert">{error}</span>
          ) : (
            <span>No ledgers were found in the selected company.</span>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setLedgers(null);
              setError('');
              setRetry(retry + 1);
            }}
          >
            Reload ledgers
          </button>
        </div>
      ) : !ledgers ? (
        <p role="status">Reading company ledgers…</p>
      ) : (
        <SearchablePicker
          label="Sales bill ledger"
          placeholder="Choose a ledger"
          emptyMessage="No matching ledgers. Try another name."
          options={ledgers}
          getId={(ledger) => ledger.externalId}
          getLabel={(ledger) => ledger.name}
          selected={selected}
          disabled={busy}
          onSelect={setLedgerId}
        />
      )}
      <label className="field">
        <span>Where do you enter the order reference on the Tally bill?</span>
        <select
          value={field}
          required
          disabled={busy}
          onChange={(event) => setField(event.target.value as BillField | '')}
        >
          <option value="">Choose a bill field</option>
          {(Object.entries(fieldLabels) as [BillField, string][]).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {field && field !== 'manual' && (
        <label className="field">
          <span>Which order reference do you enter?</span>
          <select
            value={reference}
            required
            disabled={busy}
            onChange={(event) => setReference(event.target.value as OrderReference | '')}
          >
            <option value="">Choose a reference</option>
            {(Object.entries(referenceLabels) as [OrderReference, string][]).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="billing-actions">
        <button type="submit" className="button primary" disabled={busy || !ready}>
          Preview matches
        </button>
        {onCancel && (
          <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
