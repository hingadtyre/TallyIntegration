import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BillingReport,
  BillingRule,
  BillingWorkspace,
  TrackedBillOrder,
} from '../../shared/billing-contracts.js';
import type { Snapshot } from '../../shared/contracts.js';
import { errorMessage, requestJson } from '../api.js';
import { marketplaceName } from '../../shared/marketplaces.js';
import { SellerAccountPicker } from '../MarketplaceSeller.js';
import { BillingResults } from './BillingResults.js';
import { StockCoverageSetup } from './StockCoverageSetup.js';
import { BillingSetup, fieldLabels, referenceLabels } from './BillingSetup.js';
import { BillingListingMappings, TrackedListingMapping } from './BillingListingMappings.js';
import type { SaveMapping } from './MappingDialog.js';
import { FindTallyBill, type BillTarget } from './FindTallyBill.js';

type Scope = { companyId: string; accountId: string };
type MappingAccess = {
  inventory: Snapshot;
  onSaveMapping: SaveMapping;
  onUnsavedChange?: (dirty: boolean) => void;
};

export function BillingScreen({
  companyId,
  accountId,
  inventory,
  onSaveMapping,
  onAccountChange,
  onConnect,
  onUnsavedChange,
}: Scope &
  MappingAccess & {
    onAccountChange: (id: string) => void;
    onConnect: () => void;
  }) {
  const accounts = inventory.accounts;
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const provider = marketplaceName(selectedAccount?.marketplace);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Order matching</h1>
          <p>
            {provider ?? 'The marketplace'} reports the order. Match it to a Tally sales bill to see
            when you recorded the sale.
          </p>
        </div>
        {accounts.length > 0 && (
          <SellerAccountPicker
            accounts={accounts}
            selected={selectedAccount}
            onSelect={onAccountChange}
          />
        )}
      </div>
      {companyId && accountId ? (
        <LoadWorkspace
          key={JSON.stringify([companyId, accountId])}
          companyId={companyId}
          accountId={accountId}
          inventory={inventory}
          onSaveMapping={onSaveMapping}
          onUnsavedChange={onUnsavedChange}
        />
      ) : (
        <section className="panel empty-state">
          <h2>{companyId ? 'Add a seller account' : 'Connect a Tally company'}</h2>
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
  onUnsavedChange,
}: Scope & MappingAccess & { initial: BillingWorkspace }) {
  const [workspace, setWorkspace] = useState(initial);
  const [editing, setEditing] = useState(!initial.rule && !initial.report);
  const [setupOpen, setSetupOpen] = useState(false);
  const [days, setDays] = useState<OrderPeriod>(
    initial.trackingFrom ? 'tracking' : initial.report ? orderPeriod(initial.report) : 7,
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [trackingRevision, setTrackingRevision] = useState(0);
  // Saving a date here resets the filters. A date discovered during a check only
  // invalidates the settings form; the order list already has the correct results.
  const [localTrackingDate, setLocalTrackingDate] = useState(initial.trackingFrom);
  const [coverageRevision, setCoverageRevision] = useState(0);
  const [coverageSaving, setCoverageSaving] = useState(false);
  const [mappingBusy, setMappingBusy] = useState(false);
  const [setupDirty, setSetupDirty] = useState(false);
  const [coverageDirty, setCoverageDirty] = useState(false);
  const [findOrder, setFindOrder] = useState<BillTarget | null>(null);
  const findTrigger = useRef<HTMLButtonElement | null>(null);
  const trackedHeading = useRef<HTMLHeadingElement>(null);
  const focusTrackedHeading = useRef(false);
  const previewRequest = useRef<AbortController | null>(null);
  const { rule, report, trackingFrom } = workspace;
  const tracked = !!(trackingFrom && rule) && !setupOpen;
  useEffect(() => {
    if (tracked && focusTrackedHeading.current) {
      trackedHeading.current?.focus();
      focusTrackedHeading.current = false;
    }
  }, [tracked, trackingRevision]);
  const locked = !!busy || coverageSaving || mappingBusy || !!findOrder;
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
  const dirty = setupDirty || coverageDirty || (!tracked && !!report && !confirmed);
  useEffect(() => {
    onUnsavedChange?.(dirty);
    return () => onUnsavedChange?.(false);
  }, [dirty, onUnsavedChange]);
  function openBillFinder(order: BillTarget, trigger: HTMLButtonElement) {
    findTrigger.current = trigger;
    setFindOrder(order);
  }
  useEffect(() => {
    if (findOrder || !findTrigger.current) return;
    if (findTrigger.current.isConnected) findTrigger.current.focus();
    findTrigger.current = null;
  }, [findOrder]);
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
  async function preview(draft: RuleInput, period: OrderPeriod) {
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
  }
  useEffect(() => () => previewRequest.current?.abort(), []);
  function changePeriod(value: string) {
    const period = value === 'tracking' ? value : (Number(value) as 1 | 7 | 30);
    setDays(period);
    if (!editing && rule && (!report || confirmed)) void preview(rule, period);
  }
  function startTracking(from: string) {
    if (!rule) return;
    focusTrackedHeading.current = true;
    setLocalTrackingDate(from);
    setWorkspace((previous) => ({ ...previous, trackingFrom: from, report: null }));
    setTrackingRevision((value) => value + 1);
    setDays('tracking');
    setEditing(false);
    setSetupOpen(false);
    setError('');
    setNotice('');
  }
  const syncCheckedDate = useCallback((from: string) => {
    setWorkspace((previous) => ({ ...previous, trackingFrom: from, report: null }));
    setCoverageRevision((value) => value + 1);
  }, []);
  function backToTracked() {
    focusTrackedHeading.current = true;
    setEditing(false);
    setSetupOpen(false);
    setWorkspace((previous) => ({ ...previous, report: null }));
    setError('');
    setNotice('');
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
      if (next.trackingFrom && next.rule) {
        focusTrackedHeading.current = true;
        setDays('tracking');
        setSetupOpen(false);
        setTrackingRevision((value) => value + 1);
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
      setTrackingRevision((value) => value + 1);
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
      setTrackingRevision((value) => value + 1);
      setNotice('Manual confirmation released.');
    });
  async function refreshBillDecision(message: string) {
    setFindOrder(null);
    setTrackingRevision((value) => value + 1);
    if (rule && !tracked) await preview(rule, days);
    setNotice(message);
  }
  async function releaseTracked(order: TrackedBillOrder) {
    if (locked || !order.manualBillId || !order.linkToken) return;
    setBusy('Releasing match…');
    setError('');
    setNotice('');
    try {
      await requestJson<{ saved: true }>('/billing/release-bill', {
        companyId,
        accountId,
        orderItemId: order.orderItemId,
        billId: order.manualBillId,
        linkToken: order.linkToken,
      });
      await refreshBillDecision('Manual confirmation released for ' + order.orderItemId + '.');
    } catch (cause) {
      setTrackingRevision((value) => value + 1);
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }
  const shownRule = tracked ? rule : (report?.rule ?? rule);
  return (
    <div className="billing-layout">
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
      {tracked && trackingFrom && (
        <BillingResults
          key={localTrackingDate}
          trackingFrom={trackingFrom}
          tracking={{
            companyId,
            accountId,
            revision: trackingRevision,
            headingRef: trackedHeading,
            onTrackingDateChanged: syncCheckedDate,
            onFind: openBillFinder,
            onRelease: (order) => void releaseTracked(order),
            renderMapping: (order, disabled) => (
              <TrackedListingMapping
                order={order}
                inventory={inventory}
                companyId={companyId}
                accountId={accountId}
                busy={disabled}
                onSaveMapping={onSaveMapping}
                onMapped={() => {
                  setError('');
                  setNotice('Listing mapping saved for ' + order.orderItemId + '.');
                  setTrackingRevision((value) => value + 1);
                }}
              />
            ),
          }}
          busy={locked}
        />
      )}
      <section className="panel settings-panel billing-panel">
        <h2>
          {tracked
            ? 'Saved billing setup'
            : editing
              ? 'Set up bill matching'
              : confirmed || !report
                ? 'Saved billing setup'
                : 'Review billing setup'}
        </h2>
        {!tracked && (
          <label className="field billing-period">
            <span>Order period</span>
            <select
              value={days}
              disabled={locked}
              onChange={(event) => changePeriod(event.target.value)}
            >
              {trackingFrom && (
                <option value="tracking">Since tracking start (up to 30 days)</option>
              )}
              <option value={1}>Today in India</option>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
            </select>
          </label>
        )}
        {editing ? (
          <BillingSetup
            companyId={companyId}
            accountId={accountId}
            initialRule={shownRule}
            onDirtyChange={setSetupDirty}
            busy={locked}
            onPreview={(draft) => preview(draft, days)}
            onCancel={
              setupOpen && trackingFrom
                ? backToTracked
                : shownRule
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
                    <dt>Order reference</dt>
                    <dd>{referenceLabels[shownRule.reference]}</dd>
                  </div>
                )}
              </dl>
              {!tracked && report && !confirmed && (
                <p>
                  Review the preview below, then save these settings to use them for this seller.
                </p>
              )}
              <div className="billing-actions">
                {!tracked && report && !confirmed && (
                  <button
                    className="button primary"
                    disabled={locked || !visibleReport}
                    onClick={() => void confirm()}
                  >
                    Confirm billing setup
                  </button>
                )}
                {!tracked && (
                  <button
                    className="button secondary"
                    disabled={locked}
                    onClick={() => void preview(shownRule, days)}
                  >
                    Refresh preview
                  </button>
                )}
                <button
                  className="text-button"
                  disabled={locked}
                  onClick={() => {
                    if (
                      coverageDirty &&
                      !window.confirm('Discard unsaved tracking changes and edit billing setup?')
                    )
                      return;
                    if (tracked) {
                      setWorkspace((previous) => ({ ...previous, report: null }));
                      setSetupOpen(true);
                    }
                    setEditing(true);
                    setError('');
                    setNotice('');
                  }}
                >
                  Change setup
                </button>
                {setupOpen && trackingFrom ? (
                  <button className="text-button" disabled={locked} onClick={backToTracked}>
                    Back to tracked orders
                  </button>
                ) : (
                  !tracked &&
                  rule &&
                  report &&
                  !confirmed && (
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
                  )
                )}
              </div>
            </>
          )
        )}
      </section>
      {rule && !editing && !setupOpen && (
        <StockCoverageSetup
          key={JSON.stringify([rule, coverageRevision])}
          companyId={companyId}
          accountId={accountId}
          disabled={!!busy || mappingBusy || !!findOrder || (!tracked && !!report && !confirmed)}
          onSavingChange={setCoverageSaving}
          onDirtyChange={setCoverageDirty}
          onStart={startTracking}
        />
      )}
      {!trackingFrom && !editing && (report || rule) && (
        <BillingListingMappings
          key={trackingRevision}
          companyId={companyId}
          accountId={accountId}
          inventory={inventory}
          report={visibleReport}
          busy={!!busy || coverageSaving || !!findOrder}
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
      {!tracked && !editing && (visibleReport || rule) && (
        <BillingResults
          report={visibleReport}
          trackingFrom={trackingFrom}
          confirmed={confirmed}
          busy={locked}
          onMatch={(order, bill) => void match(order, bill)}
          onUnmatch={(order) => void unmatch(order)}
          onFindBill={
            visibleReport
              ? (row, trigger) =>
                  openBillFinder({ ...row, previewId: visibleReport.previewId }, trigger)
              : undefined
          }
        />
      )}
      {findOrder && rule && (
        <FindTallyBill
          companyId={companyId}
          accountId={accountId}
          seller={inventory.accounts.find((account) => account.id === accountId)}
          order={findOrder}
          ledgerName={rule.ledgerName}
          onClose={() => setFindOrder(null)}
          onRefreshOrder={() => {
            setFindOrder(null);
            if (tracked) setTrackingRevision((value) => value + 1);
            else void preview(rule, days);
          }}
          onSaved={() =>
            void refreshBillDecision('Tally bill linked to ' + findOrder.orderItemId + '.')
          }
        />
      )}
      {!tracked && !editing && !busy && !visibleReport && (
        <p>Refresh the preview to check recent orders against the saved ledger.</p>
      )}
    </div>
  );
}
