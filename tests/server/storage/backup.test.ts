import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSnapshot } from '../../../src/server/storage/records.js';
import { queryFile, storageFixture as fixture } from '../../support/server-fixture.js';

test('a backup destination containing an apostrophe works and existing copies are not overwritten', (t) => {
  const f = fixture(t);
  const store = f.open();
  const backup = join(f.directory, "seller's backups", 'inventory.sqlite');
  store.backup(backup);
  const original = readFileSync(backup);
  store.update((state) => {
    state.items[0].physical = 99;
  });
  assert.throws(() => store.backup(backup), /already exists/);
  assert.deepEqual(readFileSync(backup), original);
  assert.equal(store.read().items[0].physical, 99);
  queryFile(backup, (copy) => assert.equal(readSnapshot(copy).items[0].physical, 4));
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
