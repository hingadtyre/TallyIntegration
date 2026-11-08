import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readSnapshot } from '../../src/server/storage/records.js';
import { serverFixture as fixture } from '../support/server-fixture.js';

test('manual backups use the current folder and preserve previous copies', (t) => {
  const f = fixture(t);
  const first = f.service.backup();
  const oldBytes = readFileSync(first.path);
  const destination = join(f.folder, 'next-backups');
  f.service.settings({ ...f.service.snapshot().settings, backupFolder: destination });
  const second = f.service.backup();
  const third = f.service.backup();
  assert.equal(dirname(second.path), destination);
  assert.notEqual(second.path, third.path);
  assert.deepEqual(readFileSync(first.path), oldBytes);
  const manifest = JSON.parse(readFileSync(`${second.path}.json`, 'utf8'));
  assert.equal(manifest.mode, 'demo');
  assert.equal(manifest.schemaVersion, f.store.schemaVersion);
  assert.equal(manifest.verified, true);
  assert.ok(Number.isFinite(Date.parse(manifest.createdAt)));
  assert.equal(f.service.snapshot().activity[0].operation, 'backup');
});

test('a destination that becomes unavailable does not report a backup or change saved inventory', (t) => {
  const f = fixture(t);
  const blocked = join(f.folder, 'blocked-backups');
  f.store.update((state) => {
    state.settings.backupFolder = blocked;
  });
  writeFileSync(blocked, 'retained fixture file');
  const before = f.service.snapshot();
  assert.throws(() => f.service.backup());
  assert.deepEqual(f.service.snapshot(), before);
  assert.equal(readFileSync(blocked, 'utf8'), 'retained fixture file');
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
  assert.equal(manifest.restoreSupported, true);
  assert.equal(manifest.restoreScope, 'offline-pilot-only');
});
