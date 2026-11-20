import { useRef, useState } from 'react';
import type { AutomationPreview, AutomationPreviewRow } from '../../shared/automation.js';
import type { InventoryPublishRow } from '../../shared/contracts.js';
import { Modal } from '../components.js';
import type { Workspace } from '../useWorkspace.js';

const outcomes: Record<InventoryPublishRow['status'], string> = {
  confirmed: 'Stock update confirmed',
  unchanged: 'Stock already matches',
  blocked: 'Trial blocked',
  failed: 'Stock update failed',
  uncertain: 'Check the update result',
};

export function AutomationDialog({
  initial,
  demo,
  startWithTrial,
  workspace,
  onClose,
}: {
  initial: AutomationPreview;
  demo: boolean;
  startWithTrial: boolean;
  workspace: Workspace;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState(initial);
  const [choosing, setChoosing] = useState(startWithTrial);
  const [selected, setSelected] = useState<AutomationPreviewRow | null>(null);
  const [result, setResult] = useState<InventoryPublishRow | null>(null);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const busy = !!workspace.busy;
  const consumed = !!result || !!error;
  const ready = preview.rows.filter((row) => row.status === 'ready');
  const sellers = new Map<string, AutomationPreviewRow[]>();
  for (const row of preview.rows) {
    const rows = sellers.get(row.accountId);
    if (rows) rows.push(row);
    else sellers.set(row.accountId, [row]);
  }
  async function act(action: 'refresh' | 'trial' | 'enable') {
    if (pending.current || busy || (consumed && action !== 'refresh')) return;
    pending.current = true;
    try {
      if (action === 'refresh') {
        const next = await workspace.previewAutomation(preview.companyId);
        if (!next.ok) {
          setError(next.error);
          return;
        }
        setPreview(next.value);
        setResult(null);
        setError('');
        setChoosing(false);
        setSelected(null);
      } else if (action === 'trial' && selected) {
        const update = await workspace.tryAutomation(
          preview.companyId,
          preview.id,
          selected.listingId,
        );
        if (update.ok) setResult(update.value);
        else setError(update.error);
        await workspace.refreshSnapshot();
      } else if (action === 'enable' && !choosing) {
        const update = await workspace.mutate(
          '/automation',
          { companyId: preview.companyId, enabled: true, previewId: preview.id },
          'Enabling company updates',
          'Automatic stock updates enabled for ' + preview.companyName + '.',
        );
        if (update.ok) onClose();
        else {
          setError(update.error);
          await workspace.refreshSnapshot();
        }
      }
    } finally {
      pending.current = false;
    }
  }
  const title = choosing ? 'Try one listing' : 'Review automatic updates';
  const changed = ready.filter((row) => row.observed !== row.proposed).length;
  return (
    <Modal
      title={title}
      wide
      onClose={() => {
        if (!pending.current) onClose();
      }}
    >
      <div className="automation-review">
        <p>
          <strong>{preview.companyName}</strong> · {sellers.size} seller{' '}
          {sellers.size === 1 ? 'account' : 'accounts'} · {preview.rows.length} listing{' '}
          {preview.rows.length === 1 ? 'destination' : 'destinations'}
        </p>
        {choosing ? (
          <p>
            {!selected && 'Select one SKU and location for a one-time stock check. '}Company
            automatic updates stay off.
          </p>
        ) : (
          <>
            <p>
              Enabling updates {demo ? 'simulates stock changes' : 'can change Flipkart stock'}{' '}
              across this company. Newly verified mappings and listings whose setup or checks clear
              can join later. Paused listings stay paused until resumed.
            </p>
            <p>
              <strong>{changed} would change</strong> · {ready.length - changed} already match ·{' '}
              {preview.rows.filter((r) => r.status === 'waiting').length} waiting ·{' '}
              {preview.rows.filter((r) => r.status === 'paused').length} paused
            </p>
          </>
        )}
        {!preview.rows.length && <p>No listings are mapped to this company yet.</p>}
        {!selected &&
          Array.from(sellers, ([id, rows]) => (
            <section key={id} aria-label={rows[0].account}>
              <h3>{rows[0].account}</h3>
              <div className="review-table-wrap stock-review">
                <table className="review-table">
                  <thead>
                    <tr>
                      <th scope="col">SKU / location</th>
                      <th scope="col">Observed</th>
                      <th scope="col">Calculated</th>
                      <th scope="col">{choosing ? 'Trial' : 'First check'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.listingId}>
                        <td>
                          <strong>{row.sku}</strong>
                          <small>
                            {row.location} · {row.itemName}
                          </small>
                        </td>
                        <td>
                          <span className="review-cell-label" aria-hidden="true">
                            Observed
                          </span>
                          {row.observed ?? 'Unknown'}
                        </td>
                        <td>
                          <span className="review-cell-label" aria-hidden="true">
                            Calculated
                          </span>
                          {row.proposed ?? 'Unavailable'}
                        </td>
                        <td>
                          <span className="review-cell-label" aria-hidden="true">
                            {choosing ? 'Trial' : 'First check'}
                          </span>
                          {choosing && row.status === 'ready' ? (
                            <button
                              className="button secondary compact"
                              aria-label={
                                'Choose ' + row.sku + ' at ' + row.location + ' for ' + row.account
                              }
                              disabled={busy || consumed}
                              onClick={() => setSelected(row)}
                            >
                              Choose
                            </button>
                          ) : row.status === 'paused' ? (
                            'Paused'
                          ) : row.status === 'waiting' ? (
                            'Waiting'
                          ) : row.observed === row.proposed ? (
                            'Already matches'
                          ) : (
                            'Would change'
                          )}
                          {row.reason && <small>{row.reason}</small>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        {selected && (
          <section aria-label="Selected trial destination">
            <h3>{selected.sku}</h3>
            <p>
              {selected.account} · {selected.location} · {selected.itemName}
            </p>
            <p>
              Observed stock <strong>{selected.observed}</strong> · Calculated stock{' '}
              <strong>{selected.proposed}</strong>
            </p>
            {!consumed && (
              <p>
                {demo
                  ? 'This trial uses sample data.'
                  : 'Confirm to check this Flipkart location and send its calculated stock if the quantity differs.'}
              </p>
            )}
          </section>
        )}
        {result && (
          <div role="status">
            <strong>{outcomes[result.status]}</strong>
            <p>{result.message}</p>
          </div>
        )}
        {error && (
          <p role="alert" className="message error">
            {error}
          </p>
        )}
        {((selected && error) || result?.status === 'uncertain') && (
          <p>
            Open this SKU in Marketplaces and check its saved result before trying another update.
          </p>
        )}
        <div className="modal-actions">
          <button className="button secondary" disabled={busy} onClick={onClose}>
            Close
          </button>
          {consumed ? (
            <button className="button primary" disabled={busy} onClick={() => void act('refresh')}>
              Refresh company preview
            </button>
          ) : choosing ? (
            <>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setChoosing(false);
                  setSelected(null);
                }}
              >
                Back to company review
              </button>
              {selected && (
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void act('trial')}
                >
                  {demo ? 'Simulate this listing once' : 'Publish this listing once'}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                className="button secondary"
                disabled={busy || !ready.length}
                onClick={() => setChoosing(true)}
              >
                Try one listing
              </button>
              <button className="button primary" disabled={busy} onClick={() => void act('enable')}>
                Enable automatic updates for this company
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
