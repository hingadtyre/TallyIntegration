import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { recordActivity } from './activity.js';
import { writeBackupManifest } from './storage/backup.js';
import type { Store } from './store.js';
import { isFullyQualifiedPath } from './filesystem-path.js';
import { InputError } from './validation.js';

export function createBackup(store: Store): { path: string; verified: true } {
  const state = store.read();
  if (!isFullyQualifiedPath(state.settings.backupFolder, true))
    throw new InputError(
      'Choose a fully qualified backup folder in Settings before creating a backup.',
    );
  const createdAt = new Date().toISOString();
  mkdirSync(state.settings.backupFolder, { recursive: true });
  const filename = `stockbridge-${state.mode}-${createdAt.replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.sqlite`;
  const path = join(state.settings.backupFolder, filename);
  store.backup(path);
  writeBackupManifest(path, store.schemaVersion, state.mode, createdAt);
  store.update((current) =>
    recordActivity(current, 'backup', 'A verified local backup was created.'),
  );
  return { path, verified: true };
}
