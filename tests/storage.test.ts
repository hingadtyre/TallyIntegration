import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Snapshot } from '../src/shared/contracts.js';
import { initialState } from '../src/server/seed.js';
import { Store } from '../src/server/store.js';
import { readSnapshot } from '../src/server/storage/records.js';
import { InvalidStoredState } from '../src/server/storage/validation.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'stockbridge-storage-'));
  const file = join(directory, 'state.sqlite');
  const stores: Store[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    const target = resolve(directory);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('stockbridge-storage-')
    ) {
      throw new Error('Refusing to remove a path outside this storage test fixture.');
    }
    rmSync(target, { recursive: true, force: true });
  });
  return {
    directory,
    file,
    open(mode: Snapshot['mode'] = 'demo') {
      const store = new Store(file, mode);
      stores.push(store);
      return store;
    },
  };
}

function legacyState(directory: string): Snapshot {
  const state = initialState('demo', join(directory, 'customer-backups'));
  state.listings[0].policy = 'limited';
  state.listings[0].remaining = 0;
  state.listings[0].paused = true;
  state.proposals.push({
    listingId: state.listings[0].id,
    quantity: 1,
    calculated: 5,
    edited: true,
    itemVersion: -1,
    listingVersion: 1,
    ruleVersion: 'flipkart-tyres-v1',
    createdAt: '2026-11-07T08:00:00.000Z',
    stale: true,
  });
  state.activity.push(
    {
      id: 'event-newer',
      at: '2026-11-07T08:00:00.000Z',
      level: 'info',
      operation: 'edit-proposal',
      message: 'A seller draft was retained.',
      companyId: 'demo-a',
      listingId: 'listing-1',
    },
    {
      id: 'event-older',
      at: '2026-11-06T08:00:00.000Z',
      level: 'warning',
      operation: 'mapping-removed',
      message: 'Historical references may outlive managed records.',
      companyId: 'removed-company',
      listingId: 'removed-listing',
    },
  );
  state.settings.tallySeconds = 45;
  return state;
}

function createLegacy(file: string, value: unknown): void {
  const database = new DatabaseSync(file);
  try {
    database.exec(
      'CREATE TABLE app_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL); PRAGMA user_version = 1;',
    );
    database
      .prepare('INSERT INTO app_state VALUES (1, ?)')
      .run(typeof value === 'string' ? value : JSON.stringify(value));
  } finally {
    database.close();
  }
}

function queryFile<T>(file: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file);
  try {
    return read(database);
  } finally {
    database.close();
  }
}

test('legacy migration preserves policies, drafts, identities and history with a verified safety copy', (t) => {
  const f = fixture(t);
  const original = legacyState(f.directory);
  createLegacy(f.file, original);
  const store = f.open();
  assert.equal(store.schemaVersion, 2);
  assert.deepEqual(store.read(), original);
  assert.ok(store.migrationBackupPath);
  assert.ok(existsSync(store.migrationBackupPath));
  queryFile(store.migrationBackupPath, (copy) => {
    assert.equal(copy.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 1);
    const value = copy.prepare('SELECT data FROM app_state WHERE id = 1').get()?.data;
    assert.equal(typeof value, 'string');
    assert.deepEqual(JSON.parse(value as string), original);
  });
  queryFile(f.file, (database) => {
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'app_state'").get(),
      undefined,
    );
    assert.equal(
      database.prepare('SELECT remaining FROM listings WHERE id = ?').get('listing-1')?.remaining,
      0,
    );
    assert.equal(
      database.prepare('SELECT count(*) AS count FROM stock_items').get()?.count,
      original.items.length,
    );
    assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
  const reopened = f.open();
  assert.equal(reopened.migrationBackupPath, null);
  assert.deepEqual(reopened.read(), original);
  assert.equal(readdirSync(join(f.directory, 'migration-backups')).length, 1);
});

test('invalid legacy data is rejected before changing or backing up the source', (t) => {
  const f = fixture(t);
  const invalid = legacyState(f.directory);
  invalid.listings[0].accountId = 'missing-account';
  createLegacy(f.file, invalid);
  const before = readFileSync(f.file);
  assert.throws(() => f.open(), InvalidStoredState);
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(existsSync(join(f.directory, 'migration-backups')), false);
  queryFile(f.file, (database) => {
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'listings'").get(),
      undefined,
    );
  });
});

test('malformed JSON and unknown future versions fail without rewriting the source', (t) => {
  const f = fixture(t);
  createLegacy(f.file, '{broken-json');
  const malformed = readFileSync(f.file);
  assert.throws(() => f.open(), /valid JSON/);
  assert.deepEqual(readFileSync(f.file), malformed);
  queryFile(f.file, (database) => database.exec('PRAGMA user_version = 99'));
  const future = readFileSync(f.file);
  assert.throws(() => f.open(), /newer application/);
  assert.deepEqual(readFileSync(f.file), future);
});

test('a migration failure rolls back new tables and leaves the original schema readable', (t) => {
  const f = fixture(t);
  const original = legacyState(f.directory);
  createLegacy(f.file, original);
  // Simulate an unexpected pre-existing table: creation fails after the first
  // statements, exercising rollback of schema changes rather than only validation.
  queryFile(f.file, (database) => database.exec('CREATE TABLE companies (original_value TEXT);'));
  assert.throws(() => f.open(), /already exists/);
  queryFile(f.file, (database) => {
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'app_metadata'").get(),
      undefined,
    );
    assert.equal(
      database.prepare('SELECT data FROM app_state WHERE id = 1').get()?.data,
      JSON.stringify(original),
    );
  });
  assert.equal(readdirSync(join(f.directory, 'migration-backups')).length, 1);
});

test('an unavailable safety-backup directory prevents migration', (t) => {
  const f = fixture(t);
  createLegacy(f.file, legacyState(f.directory));
  writeFileSync(join(f.directory, 'migration-backups'), 'This is a file, not a directory.');
  assert.throws(() => f.open());
  queryFile(f.file, (database) => {
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 1);
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'app_metadata'").get(),
      undefined,
    );
  });
});

test('invalid relationships and workspace-mode changes roll back the entire command', (t) => {
  const f = fixture(t);
  const store = f.open();
  const before = store.read();
  assert.throws(
    () =>
      store.update((state) => {
        state.settings.tallySeconds = 90;
        state.listings[0].itemId = 'missing-item';
      }),
    /missing stock item/,
  );
  assert.deepEqual(store.read(), before);
  assert.throws(
    () =>
      store.update((state) => {
        state.mode = 'live';
      }),
    /workspace mode/,
  );
  assert.deepEqual(store.read(), before);
  assert.throws(() => f.open('live'), /separate databases/);
  queryFile(f.file, (database) => {
    database.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () =>
        database
          .prepare('UPDATE listings SET account_id = ? WHERE id = ?')
          .run('missing', 'listing-1'),
      /FOREIGN KEY/,
    );
    assert.throws(
      () => database.prepare('UPDATE listings SET id = NULL WHERE id = ?').run('listing-1'),
      /NOT NULL/,
    );
  });
});

test('two stores read committed records before applying a command', (t) => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  first.update((state) => {
    state.items[0].physical = 3;
    state.items[0].version++;
  });
  second.update((state) => {
    state.settings.tallySeconds = 45;
  });
  assert.equal(first.read().settings.tallySeconds, 45);
  assert.equal(second.read().items[0].physical, 3);
  const detached = second.read();
  detached.items[0].physical = 999;
  assert.equal(second.read().items[0].physical, 3);
});

test('a local setting change and prepended activity leave unrelated records untouched', (t) => {
  const f = fixture(t);
  const store = f.open();
  const oldEvent = {
    id: 'old',
    at: '2026-11-06T08:00:00.000Z',
    level: 'info' as const,
    operation: 'test',
    message: 'Old event',
  };
  store.update((state) => {
    state.activity.push(oldEvent);
  });
  queryFile(f.file, (database) => {
    database.exec(`
      CREATE TRIGGER protect_stock BEFORE UPDATE ON stock_items BEGIN
        SELECT RAISE(ABORT, 'Unrelated stock record was rewritten'); END;
      CREATE TRIGGER protect_old_event BEFORE UPDATE ON activity WHEN OLD.id = 'old' BEGIN
        SELECT RAISE(ABORT, 'Existing history was rewritten'); END;
    `);
  });
  store.update((state) => {
    state.settings.tallySeconds = 45;
    state.activity.unshift({
      ...oldEvent,
      id: 'new',
      at: '2026-11-07T08:00:00.000Z',
      message: 'New event',
    });
  });
  assert.deepEqual(
    store.read().activity.map((event) => event.id),
    ['new', 'old'],
  );
  assert.equal(store.read().settings.tallySeconds, 45);
});

test('v2 backups preserve normalized records and remain independently readable', (t) => {
  const f = fixture(t);
  const store = f.open();
  store.update((state) => {
    state.listings[0].paused = true;
  });
  const expected = store.read();
  const backup = join(f.directory, 'manual.sqlite');
  store.backup(backup);
  queryFile(backup, (copy) => {
    assert.equal(copy.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.equal(copy.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.deepEqual(readSnapshot(copy), expected);
  });
});
