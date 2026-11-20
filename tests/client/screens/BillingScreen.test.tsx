import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BillingReport,
  BillingRow,
  BillingRule,
} from '../../../src/shared/billing-contracts.js';
import { initialState } from '../../../src/server/seed.js';
import { App } from '../../../src/client/App.js';
import { BillingScreen } from '../../../src/client/screens/BillingScreen.js';
import { act, fireEvent, render, response, screen, waitFor } from '../../support/client-dom.js';

const rule: BillingRule = {
  ledgerId: 'trade-07',
  ledgerName: 'Online sales north',
  field: 'manual',
  reference: 'orderId',
};
const candidate = { id: 'voucher-a', number: 'INV-4', date: '2026-11-19' };
const item: BillingRow = {
  orderItemId: 'OI-82',
  orderId: 'ORDER-2',
  orderDate: '2026-11-18T18:45:00Z',
  sku: 'PAIR-4',
  location: 'Shop',
  quantity: 1,
  baseUnits: 2,
  status: 'review',
  reason: 'Choose the corresponding bill.',
  bill: null,
  candidates: [candidate, { ...candidate, id: 'voucher-b' }],
};
const report: BillingReport = {
  previewId: 'preview-a',
  from: '2026-10-21T18:30:00.000Z',
  to: '2026-11-20',
  checkedAt: '2026-11-20T07:00:00Z',
  rule,
  rows: [item],
  stock: [
    { name: 'Sample tyre', unit: 'tyres', physical: 6, unmatchedUnits: 2, previewAvailable: 4 },
  ],
};

test('seller selects their ledger, previews, confirms setup, and explicitly matches or releases a bill', async (t) => {
  const state = initialState('demo', 'unused');
  const scope = { companyId: state.companies[0].id, accountId: state.accounts[0].id };
  const commands: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/state') return response(state);
    commands.push(path);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.companyId, scope.companyId);
    assert.equal(body.accountId, scope.accountId);
    switch (path) {
      case '/api/billing/workspace':
        return response({ rule: null, report: null });
      case '/api/billing/ledgers':
        return response({
          ledgers: [
            { externalId: 'fees', name: 'Fees' },
            { externalId: rule.ledgerId, name: rule.ledgerName },
          ],
        });
      case '/api/billing/preview':
        assert.deepEqual(body, {
          ...scope,
          ledgerId: rule.ledgerId,
          field: 'manual',
          reference: 'orderId',
          days: 30,
        });
        return response(report);
      case '/api/billing/confirm':
        assert.deepEqual(body, { ...scope, previewId: report.previewId });
        return response({ rule, report });
      case '/api/billing/coverage':
        return response({ from: null, current: false, checkedThrough: null });
      case '/api/billing/match':
        assert.deepEqual(body, {
          ...scope,
          previewId: report.previewId,
          orderItemId: item.orderItemId,
          billId: candidate.id,
        });
        return response({
          rule,
          report: {
            ...report,
            rows: [{ ...item, status: 'matched', manualBillId: candidate.id, bill: candidate }],
          },
        });
      case '/api/billing/unmatch':
        assert.deepEqual(body, {
          ...scope,
          previewId: report.previewId,
          orderItemId: item.orderItemId,
        });
        return response({ rule, report });
      default:
        throw new Error('Unexpected ' + path);
    }
  });
  render(<App />);
  await screen.findByRole('heading', { name: 'Inventory' });
  assert.deepEqual(commands, []);
  fireEvent.click(screen.getByRole('button', { name: 'Order matching' }));
  const ledger = await screen.findByLabelText('Sales bill ledger');
  assert.equal((ledger as HTMLSelectElement).value, '');
  fireEvent.change(screen.getByLabelText('Search ledgers'), { target: { value: 'north' } });
  assert.equal(screen.queryByRole('option', { name: 'Fees' }), null);
  fireEvent.change(ledger, { target: { value: rule.ledgerId } });
  fireEvent.change(screen.getByLabelText('Order period'), { target: { value: '30' } });
  fireEvent.change(screen.getByLabelText(/Where do you enter/), { target: { value: 'manual' } });
  assert.equal(screen.queryByLabelText(/Which Flipkart reference/), null);
  fireEvent.click(screen.getByRole('button', { name: 'Preview matches' }));
  await screen.findByText('0 matched · 1 unresolved');
  assert.ok(screen.getByText('Ordered 19 Nov 2026'));
  assert.equal(screen.queryByRole('button', { name: 'Confirm bill match' }), null);
  fireEvent.change(screen.getByLabelText('Order period'), { target: { value: '1' } });
  assert.ok(
    (screen.getByRole('button', { name: 'Confirm billing setup' }) as HTMLButtonElement).disabled,
  );
  fireEvent.change(screen.getByLabelText('Order period'), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm billing setup' }));
  const bill = await screen.findByLabelText('Choose bill for OI-82');
  assert.ok(screen.getByRole('option', { name: /Tally voucher ID voucher-a/ }));
  assert.ok(screen.getByRole('option', { name: /Tally voucher ID voucher-b/ }));
  const confirm = screen.getByRole('button', { name: 'Confirm bill match' }) as HTMLButtonElement;
  assert.ok(confirm.disabled);
  fireEvent.change(bill, { target: { value: candidate.id } });
  fireEvent.click(confirm);
  await screen.findByText('1 matched · 0 unresolved');
  fireEvent.click(screen.getByRole('button', { name: 'Release manual match' }));
  await screen.findByText('0 matched · 1 unresolved');
  assert.deepEqual(commands, [
    '/api/billing/workspace',
    '/api/billing/ledgers',
    '/api/billing/preview',
    '/api/billing/confirm',
    '/api/billing/coverage',
    '/api/billing/match',
    '/api/billing/unmatch',
  ]);
});

test('a late result from another seller cannot replace the selected billing workspace', async (t) => {
  const accounts = ['first', 'second'].map((id) => ({
    id,
    name: id,
    marketplace: 'flipkart' as const,
    status: 'demo' as const,
  }));
  let release!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === '/api/billing/coverage')
      return response({ from: null, current: false, checkedThrough: null });
    const { accountId } = JSON.parse(String(init?.body));
    if (accountId === 'first')
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return response({ rule: { ...rule, ledgerName: 'Second seller ledger' }, report: null });
  });
  const view = (accountId: string) => (
    <BillingScreen
      companyId="company"
      accountId={accountId}
      accounts={accounts}
      onAccountChange={() => {}}
      onConnect={() => {}}
    />
  );
  const { rerender } = render(view('first'));
  await waitFor(() => assert.equal(typeof release, 'function'));
  rerender(view('second'));
  await screen.findByText('Second seller ledger');
  await act(async () => release(response({ rule, report })));
  assert.ok(screen.getByText('Second seller ledger'));
  assert.equal(screen.queryByText(item.orderItemId), null);
});

test('company stock tracking starts only after the seller confirms the chosen Indian day and every coverage condition', async (t) => {
  const scope = { companyId: 'company', accountId: 'first' };
  const dates = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = dates.format(new Date());
  const yesterday = dates.format(new Date(Date.now() - 86_400_000));
  const saved: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    switch (String(input)) {
      case '/api/billing/workspace':
        return response({ rule, report: null });
      case '/api/billing/coverage':
        return response({ from: null, current: false, checkedThrough: null });
      case '/api/billing/coverage/start':
        saved.push(JSON.parse(String(init?.body)));
        return response({
          from: new Date(today + 'T00:00:00+05:30').toISOString(),
          current: true,
          checkedThrough: null,
        });
      default:
        throw new Error('Unexpected request');
    }
  });
  render(
    <BillingScreen {...scope} accounts={[]} onAccountChange={() => {}} onConnect={() => {}} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Set starting stock' }));
  const date = screen.getByLabelText('Track Flipkart orders from (India)') as HTMLInputElement;
  const button = screen.getByRole('button', {
    name: 'Confirm starting stock',
  }) as HTMLButtonElement;
  const confirmation = screen.getByRole('checkbox', {
    name: /I have checked all three/,
  }) as HTMLInputElement;
  assert.equal(date.max, today);
  assert.ok(button.disabled);
  fireEvent.change(date, { target: { value: yesterday } });
  fireEvent.click(confirmation);
  assert.equal(button.disabled, false);
  fireEvent.change(date, { target: { value: today } });
  assert.ok(button.disabled);
  fireEvent.click(confirmation);
  fireEvent.click(button);
  await screen.findByRole('button', { name: 'Review starting stock' });
  assert.deepEqual(saved, [{ ...scope, fromDate: today, confirmed: true }]);
});
