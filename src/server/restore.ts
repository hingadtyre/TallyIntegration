import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../shared/contracts.js';
import { recordActivity } from './activity.js';
import { cataloguesOverlap } from './marketplace-catalog.js';
import { acquireWorkspaceOwnership } from './runtime.js';
import { isFullyQualifiedPath } from './filesystem-path.js';
import { backupDatabase, backupDigest, writeBackupManifest } from './storage/backup.js';
import { readBilling, writeBilling, type BillingData } from './storage/billing-records.js';
import { readSnapshot, writeSnapshot } from './storage/records.js';
import {
  readMarketplace,
  validateMarketplace,
  writeMarketplace,
  type MarketplaceData,
} from './storage/marketplace-records.js';
import { createSchema, CURRENT_SCHEMA_VERSION, schemaVersion } from './storage/schema.js';
import { verifyStockCoverage } from './storage/stock-coverage.js';
import { verifyBillingOrders } from './storage/billing-orders.js';

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
  if (!isFullyQualifiedPath(file)) {
    throw new Error('Choose an absolute local file or folder path, not a network or device path.');
  }
}

function requireMode(mode: string): asserts mode is WorkspaceMode {
  if (mode !== 'live' && mode !== 'demo')
    throw new Error('Choose exactly one workspace mode: live or demo.');
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
  if (version < 2 || version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Offline pilot restore accepts schemas 2 through ${CURRENT_SCHEMA_VERSION}.`);
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
  if (version >= 3) readMarketplace(database);
  if (version >= 6) verifyStockCoverage(database);
  if (version >= 14) verifyBillingOrders(database);
  if (snapshot.mode !== mode)
    throw new Error('The backup and destination must use the same live or demo workspace mode.');
  return snapshot;
}

function loadBackup(
  file: string,
  mode: WorkspaceMode,
): {
  preview: PilotBackupPreview;
  snapshot: Snapshot;
  marketplace: MarketplaceData;
  billing: BillingData;
} {
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
    typeof manifest.schemaVersion !== 'number' ||
    !Number.isInteger(manifest.schemaVersion) ||
    manifest.schemaVersion < 2 ||
    manifest.schemaVersion > CURRENT_SCHEMA_VERSION ||
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
  const header = Buffer.alloc(100);
  const descriptor = openSync(backupFile, 'r');
  try {
    if (
      readSync(descriptor, header) !== 100 ||
      !header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))
    )
      throw new Error('Select a valid, completed SQLite backup file.');
  } finally {
    closeSync(descriptor);
  }
  // Even read-only SQLite can create WAL/SHM files. Reject WAL before opening it.
  // These format bytes are defined at https://www.sqlite.org/fileformat.html#the_database_header.
  if (header[18] !== 1 || header[19] !== 1) {
    throw new Error(
      'Select a self-contained verified backup. A database configured for active WAL use cannot be restored directly.',
    );
  }
  const before = backupDigest(backupFile);
  if ('sha256' in manifest && manifest.sha256 !== before)
    throw new Error(
      'The backup contents do not match the SHA-256 in its manifest. Select the matching pair.',
    );
  const database = new DatabaseSync(backupFile, { readOnly: true });
  let snapshot: Snapshot;
  let marketplace: MarketplaceData;
  let billing: BillingData;
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
    billing = manifest.schemaVersion >= 5 ? readBilling(database) : { rules: [], links: [] };
    marketplace =
      manifest.schemaVersion === 2
        ? { accounts: [], listings: [], changes: [] }
        : readMarketplace(database);
    if (backupDigest(backupFile) !== before)
      throw new Error('The backup changed during inspection. Inspect a completed backup again.');
    database.exec('COMMIT');
  } finally {
    database.close();
  }
  requireNoSidecars(backupFile);
  return {
    snapshot,
    marketplace,
    billing,
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
    company.stockIssue = 'not-checked';
  }
  const currentVersions = new Map(current.items.map((item) => [item.id, item.version]));
  for (const item of restored.items) {
    item.observedAt = null;
    item.version = Math.max(item.version, currentVersions.get(item.id) ?? 0) + 1;
  }
  const currentListingVersions = new Map(current.listings.map((row) => [row.id, row.version]));
  for (const listing of restored.listings) {
    listing.version = Math.max(listing.version, currentListingVersions.get(listing.id) ?? 0) + 1;
    listing.paused = true;
    delete listing.proposalIssue;
    delete listing.orderProposalPending;
    listing.observedAt = null;
    if (listing.packageAvailable !== undefined) listing.packageAvailable = false;
    if (listing.syncPendingItemVersion != null) listing.syncPendingItemVersion = null;
    delete listing.orderSyncPending;
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
    'A backup was restored. In Inventory, choose Refresh inventory. Verify each marketplace account with a fresh listing import. Uncertain updates must be checked, not replayed. Automatic Inventory publishing remains disabled.',
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
        row.policy === 'limited' &&
        row.remaining !== null &&
        listing.remaining !== null &&
        row.remaining <= listing.remaining,
    );
    if (!protectedDestination)
      throw new Error(
        'The backup would remove or weaken a current stock restriction. Reconcile marketplace policies before restoring.',
      );
  }
}

function restoredMarketplace(backup: MarketplaceData, current: MarketplaceData): MarketplaceData {
  const restored = structuredClone(backup);
  const unsentHere = new Set<string>();
  const savedPositions = new Map(restored.changes.map((change, index) => [change.id, index]));
  // Current outcomes supersede older copies, including requests subsequently
  // reconciled. Otherwise an old backup could reopen a completed recovery.
  const preservedChanges = current.changes.filter(
    (change) =>
      ['pending', 'sending', 'checking', 'uncertain', 'reconciled'].includes(change.state) ||
      savedPositions.has(change.id),
  );
  // A database rollback cannot undo a request already sent to Flipkart or the
  // seller identity verified against this machine's retained credentials.
  for (const account of current.accounts) {
    const saved = restored.accounts.find((row) => row.id === account.id);
    if (saved) {
      if (saved.sellerId && account.sellerId && saved.sellerId !== account.sellerId)
        throw new Error('The backup conflicts with a current marketplace seller binding.');
      if (!saved.sellerId || !account.sellerId) {
        const previous = current.listings.filter((row) => row.accountId === account.id);
        const incoming = restored.listings.filter((row) => row.accountId === account.id);
        if (previous.length && incoming.length && !cataloguesOverlap(previous, incoming))
          throw new Error(
            'The backup conflicts with the current authenticated listing identities.',
          );
      }
      saved.sellerId = account.sellerId ?? saved.sellerId;
    } else if (
      account.sellerId ||
      preservedChanges.some((row) => row.accountId === account.id) ||
      current.listings.some((row) => row.accountId === account.id)
    ) {
      restored.accounts.push(structuredClone(account));
    }
  }
  for (const change of preservedChanges) {
    const position = savedPositions.get(change.id);
    const saved = position === undefined ? undefined : restored.changes[position];
    if (
      saved &&
      (saved.accountId !== change.accountId ||
        saved.listingId !== change.listingId ||
        saved.sku !== change.sku ||
        JSON.stringify(saved.edit) !== JSON.stringify(change.edit))
    )
      throw new Error('The backup conflicts with a current unfinished marketplace update.');
    if (
      change.stockRequestFinality === 'not-sent' &&
      (!saved || saved.stockRequestFinality === 'not-sent')
    )
      unsentHere.add(change.id);
    if (position !== undefined) restored.changes[position] = structuredClone(change);
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
        ((savedListing.sellerId &&
          listing.sellerId &&
          savedListing.sellerId !== listing.sellerId) ||
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
    listing.sellerId ??=
      restored.accounts.find((row) => row.id === listing.accountId)?.sellerId ?? null;
    listing.observedAt = null;
    listing.version++;
  }
  for (const change of restored.changes) {
    if (['pending', 'sending', 'checking', 'uncertain'].includes(change.state)) {
      // A backup can predate the actual dispatch of a prepared request. It
      // cannot prove that the request never left the original installation.
      if (change.stockRequestFinality === 'not-sent' && !unsentHere.has(change.id))
        delete change.stockRequestFinality;
      change.state = 'uncertain';
      change.message =
        'Restored from backup. Verify the seller and refresh listings before checking this result; do not resend it automatically.';
      change.updatedAt = new Date().toISOString();
    }
  }
  return validateMarketplace(restored);
}

function restoredBilling(
  saved: BillingData,
  current: BillingData,
  snapshot: Snapshot,
): BillingData {
  const companies = new Set(snapshot.companies.map((row) => row.id));
  const accounts = new Set(snapshot.accounts.map((row) => row.id));
  const retained = current.rules.filter(
    (rule) => companies.has(rule.companyId) && accounts.has(rule.accountId),
  );
  const key = (scope: { companyId: string; accountId: string }) =>
    JSON.stringify([scope.companyId, scope.accountId]);
  const currentScopes = new Set(retained.map(key));
  return {
    rules: [...retained, ...saved.rules.filter((row) => !currentScopes.has(key(row)))],
    links: [
      ...current.links.filter((row) => currentScopes.has(key(row))),
      ...saved.links.filter((row) => !currentScopes.has(key(row))),
    ],
  };
}

function writeStage(
  file: string,
  snapshot: Snapshot,
  marketplace: MarketplaceData,
  billing: BillingData,
): void {
  const database = new DatabaseSync(file);
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
    createSchema(database);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    writeSnapshot(database, snapshot);
    writeMarketplace(database, marketplace);
    writeBilling(database, billing);
    // A restored workspace must reconcile its starting stock again. An old
    // order journal can omit sales since the backup and cannot authorize increases.
    database.exec('COMMIT;');
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
    const currentBilling =
      schemaVersion(database) >= 5 ? readBilling(database) : { rules: [], links: [] };
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
    writeBackupManifest(
      safetyBackup,
      schemaVersion(database),
      options.mode,
      new Date().toISOString(),
      'before-pilot-restore',
    );
    syncFile(safetyBackup);
    syncFile(`${safetyBackup}.json`);
    const marketplace = restoredMarketplace(source.marketplace, currentMarketplace);
    const snapshot = restoredSnapshot(source.snapshot, current, marketplace);
    requirePreservedStockRestrictions(snapshot, current);
    writeStage(
      stage,
      snapshot,
      marketplace,
      restoredBilling(source.billing, currentBilling, snapshot),
    );
    if (backupDigest(source.preview.backupFile) !== options.expectedSha256)
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
