import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../../shared/contracts.js';
import { initialState } from '../seed.js';
import { backupDatabase } from './backup.js';
import { readSnapshot, writeSnapshot } from './records.js';
import { createSchema, CURRENT_SCHEMA_VERSION, schemaVersion } from './schema.js';
import { parseLegacySnapshot } from './validation.js';

function requireMode(state: Snapshot, mode: Snapshot['mode']): void {
  if (state.mode !== mode)
    throw new Error('Sample and real company data must use separate databases.');
}

function inTransaction(database: DatabaseSync, change: () => void): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    change();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function legacyJson(database: DatabaseSync): string {
  const row = database.prepare('SELECT data FROM app_state WHERE id = 1').get();
  if (typeof row?.data !== 'string')
    throw new Error('The legacy database has no valid application state.');
  return row.data;
}

/** Upgrade known schemas only. Require a validated, verified safety copy before
 * removing the legacy JSON table. Concurrent changes abort the upgrade. */
export function prepareDatabase(
  database: DatabaseSync,
  file: string,
  mode: Snapshot['mode'],
): string | null {
  const version = schemaVersion(database);
  if (version > CURRENT_SCHEMA_VERSION) throw new Error('This database needs a newer application.');
  if (version === CURRENT_SCHEMA_VERSION) {
    requireMode(readSnapshot(database), mode);
    return null;
  }
  if (version === 0) {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all();
    if (tables.length > 0)
      throw new Error('Unversioned database contains existing tables. It was not changed.');
    inTransaction(database, () => {
      createSchema(database);
      writeSnapshot(database, initialState(mode, join(dirname(file), 'backups')));
      database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    });
    return null;
  }
  if (version !== 1) throw new Error(`Unsupported database schema ${version}.`);

  const original = legacyJson(database);
  const state = parseLegacySnapshot(original);
  requireMode(state, mode);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = join(
    dirname(file),
    'migration-backups',
    `before-schema-v2-${stamp}-${randomUUID().slice(0, 8)}.sqlite`,
  );
  backupDatabase(database, backupPath);
  inTransaction(database, () => {
    if (schemaVersion(database) !== 1 || legacyJson(database) !== original) {
      throw new Error('The database changed during upgrade. Stop other app processes and retry.');
    }
    createSchema(database);
    writeSnapshot(database, state);
    database.exec(`DROP TABLE app_state; PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
  });
  return backupPath;
}
