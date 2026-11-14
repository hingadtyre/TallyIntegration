import assert from 'node:assert/strict';
import test from 'node:test';
import { FlipkartClient } from '../../src/adapters/flipkart.js';

const credentials = { applicationId: 'test-application', applicationSecret: 'private-test-secret' };
const goodResponse = {
  access_token: 'test-access-token',
  token_type: 'bearer',
  expires_in: 120,
  scope: 'Seller_Api,Default',
};
const json = (value: unknown) => Response.json(value);

test('self access sends Basic credentials only to the fixed Flipkart HTTPS token endpoint', async () => {
  let calls = 0;
  const client = new FlipkartClient({
    now: () => 1000,
    request: async (url, options) => {
      calls++;
      assert.equal(
        url,
        'https://api.flipkart.net/oauth-service/oauth/token?grant_type=client_credentials&scope=Seller_Api,Default',
      );
      assert.equal(options?.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.body, undefined);
      assert.ok(options.signal);
      assert.deepEqual(options.headers, {
        Authorization: `Basic ${Buffer.from('test-application:private-test-secret').toString('base64')}`,
        Accept: 'application/json',
      });
      return json(goodResponse);
    },
  });
  assert.deepEqual(await client.createAccessToken(credentials), {
    value: 'test-access-token',
    expiresAt: 121000,
  });
  assert.equal(calls, 1);
});

test('invalid local credentials fail before any network request', async () => {
  const client = new FlipkartClient({
    request: async () => {
      throw new Error('Network must not run');
    },
  });
  for (const invalid of [
    { applicationId: '', applicationSecret: 'secret' },
    { applicationId: 'contains:colon', applicationSecret: 'secret' },
    { applicationId: 'id', applicationSecret: 'secret\r\nheader' },
    { applicationId: 'id', applicationSecret: '' },
  ])
    await assert.rejects(client.createAccessToken(invalid), /valid application ID/);
});

test('HTTP failures do not expose provider response bodies or request credentials', async () => {
  for (const status of [301, 400, 401, 403, 429, 500]) {
    const client = new FlipkartClient({
      request: async () => new Response('private-test-secret test-access-token', { status }),
    });
    await assert.rejects(client.createAccessToken(credentials), (error: Error) => {
      assert.doesNotMatch(error.message, /private-test-secret|test-access-token/);
      assert.equal(error.cause, undefined);
      assert.match(error.message, /Flipkart/);
      return true;
    });
  }
});

test('tokens require usable bearer type, Seller API scope and a bounded positive expiry', async () => {
  for (const changes of [
    { access_token: '' },
    { access_token: 'token\r\nheader' },
    { token_type: 'Basic' },
    { expires_in: 0 },
    { expires_in: -1 },
    { expires_in: '120' },
    { expires_in: 1.5 },
    { expires_in: Number.MAX_SAFE_INTEGER },
    { scope: 'Default' },
  ]) {
    const client = new FlipkartClient({
      request: async () => json({ ...goodResponse, ...changes }),
    });
    await assert.rejects(client.createAccessToken(credentials), /invalid or insufficient/);
  }
});

test('malformed, unexpected and oversized authentication responses are rejected without leaking content', async () => {
  const responses = [
    new Response('<html>private-test-secret</html>'),
    new Response('{private-test-secret', { headers: { 'Content-Type': 'application/json' } }),
    json([]),
    new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '100000' },
    }),
    new Response('x'.repeat(70000), { headers: { 'Content-Type': 'application/json' } }),
  ];
  for (const response of responses) {
    const client = new FlipkartClient({ request: async () => response });
    await assert.rejects(client.createAccessToken(credentials), (error: Error) => {
      assert.match(error.message, /response/);
      assert.doesNotMatch(error.message, /private-test-secret/);
      return true;
    });
  }
});

test('network and timeout errors discard private underlying errors', async () => {
  const client = new FlipkartClient({
    request: async () => {
      throw new Error('request authorization private-test-secret');
    },
  });
  await assert.rejects(client.createAccessToken(credentials), (error: Error) => {
    assert.match(error.message, /Could not reach/);
    assert.doesNotMatch(error.message + error.stack, /private-test-secret/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.throws(() => new FlipkartClient({ timeoutMs: 0 }), /timeout/);
  let aborted = false;
  const slow = new FlipkartClient({
    timeoutMs: 5,
    request: async (_url, options) =>
      new Promise<Response>((accept, reject) => {
        const timer = setTimeout(() => accept(json(goodResponse)), 1000);
        options!.signal!.addEventListener(
          'abort',
          () => {
            aborted = true;
            clearTimeout(timer);
            reject(new Error('private-test-secret timed out'));
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(slow.createAccessToken(credentials), /Could not reach Flipkart/);
  assert.equal(aborted, true);
});
