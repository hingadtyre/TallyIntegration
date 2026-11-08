import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { TallyCompany, TallyStockItem } from '../../src/adapters/tally.js';
import type { Listing } from '../../src/shared/contracts.js';
import { InputError } from '../../src/server/service.js';
import { close, listen, serverFixture as fixture } from '../support/server-fixture.js';

function sourceFixture(t: TestContext, mode: 'live' | 'demo' = 'live') {
  const source = {
    companies: [{ externalId: 'company-a', name: 'Company A' }] as TallyCompany[],
    items: new Map<string, TallyStockItem[]>([
      ['company-a', [{ externalId: 'item-a', name: 'Tyre A', unit: 'tyres', physical: 4 }]],
    ]),
    reads: [] as string[],
    failCompany: '',
  };
  const f = fixture(t, mode, {
    createTallyReader: () => ({
      async listCompanies() {
        source.reads.push('companies');
        return source.companies;
      },
      async readStock(company) {
        source.reads.push(company.externalId);
        if (company.externalId === source.failCompany) throw new Error('Fixture read failed.');
        return source.items.get(company.externalId) ?? [];
      },
    }),
  });
  return { ...f, source };
}

test('refresh imports new stock and keeps identical company and item names isolated by identity', async (t) => {
  const f = sourceFixture(t);
  f.source.companies = [
    { externalId: 'company-a', name: 'Same company name' },
    { externalId: 'company-b', name: 'Same company name' },
  ];
  f.source.items.set('company-b', [
    { externalId: 'item-a', name: 'Tyre A', unit: 'tyres', physical: 20 },
  ]);
  const first = await f.service.refresh();
  assert.equal(first.connection.tally, 'online');
  assert.deepEqual(
    first.items.map((item) => [item.id, item.companyId, item.physical, item.version]),
    [
      ['tally:company-a:item-a', 'tally:company-a', 4, 1],
      ['tally:company-b:item-a', 'tally:company-b', 20, 1],
    ],
  );
  assert.ok(first.companies.every((company) => company.lastSuccess && !company.automation));
  assert.deepEqual(first.listings, []);
  f.source.companies[0].name = 'Renamed company';
  f.source.items.set('company-a', [
    { externalId: 'item-a', name: 'Renamed tyre', unit: 'tyres', physical: 6 },
    { externalId: 'new-item', name: 'New tyre', unit: 'tyres', physical: null },
  ]);
  const second = await f.service.refresh();
  assert.equal(second.companies.length, 2);
  assert.equal(
    second.companies.find((company) => company.id === 'tally:company-a')!.name,
    'Renamed company',
  );
  const changed = second.items.find((item) => item.id === 'tally:company-a:item-a')!;
  assert.equal(changed.name, 'Renamed tyre');
  assert.equal(changed.physical, 6);
  assert.equal(changed.version, 2);
  const sibling = second.items.find((item) => item.companyId === 'tally:company-b')!;
  assert.equal(sibling.physical, 20);
  assert.equal(sibling.version, 1);
  assert.equal(second.items.find((item) => item.externalId === 'new-item')!.physical, null);
  const repeated = await f.service.refresh();
  assert.equal(repeated.items.length, 3);
  assert.equal(repeated.items.find((item) => item.id === changed.id)!.version, 2);
  assert.equal(repeated.publishingEnabled, false);
});

test('a selected-company refresh updates only that company and retains other loaded observations', async (t) => {
  const f = sourceFixture(t);
  f.source.companies.push({ externalId: 'company-b', name: 'Company B' });
  f.source.items.set('company-b', [
    { externalId: 'item-b', name: 'Tyre B', unit: 'tyres', physical: 20 },
  ]);
  const first = await f.service.refresh();
  const otherItem = first.items.find((item) => item.companyId === 'tally:company-b')!;
  f.source.reads.length = 0;
  f.source.items.get('company-a')![0].physical = 8;
  f.source.items.get('company-b')![0].physical = 999;
  const selected = await f.service.refresh('tally:company-a');
  assert.deepEqual(f.source.reads, ['companies', 'company-a']);
  assert.equal(selected.items.find((item) => item.companyId === 'tally:company-a')!.physical, 8);
  assert.deepEqual(
    selected.items.find((item) => item.id === otherItem.id),
    otherItem,
  );
});

test('missing stock becomes unknown while an unloaded company retains its quantity as unverified', async (t) => {
  const f = sourceFixture(t);
  f.source.companies.push({ externalId: 'company-b', name: 'Company B' });
  f.source.items.set('company-b', [
    { externalId: 'item-b', name: 'Tyre B', unit: 'tyres', physical: 20 },
  ]);
  await f.service.refresh();
  f.source.companies.pop();
  f.source.items.set('company-a', []);
  const missing = await f.service.refresh();
  const removedItem = missing.items.find((item) => item.companyId === 'tally:company-a')!;
  const unloadedItem = missing.items.find((item) => item.companyId === 'tally:company-b')!;
  assert.deepEqual(
    [removedItem.physical, removedItem.observedAt, removedItem.version],
    [null, null, 2],
  );
  assert.deepEqual(
    [unloadedItem.physical, unloadedItem.observedAt, unloadedItem.version],
    [20, null, 2],
  );
  assert.equal(
    missing.companies.find((company) => company.id === 'tally:company-b')!.lastSuccess,
    null,
  );
  const again = await f.service.refresh();
  assert.deepEqual(
    again.items,
    missing.items,
    'repeated missing observations do not change identity or version',
  );
});

test('a failed second company read or duplicate item rejects the complete refresh', async (t) => {
  const f = sourceFixture(t);
  const before = await f.service.refresh();
  f.source.companies.push({ externalId: 'company-b', name: 'Company B' });
  f.source.items.get('company-a')![0].physical = 99;
  f.source.failCompany = 'company-b';
  const failed = await f.service.refresh();
  assert.equal(failed.connection.tally, 'offline');
  assert.deepEqual(failed.items, before.items);
  assert.deepEqual(failed.companies, before.companies);
  f.source.failCompany = '';
  f.source.items.get('company-a')!.push({ ...f.source.items.get('company-a')![0] });
  const duplicate = await f.service.refresh();
  assert.equal(duplicate.connection.tally, 'offline');
  assert.deepEqual(duplicate.items, before.items);
  assert.deepEqual(duplicate.companies, before.companies);
  assert.match(f.service.logs(), /Duplicate Tally stock identity/);
});

test('a selected company no longer loaded in Tally retains its observations and reports failure', async (t) => {
  const f = sourceFixture(t);
  const before = await f.service.refresh();
  f.source.companies = [];
  const failed = await f.service.refresh('tally:company-a');
  assert.equal(failed.connection.tally, 'offline');
  assert.deepEqual(failed.items, before.items);
  assert.deepEqual(failed.companies, before.companies);
  await assert.rejects(f.service.refresh('unknown-company'), InputError);
});

test('sample refresh preserves all inventory and never invokes the external reader', async (t) => {
  const f = sourceFixture(t, 'demo');
  f.service.edit('demo-a', 'listing-1', 1);
  const before = f.service.snapshot();
  const refreshed = await f.service.refresh();
  assert.deepEqual(f.source.reads, []);
  assert.deepEqual(refreshed.items, before.items);
  assert.deepEqual(refreshed.listings, before.listings);
  assert.deepEqual(refreshed.proposals, before.proposals);
  assert.ok(refreshed.connection.lastChecked);
  assert.match(refreshed.connection.message, /No Tally or marketplace calls/);
});

const companiesXml =
  '<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY><NAME>Company A</NAME><GUID>company-a</GUID></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>';
const stockXml =
  '<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><STOCKITEM><NAME>Tyre A</NAME><GUID>item-a</GUID><BASEUNITS>tyres</BASEUNITS><CLOSINGBALANCE>4 tyres</CLOSINGBALANCE><STOCKBRIDGECOMPANYGUID>company-a</STOCKBRIDGECOMPANYGUID></STOCKITEM></COLLECTION></DATA></BODY></ENVELOPE>';

test('a failed source refresh retains observations and drafts but blocks review', async (t) => {
  const f = fixture(t, 'live');
  let fail = false;
  const requests: string[] = [];
  const tally = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    requests.push(body);
    if (fail) {
      response.writeHead(503);
      response.end('fixture unavailable');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/xml' });
    response.end(body.includes('<ID>StockbridgeCompanies</ID>') ? companiesXml : stockXml);
  });
  const address = await listen(tally);
  try {
    f.service.settings({ ...f.service.snapshot().settings, tallyUrl: address });
    const imported = await f.service.refresh();
    assert.equal(imported.connection.tally, 'online');
    assert.equal(imported.items[0].physical, 4);
    assert.equal(imported.items[0].companyId, 'tally:company-a');
    assert.ok(
      requests.some((body) => body.includes('<SVCURRENTCOMPANY>Company A</SVCURRENTCOMPANY>')),
    );
    f.store.update((state) => {
      const listing: Listing = {
        id: 'live-listing',
        accountId: 'flipkart-primary',
        sku: 'TEST-PAIR',
        title: 'Test pair',
        location: 'Test location',
        itemId: state.items[0].id,
        packSize: 2,
        packEvidence: 'Fixture metadata',
        verified: true,
        observed: 5,
        observedAt: new Date().toISOString(),
        policy: 'auto',
        remaining: null,
        paused: false,
        version: 1,
      };
      state.listings.push(listing);
    });
    f.service.calculate('tally:company-a', ['live-listing']);
    const before = f.service.snapshot();
    fail = true;
    const failed = await f.service.refresh('tally:company-a');
    assert.equal(failed.connection.tally, 'offline');
    assert.deepEqual(failed.items, before.items);
    assert.deepEqual(failed.listings, before.listings);
    assert.deepEqual(failed.proposals, before.proposals);
    assert.match(
      f.service.review('tally:company-a', ['live-listing']).rows[0].problem!,
      /stale|refresh/i,
    );
    assert.throws(() => f.service.edit('tally:company-a', 'live-listing', 0), InputError);
  } finally {
    await close(tally);
  }
});
