import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Listing } from '../src/shared/contracts.js';
import { createApp } from '../src/server/http.js';
import { InputError, InventoryService } from '../src/server/service.js';
import { Store } from '../src/server/store.js';
import { readSnapshot } from '../src/server/storage/records.js';

function fixture(t: TestContext, mode: 'live' | 'demo' = 'demo') {
  const folder = mkdtempSync(join(tmpdir(), 'stockbridge-service-'));
  const file = join(folder, 'state.sqlite');
  let store = new Store(file, mode);
  let service = new InventoryService(store);
  t.after(() => {
    service.stop();
    store.close();
    const target = resolve(folder);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('stockbridge-service-')
    ) {
      throw new Error('Refusing to remove a directory outside the test fixture.');
    }
    rmSync(target, { recursive: true, force: true });
  });
  return {
    folder,
    file,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    reopen() {
      service.stop();
      store.close();
      store = new Store(file, mode);
      service = new InventoryService(store);
    },
  };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

test('calculation is limited to its explicit company scope and failed scope is atomic', (t) => {
  const f = fixture(t);
  const initial = f.service.snapshot();
  const result = f.service.calculate('demo-a', ['listing-1', 'listing-1', 'listing-3']);
  assert.deepEqual(result.proposals.map((row) => row.listingId).sort(), ['listing-1', 'listing-3']);
  assert.deepEqual(
    result.proposals.map((row) => row.quantity),
    [5, 5],
  );
  assert.deepEqual(
    result.items,
    initial.items,
    'unmapped stock items and physical stock are preserved',
  );
  assert.deepEqual(
    result.listings,
    initial.listings,
    'calculation cannot alter marketplace observations or policies',
  );
  const saved = f.service.snapshot();
  assert.throws(() => f.service.calculate('demo-a', ['listing-2', 'listing-8']), InputError);
  assert.deepEqual(
    f.service.snapshot(),
    saved,
    'an invalid second row cannot partially save the first row',
  );
});

test('edited quantity and zero drafts survive calculation without activating policies', (t) => {
  const f = fixture(t);
  const original = f.service.snapshot().listings;
  f.service.edit('demo-a', 'listing-1', 1);
  f.service.calculate('demo-a', ['listing-2'], true);
  const result = f.service.calculate('demo-a', ['listing-1', 'listing-2', 'listing-3']);
  assert.deepEqual(
    result.proposals.map((row) => [row.listingId, row.quantity, row.edited]),
    [
      ['listing-1', 1, true],
      ['listing-2', 0, true],
      ['listing-3', 5, false],
    ],
  );
  assert.deepEqual(result.listings, original);
  assert.equal(result.publishingEnabled, false);
  assert.throws(() => f.service.edit('demo-a', 'listing-1', 6), InputError);
});

test('a changed source preserves the seller edit but makes its review stale', (t) => {
  const f = fixture(t);
  f.service.edit('demo-a', 'listing-1', 1);
  f.store.update((state) => {
    const item = state.items.find((row) => row.id === 'item-a')!;
    item.physical = 0;
    item.version++;
  });
  const afterCalculate = f.service.calculate('demo-a', ['listing-1']);
  assert.equal(afterCalculate.proposals[0].quantity, 1);
  assert.equal(afterCalculate.proposals[0].stale, true);
  const review = f.service.review('demo-a', ['listing-1']);
  assert.equal(review.rows[0].stale, true);
  assert.match(review.rows[0].problem!, /changed/i);
  f.service.edit('demo-a', 'listing-1', 0);
  assert.equal(f.service.review('demo-a', ['listing-1']).rows[0].problem, null);
});

test('review captures destinations and does not expand when later proposals are added', (t) => {
  const f = fixture(t);
  const missing = f.service.review('demo-a', ['listing-1']);
  assert.equal(missing.rows[0].quantity, null, 'an absent proposal is not zero');
  f.service.calculate('demo-a', ['listing-1']);
  const captured = f.service.review('demo-a', ['listing-1']);
  f.service.calculate('demo-a', ['listing-2', 'listing-3']);
  assert.deepEqual(
    captured.rows.map((row) => row.listingId),
    ['listing-1'],
  );
  assert.equal(captured.companyId, 'demo-a');
  assert.equal(captured.rows[0].account, 'Sample seller · Flipkart');
  assert.equal(captured.rows[0].location, 'Sample warehouse');
  assert.equal(captured.publishingEnabled, false);
});

test('pause and resume retain limited-sales and zero-hold policies', (t) => {
  const f = fixture(t);
  const original = f.service.snapshot();
  f.service.pause('demo-a', ['listing-5', 'listing-6'], true);
  f.service.calculate('demo-a', ['listing-5', 'listing-6']);
  const review = f.service.review('demo-a', ['listing-5', 'listing-6']);
  assert.deepEqual(
    review.rows.map((row) => [row.quantity, row.problem]),
    [
      [0, null],
      [1, null],
    ],
  );
  const resumed = f.service.pause('demo-a', ['listing-5', 'listing-6'], false);
  for (const id of ['listing-5', 'listing-6']) {
    const before = original.listings.find((row) => row.id === id)!;
    const after = resumed.listings.find((row) => row.id === id)!;
    assert.deepEqual(
      [after.policy, after.remaining, after.observed],
      [before.policy, before.remaining, before.observed],
    );
    assert.equal(after.paused, false);
  }
});

test('explicit unlink keeps remote stock unchanged and allows a confirmed remapping', (t) => {
  const f = fixture(t);
  f.service.calculate('demo-a', ['listing-1']);
  const before = f.service.snapshot().listings.find((row) => row.id === 'listing-1')!;
  assert.throws(() => f.service.remove('demo-a', 'listing-1', false), InputError);
  const removed = f.service.remove('demo-a', 'listing-1', true);
  const listing = removed.listings.find((row) => row.id === 'listing-1')!;
  assert.equal(listing.itemId, null);
  assert.equal(listing.observed, before.observed);
  assert.equal(
    removed.proposals.some((row) => row.listingId === 'listing-1'),
    false,
  );
  assert.throws(
    () =>
      f.service.mapping({ listingId: 'listing-1', itemId: 'item-a', confirmPackEvidence: false }),
    InputError,
  );
  const remapped = f.service.mapping({
    listingId: 'listing-1',
    itemId: 'item-a',
    confirmPackEvidence: true,
  });
  assert.equal(remapped.listings.find((row) => row.id === 'listing-1')!.itemId, 'item-a');
  assert.equal(remapped.items.length, removed.items.length);
});

test('settings enforce interval minimums and persist immediately without restarting', (t) => {
  const f = fixture(t);
  const settings = f.service.snapshot().settings;
  for (const [key, value] of [
    ['tallySeconds', 4],
    ['marketplaceSeconds', 29],
    ['catalogSeconds', 59],
  ] as const) {
    assert.throws(() => f.service.settings({ ...settings, [key]: value }), InputError);
    assert.deepEqual(f.service.snapshot().settings, settings);
  }
  const changed = {
    ...settings,
    tallySeconds: 5,
    marketplaceSeconds: 30,
    catalogSeconds: 60,
    backupFolder: join(f.folder, 'new-backups'),
  };
  const result = f.service.settings(changed);
  assert.deepEqual(result.settings, { ...changed, tallyUrl: 'http://127.0.0.1:9000/' });
  f.reopen();
  assert.deepEqual(f.service.snapshot().settings, result.settings);
});

test('an unusable backup destination is rejected without replacing saved settings', (t) => {
  const f = fixture(t);
  const original = f.service.snapshot().settings;
  const blockingFile = join(f.folder, 'not-a-directory');
  writeFileSync(blockingFile, 'retained fixture content');
  assert.throws(() => f.service.settings({ ...original, backupFolder: blockingFile }));
  assert.deepEqual(f.service.snapshot().settings, original);
  assert.equal(readFileSync(blockingFile, 'utf8'), 'retained fixture content');
});

test('interval-only changes preserve drafts, while a different source address invalidates them', (t) => {
  const f = fixture(t);
  f.service.edit('demo-a', 'listing-1', 1);
  const settings = f.service.snapshot().settings;
  const intervalsOnly = f.service.settings({ ...settings, tallySeconds: 45 });
  assert.equal(intervalsOnly.proposals[0].stale, false);
  assert.equal(intervalsOnly.proposals[0].quantity, 1);
  const newSource = f.service.settings({
    ...intervalsOnly.settings,
    tallyUrl: 'http://127.0.0.1:9001',
  });
  assert.equal(newSource.proposals[0].stale, true);
  assert.equal(
    newSource.proposals[0].quantity,
    1,
    'changing source preserves the edit for comparison',
  );
  assert.equal(newSource.connection.tally, 'not-checked');
});

test('saved drafts survive restart, callers cannot mutate stored state, and backup is readable', (t) => {
  const f = fixture(t);
  f.service.edit('demo-a', 'listing-1', 1);
  f.service.pause('demo-a', ['listing-5'], true);
  const saved = f.service.snapshot();
  const detached = f.service.snapshot();
  detached.listings[0].observed = 999;
  detached.proposals[0].quantity = 999;
  assert.deepEqual(f.service.snapshot(), saved);
  f.reopen();
  assert.deepEqual(f.service.snapshot().proposals, saved.proposals);
  assert.deepEqual(f.service.snapshot().listings, saved.listings);
  const backup = f.service.backup();
  assert.equal(backup.verified, true);
  assert.equal(existsSync(backup.path), true);
  const copy = new DatabaseSync(backup.path, { readOnly: true });
  try {
    assert.equal(
      (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
      'ok',
    );
    const stored = readSnapshot(copy);
    assert.deepEqual(stored.proposals, saved.proposals);
    assert.deepEqual(stored.listings, saved.listings);
    assert.equal(stored.publishingEnabled, false);
  } finally {
    copy.close();
  }
  const manifest = JSON.parse(readFileSync(`${backup.path}.json`, 'utf8'));
  assert.equal(manifest.credentialsIncluded, false);
  assert.equal(manifest.restoreSupported, false);
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

test('HTTP publication remains unavailable and untrusted mutations are rejected', async (t) => {
  const f = fixture(t);
  f.service.edit('demo-a', 'listing-1', 1);
  const before = f.service.snapshot();
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  try {
    const payload = JSON.stringify({ companyId: 'demo-a', listingIds: ['listing-1'] });
    const noHeader = await fetch(`${address}/api/zero`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(noHeader.status, 403);
    await noHeader.arrayBuffer();
    const crossOrigin = await fetch(`${address}/api/zero`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stockbridge-Request': '1',
        Origin: 'https://untrusted.example',
      },
      body: payload,
    });
    assert.equal(crossOrigin.status, 403);
    await crossOrigin.arrayBuffer();
    const publish = await fetch(`${address}/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: payload,
    });
    assert.equal(publish.status, 409);
    assert.match(((await publish.json()) as { error: string }).error, /unavailable/i);
    const stateResponse = await fetch(`${address}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = (await stateResponse.json()) as { publishingEnabled: boolean };
    assert.equal(state.publishingEnabled, false);
    assert.deepEqual(
      f.service.snapshot(),
      before,
      'blocked requests cannot activate a policy or alter stock',
    );
  } finally {
    await close(app);
  }
});
