import assert from 'node:assert/strict';
import test from 'node:test';
import { render, screen, fireEvent, response } from '../../support/client-dom.js';
import { App } from '../../../src/client/App.js';
import { initialState } from '../../../src/server/seed.js';
import type { Settings } from '../../../src/shared/contracts.js';

test('settings retain edits after rejection and show confirmed values after a successful retry', async (t) => {
  let state = initialState('demo', 'saved-backups');
  const submitted: Settings[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === '/api/state') return response(state);
      assert.equal(String(input), '/api/settings');
      const { settings } = JSON.parse(String(options?.body)) as { settings: Settings };
      submitted.push(settings);
      if (submitted.length === 1)
        return response({ error: 'The backup folder is not writable.' }, 400);
      state = { ...state, settings };
      return response(state);
    },
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  const interval = screen.getByRole('spinbutton', { name: /Tally stock/ }) as HTMLInputElement;
  const folder = screen.getByRole('textbox', { name: /Backup folder/ }) as HTMLInputElement;
  fireEvent.change(interval, { target: { value: '45' } });
  fireEvent.change(folder, { target: { value: 'new-backups' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

  assert.match((await screen.findByRole('alert')).textContent ?? '', /not writable/);
  assert.equal(interval.value, '45');
  assert.equal(folder.value, 'new-backups');
  assert.ok(screen.getByText(/Uses the saved folder: saved-backups/));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await screen.findByText('Settings saved. The next Tally check uses the new interval.');
  assert.equal(screen.queryByRole('alert'), null);
  assert.equal(submitted.length, 2);
  assert.deepEqual(submitted[1], {
    ...initialState('demo', 'new-backups').settings,
    tallySeconds: 45,
  });
  assert.ok(screen.getByText(/Uses the saved folder: new-backups/));
});

test('a verified backup remains successful when the follow-up activity refresh fails', async (t) => {
  const state = initialState('demo', 'saved-backups');
  let stateReads = 0;
  const commands: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (path === '/api/state') {
        return ++stateReads === 1
          ? response(state)
          : response({ error: 'The activity refresh failed.' }, 503);
      }
      commands.push(path);
      assert.equal(path, '/api/backup');
      assert.deepEqual(JSON.parse(String(options?.body)), {});
      return response({ path: 'saved-backups/verified.sqlite', verified: true });
    },
  );
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.change(screen.getByRole('textbox', { name: /Backup folder/ }), {
    target: { value: 'unsaved-folder' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));

  await screen.findByText('Verified backup saved: saved-backups/verified.sqlite');
  assert.match(
    screen.getByRole('alert').textContent ?? '',
    /Backup verified. Activity could not be refreshed yet/,
  );
  assert.deepEqual(commands, ['/api/backup']);
  assert.equal(stateReads, 2);
  assert.ok(screen.getByText(/Uses the saved folder: saved-backups/));
});
