import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { instanceResponds, parseRuntimeRecord, runLauncher } from '../../src/desktop/launcher.js';
import { storageFixture } from '../support/server-fixture.js';

const record = {
  application: 'stockbridge',
  mode: 'live',
  version: '0.1.0',
  instanceId: '8795dac2-c5ba-4526-bac6-03e1e010265b',
  pid: 123,
  url: 'http://127.0.0.1:4310',
  token: 'a'.repeat(64),
};

test('status does not declare shutdown complete while its runtime record still exists', async (t) => {
  const fixture = storageFixture(t);
  writeFileSync(join(fixture.directory, 'live.runtime.json'), JSON.stringify(record));
  const previous = process.env.STOCKBRIDGE_DATA_DIR;
  process.env.STOCKBRIDGE_DATA_DIR = fixture.directory;
  t.after(() => {
    if (previous === undefined) delete process.env.STOCKBRIDGE_DATA_DIR;
    else process.env.STOCKBRIDGE_DATA_DIR = previous;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('HTTP listener already closed');
  });
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  await runLauncher('status', { packageRoot: fixture.directory, openBrowser: false });
  assert.match(lines[0], /not responding or is still stopping/);
  assert.match(lines[0], /Do not update/);
  assert.ok(!lines.join('\n').includes('is not running.'));
});

test('desktop control only accepts a complete local live-instance record', () => {
  assert.deepEqual(parseRuntimeRecord(record), record);
  for (const change of [
    { application: 'other' },
    { mode: 'demo' },
    { url: 'https://untrusted.example' },
    { url: 'http://127.0.0.1:4311' },
    { token: 'short' },
    { token: 'a'.repeat(64) + '\n' },
    { instanceId: '' },
    { pid: -1 },
  ]) {
    assert.throws(() => parseRuntimeRecord({ ...record, ...change }), /Invalid application status/);
  }
});

test('desktop health checks require the exact application, mode and instance without sending its token', async (t) => {
  let health: unknown = record;
  const request = t.mock.fn<typeof fetch>(async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:4310/api/health');
    assert.equal(options?.headers, undefined);
    assert.equal(options?.redirect, 'error');
    return Response.json(health);
  });
  assert.equal(await instanceResponds(parseRuntimeRecord(record), request), true);
  for (const change of [
    { instanceId: 'another-instance' },
    { application: 'unrelated-listener' },
    { mode: 'demo' },
  ]) {
    health = { ...record, ...change };
    assert.equal(await instanceResponds(parseRuntimeRecord(record), request), false);
  }
});

test('unreachable or malformed health responses are never treated as a running instance', async (t) => {
  const responses: (Response | Error)[] = [
    new Error('Connection refused'),
    new Response('Starting', { status: 503 }),
    new Response('<html>Unrelated page</html>'),
  ];
  const request = t.mock.fn<typeof fetch>(async () => {
    const result = responses.shift()!;
    if (result instanceof Error) throw result;
    return result;
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(await instanceResponds(parseRuntimeRecord(record), request), false);
  }
});
