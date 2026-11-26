import { useEffect, useState } from 'react';
import type { StockCoverageStatus } from '../../shared/stock-coverage.js';
import { errorMessage, requestJson } from '../api.js';
import { formatIndiaDay } from '../format.js';

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
  const [editing, setEditing] = useState<'billing' | 'stock' | null>(null);
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
  const savedFrom = status?.from ?? status?.billingFrom;
  const savedDate = savedFrom ? indiaDay.format(new Date(savedFrom)) : '';
  const validDate = fromDate >= earliest && fromDate <= latest;
  function edit(mode: 'billing' | 'stock') {
    setFromDate(savedDate);
    setConfirmed(false);
    setError('');
    setEditing(mode);
  }
  async function save() {
    if (!editing || (editing === 'stock' && !confirmed) || saving || disabled || !validDate) return;
    setSaving(true);
    onSavingChange?.(true);
    setError('');
    try {
      const result = await requestJson<StockCoverageStatus>(
        editing === 'stock' ? '/billing/coverage/start' : '/billing/tracking/start',
        { companyId, accountId, fromDate, ...(editing === 'stock' && { confirmed: true }) },
      );
      const from = result.billingFrom ?? result.from;
      if (!from) throw new Error('The server did not return the saved tracking date.');
      setStatus(result);
      setEditing(null);
      onStart(from);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  }
  return (
    <section className="panel settings-panel billing-panel">
      <h2>Order tracking</h2>
      <p>
        This date applies to all participating sellers for this Tally company.
        {status &&
          !status.from &&
          ' To reserve units for mapped sales awaiting a Tally bill, set the starting stock for this company.'}
      </p>
      {!status && !error && <p role="status">Checking order coverage…</p>}
      {status && (
        <>
          <p role="status">
            {status.from
              ? status.current
                ? `Stockbridge checks orders for this company from ${formatIndiaDay(savedDate)} (India).`
                : (status.issue ?? 'Review the starting stock for this company.')
              : savedDate
                ? `Bill matching starts on ${formatIndiaDay(savedDate)} (India).`
                : 'Choose the date to start matching Flipkart orders to Tally bills.'}
          </p>
          {!status.current && status.from && (
            <p>The saved tracking start date is {formatIndiaDay(savedDate)} (India).</p>
          )}
          {!editing ? (
            <div className="billing-actions">
              {!status.from && (
                <button
                  className="button secondary"
                  disabled={disabled}
                  onClick={() => edit('billing')}
                >
                  {savedDate ? 'Change billing start date' : 'Set billing start date'}
                </button>
              )}
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => edit('stock')}
              >
                {status.from ? 'Review starting stock' : 'Set starting stock'}
              </button>
            </div>
          ) : (
            <form
              className="billing-form"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label className="field billing-period">
                <span>
                  {editing === 'billing'
                    ? 'Match Flipkart orders from (India)'
                    : 'Track Flipkart orders from (India)'}
                </span>
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
              {editing === 'stock' && status.from && fromDate > savedDate && (
                <p role="status">
                  Orders before {formatIndiaDay(fromDate)} will stop reserving stock. Check that
                  those sales are already recorded in Tally before confirming.
                </p>
              )}
              {editing === 'stock' && (
                <>
                  <p>
                    A tracked sale with a stock mapping reserves units until its Tally bill is
                    matched.
                  </p>
                  <ul>
                    <li>
                      All Flipkart sales before this date are already recorded in Tally. Check any
                      previously outstanding sales before moving the date forward.
                    </li>
                    <li>
                      Every seller account sharing this stock has bill matching set up. Only
                      standard and self-ship orders use this stock. If I receive Smart, Express or
                      Fulfilment by Flipkart orders, I have checked that they use separate stock.
                    </li>
                    <li>
                      Each mapped listing’s Set of matches the Tally units used per sale throughout
                      this period. I can map other listings as their orders appear.
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
                </>
              )}
              <div className="billing-actions">
                <button
                  className="button primary"
                  type="submit"
                  disabled={saving || disabled || (editing === 'stock' && !confirmed) || !validDate}
                >
                  {editing === 'stock'
                    ? saving
                      ? 'Saving starting stock…'
                      : 'Confirm starting stock'
                    : saving
                      ? 'Saving billing start date…'
                      : 'Save billing start date'}
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setEditing(null);
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
