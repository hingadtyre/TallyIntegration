import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FlipkartListingsClient } from '../../src/adapters/flipkart-listings.js';
import { MarketplacePublication } from '../../src/server/marketplace-publication.js';
import { MarketplaceService } from '../../src/server/marketplace-service.js';
import type { FlipkartConnectionStatus } from '../../src/shared/contracts.js';
import { inspectPilotBackup, restorePilotBackup } from '../../src/server/restore.js';
import { acquireWorkspaceOwnership } from '../../src/server/runtime.js';
import { initialState } from '../../src/server/seed.js';
import { InventoryService } from '../../src/server/service.js';
import { Store } from '../../src/server/store.js';
import { readSnapshot } from '../../src/server/storage/records.js';
import { readMarketplace, writeMarketplace } from '../../src/server/storage/marketplace-records.js';
import { marketplaceData } from '../support/marketplace-fixture.js';
import { queryFile } from '../support/server-fixture.js';

function fixture(t: TestContext, mode: 'live' | 'demo' = 'live') {
  const directory = mkdtempSync(join(tmpdir(), 'stockbridge-restore-'));
  t.after(() => {
    const target = resolve(directory);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('stockbridge-restore-')
    )
      throw new Error('Unsafe restore fixture cleanup path.');
    rmSync(target, { recursive: true, force: true });
  });
  const source = new Store(join(directory, 'source', `${mode}.sqlite`), mode);
  const service = new InventoryService(source);
  let backupFile: string;
  let saved;
  try {
    const sample = initialState('demo', join(directory, 'source', 'backups'));
    sample.mode = mode;
    sample.connection.tally = 'online';
    sample.accounts[0].name = 'Saved seller';
    sample.accounts[0].status = mode === 'demo' ? 'demo' : 'not-connected';
    for (const company of sample.companies) {
      company.source = mode === 'demo' ? 'demo' : 'tally';
      company.automation = true;
    }
    source.update((state) => Object.assign(state, sample));
    service.edit('demo-a', 'listing-1', 1);
    saved = service.snapshot();
    backupFile = service.backup().path;
  } finally {
    service.stop();
    source.close();
  }
  const dataDirectory = join(directory, 'destination');
  const destination = join(dataDirectory, `${mode}.sqlite`);
  const current = new Store(destination, mode);
  let local;
  try {
    current.update((state) => {
      state.accounts = [
        {
          id: 'flipkart-primary',
          name: 'Current seller',
          marketplace: 'flipkart',
          status: mode === 'demo' ? 'demo' : 'not-connected',
        },
      ];
      state.settings.tallyUrl = 'http://127.0.0.1:9010/';
      state.settings.tallySeconds = 45;
      state.settings.backupFolder = join(directory, 'local-backups');
    });
    local = current.read();
  } finally {
    current.close();
  }
  return { directory, dataDirectory, destination, backupFile, saved, local, mode };
}

function restoreOptions(f: ReturnType<typeof fixture>) {
  return {
    backupFile: f.backupFile,
    dataDirectory: f.dataDirectory,
    mode: f.mode,
    expectedSha256: inspectPilotBackup(f.backupFile, f.mode).sha256,
    confirmReplace: true,
  };
}

test('inspection reports date, mode and record counts without changing the backup or destination', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.backupFile);
  const manifest = readFileSync(`${f.backupFile}.json`);
  const destination = readFileSync(f.destination);
  const preview = inspectPilotBackup(f.backupFile, 'live');
  assert.equal(preview.mode, 'live');
  assert.equal(preview.schemaVersion, 3);
  assert.equal(preview.publishingEnabled, false);
  assert.ok(Number.isFinite(Date.parse(preview.createdAt)));
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    preview.companies,
    f.saved.companies.map(({ id, name }) => ({ id, name })),
  );
  assert.deepEqual(
    preview.sellerAccounts,
    f.saved.accounts.map(({ id, name, marketplace }) => ({ id, name, marketplace })),
  );
  assert.deepEqual(preview.counts, {
    companies: 2,
    stockItems: 5,
    listings: 9,
    proposals: 1,
    activity: f.saved.activity.length,
  });
  assert.deepEqual(readFileSync(f.backupFile), before);
  assert.deepEqual(readFileSync(`${f.backupFile}.json`), manifest);
  assert.deepEqual(readFileSync(f.destination), destination);
});

test('offline restore preserves local settings and a verified safety copy while resetting all freshness and automation', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.backupFile);
  const result = await restorePilotBackup(restoreOptions(f));
  assert.equal(result.restored, true);
  assert.equal(result.publishingEnabled, false);
  assert.equal(result.requiresFreshRead, true);
  const restored = queryFile(f.destination, readSnapshot);
  assert.deepEqual(restored.settings, f.local.settings);
  assert.equal(restored.connection.tally, 'not-checked');
  assert.equal(restored.connection.lastChecked, null);
  assert.equal(restored.connection.nextPoll, null);
  assert.ok(
    restored.companies.every((company) => !company.automation && company.lastSuccess === null),
  );
  assert.ok(restored.items.every((item) => item.observedAt === null));
  assert.ok(restored.listings.every((listing) => listing.paused && listing.observedAt === null));
  assert.ok(restored.accounts.every((account) => account.status === 'not-connected'));
  assert.deepEqual(
    restored.items.map((item) => [item.id, item.physical]),
    f.saved.items.map((item) => [item.id, item.physical]),
  );
  assert.deepEqual(
    restored.listings.map((listing) => [listing.itemId, listing.policy, listing.remaining]),
    f.saved.listings.map((listing) => [listing.itemId, listing.policy, listing.remaining]),
  );
  assert.equal(restored.proposals[0].quantity, 1);
  assert.equal(restored.proposals[0].stale, true);
  assert.equal(restored.proposals[0].itemVersion, -1);
  assert.equal(restored.activity[0].operation, 'pilot-restore');
  assert.deepEqual(queryFile(result.safetyBackup, readSnapshot), f.local);
  assert.equal(inspectPilotBackup(result.safetyBackup, 'live').mode, 'live');
  assert.deepEqual(readFileSync(f.backupFile), before);
  assert.ok(!readdirSync(f.dataDirectory).some((name) => name.includes('.restore-')));
  for (const suffix of ['-wal', '-shm', '-journal'])
    assert.equal(existsSync(f.destination + suffix), false);
});

test('confirmation and the inspected digest are required before any replacement', async (t) => {
  const f = fixture(t);
  const options = restoreOptions(f);
  const original = readFileSync(f.destination);
  await assert.rejects(
    restorePilotBackup({ ...options, confirmReplace: false }),
    /Inspect the backup first/,
  );
  await assert.rejects(
    restorePilotBackup({ ...options, expectedSha256: '0'.repeat(64) }),
    /differs from the inspected preview/,
  );
  queryFile(f.backupFile, (database) => database.exec('UPDATE stock_items SET physical = 99;'));
  await assert.rejects(restorePilotBackup(options), /differs from the inspected preview/);
  assert.deepEqual(readFileSync(f.destination), original);
});

test('a running workspace refuses restore before its database is touched', async (t) => {
  const f = fixture(t);
  const original = readFileSync(f.destination);
  const owner = await acquireWorkspaceOwnership(f.dataDirectory, 'live');
  try {
    await assert.rejects(restorePilotBackup(restoreOptions(f)), /already running/);
    assert.deepEqual(readFileSync(f.destination), original);
  } finally {
    await owner.release();
  }
});

test('invalid, incompatible and mismatched backup files are rejected without replacing the destination', async (t) => {
  for (const invalid of [
    'missing-manifest',
    'broken-database',
    'newer-schema',
    'wrong-mode',
    'broken-relationship',
  ] as const) {
    await t.test(invalid, async (nested) => {
      const f = fixture(nested);
      const options = restoreOptions(f);
      const original = readFileSync(f.destination);
      if (invalid === 'missing-manifest') rmSync(`${f.backupFile}.json`);
      if (invalid === 'broken-database') writeFileSync(f.backupFile, 'Not a database.');
      if (invalid === 'newer-schema')
        queryFile(f.backupFile, (database) => database.exec('PRAGMA user_version = 99;'));
      if (invalid === 'wrong-mode') {
        const manifest = JSON.parse(readFileSync(`${f.backupFile}.json`, 'utf8'));
        writeFileSync(`${f.backupFile}.json`, JSON.stringify({ ...manifest, mode: 'demo' }));
      }
      if (invalid === 'broken-relationship')
        queryFile(f.backupFile, (database) =>
          database.exec("PRAGMA foreign_keys = OFF; UPDATE listings SET account_id = 'missing';"),
        );
      await assert.rejects(restorePilotBackup(options));
      assert.deepEqual(readFileSync(f.destination), original);
    });
  }
});

test('working SQLite files and WAL-mode sources are not accepted as completed backups', (t) => {
  const f = fixture(t);
  writeFileSync(`${f.backupFile}-wal`, 'working data');
  assert.throws(() => inspectPilotBackup(f.backupFile, 'live'), /working files/);
  rmSync(`${f.backupFile}-wal`);
  queryFile(f.backupFile, (database) => database.exec('PRAGMA journal_mode = WAL;'));
  const filesBefore = readdirSync(dirname(f.backupFile));
  assert.throws(() => inspectPilotBackup(f.backupFile, 'live'), /active WAL/);
  assert.deepEqual(readdirSync(dirname(f.backupFile)), filesBefore);
});

test('another SQLite reader prevents replacement without losing the current workspace', async (t) => {
  const f = fixture(t);
  const reader = new DatabaseSync(f.destination);
  try {
    reader.exec('PRAGMA journal_mode = WAL; BEGIN;');
    reader.prepare('SELECT * FROM settings').get();
    await assert.rejects(restorePilotBackup(restoreOptions(f)), /locked|busy|self-contained/);
    assert.deepEqual(readSnapshot(reader), f.local);
  } finally {
    reader.close();
  }
  assert.deepEqual(queryFile(f.destination, readSnapshot), f.local);
});

test('a staging failure retains the original database and its verified safety copy', async (t) => {
  const f = fixture(t);
  queryFile(f.backupFile, (database) =>
    database.prepare('UPDATE stock_items SET version = ?').run(Number.MAX_SAFE_INTEGER),
  );
  await assert.rejects(
    restorePilotBackup(restoreOptions(f)),
    /did not replace.*Safety copy retained/s,
  );
  assert.deepEqual(queryFile(f.destination, readSnapshot), f.local);
  const safetyFiles = readdirSync(join(f.dataDirectory, 'restore-backups')).filter((file) =>
    file.endsWith('.sqlite'),
  );
  assert.equal(safetyFiles.length, 1);
  const safety = join(f.dataDirectory, 'restore-backups', safetyFiles[0]);
  assert.deepEqual(queryFile(safety, readSnapshot), f.local);
  assert.equal(inspectPilotBackup(safety, 'live').mode, 'live');
  assert.ok(!readdirSync(f.dataDirectory).some((name) => name.includes('.restore-')));
});

test('older schema-two backup manifests remain eligible and restore into schema three', async (t) => {
  const f = fixture(t);
  queryFile(f.backupFile, (database) =>
    database.exec(
      'DROP TABLE marketplace_changes; DROP TABLE marketplace_listings; DROP TABLE marketplace_accounts; PRAGMA user_version = 2;',
    ),
  );
  const manifest = JSON.parse(readFileSync(`${f.backupFile}.json`, 'utf8'));
  manifest.schemaVersion = 2;
  delete manifest.restoreScope;
  manifest.restoreSupported = false;
  writeFileSync(`${f.backupFile}.json`, JSON.stringify(manifest));
  assert.equal(inspectPilotBackup(f.backupFile, 'live').schemaVersion, 2);
  await restorePilotBackup(restoreOptions(f));
  queryFile(f.destination, (database) => {
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.deepEqual(readMarketplace(database), { accounts: [], listings: [], changes: [] });
  });
});

test('restoring marketplace data retains seller binding, invalidates observations and never replays unfinished edits', async (t) => {
  const f = fixture(t);
  const saved = marketplaceData(f.saved.accounts[0].id);
  saved.changes = ['pending', 'sending', 'checking', 'uncertain', 'confirmed', 'failed'].map(
    (state, index) => ({
      ...saved.changes[0],
      id: `change-${index}`,
      state: state as (typeof saved.changes)[number]['state'],
    }),
  );
  queryFile(f.backupFile, (database) => {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    writeMarketplace(database, saved);
    database.exec('COMMIT');
  });
  const original = readFileSync(f.backupFile);
  await restorePilotBackup(restoreOptions(f));
  const restored = queryFile(f.destination, readMarketplace);
  assert.equal(restored.accounts[0].sellerId, saved.accounts[0].sellerId);
  assert.equal(restored.accounts[0].lastRefreshedAt, null);
  assert.equal(restored.listings[0].observedAt, null);
  assert.equal(restored.listings[0].version, saved.listings[0].version + 1);
  assert.deepEqual(restored.listings[0].locations, saved.listings[0].locations);
  assert.deepEqual(
    restored.changes.map((row) => row.state),
    ['uncertain', 'uncertain', 'uncertain', 'uncertain', 'confirmed', 'failed'],
  );
  assert.match(restored.changes[0].message, /do not resend.*automatically/);
  assert.deepEqual(readFileSync(f.backupFile), original);
});

test('an older backup cannot erase newer seller binding or unfinished update barriers', async (t) => {
  const f = fixture(t);
  const current = marketplaceData(f.local.accounts[0].id);
  current.changes = ['pending', 'sending', 'checking', 'uncertain', 'confirmed', 'failed'].map(
    (state, index) => ({
      ...current.changes[0],
      id: `newer-change-${index}`,
      state: state as (typeof current.changes)[number]['state'],
    }),
  );
  queryFile(f.destination, (database) => writeMarketplace(database, current));
  queryFile(f.backupFile, (database) =>
    writeMarketplace(database, {
      accounts: [{ ...current.accounts[0], sellerId: null, lastRefreshedAt: null }],
      listings: [],
      changes: [],
    }),
  );
  const result = await restorePilotBackup(restoreOptions(f));
  const restored = queryFile(f.destination, readMarketplace);
  assert.equal(restored.accounts[0].sellerId, current.accounts[0].sellerId);
  assert.equal(restored.accounts[0].lastRefreshedAt, null);
  assert.equal(restored.listings[0].observedAt, null);
  assert.deepEqual(
    restored.changes.map((row) => [row.id, row.state]),
    current.changes.slice(0, 4).map((row) => [row.id, 'uncertain']),
  );
  assert.deepEqual(queryFile(result.safetyBackup, readMarketplace), current);

  const store = new Store(f.destination, 'live');
  try {
    // A fresh observation alone must not clear the retained update barrier.
    store.updateMarketplace((data) => {
      data.listings[0].observedAt = new Date().toISOString();
    });
    let requests = 0;
    const publisher = new MarketplacePublication(
      store,
      new FlipkartListingsClient({
        request: async () => {
          requests++;
          throw new Error('A retained unfinished update must block another request.');
        },
      }),
    );
    const listing = store.readMarketplace().listings[0];
    await assert.rejects(
      publisher.apply(
        listing.accountId,
        {
          listingId: listing.id,
          version: listing.version,
          edit: { kind: 'price', field: 'sellingPrice', value: 3600 },
        },
        'fixture-token',
      ),
      /Check the previous update result/,
    );
    assert.equal(requests, 0);
  } finally {
    store.close();
  }
});

test('schema-two restore keeps later account identities needed for unfinished updates', async (t) => {
  const f = fixture(t);
  queryFile(f.backupFile, (database) =>
    database.exec(
      'DROP TABLE marketplace_changes; DROP TABLE marketplace_listings; DROP TABLE marketplace_accounts; PRAGMA user_version = 2;',
    ),
  );
  const manifest = JSON.parse(readFileSync(`${f.backupFile}.json`, 'utf8'));
  writeFileSync(`${f.backupFile}.json`, JSON.stringify({ ...manifest, schemaVersion: 2 }));
  const current = marketplaceData('added-after-backup');
  const store = new Store(f.destination, 'live');
  try {
    store.updateMarketplace((data, state) => {
      state.accounts.push({
        id: 'added-after-backup',
        name: 'Later seller',
        marketplace: 'flipkart',
        status: 'not-connected',
      });
      Object.assign(data, current);
    });
  } finally {
    store.close();
  }
  await restorePilotBackup(restoreOptions(f));
  const restored = queryFile(f.destination, readMarketplace);
  assert.equal(restored.accounts[0].id, 'added-after-backup');
  assert.equal(restored.accounts[0].sellerId, current.accounts[0].sellerId);
  assert.equal(restored.listings[0].accountId, 'added-after-backup');
  assert.equal(restored.listings[0].observedAt, null);
  assert.equal(restored.changes[0].state, 'uncertain');
  assert.ok(
    queryFile(f.destination, readSnapshot).accounts.some((row) => row.id === 'added-after-backup'),
  );
});

test('old editors remain stale after restore and fresh import for existing and newer listings', async (t) => {
  for (const includedInBackup of [true, false]) {
    await t.test(
      includedInBackup ? 'older listing version' : 'listing added after backup',
      async (nested) => {
        const f = fixture(nested);
        const current = marketplaceData(f.local.accounts[0].id);
        current.changes = [];
        current.listings[0].version = 3;
        current.listings[0].locations[0].status = 'ENABLED';
        queryFile(f.destination, (database) => writeMarketplace(database, current));
        const backup = structuredClone(current);
        backup.listings[0].version = 1;
        if (!includedInBackup) backup.listings = [];
        queryFile(f.backupFile, (database) => writeMarketplace(database, backup));
        await restorePilotBackup(restoreOptions(f));
        const recovered = queryFile(f.destination, readMarketplace).listings[0];
        assert.equal(recovered.version, 4);
        assert.equal(recovered.observedAt, null);

        const remote = structuredClone(current.listings[0]);
        remote.locations[0].quantity = 1;
        remote.observedAt = new Date().toISOString();
        let writes = 0;
        const status = async (): Promise<FlipkartConnectionStatus> => ({
          state: 'verified',
          applicationIdHint: 'fixture',
          checkedAt: null,
          expiresAt: null,
          message: 'Fixture access',
        });
        const store = new Store(f.destination, 'live');
        const service = new MarketplaceService(store, f.dataDirectory, {
          createConnection: () => ({
            status,
            save: status,
            connect: status,
            check: status,
            disconnect: status,
            getAccessToken: async () => 'fixture-token',
            stop() {},
            async idle() {},
          }),
          client: {
            listListings: async () => [structuredClone(remote)],
            getListing: async (_token, listing) => ({
              ...structuredClone(remote),
              version: listing.version,
            }),
            async updateStock() {
              writes++;
            },
            async updatePrice() {
              writes++;
            },
          },
        });
        try {
          await service.refresh(remote.accountId);
          const refreshed = service.page(new URLSearchParams({ accountId: remote.accountId }))
            .listings[0];
          assert.equal(refreshed.version, 5);
          assert.equal(refreshed.locations[0].quantity, 1);
          await assert.rejects(
            service.apply({
              accountId: remote.accountId,
              listingId: remote.id,
              version: 3,
              edit: { kind: 'stock', locationId: 'warehouse-1', quantity: 4, automation: 'once' },
            }),
            /listing has changed/,
          );
          assert.equal(writes, 0);
        } finally {
          service.stop();
          await service.idle();
          store.close();
        }
      },
    );
  }
});

test('conflicting seller bindings refuse restore and retain the current marketplace records', async (t) => {
  const f = fixture(t);
  const current = marketplaceData(f.local.accounts[0].id, 'current-seller');
  queryFile(f.destination, (database) => writeMarketplace(database, current));
  queryFile(f.backupFile, (database) =>
    writeMarketplace(database, marketplaceData(f.saved.accounts[0].id, 'backup-seller')),
  );
  await assert.rejects(
    restorePilotBackup(restoreOptions(f)),
    /conflicts with a current marketplace seller binding/,
  );
  assert.deepEqual(queryFile(f.destination, readMarketplace), current);
  assert.deepEqual(queryFile(f.destination, readSnapshot), f.local);
});

test('restore refuses to remove a newer hold or reopen a consumed sales allowance', async (t) => {
  for (const policy of ['hold', 'limited', 'missing-destination'] as const) {
    await t.test(policy, async (nested) => {
      const f = fixture(nested, 'demo');
      const store = new Store(f.destination, 'demo');
      let current;
      try {
        store.update((state) => {
          const listing = state.listings[0];
          listing.policy = policy === 'limited' ? 'limited' : 'hold';
          listing.remaining = policy === 'limited' ? 0 : null;
          if (policy === 'missing-destination') listing.location = 'newer-location';
        });
        current = store.read();
      } finally {
        store.close();
      }
      await assert.rejects(
        restorePilotBackup(restoreOptions(f)),
        /remove or weaken a current stock restriction.*Reconcile marketplace policies/s,
      );
      assert.deepEqual(queryFile(f.destination, readSnapshot), current);
    });
  }
});

test('restore preserves existing paused destinations and refuses to discard a newer paused destination', async (t) => {
  for (const includedInBackup of [true, false]) {
    await t.test(
      includedInBackup ? 'existing destination' : 'newer destination',
      async (nested) => {
        const f = fixture(nested, 'demo');
        const store = new Store(f.destination, 'demo');
        let current;
        try {
          store.update((state) => {
            const listing = state.listings[0];
            listing.policy = 'auto';
            listing.remaining = null;
            listing.paused = true;
            if (!includedInBackup) listing.location = 'newer-paused-location';
          });
          current = store.read();
        } finally {
          store.close();
        }
        if (includedInBackup) {
          await restorePilotBackup(restoreOptions(f));
          assert.equal(queryFile(f.destination, readSnapshot).listings[0].paused, true);
        } else {
          await assert.rejects(
            restorePilotBackup(restoreOptions(f)),
            /remove a currently paused stock destination.*Reconcile marketplace policies/s,
          );
          assert.deepEqual(queryFile(f.destination, readSnapshot), current);
        }
      },
    );
  }
});

test('a backup manifest must match its database schema and marketplace payloads must validate', (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(readFileSync(`${f.backupFile}.json`, 'utf8'));
  writeFileSync(`${f.backupFile}.json`, JSON.stringify({ ...manifest, schemaVersion: 2 }));
  assert.throws(() => inspectPilotBackup(f.backupFile, 'live'), /does not match its manifest/);
  writeFileSync(`${f.backupFile}.json`, JSON.stringify(manifest));
  queryFile(f.backupFile, (database) => {
    writeMarketplace(database, marketplaceData(f.saved.accounts[0].id));
    database
      .prepare('UPDATE marketplace_changes SET edit = ?')
      .run('{"kind":"stock","quantity":-1}');
  });
  assert.throws(() => inspectPilotBackup(f.backupFile, 'live'), /Invalid stored state/);
});

test('restored sample data can be refreshed locally without changing quantities or saved drafts', async (t) => {
  const f = fixture(t, 'demo');
  await restorePilotBackup(restoreOptions(f));
  const store = new Store(f.destination, 'demo');
  const service = new InventoryService(store, {
    createTallyReader() {
      throw new Error('Sample refresh must not create an external reader.');
    },
  });
  try {
    const before = service.snapshot();
    assert.ok(before.items.every((item) => item.observedAt === null));
    const refreshed = await service.refresh();
    assert.ok(refreshed.items.every((item) => item.observedAt !== null));
    assert.ok(refreshed.companies.every((company) => company.lastSuccess !== null));
    assert.deepEqual(
      refreshed.items.map((item) => item.physical),
      before.items.map((item) => item.physical),
    );
    assert.deepEqual(refreshed.proposals, before.proposals);
    assert.deepEqual(refreshed.listings, before.listings);
    service.edit('demo-a', 'listing-1', 1);
    assert.equal(service.review('demo-a', ['listing-1']).rows[0].problem, null);
    assert.equal(service.snapshot().publishingEnabled, false);
  } finally {
    service.stop();
    store.close();
  }
});

test('the technician command inspects and restores from another working folder with explicit confirmation', (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL('../../../scripts/restore-pilot.mjs', import.meta.url));
  const inspected = spawnSync(
    process.execPath,
    [script, 'inspect', '--backup', f.backupFile, '--mode', 'live'],
    { cwd: tmpdir(), encoding: 'utf8', windowsHide: true },
  );
  assert.equal(inspected.status, 0, inspected.stderr);
  const digest = inspectPilotBackup(f.backupFile, 'live').sha256;
  assert.ok(inspected.stdout.includes(digest));
  assert.match(inspected.stdout, /Preview only/);
  const args = [
    script,
    'restore',
    '--backup',
    f.backupFile,
    '--mode',
    'live',
    '--data-dir',
    f.dataDirectory,
    '--expected-sha256',
    digest,
  ];
  const unconfirmed = spawnSync(process.execPath, args, {
    cwd: tmpdir(),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(unconfirmed.status, 1);
  assert.deepEqual(queryFile(f.destination, readSnapshot), f.local);
  const restored = spawnSync(process.execPath, [...args, '--confirm-replace'], {
    cwd: tmpdir(),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /Offline pilot restore completed/);
  assert.equal(queryFile(f.destination, readSnapshot).items.length, f.saved.items.length);
});
