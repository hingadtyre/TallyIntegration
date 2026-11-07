import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordActivity } from './activity.js';
import type { Store } from './store.js';

export function createBackup(store: Store): { path: string; verified: true } {
  const state = store.read();
  const createdAt = new Date().toISOString();
  mkdirSync(state.settings.backupFolder, { recursive: true });
  const filename = `stockbridge-${state.mode}-${createdAt.replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.sqlite`;
  const path = join(state.settings.backupFolder, filename);
  store.backup(path);
  const manifest = {
    createdAt,
    schemaVersion: store.schemaVersion,
    mode: state.mode,
    verified: true,
    credentialsIncluded: false,
    restoreSupported: false,
  };
  writeFileSync(`${path}.json`, JSON.stringify(manifest, null, 2));
  store.update((current) =>
    recordActivity(current, 'backup', 'A verified local backup was created.'),
  );
  return { path, verified: true };
}
