import assert from 'node:assert/strict';
import test from 'node:test';
import { storageFixture } from '../../support/server-fixture.js';

test('billing settings and exact order-to-bill assignments survive restart and reject duplicate or orphaned claims atomically', (t) => {
  const f = storageFixture(t);
  const store = f.open();
  const state = store.read();
  const scope = { companyId: state.companies[0].id, accountId: state.accounts[0].id };
  const rule = {
    ...scope,
    ledgerId: 'ledger-guid',
    ledgerName: 'Marketplace sales',
    reference: 'orderItemId' as const,
    field: 'reference' as const,
  };
  const link = {
    ...scope,
    ledgerId: rule.ledgerId,
    orderItemId: 'line-55',
    billId: 'bill-guid',
    itemId: 'stock-guid',
    fingerprint: 'original',
  };
  store.updateBilling((data) => {
    data.rules.push(rule);
    data.links.push(link);
  });
  const persisted = { rules: [rule], links: [link] };
  assert.deepEqual(f.open().readBilling(), persisted);
  for (const duplicate of [
    { ...link, orderItemId: 'another-line' },
    { ...link, billId: 'another-bill' },
  ]) {
    assert.throws(
      () =>
        store.updateBilling((data) => {
          data.rules[0].ledgerName = 'Unsaved change';
          data.links.push(duplicate);
        }),
      /conflict/,
    );
    assert.deepEqual(store.readBilling(), persisted);
  }
  assert.throws(
    () =>
      store.updateBilling((data) => {
        data.rules = [];
      }),
    /FOREIGN KEY/u,
  );
  assert.deepEqual(store.readBilling(), persisted);
});
