import type { Snapshot } from '../../shared/contracts.js';
import type { Workspace } from '../useWorkspace.js';
import { Icon } from '../components.js';
import { formatCompanyStockIssue, formatDateTime as time } from '../format.js';
import { CustomerSetup } from '../CustomerSetup.js';

export function ConnectionsScreen({
  state,
  workspace,
  onOpenSettings,
  onOpenMarketplaces,
}: {
  state: Snapshot;
  workspace: Workspace;
  onOpenSettings: () => void;
  onOpenMarketplaces?: () => void;
}) {
  const { busy, refreshTally } = workspace;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR DATA SOURCES</div>
          <h1>Connections</h1>
          <p>Keep the company and seller account behind every quantity explicit.</p>
        </div>
      </div>
      <CustomerSetup onOpenSettings={onOpenSettings} />
      <div className="connection-grid">
        <section className="panel connection-card">
          <div className="connection-card-top">
            <div className="service-logo tally-logo">T</div>
            <span
              className={`badge ${state.connection.tally === 'online' ? 'badge-green' : 'badge-amber'}`}
            >
              {state.mode === 'demo'
                ? 'Sample data'
                : state.connection.tally === 'online'
                  ? 'Connected'
                  : state.connection.tally === 'offline'
                    ? 'Offline'
                    : 'Not checked'}
            </span>
          </div>
          <h2>Tally</h2>
          <p>Read stock items from the companies loaded on this computer.</p>
          <dl className="connection-details">
            <div>
              <dt>Address</dt>
              <dd>{state.settings.tallyUrl}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>{time(state.connection.lastChecked)}</dd>
            </div>
            <div>
              <dt>Next stock check</dt>
              <dd>{time(state.connection.nextPoll)}</dd>
            </div>
            <div>
              <dt>Companies found</dt>
              <dd>{state.companies.length}</dd>
            </div>
          </dl>
          <div className="connection-note">{state.connection.message}</div>
          {state.mode === 'live' && state.companies.length > 0 && (
            <dl className="connection-details">
              {state.companies.map((company) => (
                <div key={company.id}>
                  <dt>{company.name}</dt>
                  <dd>
                    {company.stockIssue && (
                      <strong>{formatCompanyStockIssue(company.stockIssue)}. </strong>
                    )}
                    Last successful read: {time(company.lastSuccess)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => void refreshTally()}
          >
            <Icon name="refresh" />
            Check & discover companies
          </button>
        </section>
        <section className="panel connection-card">
          <div className="service-logo flipkart-logo">F</div>
          <h2>Marketplace accounts</h2>
          <p>
            Add each seller account separately in Marketplaces. Open its tile to refresh listings or
            apply a stock or price edit.
          </p>
          <button className="button secondary" onClick={onOpenMarketplaces}>
            Open Marketplaces
          </button>
        </section>
      </div>
      <section className="panel setup-panel">
        <h2>If Tally does not connect</h2>
        <ol>
          <li>
            <strong>Keep Tally open on this computer.</strong>
            <span>Load the company you want to check before trying discovery again.</span>
          </li>
          <li>
            <strong>Check that the ports match.</strong>
            <span>
              The number at the end of the connection address must match Tally's HTTP port.
            </span>
          </li>
          <li>
            <strong>Follow Tally's restart prompt.</strong>
            <span>
              If Tally asks you to restart after enabling its connection, reopen your company
              afterward.
            </span>
          </li>
          <li>
            <strong>Keep the error details for support.</strong>
            <span>
              Open Activity for the check history. Diagnostics contains details you can export.
            </span>
          </li>
        </ol>
        <button className="text-button" onClick={() => onOpenSettings()}>
          Manage local connection settings <Icon name="arrow" />
        </button>
      </section>
    </>
  );
}
