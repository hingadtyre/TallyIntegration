import { useEffect, useState } from 'react';
import type { StockCoverageStatus } from '../../shared/stock-coverage.js';
import { errorMessage, requestJson } from '../api.js';

const indiaDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function StockCoverageSetup({
  companyId,
  accountId,
  disabled = false,
  onStart,
  onSavingChange,
}: {
  companyId: string;
  accountId: string;
  disabled?: boolean;
  onStart: (from: string) => void;
  onSavingChange?: (saving: boolean) => void;
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
  const savedDate = status?.from ? indiaDay.format(new Date(status.from)) : '';
  const validDate = fromDate >= earliest && fromDate <= latest;
  async function save() {
    if (!confirmed || saving || disabled || !validDate) return;
    setSaving(true);
    onSavingChange?.(true);
    setError('');
    try {
      const result = await requestJson<StockCoverageStatus & { from: string }>(
        '/billing/coverage/start',
        { companyId, accountId, fromDate, confirmed: true },
      );
      setStatus(result);
      setEditing(false);
      onStart(result.from);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }
  return (
    <section className="panel settings-panel billing-panel">
      <h2>Order tracking for calculated stock</h2>
      <p>
        This date applies to all participating sellers for this company. A tracked sale with a stock
        mapping reserves units until its Tally bill is matched.
      </p>
      {!status && !error && <p role="status">Checking order coverage…</p>}
      {status && (
        <>
          <p role="status">
            {status.current && savedDate
              ? `Stockbridge checks orders for this company from ${savedDate} (India).`
              : (status.issue ??
                (status.from
                  ? 'Review the starting stock for this company.'
                  : 'Choose the date to start tracking this company’s Flipkart orders.'))}
          </p>
          {!status.current && savedDate && (
            <p>The saved tracking start date is {savedDate} (India).</p>
          )}
          {!editing ? (
            <button
              className="button secondary"
              disabled={disabled}
              onClick={() => {
                setFromDate(savedDate);
                setConfirmed(false);
                setEditing(true);
              }}
            >
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
                  disabled={saving || disabled}
                  onChange={(event) => {
                    setFromDate(event.target.value);
                    setConfirmed(false);
                  }}
                />
              </label>
              {savedDate && savedDate < earliest && fromDate === savedDate ? (
                <p>
                  Your saved date is outside the last 30 days. Cancel to keep it, or choose a day in
                  the last 30 days to change it.
                </p>
              ) : (
                <p>Choose a day in the last 30 days. Tracking starts at midnight in India.</p>
              )}
              {savedDate && fromDate > savedDate && (
                <p role="status">
                  Orders before {fromDate} will stop reserving stock. Check that those sales are
                  already recorded in Tally before confirming.
                </p>
              )}
              <ul>
                <li>
                  All Flipkart sales before this date are already recorded in Tally. Check any
                  previously outstanding sales before moving the date forward.
                </li>
                <li>
                  Every seller account sharing this stock has bill matching set up. Only standard
                  and self-ship seller-fulfilled orders use this stock. Smart, Express and
                  Fulfilment by Flipkart orders use separate stock.
                </li>
                <li>
                  Each mapped listing’s Set of matches the Tally units used per sale throughout this
                  period. I can map other listings as their orders appear.
                </li>
              </ul>
              <label>
                <input
                  type="checkbox"
                  disabled={saving || disabled || !validDate}
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />{' '}
                I have checked all three statements for this company.
              </label>
              <div className="billing-actions">
                <button
                  className="button primary"
                  type="submit"
                  disabled={saving || disabled || !confirmed || !validDate}
                >
                  {saving ? 'Saving starting stock…' : 'Confirm starting stock'}
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false);
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
