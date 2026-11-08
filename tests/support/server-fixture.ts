import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { InventoryService } from '../../src/server/service.js';
import { Store } from '../../src/server/store.js';
import type { Snapshot } from '../../src/shared/contracts.js';

function removeFixture(folder: string): void {
  const target = resolve(folder);
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('stockbridge-test-')
  ) {
    throw new Error('Refusing to remove a path outside this test fixture.');
  }
  rmSync(target, { recursive: true, force: true });
}

export function serverFixture(
  t: TestContext,
  mode: Snapshot['mode'] = 'demo',
  dependencies: ConstructorParameters<typeof InventoryService>[1] = {},
) {
  const folder = mkdtempSync(join(tmpdir(), 'stockbridge-test-'));
  const file = join(folder, 'state.sqlite');
  let store = new Store(file, mode);
  let service = new InventoryService(store, dependencies);
  t.after(async () => {
    service.stop();
    await service.idle();
    store.close();
    removeFixture(folder);
  });
  return {
    folder,
    file,
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    reopen() {
      service.stop();
      store.close();
      store = new Store(file, mode);
      service = new InventoryService(store, dependencies);
    },
  };
}

export function storageFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'stockbridge-test-'));
  const file = join(directory, 'state.sqlite');
  const stores: Store[] = [];
  t.after(() => {
    for (const store of stores) store.close();
    removeFixture(directory);
  });
  return {
    directory,
    file,
    open(mode: Snapshot['mode'] = 'demo') {
      const store = new Store(file, mode);
      stores.push(store);
      return store;
    },
  };
}

export function queryFile<T>(file: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file);
  try {
    return read(database);
  } finally {
    database.close();
  }
}

export async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}
