import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../../../src/shared/contracts.js';
import { initialState } from '../../../src/server/seed.js';
import { InvalidStoredState } from '../../../src/server/storage/validation.js';
import { queryFile, storageFixture as fixture } from '../../support/server-fixture.js';

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
