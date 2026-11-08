import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../../src/server/http.js';
import type { Review, Snapshot } from '../../src/shared/contracts.js';
import { close, listen, serverFixture as fixture } from '../support/server-fixture.js';

const dashboardHeaders = {
  'Content-Type': 'application/json',
  'X-Stockbridge-Request': '1',
};

test('dashboard commands return saved drafts, exact reviews, mappings and settings over HTTP', async (t) => {
  const f = fixture(t);
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  async function post<T>(path: string, input: unknown): Promise<T> {
    const response = await fetch(`${address}/api/${path}`, {
      method: 'POST',
      headers: { ...dashboardHeaders, Origin: address },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('x-request-id'));
    return (await response.json()) as T;
  }
  try {
    const scope = { companyId: 'demo-a', listingIds: ['listing-1'] };
    const calculated = await post<Snapshot>('calculate', scope);
    assert.equal(calculated.proposals[0].quantity, 5);
    const edited = await post<Snapshot>('proposals', {
      companyId: 'demo-a',
      listingId: 'listing-1',
      quantity: 1,
    });
    assert.equal(edited.proposals[0].quantity, 1);
    const reviewed = await post<Review>('review', scope);
    assert.deepEqual(
      reviewed.rows.map((row) => [row.listingId, row.quantity, row.problem]),
      [['listing-1', 1, null]],
    );
    const paused = await post<Snapshot>('pause', { ...scope, paused: true });
    assert.equal(paused.listings.find((row) => row.id === 'listing-1')!.paused, true);
    const zero = await post<Snapshot>('zero', scope);
    assert.equal(zero.proposals[0].quantity, 0);
    const removed = await post<Snapshot>('mappings/remove', {
      companyId: 'demo-a',
      listingId: 'listing-1',
      leaveRemoteStock: true,
    });
    assert.equal(removed.listings.find((row) => row.id === 'listing-1')!.itemId, null);
    const mapped = await post<Snapshot>('mappings', {
      listingId: 'listing-1',
      itemId: 'item-a',
      confirmPackEvidence: true,
    });
    assert.equal(mapped.listings.find((row) => row.id === 'listing-1')!.itemId, 'item-a');
    const settings = await post<Snapshot>('settings', {
      settings: { ...mapped.settings, tallySeconds: 45 },
    });
    assert.equal(settings.settings.tallySeconds, 45);
    const refreshed = await post<Snapshot>('refresh', { companyId: 'demo-a' });
    assert.deepEqual(refreshed.items, mapped.items);
    const backup = await post<{ path: string; verified: boolean }>('backup', {});
    assert.equal(backup.verified, true);
    assert.ok(existsSync(backup.path));
    const response = await fetch(`${address}/api/state`);
    assert.deepEqual(await response.json(), f.service.snapshot());
  } finally {
    await close(app);
  }
});

test('malformed bodies and invalid command fields return actionable errors without changing inventory', async (t) => {
  const f = fixture(t);
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  const before = f.service.snapshot();
  try {
    for (const body of ['', '{broken', 'null', '[]', '42']) {
      const response = await fetch(`${address}/api/calculate`, {
        method: 'POST',
        headers: dashboardHeaders,
        body,
      });
      assert.equal(response.status, 400);
      const result = (await response.json()) as { error: string; requestId: string };
      assert.match(result.error, /JSON object/);
      assert.equal(response.headers.get('x-request-id'), result.requestId);
    }
    for (const [path, input] of [
      ['calculate', { companyId: 'demo-a', listingIds: [] }],
      ['calculate', { companyId: 'demo-a', listingIds: ['listing-1', 'listing-8'] }],
      ['proposals', { companyId: 'demo-a', listingId: 'listing-1', quantity: -1 }],
      ['pause', { companyId: 'demo-a', listingIds: ['listing-1'], paused: 'true' }],
      ['settings', {}],
      ['mappings/remove', { companyId: 'demo-a', listingId: 'listing-1', leaveRemoteStock: false }],
    ] as const) {
      const response = await fetch(`${address}/api/${path}`, {
        method: 'POST',
        headers: dashboardHeaders,
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 400, path);
      const result = (await response.json()) as { error: string };
      assert.ok(result.error);
    }
    assert.deepEqual(f.service.snapshot(), before);
  } finally {
    await close(app);
  }
});

test('oversized bodies, unexpected routes and unsafe request headers are rejected', async (t) => {
  const f = fixture(t);
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  const before = f.service.snapshot();
  try {
    const cases: { path: string; options: RequestInit; status: number }[] = [
      {
        path: '/api/calculate',
        options: {
          method: 'POST',
          headers: dashboardHeaders,
          body: JSON.stringify({ value: 'x'.repeat(100_001) }),
        },
        status: 413,
      },
      {
        path: '/api/missing',
        options: { method: 'POST', headers: dashboardHeaders, body: '{}' },
        status: 404,
      },
      { path: '/api/calculate', options: { method: 'GET' }, status: 404 },
      { path: '/api/state', options: { method: 'PUT' }, status: 404 },
      {
        path: '/api/zero',
        options: {
          method: 'POST',
          headers: { 'X-Stockbridge-Request': '1', 'Content-Type': 'text/plain' },
          body: '{}',
        },
        status: 403,
      },
    ];
    for (const entry of cases) {
      const response = await fetch(address + entry.path, entry.options);
      assert.equal(response.status, entry.status, entry.path);
      assert.ok(((await response.json()) as { error: string }).error);
    }
    // Fetch supplies its own Host header; use HTTP directly to exercise a hostile value.
    const untrusted = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const outgoing = request(
          `${address}/api/state`,
          { headers: { Host: 'untrusted.example' } },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
              body += chunk;
            });
            response.on('end', () => resolve({ status: response.statusCode, body }));
            response.on('error', reject);
          },
        );
        outgoing.on('error', reject);
        outgoing.end();
      },
    );
    assert.equal(untrusted.status, 403);
    assert.match(JSON.parse(untrusted.body).error, /Local access only/);
    assert.deepEqual(f.service.snapshot(), before);
  } finally {
    await close(app);
  }
});

test('static files and diagnostics have the expected content and missing pages return 404', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.folder, 'index.html'), '<!doctype html><title>Fixture dashboard</title>');
  writeFileSync(join(f.folder, 'app.js'), 'globalThis.fixtureLoaded = true;');
  f.service.log('fixture-check', 'Fixture diagnostic message');
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  try {
    const home = await fetch(address);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type')!, /text\/html/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.match(home.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.match(await home.text(), /Fixture dashboard/);
    const script = await fetch(`${address}/app.js`);
    assert.equal(script.headers.get('content-type'), 'application/javascript');
    assert.match(await script.text(), /fixtureLoaded/);
    const logs = await fetch(`${address}/api/logs`);
    assert.equal(logs.status, 200);
    assert.equal(logs.headers.get('cache-control'), 'no-store');
    assert.match(await logs.text(), /Fixture diagnostic message/);
    for (const path of ['/missing.html', '/..%2foutside-fixture.txt']) {
      const response = await fetch(address + path);
      assert.equal(response.status, 404);
      await response.arrayBuffer();
    }
    const malformed = await fetch(`${address}/%ZZ`);
    assert.equal(malformed.status, 400);
    assert.match(((await malformed.json()) as { error: string }).error, /Invalid page address/);
  } finally {
    await close(app);
  }
});
test('HTTP publication remains unavailable and untrusted mutations are rejected', async (t) => {
  const f = fixture(t);
  f.service.edit('demo-a', 'listing-1', 1);
  const before = f.service.snapshot();
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  try {
    const payload = JSON.stringify({ companyId: 'demo-a', listingIds: ['listing-1'] });
    const noHeader = await fetch(`${address}/api/zero`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(noHeader.status, 403);
    await noHeader.arrayBuffer();
    const crossOrigin = await fetch(`${address}/api/zero`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stockbridge-Request': '1',
        Origin: 'https://untrusted.example',
      },
      body: payload,
    });
    assert.equal(crossOrigin.status, 403);
    await crossOrigin.arrayBuffer();
    const publish = await fetch(`${address}/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Stockbridge-Request': '1' },
      body: payload,
    });
    assert.equal(publish.status, 409);
    assert.match(((await publish.json()) as { error: string }).error, /unavailable/i);
    const stateResponse = await fetch(`${address}/api/state`);
    assert.equal(stateResponse.status, 200);
    const state = (await stateResponse.json()) as { publishingEnabled: boolean };
    assert.equal(state.publishingEnabled, false);
    assert.deepEqual(
      f.service.snapshot(),
      before,
      'blocked requests cannot activate a policy or alter stock',
    );
  } finally {
    await close(app);
  }
});
