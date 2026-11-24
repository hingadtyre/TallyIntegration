import assert from 'node:assert/strict';
import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  ProtectedFlipkartCredentialStore,
  WindowsCredentialProtector,
  type CredentialProtector,
} from '../../src/server/flipkart-credentials.js';

const credentials = {
  applicationId: 'example-application',
  applicationSecret: 'private-test-secret',
};

function directory(t: TestContext): string {
  const result = mkdtempSync(join(tmpdir(), 'stockbridge-flipkart-vault-'));
  t.after(() => {
    const target = resolve(result);
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('stockbridge-flipkart-vault-')
    )
      throw new Error('Invalid test cleanup path.');
    rmSync(target, { recursive: true, force: true });
  });
  return result;
}

function protector(): CredentialProtector {
  const key = randomBytes(32);
  return {
    available: true,
    async protect(value, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(context);
      const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async unprotect(value, context) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAAD(context);
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]);
    },
  };
}

test('credential file contains only protected data and round trips separately from SQLite', async (t) => {
  const folder = directory(t);
  const protection = protector();
  const store = new ProtectedFlipkartCredentialStore(folder, protection);
  assert.equal(await store.read(), null);
  await store.write(credentials);
  assert.deepEqual(
    await new ProtectedFlipkartCredentialStore(folder, protection).read(),
    credentials,
  );
  assert.deepEqual(readdirSync(folder), ['flipkart-self-access.credentials']);
  const saved = readFileSync(join(folder, 'flipkart-self-access.credentials'), 'utf8');
  assert.doesNotMatch(saved, /example-application|private-test-secret/);
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['protected', 'version']);
  await store.remove();
  assert.equal(await store.read(), null);
});

test('protected credentials cannot be transferred to a different workspace', async (t) => {
  const first = directory(t);
  const second = directory(t);
  const protection = protector();
  await new ProtectedFlipkartCredentialStore(first, protection).write(credentials);
  writeFileSync(
    join(second, 'flipkart-self-access.credentials'),
    readFileSync(join(first, 'flipkart-self-access.credentials')),
  );
  await assert.rejects(
    new ProtectedFlipkartCredentialStore(second, protection).read(),
    /could not be unlocked/,
  );
});

test('a failed protected replacement preserves the existing file and creates no plaintext leftovers', async (t) => {
  const folder = directory(t);
  const protection = protector();
  const original = new ProtectedFlipkartCredentialStore(folder, protection);
  await original.write(credentials);
  const file = join(folder, 'flipkart-self-access.credentials');
  const before = readFileSync(file);
  const failed = new ProtectedFlipkartCredentialStore(folder, {
    ...protection,
    async protect() {
      throw new Error('private-test-secret hidden platform error');
    },
  });
  await assert.rejects(
    failed.write({ applicationId: 'replacement', applicationSecret: 'replacement-secret' }),
    (error: Error) => {
      assert.match(error.message, /Previous credentials were retained/);
      assert.doesNotMatch(error.stack ?? '', /private-test-secret/);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(await original.read(), credentials);
  assert.deepEqual(readdirSync(folder), ['flipkart-self-access.credentials']);
});

test('corrupt credential contents are sanitized and can be disconnected without decrypting', async (t) => {
  const folder = directory(t);
  const file = join(folder, 'flipkart-self-access.credentials');
  writeFileSync(file, '{private-test-secret');
  const store = new ProtectedFlipkartCredentialStore(folder, protector());
  await assert.rejects(store.read(), (error: Error) => {
    assert.match(error.message, /could not be unlocked/);
    assert.doesNotMatch(error.stack ?? '', /private-test-secret/);
    return true;
  });
  await store.remove();
  assert.ok(!existsSync(file));
});

test('unavailable protection never falls back to plaintext storage', async (t) => {
  const folder = directory(t);
  const store = new ProtectedFlipkartCredentialStore(folder, { ...protector(), available: false });
  await assert.rejects(store.write(credentials), /Windows/);
  await assert.rejects(store.read(), /Windows/);
  assert.deepEqual(readdirSync(folder), []);
});

function startTestHelper(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdio: ChildProcessWithoutNullStreams['stdio'] = [stdin, stdout, stderr, null, null];
  const child = Object.assign(new ChildProcess(), {
    stdin,
    stdout,
    stderr,
    stdio,
    kill: t.mock.fn(() => true),
  });
  const protector = new WindowsCredentialProtector(() => child);
  const result = protector.protect(Buffer.from('test value'), Buffer.from('test context'));
  return { child, result };
}

const windowsOnly = { skip: process.platform !== 'win32' };

test(
  'the Windows helper can start slowly and return its ready marker with output',
  windowsOnly,
  async (t) => {
    const { child, result } = startTestHelper(t);
    t.mock.timers.tick(12_000);
    assert.equal(child.kill.mock.callCount(), 0);
    child.stdout.write('!Z');
    child.stdout.write('m8=');
    child.emit('close', 0);
    assert.deepEqual(await result, Buffer.from('fo'));
    t.mock.timers.tick(60_000);
    assert.equal(child.kill.mock.callCount(), 0);
  },
);

test('the Windows helper must signal readiness within 60 seconds', windowsOnly, async (t) => {
  const { child, result } = startTestHelper(t);
  const rejected = assert.rejects(result, /Windows could not protect or unlock/);
  t.mock.timers.tick(59_999);
  assert.equal(child.kill.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(child.kill.mock.callCount(), 1);
  await rejected;
});

test('readiness starts a separate 10-second Windows operation deadline', windowsOnly, async (t) => {
  const { child, result } = startTestHelper(t);
  const rejected = assert.rejects(result, /Windows could not protect or unlock/);
  t.mock.timers.tick(59_000);
  child.stdout.write('!');
  t.mock.timers.tick(9_999);
  assert.equal(child.kill.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(child.kill.mock.callCount(), 1);
  await rejected;
});

test(
  'the Windows helper rejects missing, repeated and malformed output markers',
  windowsOnly,
  async (t) => {
    for (const output of ['', 'Zm8=', '!!Zm8=', '!bad']) {
      const { child, result } = startTestHelper(t);
      const rejected = assert.rejects(result, /Windows could not protect or unlock/);
      if (output) child.stdout.write(output);
      child.emit('close', 0);
      await rejected;
      t.mock.timers.reset();
    }
  },
);

test(
  'Windows current-user DPAPI protects credentials and rejects another workspace context',
  // Each of the three helpers has up to 60 seconds to start and 10 seconds to finish.
  { ...windowsOnly, timeout: 220_000 },
  async (t) => {
    const folder = directory(t);
    const store = new ProtectedFlipkartCredentialStore(folder, new WindowsCredentialProtector());
    await store.write(credentials);
    assert.deepEqual(await store.read(), credentials);
    const protectedFile = readFileSync(join(folder, 'flipkart-self-access.credentials'));
    assert.ok(!protectedFile.includes(Buffer.from(credentials.applicationSecret)));
    const other = directory(t);
    writeFileSync(join(other, 'flipkart-self-access.credentials'), protectedFile);
    await assert.rejects(
      new ProtectedFlipkartCredentialStore(other).read(),
      /could not be unlocked/,
    );
  },
);
