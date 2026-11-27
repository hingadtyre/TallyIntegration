import type { DatabaseSync } from 'node:sqlite';
import { normalizeFlipkartProductUrl } from '../../shared/flipkart-product-url.js';
import type {
  MarketplaceAccountRecord,
  MarketplaceChange,
  MarketplaceEdit,
  MarketplaceListing,
  MarketplaceLocation,
} from '../../shared/marketplace-contracts.js';
import { InvalidStoredState } from './validation.js';

export interface MarketplaceData {
  accounts: MarketplaceAccountRecord[];
  listings: MarketplaceListing[];
  changes: MarketplaceChange[];
}

type RecordValue = Record<string, unknown>;
type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

function record(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidStoredState(field, 'must be an object');
  return value as RecordValue;
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()))
    throw new InvalidStoredState(field, 'must be text');
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result)))
    throw new InvalidStoredState(field, 'must be a valid timestamp');
  return result;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function number(value: unknown, field: string, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new InvalidStoredState(field, 'must be a non-negative number in its allowed range');
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T))
    throw new InvalidStoredState(field, `must be one of ${choices.join(', ')}`);
  return value as T;
}

function array<T>(value: unknown, field: string, parse: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) throw new InvalidStoredState(field, 'must be an array');
  return value.map((entry, index) => parse(entry, `${field}[${index}]`));
}

function unique(values: string[], field: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length)
    throw new InvalidStoredState(field, 'contains duplicate identities');
  return result;
}

function account(value: unknown, field: string): MarketplaceAccountRecord {
  const row = record(value, field);
  return {
    id: text(row.id, `${field}.id`),
    name: text(row.name, `${field}.name`),
    sellerId: row.sellerId === null ? null : text(row.sellerId, `${field}.sellerId`),
    lastRefreshedAt: nullableTimestamp(row.lastRefreshedAt, `${field}.lastRefreshedAt`),
  };
}

function location(value: unknown, field: string): MarketplaceLocation {
  const row = record(value, field);
  return {
    id: text(row.id, `${field}.id`),
    quantity: row.quantity === null ? null : number(row.quantity, `${field}.quantity`, true),
    status: text(row.status, `${field}.status`),
  };
}

function listing(value: unknown, field: string): MarketplaceListing {
  const row = record(value, field);
  const result: MarketplaceListing = {
    id: text(row.id, `${field}.id`),
    accountId: text(row.accountId, `${field}.accountId`),
    sellerId: row.sellerId === null ? null : text(row.sellerId, `${field}.sellerId`),
    productId: text(row.productId, `${field}.productId`),
    sku: text(row.sku, `${field}.sku`),
    title: text(row.title, `${field}.title`, true),
    imageUrl: row.imageUrl === null ? null : text(row.imageUrl, `${field}.imageUrl`),
    status: choice(
      row.status,
      ['ACTIVE', 'INACTIVE', 'READY_FOR_ACTIVATION', 'ARCHIVED', 'INACTIVATED_BY_FLIPKART'],
      `${field}.status`,
    ),
    mrp: row.mrp === null ? null : number(row.mrp, `${field}.mrp`),
    sellingPrice:
      row.sellingPrice === null ? null : number(row.sellingPrice, `${field}.sellingPrice`),
    locations: array(row.locations, `${field}.locations`, location),
    ...(row.packageCount !== undefined && {
      packageCount:
        row.packageCount === null ? null : number(row.packageCount, `${field}.packageCount`, true),
    }),
    observedAt: nullableTimestamp(row.observedAt, `${field}.observedAt`),
    version: number(row.version, `${field}.version`, true),
  };
  unique(
    result.locations.map((entry) => entry.id),
    `${field}.locations`,
  );
  const productUrl = normalizeFlipkartProductUrl(row.productUrl, result.productId);
  if (productUrl) result.productUrl = productUrl;
  return result;
}

function edit(value: unknown, field: string): MarketplaceEdit {
  const row = record(value, field);
  const kind = choice(row.kind, ['stock', 'price'], `${field}.kind`);
  if (kind === 'stock')
    return {
      kind,
      locationId: text(row.locationId, `${field}.locationId`),
      quantity: number(row.quantity, `${field}.quantity`, true),
      automation: choice(row.automation, ['once', 'pause'], `${field}.automation`),
    };
  return {
    kind,
    field: choice(row.field, ['mrp', 'sellingPrice'], `${field}.field`),
    value: number(row.value, `${field}.value`),
  };
}

function change(value: unknown, field: string): MarketplaceChange {
  const row = record(value, field);
  const action = edit(row.edit, `${field}.edit`);
  if (
    (row.stockRequestFinality != null && action.kind !== 'stock') ||
    (row.state === 'reconciled' && !row.stockRequestFinality)
  )
    throw new InvalidStoredState(field, 'has inconsistent stock recovery evidence');
  return {
    id: text(row.id, `${field}.id`),
    accountId: text(row.accountId, `${field}.accountId`),
    listingId: text(row.listingId, `${field}.listingId`),
    sku: text(row.sku, `${field}.sku`),
    edit: action,
    state: choice(
      row.state,
      ['pending', 'sending', 'checking', 'confirmed', 'failed', 'uncertain', 'reconciled'],
      `${field}.state`,
    ),
    ...(row.stockRequestFinality != null && {
      stockRequestFinality: choice(
        row.stockRequestFinality,
        ['not-sent', 'completed'] as const,
        `${field}.stockRequestFinality`,
      ),
    }),
    message: text(row.message, `${field}.message`, true),
    createdAt: timestamp(row.createdAt, `${field}.createdAt`),
    updatedAt: timestamp(row.updatedAt, `${field}.updatedAt`),
  };
}

/** Validate disk JSON and command results rather than trusting type assertions.
 * Rebuilding records also excludes unknown fields, including accidental secrets. */
export function validateMarketplace(value: unknown): MarketplaceData {
  const row = record(value, 'marketplace');
  const result: MarketplaceData = {
    accounts: array(row.accounts, 'marketplace.accounts', account),
    listings: array(row.listings, 'marketplace.listings', listing),
    changes: array(row.changes, 'marketplace.changes', change),
  };
  const accounts = unique(
    result.accounts.map((row) => row.id),
    'marketplace.accounts',
  );
  unique(
    result.accounts.flatMap((row) => (row.sellerId === null ? [] : [row.sellerId])),
    'marketplace.sellers',
  );
  unique(
    result.listings.map((row) => JSON.stringify([row.accountId, row.id])),
    'marketplace.listings',
  );
  unique(
    result.listings.map((row) => JSON.stringify([row.accountId, row.sku])),
    'marketplace.skus',
  );
  unique(
    result.changes.map((row) => row.id),
    'marketplace.changes',
  );
  const sellerIds = new Map(result.accounts.map((row) => [row.id, row.sellerId]));
  for (const listing of result.listings) {
    if (!accounts.has(listing.accountId))
      throw new InvalidStoredState('marketplace.listing.accountId', 'references a missing account');
    const seller = sellerIds.get(listing.accountId);
    if (seller !== null && seller !== listing.sellerId)
      throw new InvalidStoredState('marketplace.listing.sellerId', 'does not match its account');
  }
  for (const change of result.changes)
    if (!accounts.has(change.accountId))
      throw new InvalidStoredState('marketplace.change.accountId', 'references a missing account');
  return result;
}

function json(value: unknown, field: string): unknown {
  try {
    return JSON.parse(text(value, field));
  } catch {
    throw new InvalidStoredState(field, 'must be valid JSON');
  }
}

/** The caller holds a read transaction for this multi-table read. */
export function readMarketplace(database: DatabaseSync): MarketplaceData {
  return validateMarketplace({
    accounts: database
      .prepare(
        `SELECT account_id AS id, name, seller_id AS sellerId,
      last_refreshed_at AS lastRefreshedAt FROM marketplace_accounts ORDER BY sort_order`,
      )
      .all(),
    listings: database
      .prepare('SELECT * FROM marketplace_listings ORDER BY sort_order')
      .all()
      .map((row) => ({
        ...record(
          json(row.metadata, 'marketplace.listing.metadata'),
          'marketplace.listing.metadata',
        ),
        id: row.id,
        accountId: row.account_id,
        sellerId: row.seller_id === '' ? null : row.seller_id,
        productId: row.product_id,
        sku: row.sku,
        version: row.version,
        observedAt: row.observed_at,
      })),
    changes: database
      .prepare('SELECT * FROM marketplace_changes ORDER BY sort_order')
      .all()
      .map((row) => ({
        id: row.id,
        accountId: row.account_id,
        listingId: row.listing_id,
        sku: row.sku,
        state: row.state,
        stockRequestFinality: row.stock_request_finality,
        edit: json(row.edit, 'marketplace.change.edit'),
        message: row.message,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
  });
}

export function syncTable(
  database: DatabaseSync,
  table:
    | 'marketplace_accounts'
    | 'marketplace_listings'
    | 'marketplace_changes'
    | 'billing_rules'
    | 'billing_links',
  keys: string[],
  rows: SqlRow[],
): void {
  const previous = database.prepare(`SELECT * FROM ${table}`).all();
  const identity = (row: Record<string, unknown>) => JSON.stringify(keys.map((key) => row[key]));
  const previousById = new Map(previous.map((row) => [identity(row), row]));
  const retained = new Set(rows.map(identity));
  const remove = database.prepare(
    `DELETE FROM ${table} WHERE ${keys.map((key) => `${key} = ?`).join(' AND ')}`,
  );
  for (const row of previous)
    if (!retained.has(identity(row))) remove.run(...keys.map((key) => row[key]!));
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const upsert = database.prepare(`INSERT INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT (${keys.join(', ')}) DO UPDATE SET
    ${columns
      .filter((column) => !keys.includes(column))
      .map((column) => `${column} = excluded.${column}`)
      .join(', ')}`);
  for (const row of rows) {
    const old = previousById.get(identity(row));
    if (!old || columns.some((column) => old[column] !== row[column]))
      upsert.run(...columns.map((column) => row[column]!));
  }
}

/** Store owns the enclosing transaction shared with Inventory records. */
export function writeMarketplace(database: DatabaseSync, input: MarketplaceData): void {
  const market = validateMarketplace(input);
  syncTable(
    database,
    'marketplace_accounts',
    ['account_id'],
    market.accounts.map((row, index) => ({
      account_id: row.id,
      name: row.name,
      seller_id: row.sellerId,
      last_refreshed_at: row.lastRefreshedAt,
      sort_order: index,
    })),
  );
  syncTable(
    database,
    'marketplace_listings',
    ['account_id', 'id'],
    market.listings.map((row, index) => {
      const { id, accountId, sellerId, productId, sku, version, observedAt, ...metadata } = row;
      return {
        account_id: accountId,
        id,
        // Older databases require a non-null SQL value. The API uses null for
        // authenticated catalogue ownership without a provider-issued seller ID.
        seller_id: sellerId ?? '',
        product_id: productId,
        sku,
        version,
        observed_at: observedAt,
        metadata: JSON.stringify(metadata),
        sort_order: index,
      };
    }),
  );
  syncTable(
    database,
    'marketplace_changes',
    ['id'],
    market.changes.map((row, index) => ({
      id: row.id,
      account_id: row.accountId,
      listing_id: row.listingId,
      sku: row.sku,
      state: row.state,
      stock_request_finality: row.stockRequestFinality ?? null,
      edit: JSON.stringify(row.edit),
      message: row.message,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      sort_order: index,
    })),
  );
}
