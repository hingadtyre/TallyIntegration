import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BillingReport,
  BillingRule,
  BillingWorkspace,
} from '../../shared/billing-contracts.js';
import type { Snapshot } from '../../shared/contracts.js';
import { errorMessage, requestJson } from '../api.js';
import { BillingResults } from './BillingResults.js';
import { StockCoverageSetup } from './StockCoverageSetup.js';
import { BillingSetup, fieldLabels, referenceLabels } from './BillingSetup.js';
import { BillingListingMappings } from './BillingListingMappings.js';
import type { SaveMapping } from './MappingDialog.js';

type Scope = { companyId: string; accountId: string };
type MappingAccess = { inventory: Snapshot; onSaveMapping: SaveMapping };

export function BillingScreen({
  companyId,
  accountId,
  inventory,
  onSaveMapping,
  onAccountChange,
  onConnect,
}: Scope &
  MappingAccess & {
    onAccountChange: (id: string) => void;
    onConnect: () => void;
  }) {
  const accounts = inventory.accounts;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Order matching</h1>
          <p>
            Flipkart reports the order. Match it to a Tally sales bill to see when you recorded the
            sale.
          </p>
        </div>
        {accounts.length > 0 && (
          <label className="account-select">
            <span>Flipkart seller account</span>
            <select value={accountId} onChange={(event) => onAccountChange(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {companyId && accountId ? (
        <LoadWorkspace
          key={JSON.stringify([companyId, accountId])}
          companyId={companyId}
          accountId={accountId}
          inventory={inventory}
          onSaveMapping={onSaveMapping}
        />
      ) : (
        <section className="panel empty-state">
          <h2>{companyId ? 'Add a Flipkart seller account' : 'Connect a Tally company'}</h2>
          <p>
            Matching uses the sales ledger in your selected company and orders from the selected
            seller account.
          </p>
          <button className="button secondary" onClick={onConnect}>
            {companyId ? 'Open Marketplaces' : 'View connections'}
          </button>
        </section>
      )}
    </>
  );
}

function LoadWorkspace({ companyId, accountId, ...mapping }: Scope & MappingAccess) {
  const [workspace, setWorkspace] = useState<BillingWorkspace | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<BillingWorkspace>('/billing/workspace', { companyId, accountId }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setWorkspace(data);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [companyId, accountId, retry]);
  if (error)
    return (
      <div className="message error" role="alert">
        {error}
        <button
          className="button secondary"
          onClick={() => {
            setError('');
            setRetry(retry + 1);
          }}
        >
          Retry loading setup
        </button>
      </div>
    );
  if (!workspace) return <p role="status">Loading billing setup…</p>;
  return (
    <BillingReview companyId={companyId} accountId={accountId} initial={workspace} {...mapping} />
  );
}

type RuleInput = Pick<BillingRule, 'ledgerId' | 'reference' | 'field'>;
type OrderPeriod = 'tracking' | 1 | 7 | 30;

function orderPeriod(report: BillingReport): OrderPeriod {
  if (report.period === 'tracking') return 'tracking';
  const elapsed = Date.parse(report.to) - Date.parse(report.from);
  if (elapsed >= 7 * 86_400_000) return 30;
  return elapsed >= 86_400_000 ? 7 : 1;
}

function BillingReview({
  companyId,
  accountId,
  initial,
  inventory,
  onSaveMapping,
}: Scope & MappingAccess & { initial: BillingWorkspace }) {
  const [workspace, setWorkspace] = useState(initial);
  const [editing, setEditing] = useState(!initial.rule && !initial.report);
  const [days, setDays] = useState<OrderPeriod>(
    initial.trackingFrom ? 'tracking' : initial.report ? orderPeriod(initial.report) : 7,
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [trackingRevision, setTrackingRevision] = useState(0);
  const [coverageSaving, setCoverageSaving] = useState(false);
  const [mappingBusy, setMappingBusy] = useState(false);
  const previewRequest = useRef<AbortController | null>(null);
  const { rule, report, trackingFrom } = workspace;
  const locked = !!busy || coverageSaving || mappingBusy;
  const periodChanged = !!report && days !== orderPeriod(report);
  const visibleReport = requiresRefresh || periodChanged ? null : report;
  const confirmed = !!(
    rule &&
    report &&
    rule.ledgerId === report.rule.ledgerId &&
    rule.ledgerName === report.rule.ledgerName &&
    rule.field === report.rule.field &&
    rule.reference === report.rule.reference
  );
  async function run(label: string, action: () => Promise<void>) {
    if (locked || !visibleReport) return;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
      setRequiresRefresh(true);
    } finally {
      setBusy('');
    }
  }
  const preview = useCallback(
    async (draft: RuleInput, period: OrderPeriod) => {
      previewRequest.current?.abort();
      const controller = new AbortController();
      previewRequest.current = controller;
      setBusy('Reading orders and bills…');
      setError('');
      setNotice('');
      setRequiresRefresh(true);
      try {
        const latest = await requestJson<BillingReport>(
          '/billing/preview',
          {
            companyId,
            accountId,
            ledgerId: draft.ledgerId,
            field: draft.field,
            reference: draft.reference,
            days: period,
          },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setWorkspace((previous) => ({ ...previous, report: latest }));
          setRequiresRefresh(false);
          setEditing(false);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) {
          previewRequest.current = null;
          setBusy('');
        }
      }
    },
    [companyId, accountId],
  );
  useEffect(() => {
    if (initial.trackingFrom && initial.rule && initial.report?.period !== 'tracking') {
      void preview(initial.rule, 'tracking');
    }
    return () => previewRequest.current?.abort();
  }, [initial, preview]);
  function changePeriod(value: string) {
    const period = value === 'tracking' ? value : (Number(value) as 1 | 7 | 30);
    setDays(period);
    if (!editing && rule && (!report || confirmed)) void preview(rule, period);
  }
  function startTracking(from: string) {
    if (!rule) return;
    const period = trackingFrom ? days : 'tracking';
    setWorkspace((previous) => ({ ...previous, trackingFrom: from }));
    setTrackingRevision((value) => value + 1);
    setDays(period);
    void preview(rule, period);
  }
  const confirm = () =>
    report &&
    run('Saving setup…', async () => {
      const next = await requestJson<BillingWorkspace>('/billing/confirm', {
        companyId,
        accountId,
        previewId: report.previewId,
      });
      setWorkspace(next);
      if (next.trackingFrom && !trackingFrom && next.rule) {
        setDays('tracking');
        await preview(next.rule, 'tracking');
      }
      setNotice('Billing setup saved for this company and seller account.');
    });
  const match = (orderItemId: string, billId: string) =>
    report &&
    run('Saving match…', async () => {
      const next = await requestJson<BillingWorkspace>('/billing/match', {
        companyId,
        accountId,
        previewId: report.previewId,
        orderItemId,
        billId,
      });
      setWorkspace(next);
      setNotice('Bill match saved.');
    });
  const unmatch = (orderItemId: string) =>
    report &&
    run('Releasing match…', async () => {
      const next = await requestJson<BillingWorkspace>('/billing/unmatch', {
        companyId,
        accountId,
        previewId: report.previewId,
        orderItemId,
      });
      setWorkspace(next);
      setNotice('Manual confirmation released.');
    });
  const shownRule = report?.rule ?? rule;
  return (
    <div className="billing-layout">
      <section className="panel settings-panel billing-panel">
        <h2>
          {editing
            ? 'Set up bill matching'
            : confirmed || !report
              ? 'Saved billing setup'
              : 'Review billing setup'}
        </h2>
        <label className="field billing-period">
          <span>Order period</span>
          <select
            value={days}
            disabled={locked}
            onChange={(event) => changePeriod(event.target.value)}
          >
            {trackingFrom && <option value="tracking">Since tracking start (up to 30 days)</option>}
            <option value={1}>Today in India</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </label>
        {editing ? (
          <BillingSetup
            companyId={companyId}
            accountId={accountId}
            initialRule={shownRule}
            busy={locked}
            onPreview={(draft) => preview(draft, days)}
            onCancel={
              shownRule
                ? () => {
                    setEditing(false);
                    setError('');
                    if (rule && (!report || confirmed) && periodChanged) void preview(rule, days);
                  }
                : undefined
            }
          />
        ) : (
          shownRule && (
            <>
              <dl className="connection-details">
                <div>
                  <dt>Sales bill ledger</dt>
                  <dd>{shownRule.ledgerName}</dd>
                </div>
                <div>
                  <dt>Bill reference field</dt>
                  <dd>{fieldLabels[shownRule.field]}</dd>
                </div>
                {shownRule.field !== 'manual' && (
                  <div>
                    <dt>Flipkart reference</dt>
                    <dd>{referenceLabels[shownRule.reference]}</dd>
                  </div>
                )}
              </dl>
              {report && !confirmed && (
                <p>
                  Review the preview below, then save these settings to use them for this seller.
                </p>
              )}
              <div className="billing-actions">
                {report && !confirmed && (
                  <button
                    className="button primary"
                    disabled={locked || !visibleReport}
                    onClick={() => void confirm()}
                  >
                    Confirm billing setup
                  </button>
                )}
                <button
                  className="button secondary"
                  disabled={locked}
                  onClick={() => void preview(shownRule, days)}
                >
                  Refresh preview
                </button>
                <button
                  className="text-button"
                  disabled={locked}
                  onClick={() => {
                    setEditing(true);
                    setError('');
                    setNotice('');
                  }}
                >
                  Change setup
                </button>
                {rule && report && !confirmed && (
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => {
                      setWorkspace((previous) => ({ ...previous, report: null }));
                      setError('');
                      setNotice('');
                      void preview(rule, days);
                    }}
                  >
                    Return to saved setup
                  </button>
                )}
              </div>
            </>
          )
        )}
        {busy && <p role="status">{busy}</p>}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="message success" role="status">
            {notice}
          </p>
        )}
      </section>
      {rule && !editing && (
        <StockCoverageSetup
          key={JSON.stringify(rule)}
          companyId={companyId}
          accountId={accountId}
          disabled={!!busy || mappingBusy || (!!report && !confirmed)}
          onSavingChange={setCoverageSaving}
          onStart={startTracking}
        />
      )}
      {!editing && (report || rule) && (
        <BillingListingMappings
          key={trackingRevision}
          companyId={companyId}
          accountId={accountId}
          inventory={inventory}
          report={visibleReport}
          busy={!!busy || coverageSaving}
          onCheckingChange={setMappingBusy}
          onSaveMapping={onSaveMapping}
          onRefreshPreview={async () => {
            if (report) await preview(report.rule, days);
          }}
        />
      )}
      {!rule && (
        <p>
          Automatic stock increases wait until you confirm bill matching and set the starting stock
          for this company.
        </p>
      )}
      {!editing && visibleReport && (
        <BillingResults
          report={visibleReport}
          trackingFrom={trackingFrom}
          confirmed={confirmed}
          busy={locked}
          onMatch={(order, bill) => void match(order, bill)}
          onUnmatch={(order) => void unmatch(order)}
        />
      )}
      {!editing && !busy && !visibleReport && (
        <p>Refresh the preview to check recent orders against the saved ledger.</p>
      )}
    </div>
  );
}
