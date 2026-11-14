import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type { FlipkartCredentials } from '../../src/adapters/flipkart.js';
import { FlipkartAuthenticationError } from '../../src/adapters/flipkart.js';
import { FlipkartConnection } from '../../src/server/flipkart-connection.js';
import type { FlipkartCredentialStore } from '../../src/server/flipkart-credentials.js';

const first = { applicationId: 'application-one', applicationSecret: 'private-test-one' };
const second = { applicationId: 'application-two', applicationSecret: 'private-test-two' };

function fixture(mode: 'live' | 'demo' = 'live', available = true) {
  let saved: FlipkartCredentials | null = null;
  let time = 1_000_000;
  let calls = 0;
  let writes = 0;
  let failWrite = false;
  let failAuth = false;
  const store: FlipkartCredentialStore = {
    available,
    async read() {
      return saved && { ...saved };
    },
    async write(value) {
      writes++;
      if (failWrite) throw new Error('private-test-secret disk error');
      saved = { ...value };
    },
    async remove() {
      saved = null;
    },
  };
  const connection = new FlipkartConnection(resolve('.data/test-not-used'), mode, {
    credentialStore: store,
    now: () => time,
    client: {
      async createAccessToken() {
        calls++;
        if (failAuth)
          throw new FlipkartAuthenticationError('Flipkart rejected these API credentials.');
        return { value: `private-test-token-${calls}`, expiresAt: time + 120_000 };
      },
    },
  });
  return {
    connection,
    store,
    saved: () => saved,
    calls: () => calls,
    writes: () => writes,
    advance: (value: number) => {
      time += value;
    },
    failWrite: () => {
      failWrite = true;
    },
    failAuth: () => {
      failAuth = true;
    },
  };
}

test('connecting saves only verified credentials and public status contains neither secret nor token', async () => {
  const f = fixture();
  assert.equal((await f.connection.status()).state, 'not-configured');
  assert.equal(f.calls(), 0);
  const connected = await f.connection.connect(first);
  assert.equal(connected.state, 'verified');
  assert.equal(connected.applicationIdHint, '***-one');
  assert.match(connected.message, /Seller identity.*not yet verified/);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.saved(), first);
  assert.doesNotMatch(JSON.stringify(await f.connection.status()), /private-test|application-one/);
});

test('save preserves pending credentials exactly without contacting Flipkart or claiming verification', async () => {
  const f = fixture();
  const original = { ...first, applicationSecret: 'private-test-secret+/:=' };
  const saved = await f.connection.save(original);
  assert.deepEqual(f.saved(), original);
  assert.equal(f.calls(), 0);
  assert.equal(saved.state, 'needs-attention');
  assert.equal(saved.checkedAt, null);
  assert.equal(saved.expiresAt, null);
  assert.match(saved.message, /without contacting Flipkart/);
  assert.match(saved.message, /approval is pending/);
  assert.doesNotMatch(JSON.stringify(saved), /private-test|application-one/);
  assert.deepEqual(await f.connection.status(), saved);
  assert.equal(f.calls(), 0);
});

test('saving a replacement invalidates the preceding token until a fresh authorization succeeds', async () => {
  const f = fixture();
  await f.connection.connect(first);
  const replacement = await f.connection.save(second);
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.saved(), second);
  assert.equal(replacement.state, 'needs-attention');
  assert.equal(replacement.checkedAt, null);
  assert.equal(replacement.expiresAt, null);
  assert.equal(await f.connection.getAccessToken(), 'private-test-token-2');
  assert.equal(f.calls(), 2);
});

test('invalid or failed unverified saves preserve the working credentials and token', async () => {
  const f = fixture();
  await f.connection.connect(first);
  await assert.rejects(
    f.connection.save({ applicationId: 'invalid:id', applicationSecret: 'anything' }),
    /valid application ID/,
  );
  assert.equal(f.writes(), 1);
  f.failWrite();
  await assert.rejects(f.connection.save(second), (error: Error) => {
    assert.doesNotMatch(error.message + error.stack, /private-test/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(f.saved(), first);
  assert.equal((await f.connection.status()).state, 'verified');
  assert.equal(await f.connection.getAccessToken(), 'private-test-token-1');
  assert.equal(f.calls(), 1);
});

test('backend token cache renews ahead of returned expiry and explicit check verifies again', async () => {
  const f = fixture();
  await f.connection.connect(first);
  assert.equal(await f.connection.getAccessToken(), 'private-test-token-1');
  assert.equal(f.calls(), 1);
  f.advance(61_000);
  assert.equal(await f.connection.getAccessToken(), 'private-test-token-2');
  assert.equal(f.calls(), 2);
  await f.connection.check();
  assert.equal(f.calls(), 3);
});

test('failed replacement authentication and protected writes preserve the earlier working connection', async () => {
  for (const failure of ['authentication', 'storage']) {
    const f = fixture();
    await f.connection.connect(first);
    if (failure === 'authentication') f.failAuth();
    else f.failWrite();
    await assert.rejects(f.connection.connect(second), (error: Error) => {
      assert.doesNotMatch(error.message + error.stack, /private-test/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(f.saved(), first);
    assert.equal((await f.connection.status()).state, 'verified');
    assert.equal(await f.connection.getAccessToken(), 'private-test-token-1');
  }
});

test('restart reports saved credentials as requiring a check without making network calls', async () => {
  const f = fixture();
  await f.connection.connect(first);
  let requests = 0;
  const reopened = new FlipkartConnection(resolve('.data/test-not-used'), 'live', {
    credentialStore: f.store,
    client: {
      async createAccessToken() {
        requests++;
        throw new Error('must not run');
      },
    },
  });
  assert.equal((await reopened.status()).state, 'needs-attention');
  assert.equal(requests, 0);
});

test('sample mode and unsupported credential protection never save credentials or contact Flipkart', async () => {
  for (const f of [fixture('demo'), fixture('live', false)]) {
    assert.equal((await f.connection.status()).state, 'unavailable');
    await assert.rejects(f.connection.connect(first), /Windows|sample/);
    await assert.rejects(f.connection.save(first), /Windows|sample/);
    await assert.rejects(f.connection.check(), /Windows|sample/);
    await assert.rejects(f.connection.getAccessToken(), /Windows|sample/);
    await assert.rejects(f.connection.disconnect(), /Windows|sample/);
    assert.equal(f.calls(), 0);
    assert.equal(f.writes(), 0);
  }
});

test('disconnect removes saved access and cannot be undone by an earlier in-flight connect', async () => {
  const f = fixture();
  const connecting = f.connection.connect(first);
  const disconnecting = f.connection.disconnect();
  await connecting;
  const disconnected = await disconnecting;
  assert.equal(disconnected.state, 'not-configured');
  assert.equal(f.saved(), null);
  await assert.rejects(f.connection.getAccessToken(), /Connect.*first/);
  assert.equal((await f.connection.status()).state, 'not-configured');
});

test('expired or rejected authorization cannot be returned as a working token', async () => {
  const f = fixture();
  await f.connection.connect(first);
  f.advance(121_000);
  assert.equal((await f.connection.status()).state, 'needs-attention');
  f.failAuth();
  await assert.rejects(f.connection.getAccessToken(), /rejected/);
  assert.equal((await f.connection.status()).state, 'needs-attention');
  assert.match((await f.connection.status()).message, /rejected/);
  assert.deepEqual(f.saved(), first);
});

test('shutdown rejects queued/new operations and idle waits for the queue', async () => {
  const f = fixture();
  f.connection.stop();
  await assert.rejects(f.connection.connect(first), /stopping/);
  await f.connection.idle();
  assert.equal(f.calls(), 0);
  assert.equal(f.writes(), 0);
});
