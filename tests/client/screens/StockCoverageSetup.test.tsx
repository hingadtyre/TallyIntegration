import assert from 'node:assert/strict';
import test from 'node:test';
import { StockCoverageSetup } from '../../../src/client/screens/StockCoverageSetup.js';
import { fireEvent, render, response, screen } from '../../support/client-dom.js';

test('a company can set and change its billing start date independently, then review starting stock using that date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-25T20:00:00Z') });
  const scope = { companyId: 'demo-a', accountId: 'seller' };
  const starts: string[] = [];
  const saves: unknown[] = [];
  let attempt = 0;
  let billingFrom: string | null = null;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (url === '/api/billing/coverage') {
      assert.deepEqual(body, scope);
    } else {
      assert.equal(url, '/api/billing/tracking/start');
      saves.push(body);
      if (++attempt === 1) return response({ error: 'Choose a more recent date.' }, 400);
      billingFrom = new Date(body.fromDate + 'T00:00:00+05:30').toISOString();
    }
    return response({ from: null, billingFrom, current: false, checkedThrough: null });
  });
  render(<StockCoverageSetup {...scope} onStart={(from) => starts.push(from)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Set billing start date' }));
  const dateLabel = 'Match Flipkart orders from (India)';
  const date = screen.getByLabelText<HTMLInputElement>(dateLabel);
  const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save billing start date' });
  assert.equal(date.max, '2026-11-26');
  assert.equal(screen.queryByRole('checkbox'), null);
  assert.ok(save.disabled);
  fireEvent.change(date, { target: { value: '2026-11-22' } });
  fireEvent.click(save);
  await screen.findByText('Choose a more recent date.');
  assert.equal(date.value, '2026-11-22');
  assert.deepEqual(starts, []);
  fireEvent.click(save);
  await screen.findByText('Bill matching starts on 22 Nov 2026 (India).');
  fireEvent.click(screen.getByRole('button', { name: 'Change billing start date' }));
  const updated = screen.getByLabelText<HTMLInputElement>(dateLabel);
  assert.equal(updated.value, '2026-11-22');
  fireEvent.change(updated, { target: { value: '2026-11-25' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save billing start date' }));
  await screen.findByText('Bill matching starts on 25 Nov 2026 (India).');
  fireEvent.click(screen.getByRole('button', { name: 'Set starting stock' }));
  assert.equal(
    screen.getByLabelText<HTMLInputElement>('Track Flipkart orders from (India)').value,
    '2026-11-25',
  );
  assert.ok(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm starting stock' }).disabled,
  );
  assert.ok(screen.getByRole('checkbox', { name: /all three statements/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.deepEqual(
    saves,
    ['2026-11-22', '2026-11-22', '2026-11-25'].map((fromDate) => ({ ...scope, fromDate })),
  );
  assert.deepEqual(starts, ['2026-11-21T18:30:00.000Z', '2026-11-24T18:30:00.000Z']);
});
