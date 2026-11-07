import type { Snapshot } from '../../shared/contracts.js';
import type { Workspace } from '../useWorkspace.js';
import { Icon } from '../components.js';
import { formatDateTime as time } from '../format.js';
import { CustomerSetup } from '../CustomerSetup.js';

export function ConnectionsScreen({
  state,
  workspace,
  onOpenSettings,
}: {
  state: Snapshot;
  workspace: Workspace;
  onOpenSettings: () => void;
}) {
  const { busy, mutate } = workspace;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR DATA SOURCES</div>
          <h1>Connections</h1>
          <p>Keep the company and seller account behind every quantity explicit.</p>
        </div>
      </div>
      <CustomerSetup />
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
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() =>
              void mutate('/refresh', {}, 'Checking Tally', 'Tally connection check completed.')
            }
          >
            <Icon name="refresh" />
            Check & discover companies
          </button>
        </section>
        {state.accounts.map((value) => (
          <section className="panel connection-card" key={value.id}>
            <div className="connection-card-top">
              <div className="service-logo flipkart-logo">F</div>
              <span className="badge badge-amber">
                {value.status === 'demo' ? 'Sample account' : 'API connection pending'}
              </span>
            </div>
            <h2>Flipkart</h2>
            <p className="account-name">{value.name}</p>
            <p>
              {value.status === 'demo'
                ? 'A demonstration account in the sample workspace.'
                : 'Account name observed in the seller dashboard. API identity has not yet been verified.'}
            </p>
            <div className="connection-note">
              <Icon name="info" />
              <span>
                Signing in to the seller website does not connect this app. API authorization,
                inventory locations, pack evidence and order access still need verification.
              </span>
            </div>
            <div className="connection-footer">
              <span className="status-dot muted" />
              Marketplace writes unavailable
            </div>
          </section>
        ))}
      </div>
      <section className="panel setup-panel">
        <h2>Connection checklist</h2>
        <ol>
          <li>
            <strong>Open the correct Tally company.</strong>
            <span>The dashboard keeps each company's stock separate.</span>
          </li>
          <li>
            <strong>Verify the seller account and inventory location.</strong>
            <span>Every destination belongs to a specific account and location.</span>
          </li>
          <li>
            <strong>Match the physical product and pack size.</strong>
            <span>SKU text alone cannot establish a valid stock mapping.</span>
          </li>
          <li>
            <strong>Review before the first publication.</strong>
            <span>Stock publishing remains unavailable in this connection milestone.</span>
          </li>
        </ol>
        <button className="text-button" onClick={() => onOpenSettings()}>
          Manage local connection settings <Icon name="arrow" />
        </button>
      </section>
    </>
  );
}
