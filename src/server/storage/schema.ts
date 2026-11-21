import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 11;

/** Each managed record has an explicit table. Array order is presentation state,
 * so sort_order is retained without making names or positions into identities. */
export function createSchema(
  database: DatabaseSync,
  version: 6 | 7 | 8 | 9 | 10 | 11 = CURRENT_SCHEMA_VERSION,
): void {
  database.exec(`
    CREATE TABLE app_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      mode TEXT NOT NULL CHECK (mode IN ('live', 'demo'))
    );
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tally_url TEXT NOT NULL,
      tally_seconds INTEGER NOT NULL CHECK (tally_seconds >= 5),
      marketplace_seconds INTEGER NOT NULL CHECK (marketplace_seconds >= 30),
      catalog_seconds INTEGER NOT NULL CHECK (catalog_seconds >= 60),
      backup_folder TEXT NOT NULL
    );
    CREATE TABLE connection_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tally TEXT NOT NULL CHECK (tally IN ('not-checked', 'online', 'offline')),
      message TEXT NOT NULL,
      last_checked TEXT,
      next_poll TEXT
    );
    CREATE TABLE companies (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      automation INTEGER NOT NULL CHECK (automation IN (0, 1)),
      source TEXT NOT NULL CHECK (source IN ('tally', 'demo')),
      last_success TEXT,
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );
    CREATE TABLE seller_accounts (
      id TEXT PRIMARY KEY NOT NULL,
      marketplace TEXT NOT NULL CHECK (marketplace = 'flipkart'),
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('not-connected', 'demo')),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );
    CREATE TABLE stock_items (
      id TEXT PRIMARY KEY NOT NULL,
      company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      unit TEXT NOT NULL,
      physical REAL,
      observed_at TEXT,
      version INTEGER NOT NULL CHECK (version >= 0),
      low_stock_threshold REAL NOT NULL CHECK (low_stock_threshold >= 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      UNIQUE (company_id, external_id)
    );
    CREATE TABLE listings (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES seller_accounts(id) DEFERRABLE INITIALLY DEFERRED,
      sku TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT NOT NULL,
      item_id TEXT REFERENCES stock_items(id) DEFERRABLE INITIALLY DEFERRED,
      pack_size INTEGER CHECK (pack_size > 0),
      pack_evidence TEXT NOT NULL,
      verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
      observed INTEGER CHECK (observed >= 0),
      observed_at TEXT,
      policy TEXT NOT NULL CHECK (policy IN ('auto', 'limited', 'hold')),
      remaining INTEGER CHECK (remaining >= 0),
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      version INTEGER NOT NULL CHECK (version >= 0),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      CHECK (policy != 'limited' OR remaining IS NOT NULL)
    );
    CREATE TABLE proposals (
      listing_id TEXT PRIMARY KEY NOT NULL REFERENCES listings(id) DEFERRABLE INITIALLY DEFERRED,
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      calculated INTEGER NOT NULL CHECK (calculated >= 0),
      edited INTEGER NOT NULL CHECK (edited IN (0, 1)),
      item_version INTEGER NOT NULL CHECK (item_version >= -1),
      listing_version INTEGER NOT NULL CHECK (listing_version >= 0),
      rule_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      stale INTEGER NOT NULL CHECK (stale IN (0, 1)),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );
    CREATE TABLE activity (
      id TEXT PRIMARY KEY NOT NULL,
      at TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
      operation TEXT NOT NULL,
      message TEXT NOT NULL,
      company_id TEXT,
      listing_id TEXT,
      sort_order INTEGER NOT NULL
    );
    CREATE INDEX stock_items_company ON stock_items(company_id);
    CREATE INDEX listings_item ON listings(item_id);
    CREATE INDEX listings_account ON listings(account_id);
    CREATE INDEX activity_company_time ON activity(company_id, at);
    CREATE INDEX activity_listing_time ON activity(listing_id, at);
  `);
  // Activity references deliberately outlive current managed records. They are
  // historical identifiers, so deleting a record must not delete its history.
  createMarketplaceSchema(database);
  createPackSchema(database);
  createBillingSchema(database);
  createStockCoverageSchema(database);
  if (version >= 7) upgradeOrderSyncSchema(database);
  if (version >= 8) addCompanyStockIssue(database);
  if (version >= 10) addProposalIssue(database);
  if (version >= 11) createSkuMappings(database);
}

export function createSkuMappings(database: DatabaseSync): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS sku_mappings (listing_id TEXT PRIMARY KEY NOT NULL REFERENCES listings(id) ON DELETE CASCADE, marketplace_listing_id TEXT NOT NULL)',
  );
}

export function addProposalIssue(database: DatabaseSync): void {
  database.exec('ALTER TABLE listings ADD COLUMN proposal_issue TEXT');
}

export function addCompanyStockIssue(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE companies ADD COLUMN stock_issue TEXT
      CHECK (stock_issue IN ('read-failed', 'unloaded', 'not-checked'));
  `);
}

/** Old uncertain writes have no recorded request finality and must stay that way. */
export function upgradeOrderSyncSchema(database: DatabaseSync): void {
  database.exec(`
    ALTER TABLE listing_pack_settings ADD COLUMN order_sync_pending TEXT
      CHECK (order_sync_pending IS NULL OR length(trim(order_sync_pending)) > 0);
    DROP INDEX marketplace_changes_destination;
    ALTER TABLE marketplace_changes RENAME TO marketplace_changes_before_recovery;
  `);
  createChangeTable(database, true);
  database.exec(`
    INSERT INTO marketplace_changes (id, account_id, listing_id, sku, state, edit, message, created_at, updated_at, sort_order)
      SELECT id, account_id, listing_id, sku, state, edit, message, created_at, updated_at, sort_order
      FROM marketplace_changes_before_recovery;
    DROP TABLE marketplace_changes_before_recovery;
  `);
}

export function createStockCoverageSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE stock_coverage (
      company_id TEXT PRIMARY KEY NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
      from_at TEXT NOT NULL CHECK (from_at GLOB '????-??-??T18:30:00.000Z' AND julianday(from_at) IS NOT NULL),
      signature TEXT NOT NULL CHECK (length(trim(signature)) > 0),
      checked_through TEXT CHECK (checked_through IS NULL OR
        (julianday(checked_through) IS NOT NULL AND julianday(checked_through) >= julianday(from_at)))
    ) STRICT;
    CREATE TABLE stock_coverage_orders (
      company_id TEXT NOT NULL REFERENCES stock_coverage(company_id),
      account_id TEXT NOT NULL CHECK (length(trim(account_id)) > 0),
      order_item_id TEXT NOT NULL CHECK (length(trim(order_item_id)) > 0),
      evidence TEXT NOT NULL CHECK (json_valid(evidence) AND json_extract(evidence, '$.orderItemId') IS order_item_id),
      PRIMARY KEY(company_id, account_id, order_item_id)
    ) STRICT;
  `);
}

export function createBillingSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE billing_rules (
      company_id TEXT NOT NULL REFERENCES companies(id) DEFERRABLE INITIALLY DEFERRED,
      account_id TEXT NOT NULL REFERENCES seller_accounts(id) DEFERRABLE INITIALLY DEFERRED,
      ledger_id TEXT NOT NULL CHECK (length(trim(ledger_id)) > 0),
      ledger_name TEXT NOT NULL CHECK (length(trim(ledger_name)) > 0),
      field TEXT NOT NULL CHECK (field IN ('reference','number','narration','manual')),
      reference TEXT NOT NULL CHECK (reference IN ('orderId','orderItemId','invoiceNumber')),
      PRIMARY KEY(company_id, account_id)
    ) STRICT;
    CREATE TABLE billing_links (
      company_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      order_item_id TEXT NOT NULL CHECK (length(trim(order_item_id)) > 0),
      bill_id TEXT NOT NULL CHECK (length(trim(bill_id)) > 0),
      item_id TEXT NOT NULL CHECK (length(trim(item_id)) > 0),
      ledger_id TEXT NOT NULL CHECK (length(trim(ledger_id)) > 0),
      fingerprint TEXT NOT NULL CHECK (length(trim(fingerprint)) > 0),
      PRIMARY KEY(account_id, order_item_id),
      UNIQUE(company_id, bill_id, item_id),
      FOREIGN KEY(company_id, account_id) REFERENCES billing_rules(company_id, account_id) DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
  `);
}

/** Each row belongs to a specific account, seller SKU and inventory location
 * through its listing id. Missing rows preserve legacy mappings without
 * implying that a seller selected a source location or an advertising rule. */
export function createPackSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE listing_pack_settings (
      listing_id TEXT PRIMARY KEY REFERENCES listings(id) DEFERRABLE INITIALLY DEFERRED,
      pack_source TEXT CHECK (pack_source IN ('packages','manual')),
      package_count INTEGER CHECK (package_count > 0),
      package_observed_at TEXT,
      package_available INTEGER CHECK (package_available IN (0,1)),
      pack_confirmed_at TEXT,
      source_scope TEXT CHECK (source_scope = 'company'),
      tyre_floor INTEGER CHECK (tyre_floor IN (0,1)),
      sync_pending_item_version INTEGER CHECK (sync_pending_item_version >= 0)
    );
  `);
}

/** Explicit membership keeps the legacy disconnected account placeholder out of
 * Marketplaces until the seller adds it or adopts saved credentials. */
export function createMarketplaceSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE marketplace_accounts (
      account_id TEXT PRIMARY KEY NOT NULL REFERENCES seller_accounts(id) DEFERRABLE INITIALLY DEFERRED,
      name TEXT NOT NULL,
      seller_id TEXT UNIQUE,
      last_refreshed_at TEXT,
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );
    CREATE TABLE marketplace_listings (
      account_id TEXT NOT NULL REFERENCES marketplace_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
      id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 0),
      observed_at TEXT,
      metadata TEXT NOT NULL CHECK (json_valid(metadata)),
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
      PRIMARY KEY (account_id, id),
      UNIQUE (account_id, sku)
    );
  `);
  createChangeTable(database, false);
}

function createChangeTable(database: DatabaseSync, recovery: boolean): void {
  database.exec(`
    CREATE TABLE marketplace_changes (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES marketplace_accounts(account_id) DEFERRABLE INITIALLY DEFERRED,
      listing_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'checking', 'confirmed', 'failed', 'uncertain'${recovery ? ", 'reconciled'" : ''})),
      edit TEXT NOT NULL CHECK (json_valid(edit)),
      ${
        recovery
          ? `stock_request_finality TEXT CHECK (stock_request_finality IS NULL OR
        (json_extract(edit, '$.kind') = 'stock' AND
        ((stock_request_finality = 'not-sent' AND state IN ('pending','uncertain','failed','reconciled')) OR
         (stock_request_finality = 'completed' AND state IN ('checking','uncertain','confirmed','reconciled')))))
         CHECK (state <> 'reconciled' OR stock_request_finality IS NOT NULL),`
          : ''
      }
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL CHECK (sort_order >= 0)
    );
    CREATE INDEX marketplace_changes_destination ON marketplace_changes(account_id, listing_id, state);
  `);
  // Changes retain their destination even when a later refresh no longer sees
  // the listing. Missing catalog observations must not erase publication history.
}

export function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get();
  return Number(row?.user_version);
}
