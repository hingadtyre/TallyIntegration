import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createApp } from '../../src/server/http.js';
import type { FlipkartConnectionStatus, Review, Snapshot } from '../../src/shared/contracts.js';
import { FlipkartConnectionError } from '../../src/server/flipkart-connection.js';
import { close, listen, serverFixture as fixture } from '../support/server-fixture.js';

const dashboardHeaders = {
  'Content-Type': 'application/json',
  'X-Stockbridge-Request': '1',
};

test('Discard clears only the saved proposal from its exact review, including the final row', async (t) => {
  const f = fixture(t);
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  t.after(() => close(app));
  const post = (path: string, body: object) =>
    fetch(address + '/api/' + path, {
      method: 'POST',
      headers: dashboardHeaders,
      body: JSON.stringify(body),
    });
  const ids = ['listing-1', 'listing-2'];
  await f.service.pause('demo-a', [ids[1]], true);
  f.service.calculate('demo-a', ids, true);
  f.service.calculate('demo-a', [ids[1]]);
  const original = f.store.read();
  const review = (await (
    await post('review', { companyId: 'demo-a', listingIds: ids })
  ).json()) as Review;
  assert.deepEqual(
    review.rows.map((r) => [r.canDiscard, r.policy]),
    [
      [true, 'Pause Tally sync'],
      [true, 'Resume Tally sync'],
    ],
  );
  const discard = (reviewId: string, listingId: string) =>
    post('review/discard', { reviewId, listingId });
  assert.equal((await discard(review.id, 'listing-3')).status, 409);
  const first = (await (await discard(review.id, ids[0])).json()) as {
    review: Review;
    snapshot: Snapshot;
  };
  assert.notEqual(first.review.id, review.id);
  assert.deepEqual(first.review.rows, [review.rows[1]]);
  assert.deepEqual(
    first.snapshot.proposals,
    original.proposals.filter((r) => r.listingId === ids[1]),
  );
  assert.equal((await discard(review.id, ids[1])).status, 409);
  const last = (await (await discard(first.review.id, ids[1])).json()) as {
    review: Review;
    snapshot: Snapshot;
  };
  assert.deepEqual(last.review.rows, []);
  assert.deepEqual(last.snapshot.proposals, []);
  assert.deepEqual(f.store.read().listings, original.listings);
  assert.deepEqual(f.store.read().companies, original.companies);
  assert.deepEqual(f.store.read().items, original.items);
});

test('an older review cannot discard a replacement draft or publish with a retired policy choice', async (t) => {
  const f = fixture(t);
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  t.after(() => close(app));
  f.service.edit('demo-a', 'listing-1', 0);
  const review = f.service.review('demo-a', ['listing-1']);
  f.service.edit('demo-a', 'listing-1', 1);
  assert.throws(
    () => f.service.discardReviewProposal(review.id, 'listing-1'),
    /saved proposal changed/,
  );
  const response = await fetch(address + '/api/publish', {
    method: 'POST',
    headers: dashboardHeaders,
    body: JSON.stringify({ reviewId: review.id, positiveEdits: 'once' }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /Reload Inventory/);
  assert.equal(f.store.read().proposals[0].quantity, 1);
});

test('two dashboard windows can save different settings before the next refresh', async (t) => {
  const f = fixture(t);
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  t.after(() => close(app));
  const post = (changes: unknown) =>
    fetch(address + '/api/settings', {
      method: 'POST',
      headers: dashboardHeaders,
      body: JSON.stringify({ changes }),
    });
  assert.equal((await post({ tallySeconds: 51 })).status, 200);
  assert.equal((await post({ marketplaceSeconds: 401 })).status, 200);
  assert.equal((await post({ tallySeconds: 2, marketplaceSeconds: 99 })).status, 400);
  assert.equal((await post({ unknownField: true })).status, 400);
  const { settings } = f.store.read();
  assert.equal(settings.tallySeconds, 51);
  assert.equal(settings.marketplaceSeconds, 401);
});

test('item keep-back saves by company and version, queues only eligible siblings and survives restart', async (t) => {
  const f = fixture(t);
  f.store.update((state) => {
    state.companies[0].automation = true;
    state.listings[1].verified = false;
  });
  f.service.calculate('demo-a', ['listing-1']);
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  t.after(() => close(app));
  const input = { companyId: 'demo-a', itemId: 'item-a', itemVersion: 1, keepBackUnits: 6.5 };
  const post = (changes: Partial<typeof input> = {}) =>
    fetch(address + '/api/items/keep-back', {
      method: 'POST',
      headers: dashboardHeaders,
      body: JSON.stringify({ ...input, ...changes }),
    });
  assert.equal((await post({ companyId: 'demo-b' })).status, 400);
  assert.equal((await post({ keepBackUnits: -1 })).status, 400);
  const response = await post();
  assert.equal(response.status, 200);
  const result = (await response.json()) as Snapshot;
  const item = result.items.find((row) => row.id === 'item-a')!;
  assert.equal(item.keepBackUnits, 6.5);
  assert.equal(item.version, 2);
  assert.equal(item.physical, 4);
  assert.equal(result.items.find((row) => row.id === 'item-e')!.keepBackUnits, 0);
  assert.equal(result.proposals[0].stale, true);
  assert.deepEqual(
    result.listings.filter((row) => row.syncPendingItemVersion === 2).map((row) => row.id),
    ['listing-1', 'listing-3', 'listing-4'],
  );
  assert.equal(result.listings[0].observed, 5);
  assert.equal((await post()).status, 200, 'replaying a successful save is idempotent');
  assert.equal((await post({ keepBackUnits: 3 })).status, 409);
  assert.equal(
    f.store.read().activity.filter((row) => row.operation === 'item-keep-back').length,
    1,
  );
  f.reopen();
  const reloaded = f.service.snapshot();
  assert.deepEqual(reloaded.items, result.items);
  assert.deepEqual(reloaded.listings, result.listings);
  f.service.automation('demo-a', false);
  const cleared = f.service.setKeepBack('demo-a', 'item-a', 2, 0);
  assert.equal(cleared.items[0].keepBackUnits, 0);
  assert.ok(cleared.listings.every((row) => row.syncPendingItemVersion == null));
});

test('Flipkart credential routes require dashboard requests and return only public status', async (t) => {
  const f = fixture(t, 'live');
  const state: FlipkartConnectionStatus = {
    state: 'verified',
    checkedAt: '2026-11-08T00:00:00.000Z',
    expiresAt: '2026-11-09T00:00:00.000Z',
    applicationIdHint: '***1234',
    message: 'API credentials verified. Seller identity is not yet verified.',
  };
  let connects = 0;
  let saves = 0;
  let checks = 0;
  let disconnects = 0;
  const connection = {
    status: async () => state,
    connect: async (input: unknown) => {
      assert.deepEqual(input, {
        applicationId: 'example-app-1234',
        applicationSecret: 'test-private-secret',
      });
      connects++;
      return state;
    },
    save: async (input: unknown) => {
      assert.deepEqual(input, {
        applicationId: 'example-app-1234',
        applicationSecret: 'test-private-secret',
      });
      saves++;
      return {
        ...state,
        state: 'needs-attention' as const,
        checkedAt: null,
        expiresAt: null,
        message: 'Credentials saved without contacting Flipkart.',
      };
    },
    check: async () => {
      checks++;
      return state;
    },
    disconnect: async () => {
      disconnects++;
      return { ...state, state: 'not-configured' as const, applicationIdHint: null };
    },
  };
  const app = createApp(f.service, f.folder, undefined, connection);
  const address = await listen(app);
  try {
    const status = await fetch(`${address}/api/flipkart/connection`);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await status.json(), state);
    const post = (path: string, body: unknown, headers = dashboardHeaders) =>
      fetch(`${address}/api/${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    const input = { applicationId: 'example-app-1234', applicationSecret: 'test-private-secret' };
    assert.equal(
      (
        await post('flipkart/connect', input, {
          ...dashboardHeaders,
          Origin: 'https://untrusted.example',
        } as typeof dashboardHeaders)
      ).status,
      403,
    );
    assert.equal(
      (
        await post('flipkart/connect', input, {
          'Content-Type': 'application/json',
        } as typeof dashboardHeaders)
      ).status,
      403,
    );
    assert.equal((await post('flipkart/connect', { applicationId: 42 })).status, 400);
    assert.equal((await post('flipkart/save', { applicationId: 42 })).status, 400);
    assert.equal(
      (
        await post('flipkart/save', input, {
          'Content-Type': 'application/json',
        } as typeof dashboardHeaders)
      ).status,
      403,
    );
    assert.equal(saves, 0);
    assert.equal(connects, 0);
    const saved = await post('flipkart/save', input);
    assert.equal(saved.status, 200);
    const savedStatus = (await saved.json()) as FlipkartConnectionStatus;
    assert.equal(savedStatus.state, 'needs-attention');
    assert.equal(savedStatus.checkedAt, null);
    assert.equal(savedStatus.expiresAt, null);
    assert.doesNotMatch(JSON.stringify(savedStatus), /test-private-secret|example-app-1234/);
    assert.equal(saves, 1);
    assert.equal(connects, 0);
    assert.equal(checks, 0);
    const connected = await post('flipkart/connect', input);
    assert.equal(connected.status, 200);
    assert.deepEqual(await connected.json(), state);
    assert.equal(connects, 1);
    assert.equal((await post('flipkart/check', {})).status, 200);
    assert.equal(checks, 1);
    assert.equal((await post('flipkart/disconnect', {})).status, 200);
    assert.equal(disconnects, 1);
    assert.equal((await post('publish', {})).status, 409);
    assert.equal((await fetch(`${address}/api/flipkart/token`)).status, 404);
    assert.doesNotMatch(f.service.logs(), /test-private-secret|example-app-1234/);
    assert.deepEqual(f.service.snapshot().accounts, []);
    assert.equal(f.service.snapshot().publishingEnabled, false);
  } finally {
    await close(app);
  }
});

test('Flipkart failures omit raw private transport data from HTTP and diagnostics', async (t) => {
  const f = fixture(t, 'live');
  let failure: Error = new Error('unlabelled-sensitive-credential', {
    cause: new Error('private-token-value'),
  });
  const fail = async (): Promise<never> => {
    throw failure;
  };
  const app = createApp(f.service, f.folder, undefined, {
    status: fail,
    connect: fail,
    save: fail,
    check: fail,
    disconnect: fail,
  });
  const address = await listen(app);
  try {
    const unexpected = await fetch(`${address}/api/flipkart/check`, {
      method: 'POST',
      headers: dashboardHeaders,
      body: '{}',
    });
    assert.equal(unexpected.status, 500);
    assert.doesNotMatch(await unexpected.text(), /unlabelled-sensitive|private-token/);
    assert.doesNotMatch(f.service.logs(), /unlabelled-sensitive|private-token/);
    failure = new FlipkartConnectionError('Check the seller-owned application credentials.', 400);
    const expected = await fetch(`${address}/api/flipkart/check`, {
      method: 'POST',
      headers: dashboardHeaders,
      body: '{}',
    });
    assert.equal(expected.status, 400);
    assert.match(await expected.text(), /Check the seller-owned application credentials/);
    assert.equal((await fetch(`${address}/api/flipkart/check`)).status, 404);
  } finally {
    await close(app);
  }
});

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
    const listingVersion = calculated.listings.find((row) => row.id === 'listing-1')!.version;
    const edited = await post<Snapshot>('proposals', {
      companyId: 'demo-a',
      listingId: 'listing-1',
      listingVersion,
      previousManualQuantity: null,
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
      listingVersion: zero.listings.find((row) => row.id === 'listing-1')!.version,
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
      [
        'proposals',
        {
          companyId: 'demo-a',
          listingId: 'listing-1',
          listingVersion: before.listings[0].version,
          previousManualQuantity: null,
          quantity: -1,
        },
      ],
      ['pause', { companyId: 'demo-a', listingIds: ['listing-1'], paused: 'true' }],
      ['settings', {}],
      [
        'mappings/remove',
        {
          companyId: 'demo-a',
          listingId: 'listing-1',
          listingVersion: before.listings[0].version,
          leaveRemoteStock: false,
        },
      ],
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

test('an older dashboard cannot edit a draft or unlink a mapping without its reviewed values', async (t) => {
  const f = fixture(t);
  const app = createApp(f.service, f.folder);
  const address = await listen(app);
  t.after(() => close(app));
  const before = f.service.snapshot();
  const listing = before.listings.find((row) => row.id === 'listing-1')!;
  const scope = { companyId: 'demo-a', listingId: listing.id };
  for (const [path, fields] of [
    ['proposals', { quantity: 1, previousManualQuantity: null }],
    ['proposals', { quantity: 1, listingVersion: listing.version }],
    ['mappings/remove', { leaveRemoteStock: true }],
  ] as const) {
    const response = await fetch(`${address}/api/${path}`, {
      method: 'POST',
      headers: dashboardHeaders,
      body: JSON.stringify({ ...scope, ...fields }),
    });
    assert.equal(response.status, 428);
    assert.match((await response.json()).error, /reload inventory/i);
  }
  assert.deepEqual(f.service.snapshot(), before);
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
