import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { Diagnostics } from '../../src/server/diagnostics.js';
import { createApp } from '../../src/server/http.js';
import { InventoryService } from '../../src/server/service.js';
import { Store } from '../../src/server/store.js';

function removeFixture(folder: string): void {
  const target = resolve(folder);
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('stockbridge-diagnostics-')
  )
    throw new Error('Unsafe fixture cleanup path.');
  rmSync(target, { recursive: true, force: true });
}

test('unexpected HTTP errors retain a sanitized cause and stack under the public request reference', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'stockbridge-diagnostics-'));
  const store = new Store(join(folder, 'state.sqlite'), 'demo');
  const service = new InventoryService(store);
  const failure = new Error('Could not open inventory store.', {
    cause: Object.assign(new Error('Permission denied; password=fixture-password'), {
      code: 'EACCES',
    }),
  });
  service.backup = () => {
    throw failure;
  };
  const app = createApp(service, folder);
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: '{}',
    });
    assert.equal(response.status, 500);
    const result = (await response.json()) as { error: string; requestId: string };
    assert.equal(response.headers.get('x-request-id'), result.requestId);
    assert.match(result.error, /could not be completed/i);
    assert.ok(result.error.includes(result.requestId));
    assert.doesNotMatch(result.error, /inventory store|Permission denied|fixture-password/);
    const entry = JSON.parse(service.logs().trim().split('\n').at(-1)!);
    assert.equal(entry.requestId, result.requestId);
    assert.equal(entry.operation, '/api/backup');
    assert.equal(entry.error.message, 'Could not open inventory store.');
    assert.equal(entry.error.cause.code, 'EACCES');
    assert.match(entry.error.cause.message, /Permission denied/);
    assert.match(entry.error.stack, /diagnostics\.test/);
    assert.doesNotMatch(service.logs(), /fixture-password/);
  } finally {
    app.closeAllConnections();
    await new Promise<void>((done, reject) =>
      app.close((error) => (error ? reject(error) : done())),
    );
    service.stop();
    store.close();
    removeFixture(folder);
  }
});

test('diagnostics omit raw payloads and credentials while retaining operation context', () => {
  const folder = mkdtempSync(join(tmpdir(), 'stockbridge-diagnostics-'));
  try {
    const diagnostics = new Diagnostics(join(folder, 'events.ndjson'));
    diagnostics.error(
      'read-fixture',
      new Error('Remote read failed: <ENVELOPE><CUSTOMER>private-name</CUSTOMER></ENVELOPE>'),
    );
    diagnostics.error(
      'read-fixture',
      new Error('Response rejected: {"customer":"private-name","token":"private-token"}'),
    );
    diagnostics.error(
      'read-fixture',
      new Error(
        'Authentication failed Bearer private-token; password=private-password; https://user:private-password@example.test/read?token=private-token',
      ),
    );
    diagnostics.error('read-fixture', { customer: 'private-name', token: 'private-token' });
    const text = diagnostics.read();
    assert.doesNotMatch(text, /private-name|private-token|private-password|<ENVELOPE>/);
    assert.match(text, /Remote read failed/);
    assert.match(text, /Authentication failed/);
    assert.match(text, /NonError/);
  } finally {
    removeFixture(folder);
  }
});
