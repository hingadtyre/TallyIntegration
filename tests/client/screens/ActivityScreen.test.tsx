import assert from 'node:assert/strict';
import test from 'node:test';
import { render, screen, fireEvent } from '../../support/client-dom.js';
import { ActivityScreen } from '../../../src/client/screens/ActivityScreen.js';
import { initialState } from '../../../src/server/seed.js';

test('activity includes global and current-company events and combines search with level filters', () => {
  const state = initialState('demo', 'unused');
  state.activity = [
    {
      id: 'global',
      at: '2026-11-08T00:00:00.000Z',
      level: 'info',
      operation: 'settings',
      message: 'Polling settings saved.',
    },
    {
      id: 'local',
      at: '2026-11-08T00:00:01.000Z',
      level: 'warning',
      operation: 'refresh',
      message: 'Stock observation is stale.',
      companyId: 'demo-a',
    },
    {
      id: 'other',
      at: '2026-11-08T00:00:02.000Z',
      level: 'error',
      operation: 'refresh',
      message: 'Other company cannot connect.',
      companyId: 'demo-b',
    },
  ];
  render(<ActivityScreen state={state} companyId="demo-a" active />);
  assert.ok(screen.getByText('Polling settings saved.'));
  assert.ok(screen.getByText('Stock observation is stale.'));
  assert.equal(screen.queryByText('Other company cannot connect.'), null);

  fireEvent.change(screen.getByLabelText('Search activity'), { target: { value: 'REFRESH' } });
  assert.equal(screen.queryByText('Polling settings saved.'), null);
  assert.ok(screen.getByText('Stock observation is stale.'));
  fireEvent.change(screen.getByLabelText('Activity level'), { target: { value: 'error' } });
  assert.ok(screen.getByRole('heading', { name: 'No activity to show' }));
  fireEvent.change(screen.getByLabelText('Activity level'), { target: { value: 'warning' } });
  assert.ok(screen.getByText('Stock observation is stale.'));
});

test('diagnostics load only on the active diagnostic view and display the returned log', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(String(input), '/api/logs');
    return new Response('Refresh completed: request-123');
  });
  const state = initialState('demo', 'unused');
  const { rerender } = render(<ActivityScreen state={state} companyId="demo-a" active={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  assert.equal(fetch.mock.callCount(), 0);

  rerender(<ActivityScreen state={state} companyId="demo-a" active />);
  await screen.findByText('Refresh completed: request-123');
  assert.equal(fetch.mock.callCount(), 1);
  assert.match(
    screen.getByLabelText('Application diagnostic log').textContent ?? '',
    /request-123/,
  );
  assert.equal(
    screen.getByRole('link', { name: 'Export diagnostics' }).getAttribute('href'),
    '/api/logs',
  );
});

test('a diagnostic failure is visible and switching back to business activity remains available', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
  render(<ActivityScreen state={initialState('demo', 'unused')} companyId="demo-a" active />);
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
  assert.match(
    (await screen.findByRole('alert')).textContent ?? '',
    /Diagnostics could not be read \(503\)/,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Business activity' }));
  assert.ok(screen.getByLabelText('Search activity'));
  assert.equal(screen.queryByRole('alert'), null);
});
