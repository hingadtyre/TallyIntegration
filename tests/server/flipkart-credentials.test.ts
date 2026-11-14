import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
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

test(
  'Windows current-user DPAPI protects credentials and rejects another workspace context',
  { skip: process.platform !== 'win32', timeout: 20_000 },
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
