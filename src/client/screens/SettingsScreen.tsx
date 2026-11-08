import { useState, type FormEvent } from 'react';
import type { Snapshot } from '../../shared/contracts.js';
import type { Workspace } from '../useWorkspace.js';
import { Icon } from '../components.js';

export function SettingsScreen({ state, workspace }: { state: Snapshot; workspace: Workspace }) {
  const [settings, setSettings] = useState(state.settings);
  const { busy, mutate, backUpNow } = workspace;
  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    const result = await mutate(
      '/settings',
      { settings },
      'Saving settings',
      'Settings saved. The next Tally check uses the new interval.',
    );
    if (result.ok) setSettings(result.value.settings);
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">MAKE IT YOURS</div>
          <h1>Settings</h1>
          <p>Saved locally. Valid changes apply without restarting the app.</p>
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
              type="url"
              required
              value={settings.tallyUrl}
              onChange={(event) => setSettings({ ...settings, tallyUrl: event.target.value })}
            />
            <small>Keep Tally open with the required company loaded.</small>
          </label>
        </section>
        <section className="panel settings-panel">
          <div className="section-intro">
            <Icon name="refresh" />
            <div>
              <h2>Refresh intervals</h2>
              <p>Each running check finishes before the next one begins.</p>
            </div>
          </div>
          <div className="setting-fields">
            <label className="field">
              <span>Tally stock</span>
              <div className="input-with-unit">
                <input
                  type="number"
                  min="5"
                  step="1"
                  required
                  value={settings.tallySeconds}
                  onChange={(event) =>
                    setSettings({ ...settings, tallySeconds: Number(event.target.value) })
                  }
                />
                <span>seconds</span>
              </div>
              <small>Active when the Tally connection is available.</small>
            </label>
            <label className="field">
              <span>Marketplace stock</span>
              <div className="input-with-unit">
                <input
                  type="number"
                  min="30"
                  step="1"
                  required
                  value={settings.marketplaceSeconds}
                  onChange={(event) =>
                    setSettings({ ...settings, marketplaceSeconds: Number(event.target.value) })
                  }
                />
                <span>seconds</span>
              </div>
              <small>
                Saved preference only. Marketplace stock checks do not run in this version.
              </small>
            </label>
            <label className="field">
              <span>Listing metadata</span>
              <div className="input-with-unit">
                <input
                  type="number"
                  min="60"
                  step="1"
                  required
                  value={settings.catalogSeconds}
                  onChange={(event) =>
                    setSettings({ ...settings, catalogSeconds: Number(event.target.value) })
                  }
                />
                <span>seconds</span>
              </div>
              <small>Saved preference only. Listing imports do not run in this version.</small>
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
              value={settings.backupFolder}
              onChange={(event) => setSettings({ ...settings, backupFolder: event.target.value })}
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
              Automatic backups and restore are not available in this version.
            </small>
          </div>
        </section>
        <div className="settings-save">
          <p>Marketplace publishing remains unavailable regardless of these settings.</p>
          <button className="button primary" type="submit" disabled={!!busy}>
            <Icon name="check" />
            {busy === 'Saving settings' ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </>
  );
}
