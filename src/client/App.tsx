import { useState } from 'react';
import { Icon } from './components.js';
import { useWorkspace } from './useWorkspace.js';
import { InventoryScreen } from './screens/InventoryScreen.js';
import { ActivityScreen } from './screens/ActivityScreen.js';
import { ConnectionsScreen } from './screens/ConnectionsScreen.js';
import { SettingsScreen } from './screens/SettingsScreen.js';
import { MarketplacesScreen } from './screens/MarketplacesScreen.js';
import { BillingScreen } from './screens/BillingScreen.js';

const screens = {
  inventory: 'Inventory',
  marketplaces: 'Marketplaces',
  billing: 'Order matching',
  activity: 'Activity',
  connections: 'Connections',
  settings: 'Settings',
};
type Screen = keyof typeof screens;

function isNarrowViewport() {
  return window.innerWidth <= 960;
}

/** Navigation and company/account context only. Each screen owns its own controls. */
export function App() {
  const workspace = useWorkspace();
  const { state, busy, error, notice } = workspace;
  const [screen, setScreen] = useState<Screen>('inventory');
  const [selectedCompanyId, setSelectedCompanyId] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  if (!state)
    return (
      <main className="startup">
        <div className="startup-mark">
          <Icon name="box" />
        </div>
        <h1>Stockbridge</h1>
        <p>{error || 'Opening your inventory workspace…'}</p>
        {error && <button onClick={() => window.location.reload()}>Try again</button>}
      </main>
    );

  const companyId = state.companies.some((company) => company.id === selectedCompanyId)
    ? selectedCompanyId
    : (state.companies[0]?.id ?? '');
  const accountId = state.accounts.some((account) => account.id === selectedAccountId)
    ? selectedAccountId
    : (state.accounts[0]?.id ?? '');
  const company = state.companies.find((value) => value.id === companyId);
  const companyItems = state.items.filter((item) => item.companyId === companyId);
  function changeCompany(id: string) {
    setSelectedCompanyId(id);
    workspace.dismissNotice();
  }
  function changeAccount(id: string) {
    setSelectedAccountId(id);
    workspace.dismissNotice();
  }
  function selectScreen(value: Screen) {
    setScreen(value);
    if (isNarrowViewport()) setSidebarExpanded(false);
    workspace.dismissNotice();
    if (screen === 'marketplaces' && (value === 'inventory' || value === 'billing'))
      void workspace.refreshSnapshot();
  }
  return (
    <div className={`app-shell ${sidebarExpanded ? 'sidebar-expanded' : 'sidebar-collapsed'}`}>
      <aside className="sidebar" id="workspace-sidebar">
        <a
          href="#inventory"
          className="wordmark"
          aria-label="Stockbridge inventory"
          onClick={(event) => {
            event.preventDefault();
            selectScreen('inventory');
          }}
        >
          <span className="logo-mark">
            <Icon name="box" />
          </span>
          <span>
            stockbridge<span className="wordmark-caption">TALLY · MARKETPLACES</span>
          </span>
        </a>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
          title={sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={sidebarExpanded}
          aria-controls="workspace-sidebar"
          onClick={() => setSidebarExpanded(!sidebarExpanded)}
        >
          <Icon name="chevron" />
        </button>
        <div className="sidebar-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {(Object.keys(screens) as Screen[]).map((value) => (
            <button
              key={value}
              className={`nav-item ${screen === value ? 'active' : ''}`}
              aria-label={screens[value]}
              title={screens[value]}
              aria-current={screen === value ? 'page' : undefined}
              onClick={() => selectScreen(value)}
            >
              <Icon name={value} />
              <span>{screens[value]}</span>
              {value === 'inventory' && companyItems.length > 0 && (
                <span className="nav-count">{companyItems.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-indicator">
            <span className="status-dot" /> Local workspace
          </div>
          <p>
            {state.mode === 'demo'
              ? 'Sample data · separate database'
              : 'Your inventory stays on this computer.'}
          </p>
          <div className="sidebar-version">LOCAL INVENTORY REVIEW</div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          {screen === 'marketplaces' ? (
            <div className="marketplace-context">
              <Icon name="marketplaces" />
              <span>Marketplace management</span>
            </div>
          ) : (
            <div className="company-picker">
              <span className="company-icon">{company?.name.charAt(0) || 'T'}</span>
              <label>
                <span>Tally company</span>
                <select
                  aria-label="Tally company"
                  value={companyId}
                  onChange={(event) => changeCompany(event.target.value)}
                >
                  {!state.companies.length && <option value="">No company connected</option>}
                  {state.companies.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <div className="topbar-right">
            {screen !== 'marketplaces' && (
              <span
                className={`connection-pill ${state.connection.tally === 'online' ? 'online' : 'offline'}`}
              >
                <span className="status-dot" />
                Tally{' '}
                {state.mode === 'demo'
                  ? 'sample'
                  : state.connection.tally === 'online'
                    ? 'connected'
                    : state.connection.tally === 'offline'
                      ? 'offline'
                      : 'not checked'}
              </span>
            )}
            <span className="avatar" title="Local workspace">
              <Icon name="box" />
            </span>
          </div>
        </header>
        <main className="main-content">
          {state.mode === 'demo' && (
            <div className="environment-banner">
              <strong>Sample workspace</strong>
              <span>
                These items and quantities are demonstration data. Nothing is connected to Tally or
                Flipkart.
              </span>
            </div>
          )}
          {error && (
            <div className="message error" role="alert">
              <Icon name="info" />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => workspace.dismissError()}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          {notice && (
            <div className="message success" role="status">
              <Icon name="check" />
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => workspace.dismissNotice()}
              >
                <Icon name="close" />
              </button>
            </div>
          )}

          <div hidden={screen !== 'inventory'}>
            <InventoryScreen
              key={companyId}
              state={state}
              companyId={companyId}
              accountId={accountId}
              workspace={workspace}
              onAccountChange={changeAccount}
              onOpenConnections={() => selectScreen('connections')}
            />
          </div>
          <div hidden={screen !== 'activity'}>
            <ActivityScreen state={state} companyId={companyId} active={screen === 'activity'} />
          </div>
          {screen === 'marketplaces' && (
            <MarketplacesScreen
              mode={state.mode}
              onOpenInventory={() => selectScreen('inventory')}
            />
          )}
          {screen === 'billing' && (
            <BillingScreen
              companyId={companyId}
              accountId={accountId}
              accounts={state.accounts}
              onAccountChange={changeAccount}
              onConnect={() => selectScreen(companyId ? 'marketplaces' : 'connections')}
            />
          )}
          <div hidden={screen !== 'connections'}>
            <ConnectionsScreen
              state={state}
              workspace={workspace}
              onOpenSettings={() => selectScreen('settings')}
              onOpenMarketplaces={() => selectScreen('marketplaces')}
            />
          </div>
          <div hidden={screen !== 'settings'}>
            <SettingsScreen state={state} workspace={workspace} />
          </div>
        </main>
        <footer className="app-footer">
          <span>
            Stockbridge <span className="footer-divider">/</span> Tally → marketplace inventory
          </span>
          <span>
            {busy ||
              (screen === 'marketplaces'
                ? state.mode === 'demo'
                  ? 'Sample simulation · no external changes'
                  : 'Marketplace edits apply individually'
                : 'Tally inventory')}
          </span>
        </footer>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {busy}
      </div>
    </div>
  );
}
