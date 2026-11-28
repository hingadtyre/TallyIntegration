import { useState, type FormEvent } from 'react';
import type { Settings, Snapshot } from '../../shared/contracts.js';
import type { Workspace } from '../useWorkspace.js';
import { Icon } from '../components.js';

export function SettingsScreen({ state, workspace }: { state: Snapshot; workspace: Workspace }) {
  const [edits, setEdits] = useState<Partial<Record<keyof Settings, string>>>({});
  const settings = { ...state.settings, ...edits };
  const hasEdits = Object.keys(edits).length > 0;
  function edit(field: keyof Settings, value: string) {
    setEdits((current) => {
      const next = { ...current, [field]: value };
      if (String(state.settings[field]) === value) delete next[field];
      return next;
    });
  }
  const { busy, mutate, backUpNow } = workspace;
  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!hasEdits || busy) return;
    const changes = Object.fromEntries(
      Object.entries(edits).map(([field, value]) => [
        field,
        typeof state.settings[field as keyof Settings] === 'number' ? Number(value) : value,
      ]),
    );
    const result = await mutate('/settings', { changes }, 'Saving settings', 'Settings saved.');
    if (result.ok) setEdits({});
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>These settings apply to every company in this workspace as soon as you save.</p>
        </div>
      </div>
      <form className="settings-layout" onSubmit={saveSettings}>
        <section className="panel settings-panel">
          <div className="section-intro">
            <Icon name="connections" />
            <div>
              <h2>Tally connection</h2>
              <p>The local address configured in Tally.</p>
            </div>
          </div>
          <label className="field">
            <span>Connection address</span>
            <input
              disabled={busy === 'Saving settings'}
              type="url"
              required
              value={settings.tallyUrl}
              onChange={(event) => edit('tallyUrl', event.target.value)}
            />
            <small>Keep Tally open with the required company loaded.</small>
          </label>
        </section>
        <section className="panel settings-panel">
          <div className="section-intro">
            <Icon name="refresh" />
            <div>
              <h2>Refresh intervals</h2>
              <p>Each interval starts when its previous check finishes.</p>
            </div>
          </div>
          <div className="setting-fields">
            <label className="field">
              <span>Tally stock</span>
              <div className="input-with-unit">
                <input
                  disabled={busy === 'Saving settings'}
                  type="number"
                  min="5"
                  max="86400"
                  step="1"
                  required
                  value={settings.tallySeconds}
                  onChange={(event) => edit('tallySeconds', event.target.value)}
                />
                <span>seconds</span>
              </div>
              <small>
                Reads stock from companies open in Tally. With company sync on, balance changes can
                update mapped listings.
              </small>
            </label>
            <label className="field">
              <span>Marketplace orders</span>
              <div className="input-with-unit">
                <input
                  disabled={busy === 'Saving settings'}
                  type="number"
                  min="30"
                  max="86400"
                  step="1"
                  required
                  value={settings.marketplaceSeconds}
                  onChange={(event) => edit('marketplaceSeconds', event.target.value)}
                />
                <span>seconds</span>
              </div>
              <small>
                Checks orders from the confirmed stock-tracking date and reserves units for verified
                sales awaiting a Tally bill.
              </small>
            </label>
            <label className="field">
              <span>Listings</span>
              <div className="input-with-unit">
                <input
                  disabled={busy === 'Saving settings'}
                  type="number"
                  min="60"
                  max="86400"
                  step="1"
                  required
                  value={settings.catalogSeconds}
                  onChange={(event) => edit('catalogSeconds', event.target.value)}
                />
                <span>seconds</span>
              </div>
              <small>
                Refreshes prices, stock by pickup location, package counts and product links from
                connected seller catalogues.
              </small>
            </label>
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="section-intro">
            <Icon name="box" />
            <div>
              <h2>Backups</h2>
              <p>Save a verified copy of this app's local database.</p>
            </div>
          </div>
          <label className="field">
            <span>Backup folder</span>
            <input
              disabled={busy === 'Saving settings'}
              required
              value={settings.backupFolder}
              onChange={(event) => edit('backupFolder', event.target.value)}
            />
            <small>
              Enter a full folder path, such as C:\Stockbridge Backups. Save settings to apply a
              change. Existing backups stay in their original folder.
            </small>
          </label>
          <div className="backup-actions">
            <button
              className="button secondary"
              type="button"
              disabled={!!busy}
              onClick={() => void backUpNow()}
            >
              <Icon name="box" />
              {busy === 'Creating backup' ? 'Creating backup…' : 'Back up now'}
            </button>
            <small>
              Uses the saved folder: {state.settings.backupFolder}
              <br />
              Create backups manually. Contact support to restore a backup offline.
            </small>
          </div>
        </section>
        <div className="settings-save">
          <p>Enable automatic stock updates for each company in Inventory.</p>
          <button className="button primary" type="submit" disabled={!!busy || !hasEdits}>
            <Icon name="check" />
            {busy === 'Saving settings' ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </>
  );
}
