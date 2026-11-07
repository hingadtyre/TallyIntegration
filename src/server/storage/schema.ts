import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 2;

/** Each managed record has an explicit table. Array order is presentation state,
 * so sort_order is retained without making names or positions into identities. */
export function createSchema(database: DatabaseSync): void {
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
}

export function schemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get();
  return Number(row?.user_version);
}
