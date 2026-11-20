import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../../../src/shared/contracts.js';
import { initialState } from '../../../src/server/seed.js';
import { InvalidStoredState } from '../../../src/server/storage/validation.js';
import { createSchema, CURRENT_SCHEMA_VERSION } from '../../../src/server/storage/schema.js';
import { readSnapshot, writeSnapshot } from '../../../src/server/storage/records.js';
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
  assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
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
    assert.equal(
      database.prepare('PRAGMA user_version').get()?.user_version,
      CURRENT_SCHEMA_VERSION,
    );
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

function createVersionTwo(file: string, state: Snapshot): void {
  const database = new DatabaseSync(file);
  try {
    createSchema(database, 6);
    writeSnapshot(database, state);
    database.exec(
      'DROP TABLE stock_coverage_orders; DROP TABLE stock_coverage; DROP TABLE billing_links; DROP TABLE billing_rules; DROP TABLE listing_pack_settings; DROP TABLE marketplace_changes; DROP TABLE marketplace_listings; DROP TABLE marketplace_accounts; PRAGMA user_version = 2;',
    );
  } finally {
    database.close();
  }
}

test('schema four upgrades retain the stock mapping and start billing unconfigured', (t) => {
  const f = fixture(t);
  const original = legacyState(f.directory);
  queryFile(f.file, (db) => {
    createSchema(db, 6);
    writeSnapshot(db, original);
    db.exec(
      'DROP TABLE stock_coverage_orders; DROP TABLE stock_coverage; DROP TABLE billing_links; DROP TABLE billing_rules; PRAGMA user_version = 4;',
    );
  });
  const store = f.open();
  assert.deepEqual(store.read(), original);
  assert.deepEqual(store.readBilling(), { rules: [], links: [] });
  assert.ok(store.migrationBackupPath);
  queryFile(store.migrationBackupPath, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 4);
    assert.deepEqual(readSnapshot(db), original);
  });
});

test('version three mapping records migrate without opting live records into calculated publication', (t) => {
  const f = fixture(t);
  const original = legacyState(f.directory);
  queryFile(f.file, (db) => {
    createSchema(db, 6);
    writeSnapshot(db, original);
    db.exec(
      'DROP TABLE stock_coverage_orders; DROP TABLE stock_coverage; DROP TABLE billing_links; DROP TABLE billing_rules; DROP TABLE listing_pack_settings; PRAGMA user_version = 3',
    );
  });
  const store = f.open();
  assert.deepEqual(store.read(), original);
  assert.ok(store.migrationBackupPath);
  queryFile(store.migrationBackupPath, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 3);
    assert.equal(
      db.prepare("SELECT name FROM sqlite_master WHERE name='listing_pack_settings'").get(),
      undefined,
    );
  });
});

test('version two upgrades preserve all records and a verified version-two safety copy without adopting placeholders', (t) => {
  const f = fixture(t);
  const original = legacyState(f.directory);
  createVersionTwo(f.file, original);
  const store = f.open();
  assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(store.read(), original);
  assert.deepEqual(store.readMarketplace(), { accounts: [], listings: [], changes: [] });
  assert.ok(store.migrationBackupPath);
  queryFile(store.migrationBackupPath, (database) => {
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.deepEqual(readSnapshot(database), original);
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'marketplace_accounts'").get(),
      undefined,
    );
  });
  assert.equal(f.open().migrationBackupPath, null);
  assert.equal(readdirSync(join(f.directory, 'migration-backups')).length, 1);
});

test('schema five preserves saved billing setup and leaves the stock baseline unconfirmed', (t) => {
  const f = fixture(t);
  const original = legacyState(f.directory);
  const companyId = original.companies[0].id;
  const accountId = original.accounts[0].id;
  queryFile(f.file, (db) => {
    createSchema(db, 6);
    writeSnapshot(db, original);
    db.prepare('INSERT INTO billing_rules VALUES (?, ?, ?, ?, ?, ?)').run(
      companyId,
      accountId,
      'ledger',
      'Seller sales',
      'reference',
      'orderItemId',
    );
    db.prepare('INSERT INTO billing_links VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      companyId,
      accountId,
      'order',
      'bill',
      'item',
      'ledger',
      'fingerprint',
    );
    db.exec('DROP TABLE stock_coverage_orders; DROP TABLE stock_coverage; PRAGMA user_version = 5');
  });
  const store = f.open();
  assert.ok(store.migrationBackupPath);
  assert.equal(store.readBilling().rules[0].ledgerId, 'ledger');
  assert.equal(store.readBilling().links[0].billId, 'bill');
  assert.equal(store.readStockCoverage(companyId), null);
  assert.deepEqual(store.read(), original);
});

test('upgrading a version-seven live company retains its last read and requires a fresh check on restart', (t) => {
  const f = fixture(t);
  const state = initialState('live', join(f.directory, 'backups'));
  const lastSuccess = '2026-11-07T08:00:00.000Z';
  state.companies.push({
    id: 'tally:a',
    name: 'Company A',
    source: 'tally',
    automation: false,
    lastSuccess,
  });
  queryFile(f.file, (db) => {
    createSchema(db, 7);
    db.exec('PRAGMA user_version = 7');
    writeSnapshot(db, state);
  });
  const store = f.open('live');
  assert.ok(store.migrationBackupPath);
  assert.deepEqual(store.read().companies, [{ ...state.companies[0], stockIssue: 'not-checked' }]);
  assert.equal(f.open('live').read().companies[0].lastSuccess, lastSuccess);
});

test('upgrading schema nine retains paused listings and drafts and can persist a later calculation issue', (t) => {
  const f = fixture(t);
  const state = legacyState(f.directory);
  queryFile(f.file, (db) => {
    createSchema(db, 9);
    db.exec('PRAGMA user_version = 9');
    writeSnapshot(db, state);
  });
  const store = f.open();
  assert.equal(store.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.ok(store.migrationBackupPath);
  assert.deepEqual(store.read(), state);
  queryFile(store.migrationBackupPath, (db) => {
    assert.equal(db.prepare('PRAGMA user_version').get()?.user_version, 9);
    assert.deepEqual(readSnapshot(db), state);
  });
  const reason = 'Refresh stock for this company to calculate the proposal.';
  store.update((saved) => {
    saved.listings[1].proposalIssue = reason;
  });
  const reopened = f.open();
  assert.equal(reopened.read().listings[1].proposalIssue, reason);
  assert.equal(reopened.migrationBackupPath, null);
});

test('existing out-of-stock holds become paused exactly once, retaining stock and invalidating their drafts', (t) => {
  const f = fixture(t);
  const state = legacyState(f.directory);
  const listing = state.listings[0];
  listing.observed = 3;
  listing.syncPendingItemVersion = 4;
  listing.orderSyncPending = 'sale-to-check';
  state.proposals[0].stale = false;
  const allowance = state.listings[1];
  allowance.policy = 'limited';
  allowance.remaining = 0;
  queryFile(f.file, (db) => {
    createSchema(db, 8);
    db.exec('PRAGMA user_version = 8');
    writeSnapshot(db, state);
    db.prepare("UPDATE listings SET policy = 'hold', paused = 0 WHERE id = ?").run(listing.id);
  });
  const store = f.open();
  const converted = store.read();
  assert.equal(converted.listings[0].policy, 'auto');
  assert.equal(converted.listings[0].remaining, null);
  assert.equal(converted.listings[0].paused, true);
  assert.equal(converted.listings[0].observed, 3);
  assert.equal(converted.listings[0].observedAt, listing.observedAt);
  assert.equal(converted.listings[0].version, listing.version + 1);
  assert.equal(converted.listings[0].syncPendingItemVersion, null);
  assert.equal(converted.listings[0].orderSyncPending, undefined);
  assert.deepEqual(converted.proposals, [{ ...state.proposals[0], stale: true }]);
  assert.deepEqual(converted.listings[1], allowance);
  assert.deepEqual(store.readMarketplace().changes, []);
  assert.ok(store.migrationBackupPath);
  queryFile(store.migrationBackupPath, (db) =>
    assert.equal(
      db.prepare('SELECT policy FROM listings WHERE id = ?').get(listing.id)?.policy,
      'hold',
    ),
  );
  const reopened = f.open();
  assert.equal(reopened.migrationBackupPath, null);
  assert.deepEqual(reopened.read(), converted);
});

test('version-one JSON holds migrate to pauses while preserving a seller draft for review', (t) => {
  const f = fixture(t);
  const state = legacyState(f.directory);
  const previous = {
    ...state,
    listings: [{ ...state.listings[0], policy: 'hold', paused: false }, ...state.listings.slice(1)],
  };
  createLegacy(f.file, previous);
  const converted = f.open().read();
  assert.equal(converted.listings[0].policy, 'auto');
  assert.equal(converted.listings[0].paused, true);
  assert.equal(converted.listings[0].version, state.listings[0].version + 1);
  assert.deepEqual(converted.proposals, state.proposals);
});

test('a version-two migration failure rolls back new tables and preserves its pre-upgrade backup', (t) => {
  const f = fixture(t);
  const original = legacyState(f.directory);
  createVersionTwo(f.file, original);
  queryFile(f.file, (database) =>
    database.exec('CREATE TABLE marketplace_listings (retained TEXT);'),
  );
  assert.throws(() => f.open(), /already exists/);
  queryFile(f.file, (database) => {
    assert.equal(database.prepare('PRAGMA user_version').get()?.user_version, 2);
    assert.deepEqual(readSnapshot(database), original);
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'marketplace_accounts'").get(),
      undefined,
    );
  });
  assert.equal(readdirSync(join(f.directory, 'migration-backups')).length, 1);
});

test('schema six keeps observed orders and treats every older uncertain request as lacking proof', (t) => {
  const f = fixture(t);
  const state = legacyState(f.directory);
  const { id: companyId } = state.companies[0];
  const { id: accountId } = state.accounts[0];
  const from = '2026-11-18T18:30:00.000Z';
  const order = {
    orderItemId: 'previous-line',
    orderId: 'O1',
    sku: 'A',
    listingId: 'L',
    locationId: 'W',
    orderDate: from,
    invoiceNumber: null,
    quantity: 1,
  };
  queryFile(f.file, (db) => {
    createSchema(db, 6);
    writeSnapshot(db, state);
    db.exec('PRAGMA user_version = 6');
    db.prepare('INSERT INTO stock_coverage VALUES (?, ?, ?, ?)').run(
      companyId,
      from,
      'confirmed',
      from,
    );
    db.prepare('INSERT INTO stock_coverage_orders VALUES (?, ?, ?, ?)').run(
      companyId,
      accountId,
      order.orderItemId,
      JSON.stringify(order),
    );
    db.prepare('INSERT INTO marketplace_accounts VALUES (?, ?, ?, ?, ?)').run(
      accountId,
      'Seller',
      'owner',
      from,
      0,
    );
    db.prepare('INSERT INTO marketplace_changes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'old-attempt',
      accountId,
      'L',
      'A',
      'uncertain',
      JSON.stringify({ kind: 'stock', quantity: 5, locationId: 'W', automation: 'once' }),
      'Original outcome unknown',
      from,
      from,
      0,
    );
  });
  const store = f.open();
  assert.ok(store.migrationBackupPath);
  assert.deepEqual(store.readStockCoverage(companyId)?.orders, [{ accountId, order }]);
  const change = store.readMarketplace().changes[0];
  assert.equal(change.state, 'uncertain');
  assert.equal(change.stockRequestFinality, undefined);
  const coverage = store.readStockCoverage(companyId)!;
  coverage.orders[0].order.stockSyncQueued = true;
  assert.throws(
    () =>
      store.saveStockCoverage(coverage, () => {
        throw new Error('interrupted');
      }),
    /interrupted/,
  );
  assert.equal(store.readStockCoverage(companyId)?.orders[0].order.stockSyncQueued, undefined);
  store.saveStockCoverage(coverage, (current) => {
    current.listings[0].orderSyncPending = 'new-sale';
  });
  const reopened = f.open();
  assert.equal(reopened.readStockCoverage(companyId)?.orders[0].order.stockSyncQueued, true);
  assert.equal(reopened.read().listings[0].orderSyncPending, 'new-sale');
  assert.equal(reopened.read().listings[0].tyreFloor, state.listings[0].tyreFloor);
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
