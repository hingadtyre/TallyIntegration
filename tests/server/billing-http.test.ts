import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/server/http.js';
import { MarketplaceService } from '../../src/server/marketplace-service.js';
import { BillingService } from '../../src/server/billing-service.js';
import { saleDay } from '../../src/server/billing-matcher.js';
import { marketplaceData } from '../support/marketplace-fixture.js';
import type { BillingReport, BillingWorkspace } from '../../src/shared/billing-contracts.js';
import { close, listen, serverFixture } from '../support/server-fixture.js';

test('seller selects a ledger, previews, confirms and corrects a bill without publishing stock', async (t) => {
  const f = serverFixture(t);
  const markets = new MarketplaceService(f.store, f.folder);
  const app = createApp(f.service, f.folder, undefined, undefined, markets);
  const address = await listen(app);
  t.after(async () => {
    await close(app);
    markets.stop();
    await markets.idle();
  });
  const scope = { companyId: 'demo-a', accountId: 'flipkart-primary' };
  const post = (action: string, data: Record<string, unknown> = {}) =>
    fetch(address + '/api/billing/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: JSON.stringify({ ...scope, ...data }),
    });
  assert.equal((await fetch(address + '/api/billing/confirm', { method: 'POST' })).status, 403);
  assert.equal((await post('ledgers', { accountId: 'nonexistent' })).status, 404);
  const market = f.store.readMarketplace();
  const inventory = f.store.read();
  const { ledgers } = (await (await post('ledgers')).json()) as {
    ledgers: { externalId: string }[];
  };
  const settings = {
    ledgerId: ledgers[0].externalId,
    field: 'manual',
    reference: 'orderId',
    days: 7,
  };
  const preview = (await (await post('preview', settings)).json()) as BillingReport;
  assert.equal(preview.rows.length, 2);
  assert.equal(preview.stock[0].unmatchedUnits, 2);
  assert.equal(
    (
      await post('match', {
        previewId: preview.previewId,
        orderItemId: 'SAMPLE-LINE-1',
        billId: 'sample-bill-1',
      })
    ).status,
    409,
  );
  const confirmed = (await (
    await post('confirm', { previewId: preview.previewId })
  ).json()) as BillingWorkspace;
  assert.equal(confirmed.rule?.ledgerId, settings.ledgerId);
  const linked = (await (
    await post('match', {
      previewId: confirmed.report!.previewId,
      orderItemId: 'SAMPLE-LINE-1',
      billId: 'sample-bill-1',
    })
  ).json()) as BillingWorkspace;
  const row = linked.report!.rows[0];
  assert.equal(row.status, 'matched');
  assert.equal(row.manualBillId, 'sample-bill-1');
  assert.equal(linked.report!.rows[1].candidates.length, 0);
  assert.equal(linked.report!.stock[0].unmatchedUnits, 1);
  assert.equal(
    (
      await post('match', {
        previewId: confirmed.report!.previewId,
        orderItemId: 'SAMPLE-LINE-2',
        billId: 'sample-bill-1',
      })
    ).status,
    409,
  );
  const other = (await (
    await post('workspace', { companyId: 'demo-b' })
  ).json()) as BillingWorkspace;
  assert.deepEqual(other, { rule: null, report: null });
  const released = (await (
    await post('unmatch', { previewId: linked.report!.previewId, orderItemId: row.orderItemId })
  ).json()) as BillingWorkspace;
  assert.equal(released.report!.stock[0].unmatchedUnits, 2);
  const automatic = (await (
    await post('preview', { ...settings, field: 'reference' })
  ).json()) as BillingReport;
  assert.equal(automatic.rows[0].status, 'matched');
  assert.equal(automatic.rows[1].status, 'unmatched');
  f.store.update((state) => {
    state.listings[0].verified = false;
  });
  assert.equal((await post('confirm', { previewId: automatic.previewId })).status, 409);
  assert.equal(f.store.readBilling().rules[0].field, 'manual');
  assert.deepEqual(f.store.readMarketplace(), market);
  assert.deepEqual(f.store.read().items, inventory.items);
});

test('live review reads the configured books and seller, and a ledger bill alone creates no order', async (t) => {
  const f = serverFixture(t, 'live');
  const scope = { companyId: 'tally:company-guid', accountId: 'seller' };
  const now = new Date(Date.now() - 60_000).toISOString();
  const market = marketplaceData(scope.accountId);
  f.store.updateMarketplace((data, state) => {
    Object.assign(data, { ...market, changes: [] });
    state.accounts.push({
      id: scope.accountId,
      marketplace: 'flipkart',
      name: 'Seller',
      status: 'not-connected',
    });
    state.companies.push({
      id: scope.companyId,
      name: 'Books',
      source: 'tally',
      lastSuccess: null,
      automation: false,
    });
    state.items.push({
      id: 'local-item',
      companyId: scope.companyId,
      externalId: 'tally-item',
      name: 'Tyre',
      unit: 'ea',
      brand: '',
      physical: 99,
      observedAt: null,
      version: 1,
      lowStockThreshold: 1,
    });
    state.listings.push({
      id: 'destination',
      accountId: scope.accountId,
      sku: 'TYRE-PAIR',
      title: 'Pair',
      location: 'warehouse-1',
      itemId: 'local-item',
      packSize: 2,
      packSource: 'manual',
      packEvidence: 'seller',
      verified: true,
      observed: 5,
      observedAt: now,
      policy: 'auto',
      remaining: null,
      paused: false,
      version: 1,
    });
  });
  let hasOrder = false;
  let hasBill = true;
  const service = new BillingService(f.store, {
    tally: () => ({
      async listLedgers(company) {
        assert.equal(company.externalId, 'company-guid');
        return [{ externalId: 'ledger-guid', name: 'My online sales' }];
      },
      async readSalesBills(company, ledger) {
        assert.equal(company.name, 'Books');
        assert.equal(ledger, 'ledger-guid');
        return hasBill
          ? [
              {
                externalId: 'voucher',
                number: 'B1',
                reference: 'O1',
                narration: 'Private customer details',
                date: saleDay(now),
                lines: [{ itemExternalId: 'tally-item', unit: 'ea', quantity: 2 }],
              },
            ]
          : [];
      },
      async readStock() {
        return [{ externalId: 'tally-item', name: 'Tyre', unit: 'ea', physical: 6 }];
      },
    }),
    orders: {
      async readOrders(token, from, to, invoices) {
        assert.equal(token, 'test-token');
        assert.ok(from <= now && to >= now);
        assert.equal(invoices, false);
        return hasOrder
          ? [
              {
                orderId: 'O1',
                orderItemId: 'I1',
                invoiceNumber: null,
                listingId: 'remote-listing',
                sku: 'TYRE-PAIR',
                locationId: 'warehouse-1',
                orderDate: now,
                quantity: 1,
              },
            ]
          : [];
      },
    },
  });
  const preview = () =>
    service.command(
      '/api/billing/preview',
      { ...scope, ledgerId: 'ledger-guid', field: 'reference', reference: 'orderId', days: 30 },
      async () => 'test-token',
    ) as Promise<BillingReport>;
  const empty = await preview();
  assert.deepEqual(empty.rows, []);
  hasOrder = true;
  const matched = await preview();
  assert.equal(matched.rows[0].status, 'matched');
  assert.equal(matched.stock[0].physical, 6);
  assert.ok(!JSON.stringify(matched).includes('Private customer details'));
  hasBill = false;
  await assert.rejects(
    service.command(
      '/api/billing/confirm',
      { ...scope, previewId: matched.previewId },
      async () => 'test-token',
    ),
    /changed/,
  );
  assert.deepEqual(f.store.readBilling().rules, []);
  const unbilled = await preview();
  assert.equal(unbilled.stock[0].previewAvailable, 4);
  assert.equal(f.store.read().items[0].physical, 99);
});
