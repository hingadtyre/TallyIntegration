import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InputError } from '../../src/server/service.js';
import { serverFixture as fixture } from '../support/server-fixture.js';

test('changing Tally address requires each company to be refreshed before its stock can be reviewed', async (t) => {
  const f = fixture(t, 'live', {
    createTallyReader: (endpoint) => ({
      async listCompanies() {
        return [
          { externalId: 'a', name: 'Company A' },
          { externalId: 'b', name: 'Company B' },
        ];
      },
      async readStock() {
        return [
          {
            externalId: 'tyre',
            name: 'Tyre',
            unit: 'tyres',
            physical: endpoint.includes(':9001') ? 12 : 4,
          },
        ];
      },
    }),
  });
  await f.service.refresh();
  f.store.update((state) => {
    state.listings.push({
      id: 'company-b-listing',
      accountId: 'flipkart-primary',
      sku: 'TEST-TYRE',
      title: 'Test tyre',
      location: 'Test location',
      itemId: 'tally:b:tyre',
      packSize: 1,
      packEvidence: 'Fixture metadata',
      verified: true,
      observed: 5,
      observedAt: state.items[0].observedAt,
      policy: 'auto',
      remaining: null,
      paused: false,
      version: 1,
    });
  });
  const initial = f.service.calculate('tally:b', ['company-b-listing']);
  const equivalent = f.service.settings({
    ...initial.settings,
    tallyUrl: 'http://localhost:9000',
    tallySeconds: 45,
  });
  assert.deepEqual(equivalent.items, initial.items);
  assert.deepEqual(equivalent.companies, initial.companies);

  const changed = f.service.settings({
    ...equivalent.settings,
    tallyUrl: 'http://127.0.0.1:9001/',
  });
  assert.ok(changed.items.every((item) => item.observedAt === null && item.physical === 4));
  assert.ok(changed.companies.every((company) => company.lastSuccess === null));
  assert.deepEqual(changed.listings, initial.listings);
  assert.equal(changed.proposals[0].quantity, 5);
  assert.equal(changed.proposals[0].stale, true);
  f.reopen();
  const partial = await f.service.refresh('tally:a');
  assert.equal(partial.connection.tally, 'online');
  assert.equal(partial.items.find((item) => item.companyId === 'tally:a')!.physical, 12);
  assert.equal(partial.items.find((item) => item.companyId === 'tally:b')!.observedAt, null);
  assert.throws(() => f.service.calculate('tally:b', ['company-b-listing']), InputError);
  assert.throws(() => f.service.calculate('tally:b', ['company-b-listing'], true), InputError);
  assert.throws(() => f.service.edit('tally:b', 'company-b-listing', 0), InputError);
  assert.ok(f.service.review('tally:b', ['company-b-listing']).rows[0].problem);
  assert.deepEqual(f.service.snapshot(), partial);

  await f.service.refresh('tally:b');
  const verified = f.service.calculate('tally:b', ['company-b-listing']);
  assert.equal(verified.proposals[0].quantity, 12);
  assert.equal(verified.proposals[0].stale, false);
  assert.equal(f.service.review('tally:b', ['company-b-listing']).rows[0].problem, null);
});

test('malformed settings, unsafe source addresses and invalid intervals leave the saved state intact', (t) => {
  const f = fixture(t);
  const before = f.service.snapshot();
  const settings = before.settings;
  for (const input of [
    null,
    [],
    {},
    { ...settings, tallyUrl: 'https://example.com/' },
    { ...settings, tallyUrl: 'http://user:password@localhost:9000/' },
    { ...settings, tallyUrl: 'http://localhost:9000/path' },
    { ...settings, tallySeconds: '30' },
    { ...settings, tallySeconds: 30.5 },
    { ...settings, marketplaceSeconds: 86_401 },
    { ...settings, catalogSeconds: Number.NaN },
    { ...settings, backupFolder: 'relative-backups' },
    { ...settings, backupFolder: '' },
  ]) {
    assert.throws(() => f.service.settings(input), InputError);
    assert.deepEqual(f.service.snapshot(), before);
  }
});

test('equivalent local source addresses preserve drafts and folder validation leaves no probe files', (t) => {
  const f = fixture(t);
  f.service.edit('demo-a', 'listing-1', 1);
  const saved = f.service.snapshot();
  const backupFolder = join(f.folder, 'validated-backups');
  const result = f.service.settings({
    ...saved.settings,
    tallyUrl: 'http://localhost:9000',
    tallySeconds: 86_400,
    marketplaceSeconds: 86_400,
    catalogSeconds: 86_400,
    backupFolder,
  });
  assert.equal(result.settings.tallyUrl, 'http://127.0.0.1:9000/');
  assert.deepEqual(result.proposals, saved.proposals);
  assert.deepEqual(readdirSync(backupFolder), []);
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
