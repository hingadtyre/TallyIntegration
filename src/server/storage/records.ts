import type { DatabaseSync } from 'node:sqlite';
import type { Snapshot } from '../../shared/contracts.js';
import { schemaVersion } from './schema.js';
import { validateSnapshot } from './validation.js';

type ColumnValue = string | number | null;
type Row = Record<string, ColumnValue>;
type TableName =
  | 'app_metadata'
  | 'settings'
  | 'connection_status'
  | 'companies'
  | 'seller_accounts'
  | 'stock_items'
  | 'listings'
  | 'sku_mappings'
  | 'listing_pack_settings'
  | 'proposals'
  | 'activity';

/** Reconstruct the API read model from explicit records. Store supplies a read
 * transaction so all these queries observe the same committed database state. */
export function readSnapshot(database: DatabaseSync): Snapshot {
  const version = schemaVersion(database);
  const metadata = database.prepare('SELECT mode FROM app_metadata WHERE id = 1').get();
  const settings = database
    .prepare(
      `
    SELECT tally_url AS tallyUrl, tally_seconds AS tallySeconds,
      marketplace_seconds AS marketplaceSeconds, catalog_seconds AS catalogSeconds,
      backup_folder AS backupFolder FROM settings WHERE id = 1
  `,
    )
    .get();
  const connection = database
    .prepare(
      `
    SELECT tally, message, last_checked AS lastChecked, next_poll AS nextPoll
    FROM connection_status WHERE id = 1
  `,
    )
    .get();
  const companies = database
    .prepare(
      `
    SELECT id, name, automation, source, last_success AS lastSuccess
      ${version >= 8 ? ', stock_issue AS stockIssue' : ''}
    FROM companies ORDER BY sort_order
  `,
    )
    .all()
    .map((row) => ({ ...row, automation: row.automation === 1 }));
  const accounts = database
    .prepare('SELECT id, marketplace, name, status FROM seller_accounts ORDER BY sort_order')
    .all();
  const items = database
    .prepare(
      `
    SELECT id, company_id AS companyId, external_id AS externalId, name, brand, unit,
      physical, observed_at AS observedAt, version, low_stock_threshold AS lowStockThreshold
    FROM stock_items ORDER BY sort_order
  `,
    )
    .all();
  const packs = new Map(
    (version >= 4 ? database.prepare('SELECT * FROM listing_pack_settings').all() : []).map(
      (row) => [row.listing_id, row],
    ),
  );
  const skuMappings = new Map(
    version >= 11
      ? database
          .prepare('SELECT * FROM sku_mappings')
          .all()
          .map((row) => [row.listing_id, row.marketplace_listing_id] as const)
      : [],
  );
  const listings = database
    .prepare(
      `
    SELECT id, account_id AS accountId, sku, title, location, item_id AS itemId,
      pack_size AS packSize, pack_evidence AS packEvidence, verified, observed,
      observed_at AS observedAt, policy, remaining, paused, version
      ${version >= 10 ? ', proposal_issue AS proposalIssue' : ''}
    FROM listings ORDER BY sort_order
  `,
    )
    .all()
    .map((row) => {
      const pack = packs.get(row.id);
      return {
        ...row,
        ...(skuMappings.has(row.id) && { skuMappingId: skuMappings.get(row.id) }),
        verified: row.verified === 1,
        paused: row.paused === 1,
        ...(pack && {
          packSource: pack.pack_source,
          packageCount: pack.package_count,
          packageObservedAt: pack.package_observed_at,
          packageAvailable: pack.package_available === 1,
          packConfirmedAt: pack.pack_confirmed_at,
          sourceScope: pack.source_scope,
          ...(pack.tyre_floor != null && { tyreFloor: pack.tyre_floor === 1 }),
          syncPendingItemVersion: pack.sync_pending_item_version,
          orderSyncPending: pack.order_sync_pending,
        }),
      };
    });
  const proposals = database
    .prepare(
      `
    SELECT listing_id AS listingId, quantity, calculated, edited,
      item_version AS itemVersion, listing_version AS listingVersion,
      rule_version AS ruleVersion, created_at AS createdAt, stale
    FROM proposals ORDER BY sort_order
  `,
    )
    .all()
    .map((row) => ({ ...row, edited: row.edited === 1, stale: row.stale === 1 }));
  const activity = database
    .prepare(
      `
    SELECT id, at, level, operation, message, company_id AS companyId, listing_id AS listingId
    FROM activity ORDER BY sort_order
  `,
    )
    .all()
    .map((row) => ({
      ...row,
      companyId: row.companyId ?? undefined,
      listingId: row.listingId ?? undefined,
    }));
  return validateSnapshot(
    {
      mode: metadata?.mode,
      publishingEnabled: false,
      companies,
      items,
      accounts,
      listings,
      proposals,
      activity,
      settings,
      connection,
    },
    { convertLegacyHolds: version < 9 },
  );
}

/** Identifiers come only from the explicit mappings below, never from user input.
 * Values use parameters. This leaves unchanged records untouched. */
function syncTable(database: DatabaseSync, table: TableName, key: string, rows: Row[]): void {
  const previous = database.prepare(`SELECT * FROM ${table}`).all();
  const previousById = new Map(previous.map((row) => [row[key], row]));
  const nextIds = new Set(rows.map((row) => row[key]));
  const remove = database.prepare(`DELETE FROM ${table} WHERE ${key} = ?`);
  for (const row of previous) {
    if (!nextIds.has(row[key] as ColumnValue)) remove.run(row[key]!);
  }
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const updates = columns
    .filter((column) => column !== key)
    .map((column) => `${column} = excluded.${column}`);
  const upsert = database.prepare(`
    INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT (${key}) DO UPDATE SET ${updates.join(', ')}
  `);
  for (const row of rows) {
    const old = previousById.get(row[key]);
    if (!old || columns.some((column) => old[column] !== row[column]))
      upsert.run(...columns.map((column) => row[column]!));
  }
}

/** New activity is normally prepended. Stable order keys avoid rewriting the
 * complete history on every poll. An explicit reorder renumbers this table. */
function activityOrder(database: DatabaseSync, ids: string[]): Map<string, number> {
  const existing = database
    .prepare('SELECT id, sort_order FROM activity ORDER BY sort_order')
    .all();
  const positions = new Map(existing.map((row) => [String(row.id), Number(row.sort_order)]));
  const retainedIds = new Set(ids);
  const retained = existing
    .filter((row) => retainedIds.has(String(row.id)))
    .map((row) => String(row.id));
  const firstExistingIndex = ids.findIndex((id) => positions.has(id));
  const prefixLength = firstExistingIndex === -1 ? ids.length : firstExistingIndex;
  const existingSuffix = ids.slice(prefixLength);
  if (
    existingSuffix.length !== retained.length ||
    existingSuffix.some((id, index) => id !== retained[index])
  ) {
    return new Map(ids.map((id, index) => [id, index]));
  }
  const firstOrder = existing.length ? Number(existing[0].sort_order) : 0;
  ids
    .slice(0, prefixLength)
    .forEach((id, index) => positions.set(id, firstOrder - prefixLength + index));
  return positions;
}

/** The caller owns the transaction. Deferred foreign keys allow related records
 * to change together but still require a consistent state when committing. */
export function writeSnapshot(database: DatabaseSync, input: Snapshot): void {
  const state = validateSnapshot(input);
  syncTable(database, 'app_metadata', 'id', [{ id: 1, mode: state.mode }]);
  syncTable(database, 'settings', 'id', [
    {
      id: 1,
      tally_url: state.settings.tallyUrl,
      tally_seconds: state.settings.tallySeconds,
      marketplace_seconds: state.settings.marketplaceSeconds,
      catalog_seconds: state.settings.catalogSeconds,
      backup_folder: state.settings.backupFolder,
    },
  ]);
  syncTable(database, 'connection_status', 'id', [
    {
      id: 1,
      tally: state.connection.tally,
      message: state.connection.message,
      last_checked: state.connection.lastChecked,
      next_poll: state.connection.nextPoll,
    },
  ]);
  const version = schemaVersion(database);
  syncTable(
    database,
    'companies',
    'id',
    state.companies.map((company, index) => ({
      id: company.id,
      name: company.name,
      automation: Number(company.automation),
      source: company.source,
      last_success: company.lastSuccess,
      ...(version >= 8 && { stock_issue: company.stockIssue ?? null }),
      sort_order: index,
    })),
  );
  syncTable(
    database,
    'seller_accounts',
    'id',
    state.accounts.map((account, index) => ({
      id: account.id,
      marketplace: account.marketplace,
      name: account.name,
      status: account.status,
      sort_order: index,
    })),
  );
  syncTable(
    database,
    'stock_items',
    'id',
    state.items.map((item, index) => ({
      id: item.id,
      company_id: item.companyId,
      external_id: item.externalId,
      name: item.name,
      brand: item.brand,
      unit: item.unit,
      physical: item.physical,
      observed_at: item.observedAt,
      version: item.version,
      low_stock_threshold: item.lowStockThreshold,
      sort_order: index,
    })),
  );
  syncTable(
    database,
    'listings',
    'id',
    state.listings.map((listing, index) => ({
      id: listing.id,
      account_id: listing.accountId,
      sku: listing.sku,
      title: listing.title,
      location: listing.location,
      item_id: listing.itemId,
      pack_size: listing.packSize,
      pack_evidence: listing.packEvidence,
      verified: Number(listing.verified),
      observed: listing.observed,
      observed_at: listing.observedAt,
      policy: listing.policy,
      remaining: listing.remaining,
      paused: Number(listing.paused),
      ...(version >= 10 && { proposal_issue: listing.proposalIssue ?? null }),
      version: listing.version,
      sort_order: index,
    })),
  );
  if (version >= 11)
    syncTable(
      database,
      'sku_mappings',
      'listing_id',
      state.listings
        .filter((row) => row.skuMappingId)
        .map((row) => ({ listing_id: row.id, marketplace_listing_id: row.skuMappingId! })),
    );
  syncTable(
    database,
    'listing_pack_settings',
    'listing_id',
    state.listings
      .filter(
        (row) =>
          row.packSource !== undefined ||
          row.packageCount !== undefined ||
          row.packageObservedAt !== undefined ||
          row.packConfirmedAt !== undefined ||
          row.packageAvailable !== undefined ||
          row.syncPendingItemVersion != null ||
          row.orderSyncPending != null ||
          row.sourceScope != null ||
          row.tyreFloor !== undefined,
      )
      .map((row) => ({
        listing_id: row.id,
        pack_source: row.packSource ?? null,
        package_count: row.packageCount ?? null,
        package_observed_at: row.packageObservedAt ?? null,
        package_available: Number(row.packageAvailable ?? false),
        pack_confirmed_at: row.packConfirmedAt ?? null,
        source_scope: row.sourceScope ?? null,
        tyre_floor: row.tyreFloor === undefined ? null : Number(row.tyreFloor),
        sync_pending_item_version: row.syncPendingItemVersion ?? null,
        order_sync_pending: row.orderSyncPending ?? null,
      })),
  );
  syncTable(
    database,
    'proposals',
    'listing_id',
    state.proposals.map((proposal, index) => ({
      listing_id: proposal.listingId,
      quantity: proposal.quantity,
      calculated: proposal.calculated,
      edited: Number(proposal.edited),
      item_version: proposal.itemVersion,
      listing_version: proposal.listingVersion,
      rule_version: proposal.ruleVersion,
      created_at: proposal.createdAt,
      stale: Number(proposal.stale),
      sort_order: index,
    })),
  );
  const activityPositions = activityOrder(
    database,
    state.activity.map((event) => event.id),
  );
  syncTable(
    database,
    'activity',
    'id',
    state.activity.map((event) => ({
      id: event.id,
      at: event.at,
      level: event.level,
      operation: event.operation,
      message: event.message,
      company_id: event.companyId ?? null,
      listing_id: event.listingId ?? null,
      sort_order: activityPositions.get(event.id)!,
    })),
  );
}
