import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  instanceResponds,
  parseRuntimeRecord,
  runLauncher,
  waitForDashboard,
} from '../../src/desktop/launcher.js';
import { spawnSync } from 'node:child_process';
import { acquireWorkspaceOwnership } from '../../src/server/runtime.js';
import { WorkspaceInUseError } from '../../src/server/workspace-in-use.js';
import { liveDashboardPort } from '../../src/shared/dashboard-port.js';
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

test('the dashboard port override accepts only a port number', () => {
  assert.equal(liveDashboardPort('51932'), 51932);
  for (const value of ['', '0', '-1', '65536', '123.5', '127.0.0.1:51932', 'https://example.com'])
    assert.throws(() => liveDashboardPort(value), /must be a port number/);
});

test('a slow Windows credential read can still open the dashboard after 20 seconds', async (t) => {
  const fixture = storageFixture(t);
  writeFileSync(join(fixture.directory, 'live.runtime.json'), JSON.stringify(record));
  let reads = 0;
  t.mock.method(Date, 'now', () => (reads++ === 0 ? 0 : 72_000));
  t.mock.method(globalThis, 'fetch', async () => Response.json(record));
  assert.ok(
    await waitForDashboard(
      fixture.directory,
      { pid: record.pid, exitCode: null, signalCode: null },
      true,
    ),
  );
});

test('a second Start waits for the original workspace owner while Upgrade requires its own child', async (t) => {
  const fixture = storageFixture(t);
  const owner = await acquireWorkspaceOwnership(fixture.directory, 'live');
  t.after(() => owner.release());
  const second = spawnSync(process.execPath, ['dist/src/server/main.js'], {
    env: { ...process.env, STOCKBRIDGE_DATA_DIR: fixture.directory },
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(second.status, WorkspaceInUseError.exitCode, second.stderr);
  writeFileSync(join(fixture.directory, 'live.runtime.json'), JSON.stringify(record));
  const times: number[] = [];
  t.mock.method(Date, 'now', () => times.shift() ?? 95_000);
  t.mock.method(globalThis, 'fetch', async () => Response.json(record));
  const child = { pid: record.pid + 1, exitCode: second.status, signalCode: null };
  times.push(0, 72_000);
  assert.equal(await waitForDashboard(fixture.directory, child, false), true);
  times.push(0, 72_000);
  assert.equal(await waitForDashboard(fixture.directory, child, true), false);
  times.push(0, 72_000);
  assert.equal(await waitForDashboard(fixture.directory, { ...child, exitCode: 1 }, false), false);
});

test('an incomplete shortcut selection cannot open a different workspace', (t) => {
  const fixture = storageFixture(t);
  const result = spawnSync(
    process.execPath,
    ['scripts/windows-launcher.mjs', 'start', '--no-browser', '--workspace', 'file:///C:/example'],
    {
      env: { ...process.env, STOCKBRIDGE_DATA_DIR: fixture.directory },
      windowsHide: true,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid launcher arguments/);
});

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
  assert.match(lines.join('\n'), /automatic updates can publish stock to eligible listings/);
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
