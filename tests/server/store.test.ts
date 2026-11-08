import assert from 'node:assert/strict';
import test from 'node:test';
import { queryFile, storageFixture as fixture } from '../support/server-fixture.js';

test('a new live workspace is empty and a reopened workspace requires fresh source verification', (t) => {
  const f = fixture(t);
  const store = f.open('live');
  const initial = store.read();
  assert.deepEqual(initial.companies, []);
  assert.deepEqual(initial.items, []);
  assert.deepEqual(initial.listings, []);
  assert.deepEqual(initial.proposals, []);
  assert.equal(initial.publishingEnabled, false);
  assert.equal(initial.accounts[0].status, 'not-connected');
  assert.equal(initial.accounts[0].name, 'Flipkart seller');
  store.update((state) => {
    state.settings.tallySeconds = 45;
    state.connection.tally = 'online';
    state.connection.nextPoll = new Date().toISOString();
  });
  const reopened = f.open('live').read();
  assert.equal(reopened.settings.tallySeconds, 45);
  assert.equal(reopened.connection.tally, 'not-checked');
  assert.equal(reopened.connection.nextPoll, null);
});

test('opening an existing live workspace preserves its saved seller identity', (t) => {
  const f = fixture(t);
  const store = f.open('live');
  store.update((state) => {
    state.accounts[0].name = 'HINGADTYRES';
  });
  const reopened = f.open('live').read();
  assert.deepEqual(reopened.accounts, store.read().accounts);
  assert.equal(reopened.accounts[0].name, 'HINGADTYRES');
});

test('a thrown update rolls back all changes and later valid commands still commit', (t) => {
  const f = fixture(t);
  const store = f.open();
  const before = store.read();
  const failure = new Error('Fixture command failed.');
  assert.throws(
    () =>
      store.update((state) => {
        state.items[0].physical = 99;
        state.settings.tallySeconds = 45;
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.deepEqual(store.read(), before);
  const result = store.update((state) => {
    state.items[0].physical = 3;
    return 'committed';
  });
  assert.equal(result, 'committed');
  assert.equal(store.read().items[0].physical, 3);
  assert.equal(store.read().settings.tallySeconds, before.settings.tallySeconds);
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
