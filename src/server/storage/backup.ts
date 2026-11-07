import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
