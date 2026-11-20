import { useEffect, useState } from 'react';
import type { StockCoverageStatus } from '../../shared/stock-coverage.js';
import { errorMessage, requestJson } from '../api.js';
import { formatDateTime } from '../format.js';

const indiaDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function StockCoverageSetup({
  companyId,
  accountId,
}: {
  companyId: string;
  accountId: string;
}) {
  const [status, setStatus] = useState<StockCoverageStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<StockCoverageStatus>(
      '/billing/coverage',
      { companyId, accountId },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setStatus(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [companyId, accountId, retry]);

  const today = new Date();
  const latest = indiaDay.format(today);
  const earliest = indiaDay.format(new Date(today.getTime() - 29 * 86_400_000));
  async function save() {
    if (!confirmed || saving || fromDate < earliest || fromDate > latest) return;
    setSaving(true);
    setError('');
    try {
      const result = await requestJson<StockCoverageStatus>('/billing/coverage/start', {
        companyId,
        accountId,
        fromDate,
        confirmed: true,
      });
      setStatus(result);
      setEditing(false);
      setConfirmed(false);
      setFromDate('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel settings-panel billing-panel">
      <h2>Order coverage for automatic stock updates</h2>
      {!status && !error && <p role="status">Checking order coverage…</p>}
      {status && (
        <>
          <p role="status">
            {status.current && status.from
              ? `Stockbridge checks orders for this company from ${indiaDay.format(new Date(status.from))} (India).`
              : status.from
                ? 'Live calculated stock above zero is waiting. Review the company’s setup and confirm the stock again.'
                : 'Before Stockbridge can publish a calculated stock quantity above zero to Flipkart, confirm the starting stock for this company.'}
          </p>
          {status.current && status.checkedThrough && (
            <p>Last order check through {formatDateTime(status.checkedThrough)}.</p>
          )}
          {!editing ? (
            <button className="button secondary" onClick={() => setEditing(true)}>
              {status.from ? 'Review starting stock' : 'Set starting stock'}
            </button>
          ) : (
            <form
              className="billing-form"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label className="field billing-period">
                <span>Track Flipkart orders from (India)</span>
                <input
                  type="date"
                  min={earliest}
                  max={latest}
                  required
                  value={fromDate}
                  disabled={saving}
                  onChange={(event) => {
                    setFromDate(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              <p>
                Choose a day in the last 30 days, including today. Tracking starts at midnight in
                India.
              </p>
              <ul>
                <li>
                  All Flipkart sales before this date are already recorded in Tally. Check any
                  previously outstanding sales before moving the date forward.
                </li>
                <li>
                  Every Flipkart seller account and location using this company’s stock is mapped.
                  Only standard and self-ship seller-fulfilled orders use this stock. Smart, Express
                  and Fulfilment by Flipkart orders use separate stock.
                </li>
                <li>
                  Each listing’s confirmed Set of matches the Tally units used per sale throughout
                  this period.
                </li>
              </ul>
              <label>
                <input
                  type="checkbox"
                  disabled={saving || !fromDate}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{' '}
                I have checked all three statements for this company.
              </label>
              <div className="billing-actions">
                <button
                  className="button primary"
                  type="submit"
                  disabled={saving || !confirmed || fromDate < earliest || fromDate > latest}
                >
                  {saving ? 'Saving starting stock…' : 'Confirm starting stock'}
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false);
                    setConfirmed(false);
                    setFromDate('');
                    setError('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {error && (
        <p className="message error" role="alert">
          {error}
        </p>
      )}
      {!status && error && (
        <button
          className="button secondary"
          onClick={() => {
            setError('');
            setRetry(retry + 1);
          }}
        >
          Retry loading coverage
        </button>
      )}
    </section>
  );
}
