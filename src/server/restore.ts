import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../shared/contracts.js';
import { recordActivity } from './activity.js';
import { acquireWorkspaceOwnership } from './runtime.js';
import { backupDatabase } from './storage/backup.js';
import { readSnapshot, writeSnapshot } from './storage/records.js';
import {
  readMarketplace,
  validateMarketplace,
  writeMarketplace,
  type MarketplaceData,
} from './storage/marketplace-records.js';
import { createSchema, CURRENT_SCHEMA_VERSION, schemaVersion } from './storage/schema.js';

type WorkspaceMode = Snapshot['mode'];

export interface PilotBackupPreview {
  backupFile: string;
  createdAt: string;
  mode: WorkspaceMode;
  schemaVersion: number;
  sha256: string;
  companies: { id: string; name: string }[];
  sellerAccounts: { id: string; name: string; marketplace: 'flipkart' }[];
  counts: {
    companies: number;
    stockItems: number;
    listings: number;
    proposals: number;
    activity: number;
  };
  publishingEnabled: false;
}

function requireLocalAbsolutePath(file: string): void {
  if (!isAbsolute(file) || file.includes('\0') || file.replaceAll('\\', '/').startsWith('//')) {
    throw new Error('Choose an absolute local file or folder path, not a network or device path.');
  }
}

function requireMode(mode: string): asserts mode is WorkspaceMode {
  if (mode !== 'live' && mode !== 'demo')
    throw new Error('Choose exactly one workspace mode: live or demo.');
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function requireNoSidecars(file: string): void {
  if (['-wal', '-shm', '-journal'].some((suffix) => existsSync(file + suffix))) {
    throw new Error(
      'This file has SQLite working files beside it. Select a completed verified backup, not an active database.',
    );
  }
}

function readCheckedSnapshot(database: DatabaseSync, mode: WorkspaceMode): Snapshot {
  const version = schemaVersion(database);
  if (version !== 2 && version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Offline pilot restore only accepts schemas 2 and ${CURRENT_SCHEMA_VERSION}. Other schemas must not be replaced with this tool.`,
    );
  }
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (
    integrity.length !== 1 ||
    integrity[0].integrity_check !== 'ok' ||
    database.prepare('PRAGMA foreign_key_check').all().length !== 0
  ) {
    throw new Error(
      'The database did not pass its integrity and relationship checks. Nothing was replaced.',
    );
  }
  const snapshot = readSnapshot(database);
  if (version === CURRENT_SCHEMA_VERSION) readMarketplace(database);
  if (snapshot.mode !== mode)
    throw new Error('The backup and destination must use the same live or demo workspace mode.');
  return snapshot;
}

function loadBackup(
  file: string,
  mode: WorkspaceMode,
): { preview: PilotBackupPreview; snapshot: Snapshot; marketplace: MarketplaceData } {
  requireMode(mode);
  requireLocalAbsolutePath(file);
  const backupFile = realpathSync.native(file);
  requireLocalAbsolutePath(backupFile);
  if (!lstatSync(backupFile).isFile()) throw new Error('Choose a completed SQLite backup file.');
  requireNoSidecars(backupFile);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(`${backupFile}.json`, 'utf8'));
  } catch (error) {
    throw new Error(
      'The matching backup manifest (.json) is missing or unreadable. Keep it beside the completed backup.',
      { cause: error },
    );
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('verified' in manifest) ||
    manifest.verified !== true ||
    !('schemaVersion' in manifest) ||
    (manifest.schemaVersion !== 2 && manifest.schemaVersion !== CURRENT_SCHEMA_VERSION) ||
    !('mode' in manifest) ||
    manifest.mode !== mode ||
    !('credentialsIncluded' in manifest) ||
    manifest.credentialsIncluded !== false ||
    !('restoreSupported' in manifest) ||
    !(
      manifest.restoreSupported === false ||
      (manifest.restoreSupported === true &&
        'restoreScope' in manifest &&
        manifest.restoreScope === 'offline-pilot-only')
    ) ||
    !('createdAt' in manifest) ||
    typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  ) {
    throw new Error(
      'The backup needs its matching verified manifest for this workspace mode and current schema.',
    );
  }
  const bytes = readFileSync(backupFile);
  if (bytes.length < 100 || !bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
    throw new Error('Select a valid, completed SQLite backup file.');
  }
  // Even read-only SQLite can create WAL/SHM files. Reject WAL before opening it.
  // These format bytes are defined at https://www.sqlite.org/fileformat.html#the_database_header.
  if (bytes[18] !== 1 || bytes[19] !== 1) {
    throw new Error(
      'Select a self-contained verified backup. A database configured for active WAL use cannot be restored directly.',
    );
  }
  const before = createHash('sha256').update(bytes).digest('hex');
  const database = new DatabaseSync(backupFile, { readOnly: true });
  let snapshot: Snapshot;
  let marketplace: MarketplaceData;
  try {
    if (database.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') {
      throw new Error(
        'Select a self-contained verified backup. A database configured for active WAL use cannot be restored directly.',
      );
    }
    database.exec('BEGIN');
    if (schemaVersion(database) !== manifest.schemaVersion)
      throw new Error('The backup schema does not match its manifest. Nothing was replaced.');
    snapshot = readCheckedSnapshot(database, mode);
    marketplace =
      manifest.schemaVersion === 2
        ? { accounts: [], listings: [], changes: [] }
        : readMarketplace(database);
    if (hashFile(backupFile) !== before)
      throw new Error('The backup changed during inspection. Inspect a completed backup again.');
    database.exec('COMMIT');
  } finally {
    database.close();
  }
  requireNoSidecars(backupFile);
  return {
    snapshot,
    marketplace,
    preview: {
      backupFile,
      createdAt: manifest.createdAt,
      mode,
      schemaVersion: manifest.schemaVersion,
      sha256: before,
      companies: snapshot.companies.map(({ id, name }) => ({ id, name })),
      sellerAccounts: snapshot.accounts.map(({ id, name, marketplace }) => ({
        id,
        name,
        marketplace,
      })),
      counts: {
        companies: snapshot.companies.length,
        stockItems: snapshot.items.length,
        listings: snapshot.listings.length,
        proposals: snapshot.proposals.length,
        activity: snapshot.activity.length,
      },
      publishingEnabled: false,
    },
  };
}

/** Read-only preview. The returned digest binds the later confirmation to this backup. */
export function inspectPilotBackup(file: string, mode: WorkspaceMode): PilotBackupPreview {
  return loadBackup(file, mode).preview;
}

function restoredSnapshot(
  backup: Snapshot,
  current: Snapshot,
  marketplace: MarketplaceData,
): Snapshot {
  const restored = structuredClone(backup);
  // Retained marketplace recovery records need their account parent, even when
  // the account was first added after the selected backup.
  for (const account of current.accounts)
    if (
      marketplace.accounts.some((row) => row.id === account.id) &&
      !restored.accounts.some((row) => row.id === account.id)
    )
      restored.accounts.push(structuredClone(account));
  restored.settings = structuredClone(current.settings);
  restored.connection = {
    tally: 'not-checked',
    message: 'Backup restored. Refresh source stock before reviewing changes.',
    lastChecked: null,
    nextPoll: null,
  };
  restored.publishingEnabled = false;
  for (const company of restored.companies) {
    company.automation = false;
    company.lastSuccess = null;
  }
  for (const item of restored.items) {
    item.observedAt = null;
    item.version++;
  }
  for (const listing of restored.listings) {
    if (!listing.paused) listing.version++;
    listing.paused = true;
    listing.observedAt = null;
  }
  for (const account of restored.accounts)
    account.status = restored.mode === 'demo' ? 'demo' : 'not-connected';
  for (const proposal of restored.proposals) {
    proposal.itemVersion = -1;
    proposal.stale = true;
  }
  recordActivity(
    restored,
    'pilot-restore',
    'A backup was restored. Refresh Tally and verify each marketplace account with a fresh listing import. Uncertain updates must be checked, not replayed. Automatic Inventory publishing remains disabled.',
  );
  return restored;
}

function syncFile(file: string): void {
  const descriptor = openSync(file, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function requirePreservedStockRestrictions(restored: Snapshot, current: Snapshot): void {
  for (const listing of current.listings) {
    if (listing.policy === 'auto' && !listing.paused) continue;
    const destinations = restored.listings.filter(
      (row) =>
        row.accountId === listing.accountId &&
        row.sku === listing.sku &&
        row.location === listing.location,
    );
    if (listing.paused && destinations.length === 0)
      throw new Error(
        'The backup would remove a currently paused stock destination. Reconcile marketplace policies before restoring.',
      );
    if (listing.policy === 'auto') continue;
    const protectedDestination = destinations.some(
      (row) =>
        row.policy === 'hold' ||
        (listing.policy === 'limited' &&
          row.policy === 'limited' &&
          row.remaining !== null &&
          listing.remaining !== null &&
          row.remaining <= listing.remaining),
    );
    if (!protectedDestination)
      throw new Error(
        'The backup would remove or weaken a current stock restriction. Reconcile marketplace policies before restoring.',
      );
  }
}

function restoredMarketplace(backup: MarketplaceData, current: MarketplaceData): MarketplaceData {
  const restored = structuredClone(backup);
  const unfinished = current.changes.filter((change) =>
    ['pending', 'sending', 'checking', 'uncertain'].includes(change.state),
  );
  // A database rollback cannot undo a request already sent to Flipkart or the
  // seller identity verified against this machine's retained credentials.
  for (const account of current.accounts) {
    const saved = restored.accounts.find((row) => row.id === account.id);
    if (saved) {
      if (saved.sellerId && account.sellerId && saved.sellerId !== account.sellerId)
        throw new Error('The backup conflicts with a current marketplace seller binding.');
      saved.sellerId = account.sellerId ?? saved.sellerId;
    } else if (
      account.sellerId ||
      unfinished.some((row) => row.accountId === account.id) ||
      current.listings.some((row) => row.accountId === account.id)
    ) {
      restored.accounts.push(structuredClone(account));
    }
  }
  for (const change of unfinished) {
    const saved = restored.changes.find((row) => row.id === change.id);
    if (
      saved &&
      (saved.accountId !== change.accountId ||
        saved.listingId !== change.listingId ||
        saved.sku !== change.sku ||
        JSON.stringify(saved.edit) !== JSON.stringify(change.edit))
    )
      throw new Error('The backup conflicts with a current unfinished marketplace update.');
    if (saved) restored.changes[restored.changes.indexOf(saved)] = structuredClone(change);
    else restored.changes.push(structuredClone(change));
  }
  // Keep every known listing identity and version, including listings added
  // since the backup. Otherwise an open pre-restore editor can become valid
  // again when refresh increments a rolled-back version to its old value.
  for (const listing of current.listings) {
    const savedListing = restored.listings.find(
      (row) => row.accountId === listing.accountId && row.id === listing.id,
    );
    const savedSku = restored.listings.find(
      (row) => row.accountId === listing.accountId && row.sku === listing.sku,
    );
    if (
      (savedListing &&
        (savedListing.sellerId !== listing.sellerId ||
          savedListing.productId !== listing.productId ||
          savedListing.sku !== listing.sku)) ||
      (savedSku && savedSku.id !== listing.id)
    )
      throw new Error('The backup conflicts with a current marketplace listing identity.');
    if (savedListing) savedListing.version = Math.max(savedListing.version, listing.version);
    else restored.listings.push(structuredClone(listing));
  }
  for (const account of restored.accounts) account.lastRefreshedAt = null;
  for (const listing of restored.listings) {
    listing.observedAt = null;
    listing.version++;
  }
  for (const change of restored.changes) {
    if (['pending', 'sending', 'checking', 'uncertain'].includes(change.state)) {
      change.state = 'uncertain';
      change.message =
        'Restored from backup. Verify the seller and refresh listings before checking this result; do not resend it automatically.';
      change.updatedAt = new Date().toISOString();
    }
  }
  return validateMarketplace(restored);
}

function writeStage(file: string, snapshot: Snapshot, marketplace: MarketplaceData): void {
  const database = new DatabaseSync(file);
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    createSchema(database);
    writeSnapshot(database, snapshot);
    writeMarketplace(database, marketplace);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}; COMMIT;`);
    readCheckedSnapshot(database, snapshot.mode);
  } finally {
    database.close();
  }
  requireNoSidecars(file);
  syncFile(file);
}

export async function restorePilotBackup(options: {
  backupFile: string;
  mode: WorkspaceMode;
  dataDirectory: string;
  expectedSha256: string;
  confirmReplace: boolean;
}): Promise<{
  restored: true;
  mode: WorkspaceMode;
  destination: string;
  safetyBackup: string;
  publishingEnabled: false;
  requiresFreshRead: true;
}> {
  requireMode(options.mode);
  if (options.confirmReplace !== true || !/^[a-f0-9]{64}$/.test(options.expectedSha256)) {
    throw new Error(
      'Inspect the backup first, then supply its SHA-256 and explicit --confirm-replace.',
    );
  }
  const owner = await acquireWorkspaceOwnership(options.dataDirectory, options.mode);
  const destination = join(owner.dataDirectory, `${options.mode}.sqlite`);
  const identifier = randomUUID();
  const stage = join(owner.dataDirectory, `.${options.mode}.restore-${identifier}.sqlite`);
  let database: DatabaseSync | undefined;
  let safetyBackup: string | undefined;
  try {
    const source = loadBackup(options.backupFile, options.mode);
    if (source.preview.sha256 !== options.expectedSha256)
      throw new Error(
        'The backup differs from the inspected preview. Inspect it again before confirming replacement.',
      );
    if (!existsSync(destination))
      throw new Error(
        'Start and stop this workspace once before restoring so its local settings can be preserved.',
      );
    const destinationInfo = lstatSync(destination);
    if (
      !destinationInfo.isFile() ||
      destinationInfo.isSymbolicLink() ||
      destinationInfo.nlink !== 1
    )
      throw new Error('The destination must be one ordinary local database file, not a link.');
    const destinationPath = realpathSync.native(destination);
    const sameFile =
      process.platform === 'win32'
        ? destinationPath.toLowerCase() === source.preview.backupFile.toLowerCase()
        : destinationPath === source.preview.backupFile;
    if (sameFile)
      throw new Error('Choose a separate verified backup, not the destination database itself.');

    database = new DatabaseSync(destination);
    database.exec(
      'PRAGMA busy_timeout = 1000; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;',
    );
    // SQLite checkpoints and removes its own WAL/SHM files. Never delete those files ourselves.
    if (database.prepare('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete') {
      throw new Error(
        'Could not make the offline destination self-contained. Close other database tools and retry.',
      );
    }
    const current = readCheckedSnapshot(database, options.mode);
    const currentMarketplace =
      schemaVersion(database) === 2
        ? { accounts: [], listings: [], changes: [] }
        : readMarketplace(database);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const safetyCandidate = join(
      owner.dataDirectory,
      'restore-backups',
      `before-pilot-restore-${options.mode}-${stamp}-${identifier}.sqlite`,
    );
    backupDatabase(database, safetyCandidate);
    safetyBackup = safetyCandidate;
    writeFileSync(
      `${safetyBackup}.json`,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          schemaVersion: schemaVersion(database),
          mode: options.mode,
          verified: true,
          credentialsIncluded: false,
          restoreSupported: true,
          restoreScope: 'offline-pilot-only',
          reason: 'before-pilot-restore',
        },
        null,
        2,
      ),
      { flag: 'wx', mode: 0o600 },
    );
    syncFile(safetyBackup);
    syncFile(`${safetyBackup}.json`);
    const marketplace = restoredMarketplace(source.marketplace, currentMarketplace);
    const snapshot = restoredSnapshot(source.snapshot, current, marketplace);
    requirePreservedStockRestrictions(snapshot, current);
    writeStage(stage, snapshot, marketplace);
    if (hashFile(source.preview.backupFile) !== options.expectedSha256)
      throw new Error('The backup changed before replacement. Inspect it again.');
    database.close();
    database = undefined;
    requireNoSidecars(destination);
    // One same-volume rename replaces the closed database; there is no delete-then-copy gap.
    renameSync(stage, destination);
    return {
      restored: true,
      mode: options.mode,
      destination,
      safetyBackup,
      publishingEnabled: false,
      requiresFreshRead: true,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown restore error.';
    throw new Error(
      `Pilot restore did not replace the workspace. ${detail}${safetyBackup ? ` Safety copy retained at ${safetyBackup}.` : ''}`,
      { cause: error },
    );
  } finally {
    try {
      database?.close();
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        rmSync(stage + suffix, { force: true });
    } finally {
      await owner.release();
    }
  }
}
