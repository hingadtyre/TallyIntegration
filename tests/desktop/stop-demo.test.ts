import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stopDemo } from '../../src/desktop/runtime-control.js';
import { storageFixture } from '../support/server-fixture.js';

const demo = {
  application: 'stockbridge',
  mode: 'demo',
  version: '0.1.0',
  instanceId: '8795dac2-c5ba-4526-bac6-03e1e010265b',
  pid: 123,
  url: 'http://127.0.0.1:4311',
  token: 'a'.repeat(64),
};
const health = {
  application: demo.application,
  version: demo.version,
  mode: demo.mode,
  instanceId: demo.instanceId,
  publishingEnabled: true,
};

test('demo shutdown verifies identity, stops once and preserves the live record', async (t) => {
  const { directory } = storageFixture(t);
  const file = join(directory, 'demo.runtime.json');
  const liveFile = join(directory, 'live.runtime.json');
  const liveRecord = JSON.stringify({
    ...demo,
    mode: 'live',
    instanceId: '7be0f8eb-ab22-4985-8b28-bbfe24df7397',
    url: 'http://127.0.0.1:4310',
    token: 'b'.repeat(64),
  });
  writeFileSync(file, JSON.stringify(demo));
  writeFileSync(liveFile, liveRecord);
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    requests.push((options?.method ?? 'GET') + ' ' + url);
    assert.equal(options?.redirect, 'error');
    const headers = new Headers(options?.headers);
    if (url === demo.url + '/api/health') {
      assert.equal(headers.has('authorization'), false);
      return Response.json(health);
    }
    assert.equal(url, demo.url + '/api/runtime/stop');
    assert.equal(headers.get('authorization'), 'Bearer ' + demo.token);
    assert.equal(headers.get('x-stockbridge-request'), '1');
    unlinkSync(file);
    return Response.json({ stopping: true, instanceId: demo.instanceId });
  });

  await stopDemo(directory);
  await stopDemo(directory);

  assert.deepEqual(requests, [
    'GET ' + demo.url + '/api/health',
    'POST ' + demo.url + '/api/runtime/stop',
  ]);
  assert.equal(readFileSync(liveFile, 'utf8'), liveRecord);
});

test('demo shutdown rejects a saved live record or an unexpected dashboard address before making a request', async (t) => {
  const { directory } = storageFixture(t);
  const file = join(directory, 'demo.runtime.json');
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json(health));
  for (const change of [
    { mode: 'live' },
    { url: 'http://127.0.0.1:4310' },
    { url: 'https://untrusted.example' },
  ]) {
    const record = JSON.stringify({ ...demo, ...change });
    writeFileSync(file, record);
    await assert.rejects(stopDemo(directory), /invalid application status/i);
    assert.equal(readFileSync(file, 'utf8'), record);
  }
  assert.equal(request.mock.callCount(), 0);
});

test('a different application, mode or instance at the demo address never receives a shutdown request', async (t) => {
  const { directory } = storageFixture(t);
  const file = join(directory, 'demo.runtime.json');
  const record = JSON.stringify(demo);
  writeFileSync(file, record);
  let reported = health;
  const requests: { url: string; method: string; authorization: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    requests.push({
      url,
      method: options?.method ?? 'GET',
      authorization: new Headers(options?.headers).get('authorization'),
    });
    return Response.json(reported);
  });
  for (const change of [
    { application: 'another-app' },
    { mode: 'live' },
    { instanceId: '224083b4-8ef8-4ff6-ba6e-8473453466e9' },
  ]) {
    reported = { ...health, ...change };
    requests.length = 0;
    await assert.rejects(stopDemo(directory), /could not verify/i);
    assert.deepEqual(requests, [
      { url: demo.url + '/api/health', method: 'GET', authorization: null },
    ]);
    assert.equal(readFileSync(file, 'utf8'), record);
  }
});
