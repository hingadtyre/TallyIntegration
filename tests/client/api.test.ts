import assert from 'node:assert/strict';
import test from 'node:test';
import { requestJson } from '../../src/client/api.js';

test('reading a snapshot uses the API prefix and forwards cancellation', async (t) => {
  const controller = new AbortController();
  const snapshot = { mode: 'demo', items: [] };
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (path: string | URL | Request, options?: RequestInit) => {
      assert.equal(path, '/api/state');
      assert.deepEqual(options, { signal: controller.signal });
      return Response.json(snapshot);
    },
  );

  assert.deepEqual(await requestJson('/state', undefined, controller.signal), snapshot);
  assert.equal(fetch.mock.callCount(), 1);
});

test('commands send JSON and the required local-request header', async (t) => {
  const body = { companyId: 'company-a', listingIds: ['listing-a'], quantity: 0 };
  t.mock.method(
    globalThis,
    'fetch',
    async (path: string | URL | Request, options?: RequestInit) => {
      assert.equal(path, '/api/zero');
      assert.equal(options?.method, 'POST');
      assert.deepEqual(options?.headers, {
        'Content-Type': 'application/json',
        'X-Stockbridge-Request': '1',
      });
      assert.deepEqual(JSON.parse(String(options?.body)), body);
      return Response.json({ saved: true });
    },
  );

  assert.deepEqual(await requestJson('/zero', body), { saved: true });
});

test('failed requests preserve actionable server messages and otherwise report the status', async (t) => {
  const responses = [
    Response.json(
      { error: 'The proposal is stale. Recalculate and review again.' },
      { status: 409 },
    ),
    Response.json({ message: 'Unavailable' }, { status: 503 }),
  ];
  t.mock.method(globalThis, 'fetch', async () => responses.shift()!);

  await assert.rejects(requestJson('/review', {}), /proposal is stale/);
  await assert.rejects(requestJson('/state'), /Request failed \(503\)/);
});

test('network failures reject the request so a caller cannot treat them as success', async (t) => {
  const failure = new TypeError('Network connection lost');
  t.mock.method(globalThis, 'fetch', async () => {
    throw failure;
  });

  await assert.rejects(requestJson('/settings', {}), (error: unknown) => error === failure);
});
