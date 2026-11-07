import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../shared/contracts.js';
import { backupDatabase } from './storage/backup.js';
import { prepareDatabase } from './storage/migrations.js';
import { readSnapshot, writeSnapshot } from './storage/records.js';
import { CURRENT_SCHEMA_VERSION } from './storage/schema.js';

/** SQLite owns records and transactions; callers receive a detached read model. */
export class Store {
  readonly schemaVersion = CURRENT_SCHEMA_VERSION;
  readonly migrationBackupPath: string | null;
  private readonly database: DatabaseSync;

  constructor(
    readonly file: string,
    private readonly mode: Snapshot['mode'],
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.migrationBackupPath = prepareDatabase(this.database, file, mode);
      this.database.exec('PRAGMA journal_mode = WAL;');
      this.update((state) => {
        state.connection.nextPoll = null;
        if (mode === 'live') {
          state.connection.tally = 'not-checked';
          state.connection.message = 'Fresh Tally verification required after startup.';
        }
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  read(): Snapshot {
    this.database.exec('BEGIN');
    try {
      const state = readSnapshot(this.database);
      this.database.exec('COMMIT');
      return state;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  update<T>(change: (state: Snapshot) => T): T {
    // Lock before reading so another Store cannot overwrite a newer commit
    // using an old in-memory snapshot.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const state = readSnapshot(this.database);
      const result = change(state);
      if (state.mode !== this.mode)
        throw new Error('The workspace mode cannot be changed after creation.');
      writeSnapshot(this.database, state);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  backup(target: string): void {
    backupDatabase(this.database, target);
  }

  close(): void {
    this.database.close();
  }
}
