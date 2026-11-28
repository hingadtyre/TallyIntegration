import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { TallyCompany, TallyStockItem } from '../../src/adapters/tally.js';
import type { Listing } from '../../src/shared/contracts.js';
import { InputError } from '../../src/server/service.js';
import { initialState } from '../../src/server/seed.js';
import { readSnapshot } from '../../src/server/storage/records.js';
import { requireStockSource } from '../../src/server/proposals.js';
import { keepBackSource } from '../../src/server/marketplace-keep-back.js';
import { marketplaceData } from '../support/marketplace-fixture.js';
import { queryFile } from '../support/server-fixture.js';
import { close, listen, serverFixture as fixture } from '../support/server-fixture.js';

function sourceFixture(t: TestContext, mode: 'live' | 'demo' = 'live') {
  const source = {
    companies: [{ externalId: 'company-a', name: 'Company A' }] as TallyCompany[],
    items: new Map<string, TallyStockItem[]>([
      ['company-a', [{ externalId: 'item-a', name: 'Tyre A', unit: 'tyres', physical: 4 }]],
    ]),
    reads: [] as string[],
    failCompany: '',
    failDiscovery: false,
  };
  const f = fixture(t, mode, {
    createTallyReader: () => ({
      async listCompanies() {
        source.reads.push('companies');
        if (source.failDiscovery) throw new Error('Discovery unavailable.');
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

test('a base-unit change keeps the original held amount until the seller confirms it in the current unit', async (t) => {
  const f = sourceFixture(t);
  const initial = await f.service.refresh();
  const item = initial.items[0];
  f.service.setKeepBack(item.companyId, item.id, item.version, 2);
  f.source.items.get('company-a')![0].unit = 'pairs';
  const changed = await f.service.refresh();
  assert.equal(changed.items[0].keepBackPreviousUnit, 'tyres');
  f.source.items.get('company-a')![0].unit = 'sets';
  await f.service.refresh();
  const stored = queryFile(f.file, readSnapshot);
  const current = stored.items[0];
  assert.equal(current.keepBackPreviousUnit, 'tyres');
  assert.equal(current.keepBackUnits, 2);
  const listing = { ...initialState('demo', 'unused').listings[0], itemId: item.id };
  const state = { ...stored, listings: [listing] };
  assert.throws(() => requireStockSource(state, listing), /quantity to keep back/i);
  const remote = { ...marketplaceData(listing.accountId).listings[0], sku: listing.sku };
  assert.throws(() => keepBackSource(state, remote, listing.location), /quantity to keep back/i);
  assert.throws(
    () => f.service.setKeepBack(item.companyId, item.id, item.version, 2),
    /item changed/i,
  );
  f.store.update((snapshot) => {
    snapshot.items.find((entry) => entry.id === item.id)!.observedAt = '2000-01-01T00:00:00.000Z';
  });
  assert.throws(
    () => f.service.setKeepBack(item.companyId, item.id, current.version, 2),
    /refresh the tally item/i,
  );
  await f.service.refresh();
  const confirmed = f.service.setKeepBack(item.companyId, item.id, current.version, 2);
  assert.equal(confirmed.items[0].keepBackPreviousUnit, undefined);
  assert.equal(confirmed.items[0].unit, 'sets');
  assert.equal(confirmed.items[0].keepBackUnits, 2);
  assert.equal(requireStockSource(confirmed, listing).packSize, listing.packSize);
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
  const before = await f.service.refresh();
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
  const unloaded = missing.companies.find((company) => company.id === 'tally:company-b')!;
  assert.equal(unloaded.stockIssue, 'unloaded');
  assert.equal(unloaded.lastSuccess, before.companies[1].lastSuccess);
  const again = await f.service.refresh();
  assert.deepEqual(
    again.items,
    missing.items,
    'repeated missing observations do not change identity or version',
  );
});

test('company reads continue past a failure and a duplicate invalidates only that company', async (t) => {
  const f = sourceFixture(t);
  f.source.companies.push({ externalId: 'company-b', name: 'Company B' });
  f.source.items.set('company-b', [
    { externalId: 'item-b', name: 'Tyre B', unit: 'tyres', physical: 20 },
  ]);
  const before = await f.service.refresh();
  f.source.failCompany = 'company-a';
  f.source.items.get('company-b')![0].physical = 99;
  const partial = await f.service.refresh();
  assert.equal(partial.connection.tally, 'online');
  assert.match(partial.connection.message, /1 company.*failed for Company A/);
  assert.equal(partial.companies[0].stockIssue, 'read-failed');
  assert.equal(partial.companies[0].lastSuccess, before.companies[0].lastSuccess);
  assert.deepEqual(partial.items[0], before.items[0]);
  assert.equal(partial.items[1].physical, 99);

  f.source.failCompany = '';
  f.source.items.get('company-a')![0].physical = 8;
  f.source.items.get('company-b')![0].physical = 123;
  f.source.items.get('company-b')!.push({ ...f.source.items.get('company-b')![0] });
  const duplicate = await f.service.refresh();
  assert.equal(duplicate.companies[0].stockIssue, undefined);
  assert.equal(duplicate.items[0].physical, 8);
  assert.equal(duplicate.companies[1].stockIssue, 'read-failed');
  assert.deepEqual(duplicate.items[1], partial.items[1]);
  assert.match(f.service.logs(), /Duplicate Tally stock identity/);

  f.source.failDiscovery = true;
  const offline = await f.service.refresh('tally:company-b');
  assert.equal(offline.connection.tally, 'offline');
  assert.deepEqual(offline.items, duplicate.items);
  assert.ok(offline.companies.every((company) => company.stockIssue === 'read-failed'));
  f.source.failDiscovery = false;
  await f.service.refresh('tally:company-a');
  assert.equal(f.service.snapshot().companies[1].stockIssue, 'read-failed');
});

test('discovery invalidates unloaded companies and healthy reads are immediately visible while another company waits', async (t) => {
  const companies = [
    { externalId: 'a', name: 'Company A' },
    { externalId: 'b', name: 'Company B' },
    { externalId: 'c', name: 'Company C' },
  ];
  let slowReadStarted!: () => void;
  let releaseRead!: () => void;
  const readingPeer = new Promise<void>((resolve) => {
    slowReadStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let delayed = false;
  const f = fixture(t, 'live', {
    createTallyReader: () => ({
      listCompanies: async () => (delayed ? companies.slice(0, 2) : companies),
      async readStock(company) {
        if (delayed && company.externalId === 'b') {
          slowReadStarted();
          await released;
        }
        return [{ externalId: 'tyre', name: 'Tyre', unit: 'tyres', physical: delayed ? 8 : 4 }];
      },
    }),
  });
  const first = await f.service.refresh();
  delayed = true;
  const pending = f.service.refresh();
  try {
    await readingPeer;
    const inFlight = f.service.snapshot();
    assert.equal(inFlight.items.find((i) => i.companyId === 'tally:a')?.physical, 8);
    assert.equal(inFlight.companies.find((c) => c.id === 'tally:c')?.stockIssue, 'unloaded');
    assert.equal(inFlight.items.find((i) => i.companyId === 'tally:c')?.observedAt, null);
    f.service.settings({ ...first.settings, tallyUrl: 'http://127.0.0.1:9001/' });
    f.service.settings({ ...first.settings, tallySeconds: 75 });
  } finally {
    releaseRead();
    await pending;
  }
  const after = f.service.snapshot();
  assert.equal(after.connection.tally, 'not-checked');
  assert.equal(after.settings.tallySeconds, 75);
  assert.equal(after.items.find((i) => i.companyId === 'tally:b')?.physical, 4);
  assert.ok(after.companies.every((c) => c.stockIssue === 'not-checked'));
});

test('a selected company unloaded in Tally retains its last successful read and quantity', async (t) => {
  const f = sourceFixture(t);
  const before = await f.service.refresh();
  f.source.companies = [];
  const failed = await f.service.refresh('tally:company-a');
  assert.equal(failed.connection.tally, 'online');
  assert.equal(failed.items[0].physical, before.items[0].physical);
  assert.equal(failed.items[0].observedAt, null);
  assert.equal(failed.companies[0].stockIssue, 'unloaded');
  assert.equal(failed.companies[0].lastSuccess, before.companies[0].lastSuccess);
  await assert.rejects(f.service.refresh('unknown-company'), InputError);
});

test('a successful read for another company cannot authorize stock from a failed read', async (t) => {
  const f = sourceFixture(t);
  f.source.companies.push({ externalId: 'company-b', name: 'Company B' });
  await f.service.refresh();
  const companyId = 'tally:company-a';
  f.store.update((state) => {
    state.accounts.push({
      id: 'seller',
      name: 'Seller',
      marketplace: 'flipkart',
      status: 'not-connected',
    });
    state.listings.push({
      id: 'listing',
      accountId: 'seller',
      sku: 'pair',
      title: 'Pair',
      location: 'warehouse',
      itemId: 'tally:company-a:item-a',
      packSize: 2,
      packEvidence: 'Confirmed',
      verified: true,
      observed: 2,
      observedAt: state.items[0].observedAt,
      policy: 'auto',
      remaining: null,
      paused: false,
      version: 1,
    });
  });
  f.service.calculate(companyId, ['listing']);
  f.source.failCompany = 'company-a';
  await f.service.refresh(companyId);
  const other = await f.service.refresh('tally:company-b');
  assert.equal(other.connection.tally, 'online');
  assert.equal(other.items[0].physical, 4);
  assert.throws(() => f.service.calculate(companyId, ['listing']), /Tally stock is stale/);
  assert.match(
    f.service.review(companyId, ['listing']).rows[0].problem ?? '',
    /Tally stock is stale/,
  );
  f.source.failCompany = '';
  await f.service.refresh(companyId);
  assert.equal(f.service.calculate(companyId, ['listing']).proposals[0].quantity, 2);
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
      state.accounts.push({
        id: 'flipkart-primary',
        name: 'Fixture seller',
        marketplace: 'flipkart',
        status: 'not-connected',
      });
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
