import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import {
  acquireWorkspaceOwnership,
  resolveRuntimePaths,
  startRuntime,
} from '../../src/server/runtime.js';
import { close, listen, queryFile } from '../support/server-fixture.js';
import { readSnapshot } from '../../src/server/storage/records.js';
import type { Snapshot } from '../../src/shared/contracts.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'stockbridge-runtime-'));
  const cleanups: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    const target = resolve(directory);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('stockbridge-runtime-')
    ) {
      throw new Error('Refusing to remove a path outside the runtime test fixture.');
    }
    rmSync(target, { recursive: true, force: true });
  });
  return { directory, cleanups };
}

test('runtime paths come from the application location and only accept absolute local data folders', (t) => {
  const f = fixture(t);
  const appRoot = join(f.directory, 'app');
  const moduleUrl = pathToFileURL(join(appRoot, 'dist', 'src', 'server', 'runtime.js')).href;
  assert.deepEqual(resolveRuntimePaths(undefined, moduleUrl), {
    appRoot,
    webRoot: join(appRoot, 'dist', 'web'),
    dataDirectory: join(appRoot, '.data'),
  });
  assert.equal(
    resolveRuntimePaths(join(f.directory, 'separate-data'), moduleUrl).dataDirectory,
    join(f.directory, 'separate-data'),
  );
  for (const value of [
    '',
    'relative-data',
    '\\\\server\\share',
    '//server/share',
    '\\\\?\\C:\\data',
  ]) {
    assert.throws(() => resolveRuntimePaths(value, moduleUrl), /absolute local folder/);
  }
});

test('one process owns a canonical workspace while live and sample modes stay separate', async (t) => {
  const f = fixture(t);
  const first = await acquireWorkspaceOwnership(f.directory, 'demo');
  f.cleanups.push(() => first.release());
  await assert.rejects(
    acquireWorkspaceOwnership(join(f.directory, '.'), 'demo'),
    /already running/,
  );
  if (process.platform === 'win32') {
    await assert.rejects(
      acquireWorkspaceOwnership(f.directory.toUpperCase(), 'demo'),
      /already running/,
    );
  }
  const live = await acquireWorkspaceOwnership(f.directory, 'live');
  f.cleanups.push(() => live.release());
  await first.release();
  const next = await acquireWorkspaceOwnership(f.directory, 'demo');
  f.cleanups.push(() => next.release());
});

test(
  'workspace ownership is released by the operating system after a process terminates',
  { timeout: 15_000 },
  async (t) => {
    const f = fixture(t);
    const runtimeUrl = new URL('../../src/server/runtime.js', import.meta.url).href;
    const code = `import { acquireWorkspaceOwnership } from ${JSON.stringify(runtimeUrl)}; await acquireWorkspaceOwnership(process.argv[1], 'demo'); process.send('owned');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, f.directory], {
      cwd: tmpdir(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += chunk;
    });
    f.cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    });
    await new Promise<void>((accept, reject) => {
      child.once('message', () => accept());
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`Ownership fixture exited ${code}: ${stderr}`)),
      );
    });
    await assert.rejects(acquireWorkspaceOwnership(f.directory, 'demo'), /already running/);
    child.kill();
    await once(child, 'exit');
    const recovered = await acquireWorkspaceOwnership(f.directory, 'demo');
    f.cleanups.push(() => recovered.release());
  },
);

test('health identifies this instance and authenticated shutdown removes only its runtime record', async (t) => {
  const f = fixture(t);
  const runtime = await startRuntime({ mode: 'demo', dataDirectory: f.directory, port: 0 });
  f.cleanups.push(() => runtime.stop());
  const runtimeFile = join(f.directory, 'demo.runtime.json');
  assert.deepEqual(JSON.parse(readFileSync(runtimeFile, 'utf8')), runtime.record);
  const health = await fetch(`${runtime.record.url}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    application: 'stockbridge',
    version: '0.1.0',
    mode: 'demo',
    instanceId: runtime.record.instanceId,
    publishingEnabled: false,
  });
  assert.match(runtime.record.token, /^[a-f0-9]{64}$/);
  const rejectedHeaders: Record<string, string>[] = [
    { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
    {
      'Content-Type': 'application/json',
      'X-Stockbridge-Request': '1',
      Authorization: 'Bearer wrong-token',
    },
    { 'Content-Type': 'application/json', Authorization: `Bearer ${runtime.record.token}` },
    {
      'Content-Type': 'application/json',
      'X-Stockbridge-Request': '1',
      Authorization: `Bearer ${runtime.record.token}`,
      Origin: 'https://untrusted.example',
    },
  ];
  for (const headers of rejectedHeaders) {
    const response = await fetch(`${runtime.record.url}/api/runtime/stop`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
    assert.ok(existsSync(runtimeFile));
  }
  const backupResponse = await fetch(`${runtime.record.url}/api/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
    body: '{}',
  });
  assert.equal(backupResponse.status, 200);
  const backup = (await backupResponse.json()) as { path: string };
  queryFile(backup.path, (database) =>
    assert.ok(!JSON.stringify(readSnapshot(database)).includes(runtime.record.token)),
  );
  const stopped = await fetch(`${runtime.record.url}/api/runtime/stop`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Stockbridge-Request': '1',
      Authorization: `Bearer ${runtime.record.token}`,
    },
    body: '{}',
  });
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { stopping: true, instanceId: runtime.record.instanceId });
  await runtime.stop();
  assert.equal(existsSync(runtimeFile), false);
  assert.ok(
    !readFileSync(join(f.directory, 'demo.diagnostics.ndjson'), 'utf8').includes(
      runtime.record.token,
    ),
  );
  await assert.rejects(fetch(`${runtime.record.url}/api/health`));
  const recovered = await acquireWorkspaceOwnership(f.directory, 'demo');
  f.cleanups.push(() => recovered.release());
});

test('a second runtime cannot open or replace the running workspace', async (t) => {
  const f = fixture(t);
  const first = await startRuntime({ mode: 'demo', dataDirectory: f.directory, port: 0 });
  f.cleanups.push(() => first.stop());
  const recordBefore = readFileSync(join(f.directory, 'demo.runtime.json'), 'utf8');
  await assert.rejects(
    startRuntime({ mode: 'demo', dataDirectory: f.directory, port: 0 }),
    /already running/,
  );
  assert.equal(readFileSync(join(f.directory, 'demo.runtime.json'), 'utf8'), recordBefore);
  const response = await fetch(`${first.record.url}/api/health`);
  assert.equal(
    ((await response.json()) as { instanceId: string }).instanceId,
    first.record.instanceId,
  );
});

test('a busy dashboard port reports the conflict and releases the workspace for another start', async (t) => {
  const f = fixture(t);
  const listener = createServer((request, response) => response.end('Another application'));
  const address = await listen(listener);
  f.cleanups.push(() => close(listener));
  const port = Number(new URL(address).port);
  await assert.rejects(
    startRuntime({ mode: 'demo', dataDirectory: f.directory, port }),
    /port .* already in use/,
  );
  assert.equal(existsSync(join(f.directory, 'demo.runtime.json')), false);
  const recovered = await startRuntime({ mode: 'demo', dataDirectory: f.directory, port: 0 });
  f.cleanups.push(() => recovered.stop());
});

test('shutdown leaves a runtime record belonging to another instance untouched', async (t) => {
  const f = fixture(t);
  const runtime = await startRuntime({ mode: 'demo', dataDirectory: f.directory, port: 0 });
  f.cleanups.push(() => runtime.stop());
  const runtimeFile = join(f.directory, 'demo.runtime.json');
  const otherRecord = { ...runtime.record, instanceId: 'another-instance' };
  writeFileSync(runtimeFile, JSON.stringify(otherRecord));
  await runtime.stop();
  assert.deepEqual(JSON.parse(readFileSync(runtimeFile, 'utf8')), otherRecord);
});

test(
  'graceful shutdown lets an active local source read finish before closing the database',
  { timeout: 15_000 },
  async (t) => {
    const f = fixture(t);
    let sourceReached!: () => void;
    let releaseSource!: () => void;
    const sourceStarted = new Promise<void>((accept) => {
      sourceReached = accept;
    });
    const sourceReleased = new Promise<void>((accept) => {
      releaseSource = accept;
    });
    const tally = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      let rows: string;
      if (body.includes('<ID>StockbridgeStockItems</ID>')) {
        sourceReached();
        await sourceReleased;
        rows =
          '<STOCKITEM><NAME>Tyre</NAME><GUID>tyre</GUID><BASEUNITS>tyres</BASEUNITS><CLOSINGBALANCE>4 tyres</CLOSINGBALANCE><STOCKBRIDGECOMPANYGUID>company</STOCKBRIDGECOMPANYGUID></STOCKITEM>';
      } else {
        rows = '<COMPANY><NAME>Company</NAME><GUID>company</GUID></COMPANY>';
      }
      response.end(
        `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${rows}</COLLECTION></DATA></BODY></ENVELOPE>`,
      );
    });
    const endpoint = await listen(tally);
    f.cleanups.push(() => close(tally));
    const runtime = await startRuntime({ mode: 'live', dataDirectory: f.directory, port: 0 });
    f.cleanups.push(async () => {
      releaseSource();
      await runtime.stop();
    });
    const headers = { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' };
    const stateResponse = await fetch(`${runtime.record.url}/api/state`);
    const state = (await stateResponse.json()) as Snapshot;
    const settingsResponse = await fetch(`${runtime.record.url}/api/settings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ settings: { ...state.settings, tallyUrl: endpoint } }),
    });
    assert.equal(settingsResponse.status, 200);
    await settingsResponse.arrayBuffer();
    const refreshing = fetch(`${runtime.record.url}/api/refresh`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    await sourceStarted;
    const stopResponse = await fetch(`${runtime.record.url}/api/runtime/stop`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${runtime.record.token}` },
      body: '{}',
    });
    assert.equal(stopResponse.status, 200);
    await stopResponse.arrayBuffer();
    let completed = false;
    const stopping = runtime.stop().then(() => {
      completed = true;
    });
    await new Promise((accept) => setImmediate(accept));
    assert.equal(completed, false);
    assert.ok(existsSync(join(f.directory, 'live.runtime.json')));
    releaseSource();
    const refreshed = await refreshing;
    assert.equal(refreshed.status, 200);
    assert.equal(((await refreshed.json()) as Snapshot).items[0].physical, 4);
    await stopping;
    assert.equal(existsSync(join(f.directory, 'live.runtime.json')), false);
    queryFile(join(f.directory, 'live.sqlite'), (database) =>
      assert.equal(readSnapshot(database).items[0].physical, 4),
    );
  },
);

test('an invalid database fails startup and releases workspace ownership', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'demo.sqlite'), 'This is not a SQLite database.');
  await assert.rejects(
    startRuntime({ mode: 'demo', dataDirectory: f.directory, port: 0 }),
    /not a database/,
  );
  assert.equal(existsSync(join(f.directory, 'demo.runtime.json')), false);
  const recovered = await acquireWorkspaceOwnership(f.directory, 'demo');
  f.cleanups.push(() => recovered.release());
});
