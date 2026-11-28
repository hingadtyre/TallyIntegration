import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function backupDigest(file: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(file, 'r');
  try {
    let length: number;
    while ((length = readSync(descriptor, buffer)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}

export function writeBackupManifest(
  file: string,
  schemaVersion: number,
  mode: 'demo' | 'live',
  createdAt: string,
  reason?: 'before-pilot-restore' | 'before-upgrade',
): void {
  const manifest = {
    createdAt,
    schemaVersion,
    mode,
    sha256: backupDigest(file),
    verified: true,
    credentialsIncluded: false,
    restoreSupported: true,
    restoreScope: 'offline-pilot-only',
    reason,
  };
  writeFileSync(file + '.json', JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
}

/** VACUUM INTO includes committed WAL changes and needs no active source transaction. */
export function backupDatabase(database: DatabaseSync, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').get();
    if (
      integrity?.integrity_check !== 'ok' ||
      copy.prepare('PRAGMA foreign_key_check').all().length > 0
    ) {
      throw new Error('Backup verification failed. The active database was not replaced.');
    }
  } finally {
    copy.close();
  }
}
