import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BillingReport,
  BillingRow,
  BillingRule,
  PendingOrderResult,
} from '../../../src/shared/billing-contracts.js';
import { initialState } from '../../../src/server/seed.js';
import { App } from '../../../src/client/App.js';
import { BillingListingMappings } from '../../../src/client/screens/BillingListingMappings.js';
import { BillingResults } from '../../../src/client/screens/BillingResults.js';
import { BillingScreen } from '../../../src/client/screens/BillingScreen.js';
import { BillingSetup } from '../../../src/client/screens/BillingSetup.js';
import {
  act,
  fireEvent,
  render,
  response,
  screen,
  waitFor,
  within,
} from '../../support/client-dom.js';

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
  listingId: 'listing-pair',
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
    {
      name: 'Sample tyre',
      unit: 'tyres',
      physical: 6,
      keepBackUnits: 0,
      unmatchedUnits: 2,
      previewAvailable: 4,
    },
  ],
};

test('the preview shows the listing and Tally quantities in their own units', () => {
  const rows = [
    { ...item, orderItemId: 'single', baseUnits: 1 },
    { ...item, orderItemId: 'pair' },
    { ...item, orderItemId: 'two-pairs', quantity: 2, baseUnits: 4 },
    { ...item, orderItemId: 'unmapped', status: 'unmapped' as const, baseUnits: null },
  ];
  render(
    <BillingResults
      report={{ ...report, rows }}
      confirmed={false}
      busy={false}
      onMatch={assert.fail}
      onUnmatch={assert.fail}
    />,
  );
  const table = within(screen.getByRole('table', { name: 'Order and bill matches' }));
  assert.ok(table.getByText('1 listing unit · 1 Tally unit'));
  assert.ok(table.getByText('1 listing unit · 2 Tally units'));
  assert.ok(table.getByText('2 listing units · 4 Tally units'));
  assert.ok(table.getByText('1 listing unit · Tally units unknown'));
});

test('seller selects their ledger, previews, confirms setup, and explicitly matches or releases a bill', async (t) => {
  const state = initialState('demo', 'unused');
  const scope = { companyId: state.companies[0].id, accountId: state.accounts[0].id };
  const commands: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/state') return response(state);
    if (path === '/api/billing/pending') return response({ trackingStarted: false, listings: [] });
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
        return response({ rule, report: { ...report, previewId: 'confirmed' } });
      case '/api/billing/coverage':
        return response({ from: null, current: false, checkedThrough: null });
      case '/api/billing/match':
        assert.deepEqual(body, {
          ...scope,
          previewId: 'confirmed',
          orderItemId: item.orderItemId,
          billId: candidate.id,
        });
        return response({
          rule,
          report: {
            ...report,
            previewId: 'matched',
            rows: [{ ...item, status: 'matched', manualBillId: candidate.id, bill: candidate }],
          },
        });
      case '/api/billing/unmatch':
        assert.deepEqual(body, {
          ...scope,
          previewId: 'matched',
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
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Order matching' }));
  });
  const ledger = screen.getByRole<HTMLInputElement>('combobox', {
    name: 'Sales bill ledger',
  });
  assert.equal(ledger.value, '');
  assert.equal(screen.queryByLabelText('Search ledgers'), null);
  fireEvent.focus(ledger);
  fireEvent.click(ledger);
  assert.ok(within(screen.getByRole('listbox')).getByRole('option', { name: 'Fees' }));
  fireEvent.change(ledger, { target: { value: 'NoRtH' } });
  const matches = within(screen.getByRole('listbox'));
  assert.equal(matches.getAllByRole('option').length, 1);
  fireEvent.click(matches.getByRole('option', { name: rule.ledgerName }));
  assert.equal(ledger.value, rule.ledgerName);
  assert.equal(screen.queryByRole('listbox'), null);
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
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show unresolved only' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm billing setup' }));
  const bill = await screen.findByLabelText('Choose bill for OI-82');
  assert.ok(screen.getByRole('checkbox', { name: 'Show unresolved only', checked: true }));
  assert.ok(screen.getByRole('option', { name: /Tally voucher ID voucher-a/ }));
  assert.ok(screen.getByRole('option', { name: /Tally voucher ID voucher-b/ }));
  const confirm = screen.getByRole('button', { name: 'Confirm bill match' }) as HTMLButtonElement;
  assert.ok(confirm.disabled);
  fireEvent.change(bill, { target: { value: candidate.id } });
  fireEvent.click(confirm);
  await screen.findByText('1 matched · 0 unresolved');
  assert.ok(screen.getByText('All order items in this preview have a matched bill.'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show unresolved only', checked: true }));
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

test('editing a saved ledger restores dismissed searches and accepts a keyboard choice before preview', async (t) => {
  const replacement = { externalId: 'trade-18', name: 'Online sales south' };
  t.mock.method(globalThis, 'fetch', async () =>
    response({ ledgers: [{ externalId: rule.ledgerId, name: rule.ledgerName }, replacement] }),
  );
  const previews: Pick<BillingRule, 'ledgerId' | 'field' | 'reference'>[] = [];
  render(
    <BillingSetup
      companyId="company"
      accountId="seller"
      initialRule={rule}
      busy={false}
      onPreview={async (input) => {
        previews.push(input);
      }}
    />,
  );
  const ledger = await screen.findByRole<HTMLInputElement>('combobox', {
    name: 'Sales bill ledger',
  });
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Preview matches' });
  assert.equal(ledger.value, rule.ledgerName);
  assert.equal(submit.disabled, false);

  fireEvent.focus(ledger);
  fireEvent.change(ledger, { target: { value: 'no such ledger' } });
  assert.ok(screen.getByText(/No matching ledgers/i));
  fireEvent.keyDown(ledger, { key: 'Escape' });
  assert.equal(ledger.value, rule.ledgerName);
  assert.equal(screen.queryByRole('listbox'), null);
  fireEvent.change(ledger, { target: { value: 'south' } });
  fireEvent.blur(ledger);
  assert.equal(ledger.value, rule.ledgerName);
  assert.equal(screen.queryByRole('listbox'), null);
  assert.equal(submit.disabled, false);

  fireEvent.focus(ledger);
  fireEvent.change(ledger, { target: { value: 'online sales' } });
  fireEvent.keyDown(ledger, { key: 'ArrowDown' });
  assert.equal(fireEvent.keyDown(ledger, { key: 'Enter' }), false);
  assert.equal(ledger.value, replacement.name);
  assert.equal(screen.queryByRole('listbox'), null);
  assert.equal(previews.length, 0);
  fireEvent.click(submit);
  assert.deepEqual(previews, [
    { ledgerId: replacement.externalId, field: rule.field, reference: rule.reference },
  ]);
});

test('an empty ledger list can be reloaded and a sole ledger still requires selection', async (t) => {
  const ledgers: { externalId: string; name: string }[] = [];
  t.mock.method(globalThis, 'fetch', async () => response({ ledgers }));
  render(
    <BillingSetup
      companyId="company"
      accountId="seller"
      initialRule={null}
      busy={false}
      onPreview={async () => assert.fail('Selecting a ledger must not submit the form.')}
    />,
  );
  await screen.findByText('No ledgers were found in the selected company.');
  ledgers.push({ externalId: rule.ledgerId, name: rule.ledgerName });
  fireEvent.click(screen.getByRole('button', { name: 'Reload ledgers' }));
  const ledger = await screen.findByRole<HTMLInputElement>('combobox', {
    name: 'Sales bill ledger',
  });
  const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Preview matches' });
  fireEvent.change(screen.getByLabelText(/Where do you enter/), { target: { value: 'manual' } });
  fireEvent.focus(ledger);
  fireEvent.change(ledger, { target: { value: rule.ledgerName } });
  assert.ok(submit.disabled);
  fireEvent.keyDown(ledger, { key: 'Enter' });
  assert.equal(submit.disabled, false);
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
    if (String(input) === '/api/billing/pending')
      return response({ trackingStarted: false, listings: [] });
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
      inventory={{ ...initialState('demo', 'unused'), accounts }}
      onSaveMapping={async () => {
        throw new Error('Unexpected mapping');
      }}
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
      case '/api/billing/pending':
        return response({ trackingStarted: false, listings: [] });
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
    <BillingScreen
      {...scope}
      inventory={initialState('demo', 'unused')}
      onSaveMapping={async () => {
        throw new Error('Unexpected mapping');
      }}
      onAccountChange={() => {}}
      onConnect={() => {}}
    />,
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

test('maps a listing once and checks tracked orders outside the current billing preview', async (t) => {
  const state = initialState('demo', 'unused');
  const originalItem = state.items.find((row) => row.id === 'item-a')!;
  const replacement = state.items.find((row) => row.id === 'item-d')!;
  replacement.name = originalItem.name;
  const listing = state.listings.find((row) => !row.itemId)!;
  const company = state.companies[0];
  company.automation = true;
  listing.marketplaceListingId = 'FK-71';
  const source = { listingId: 'FK-71', sku: listing.sku, location: listing.location };
  const scope = { companyId: company.id, accountId: listing.accountId };
  const ids = ['OI-earlier', 'OI-later'];
  const commands: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path === '/api/state') return response(state);
    const body = JSON.parse(String(init?.body));
    commands.push(path);
    switch (path) {
      case '/api/billing/workspace':
        return response({ rule, report: { ...report, rows: [], stock: [] } });
      case '/api/billing/coverage':
        return response({ current: true, from: report.from });
      case '/api/billing/pending':
        assert.deepEqual(body, scope);
        return response({
          trackingStarted: true,
          listings: [{ ...source, orderItemIds: ids, mapped: !!listing.itemId }],
        });
      case '/api/mappings':
        assert.deepEqual(body, {
          listingId: listing.id,
          itemId: 'item-d',
          expectedUnit: 'tyres',
          listingVersion: listing.version,
          confirmPackEvidence: true,
          packSize: 1,
          packSource: 'manual',
          sourceScope: 'company',
          tyreFloor: false,
          keepPaused: true,
          orderSource: { ...scope, listingId: 'FK-71', locationId: listing.location },
        });
        listing.itemId = 'item-d';
        listing.paused = true;
        return response(state);
      case '/api/billing/pending/recheck':
        assert.deepEqual(body, { ...scope, ...source });
        if (commands.filter((path) => path === '/api/billing/pending/recheck').length === 1)
          return response({ error: 'Tally is unavailable.' }, 409);
        return response({
          ...source,
          rows: [
            {
              orderItemId: ids[0],
              status: 'matched',
              baseUnits: 2,
              reason: 'Already billed on INV-2.',
            },
            {
              orderItemId: ids[1],
              status: 'reserved',
              baseUnits: 1,
              reason: 'Awaiting a matching bill.',
            },
          ],
        });
      case '/api/billing/preview':
        return response({ ...report, previewId: 'updated', rows: [], stock: [] });
      default:
        throw new Error('Unexpected request ' + path);
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Map listing' }));
  const dialog = within(screen.getByRole('dialog'));
  const picker = dialog.getByRole<HTMLInputElement>('combobox', { name: 'Tally stock item' });
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: 'mIlAzE' } });
  const results = within(dialog.getByRole('listbox'));
  assert.equal(results.getAllByRole('option').length, 2);
  assert.equal(results.queryByRole('option', { name: /sample-e/ }), null);
  fireEvent.click(results.getByRole('option', { name: /tyres · sample-a$/ }));
  const units = dialog.getByLabelText<HTMLInputElement>('Tally units per sale');
  const confirmation = () =>
    dialog.getByRole<HTMLInputElement>('checkbox', { name: /I confirm the item/ });
  fireEvent.change(units, { target: { value: '4' } });
  fireEvent.click(confirmation());
  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: 'No such stock item' } });
  assert.ok(dialog.getByText('No items match this search.'));
  assert.equal(fireEvent.keyDown(picker, { key: 'Escape' }), false);
  assert.ok(picker.value.endsWith('tyres · sample-a'));
  assert.equal(units.value, '4');
  assert.equal(confirmation().checked, true);

  fireEvent.click(picker);
  fireEvent.change(picker, { target: { value: 'sample-d' } });
  fireEvent.keyDown(picker, { key: 'Enter' });
  assert.ok(picker.value.endsWith('tyres · sample-d'));
  assert.equal(confirmation().checked, false);
  fireEvent.change(dialog.getByLabelText('Tally units per sale'), { target: { value: '1' } });
  const pause = dialog.getByRole('checkbox', {
    name: /Keep this listing paused/,
  }) as HTMLInputElement;
  assert.equal(pause.checked, false);
  fireEvent.click(pause);
  fireEvent.click(confirmation());
  fireEvent.click(dialog.getByRole('button', { name: 'Save mapping and check orders' }));
  await screen.findByText('Tally is unavailable.');
  const retry = await screen.findByRole<HTMLButtonElement>('button', { name: 'Retry order check' });
  await waitFor(() => assert.equal(retry.disabled, false));
  fireEvent.click(retry);
  await screen.findByText('1 billed · 1 awaiting a bill · 1 Tally unit reserved');
  fireEvent.click(screen.getByText('Order item details'));
  const [billed, reserved] = screen.getAllByRole('listitem');
  assert.ok(within(billed).getByText('OI-earlier · Billed in Tally'));
  assert.equal(within(billed).getByRole('paragraph').textContent, 'Already billed on INV-2.');
  assert.ok(within(reserved).getByText('OI-later · Reserved for this order'));
  assert.equal(within(reserved).getByRole('paragraph').textContent, 'Awaiting a matching bill.');
  assert.equal(commands.filter((path) => path === '/api/mappings').length, 1);
  assert.ok(screen.getByText('No order items in this preview'));
});

test('the order check distinguishes confirmed reservations while another order needs review', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings[0];
  const source = { listingId: 'FK-71', sku: listing.sku, location: listing.location };
  const rows: PendingOrderResult[] = [
    { orderItemId: 'pair', status: 'reserved', baseUnits: 2, reason: 'Awaiting a matching bill.' },
    { orderItemId: 'unknown', status: 'review', baseUnits: null, reason: 'Check the order.' },
  ];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === '/api/billing/pending/recheck') return response({ ...source, rows });
    assert.equal(url, '/api/billing/pending');
    return response({
      trackingStarted: true,
      listings: [{ ...source, mapped: true, orderItemIds: rows.map((row) => row.orderItemId) }],
    });
  });
  render(
    <BillingListingMappings
      companyId={state.companies[0].id}
      accountId={listing.accountId}
      inventory={state}
      report={report}
      trackingRevision={0}
      busy={false}
      onSaveMapping={() => assert.fail('Checking saved orders must not change the mapping.')}
      onRefreshPreview={async () => {}}
    />,
  );
  fireEvent.click(await screen.findByText('Previously mapped listings (1)'));
  const check = screen.getByRole('button', { name: 'Check orders' });
  fireEvent.click(check);
  await screen.findByText(
    '0 billed · 1 awaiting a bill · 2 Tally units in confirmed reservations · 1 needs review',
  );
  rows[0] = { ...rows[0], status: 'matched', reason: 'Recorded in Tally.' };
  fireEvent.click(check);
  await screen.findByText('1 billed · 0 awaiting a bill · 1 needs review');
});

test('a preview-only order completes the exact pickup of a paused SKU mapping and refreshes bill matching', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings[0];
  Object.assign(listing, {
    marketplaceListingId: item.listingId,
    skuMappingId: item.listingId,
    sku: item.sku,
    paused: true,
    location: '',
    pickupChoices: ['Shop', 'Other'],
  });
  state.listings.push({
    ...listing,
    id: 'new-location-observation',
    location: 'Shop',
    itemId: null,
    skuMappingId: undefined,
    paused: false,
    pickupChoices: undefined,
  });
  const company = state.companies[0];
  const preview = { ...report, rows: [{ ...item, status: 'unmapped' as const }] };
  const mapped: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    switch (String(url)) {
      case '/api/state':
        return response(state);
      case '/api/billing/workspace':
        return response({ rule, report: preview });
      case '/api/billing/coverage':
        return response({ current: false, from: null });
      case '/api/billing/pending':
        return response({ trackingStarted: false, listings: [] });
      case '/api/mappings': {
        const input = JSON.parse(String(init?.body));
        assert.equal(input.keepPaused, true);
        assert.equal(input.pickupLocation, 'Shop');
        assert.deepEqual(input.orderSource, {
          accountId: listing.accountId,
          companyId: company.id,
          listingId: item.listingId,
          locationId: 'Shop',
        });
        assert.equal(input.itemId, listing.itemId);
        mapped.push(input.listingId);
        listing.location = 'Shop';
        return response(state);
      }
      case '/api/billing/preview':
        return response({
          ...preview,
          previewId: 'after-mapping',
          rows: [{ ...item, status: 'matched', bill: candidate }],
        });
      default:
        throw new Error('Unexpected request ' + String(url));
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  await screen.findByText('Billing preview only');
  const pickup = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm order pickup' });
  await waitFor(() => assert.equal(pickup.disabled, false));
  fireEvent.click(pickup);
  const dialog = within(screen.getByRole('dialog'));
  assert.equal(dialog.queryByLabelText('Tally stock item'), null);
  assert.equal(dialog.queryByLabelText('Flipkart pickup location'), null);
  assert.ok(dialog.getByText(/Stock updates are paused/));
  fireEvent.click(dialog.getByRole('checkbox', { name: /I confirm the item/ }));
  fireEvent.click(dialog.getByRole('button', { name: 'Save mapping and check orders' }));
  await screen.findByText('1 matched · 0 unresolved');
  assert.deepEqual(mapped, [listing.id]);
  assert.equal(screen.queryByText('Reserved for this order'), null);
});

test('a confirmed tracking date keeps earlier and cancelled preview orders out of the mapping queue', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings.find((row) => !row.itemId)!;
  const started = '2026-11-17T18:30:00Z';
  t.mock.timers.enable({ apis: ['setInterval'] });
  let cancelled = false;
  const current = {
    ...item,
    listingId: 'active-listing',
    sku: listing.sku,
    location: listing.location,
    status: 'unmapped' as const,
  };
  const previewRows = [
    current,
    { ...current, orderItemId: 'before-start', orderDate: '2026-11-16T12:30:00Z' },
    {
      ...current,
      orderItemId: 'since-cancelled',
      listingId: 'cancelled-listing',
      sku: 'CANCELLED',
    },
  ];
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    switch (String(input)) {
      case '/api/state':
        return response(state);
      case '/api/billing/workspace':
        return response({ rule, report: { ...report, rows: previewRows } });
      case '/api/billing/coverage':
        return response({ current: true, from: started });
      case '/api/billing/pending':
        return response({
          trackingStarted: true,
          listings: cancelled
            ? []
            : [
                {
                  listingId: current.listingId,
                  sku: current.sku,
                  location: current.location,
                  mapped: false,
                  orderItemIds: [current.orderItemId],
                },
              ],
        });
      default:
        throw new Error('Unexpected request ' + input);
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  const queue = within(await screen.findByRole('table', { name: 'Listings to map' }));
  await screen.findByRole('button', { name: 'Review starting stock' });
  await queue.findByText('1 tracked since starting stock');
  assert.equal(queue.getAllByRole('row').length, 2);
  assert.equal(queue.getByText('1').textContent, '1');
  assert.equal(queue.queryByText('CANCELLED'), null);
  assert.ok(screen.getByText('before-start'));
  fireEvent.click(queue.getByRole('button', { name: 'Map listing' }));
  await screen.findByRole('dialog');
  cancelled = true;
  await act(async () => t.mock.timers.tick(30_000));
  assert.equal(screen.queryByRole('dialog'), null);
  assert.equal(screen.queryByRole('table', { name: 'Listings to map' }), null);
});

test('an open Order matching screen picks up newly saved orders without another Flipkart scan', async (t) => {
  const state = initialState('demo', 'unused');
  const listing = state.listings.find((row) => !row.itemId)!;
  // Older located Inventory rows can be bound by the server against the current catalogue.
  assert.equal(listing.marketplaceListingId, undefined);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const reads: boolean[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    switch (String(input)) {
      case '/api/state':
        return response(state);
      case '/api/billing/workspace':
        return response({ rule, report: null });
      case '/api/billing/coverage':
        return response({ current: true, from: report.from });
      case '/api/billing/pending': {
        const { savedOnly } = JSON.parse(String(init?.body));
        reads.push(!!savedOnly);
        return response({
          trackingStarted: true,
          listings: savedOnly
            ? [
                {
                  listingId: 'market-id',
                  sku: listing.sku,
                  location: listing.location,
                  orderItemIds: ['new-item'],
                  mapped: false,
                },
              ]
            : [],
        });
      }
      default:
        throw new Error('Unexpected request ' + String(input));
    }
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Order matching' }));
  await screen.findByText('No listings need a mapping from the orders checked.');
  await act(async () => t.mock.timers.tick(30_000));
  await screen.findByRole('button', { name: 'Map listing' });
  assert.deepEqual(reads, [false, true]);
});
