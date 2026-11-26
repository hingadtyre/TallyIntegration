import type { DatabaseSync } from 'node:sqlite';
import type { StockCoverageOrder, StockSyncCoverage } from '../../shared/stock-coverage.js';
import { InvalidStoredState } from './validation.js';

export function checkedOrder(
  value: unknown,
  scope: 'stock' | 'billing' = 'stock',
): StockCoverageOrder {
  const order = value as Partial<StockCoverageOrder> | null;
  if (
    !order ||
    typeof order !== 'object' ||
    [order.orderItemId, order.orderId, order.sku, order.listingId].some(
      (id) => typeof id !== 'string' || !id.trim(),
    ) ||
    typeof order.locationId !== 'string' ||
    (!order.locationId.trim() && (scope === 'stock' || !order.eligibilityUnverified)) ||
    (order.invoiceNumber !== null && typeof order.invoiceNumber !== 'string') ||
    (order.invoiceLookup !== undefined &&
      order.invoiceLookup !== 'failed' &&
      order.invoiceLookup !== 'no-number' &&
      order.invoiceLookup !== 'unsupported-format') ||
    !Number.isSafeInteger(order.quantity) ||
    Number(order.quantity) <= 0 ||
    typeof order.orderDate !== 'string' ||
    !Number.isFinite(Date.parse(order.orderDate)) ||
    (order.eligibilityUnverified !== undefined && order.eligibilityUnverified !== true) ||
    ('preDispatchWithoutCourierReturn' in order &&
      (order.preDispatchWithoutCourierReturn !== true || !order.stockShipmentId)) ||
    (order.stockSyncQueued !== undefined && order.stockSyncQueued !== true) ||
    (order.firstSeenUnmapped !== undefined && order.firstSeenUnmapped !== true) ||
    (order.stockIdentityConflict !== undefined && order.stockIdentityConflict !== true) ||
    ('stockDispatchObserved' in order && order.stockDispatchObserved !== true) ||
    ('stockReconciliationRequired' in order && order.stockReconciliationRequired !== true) ||
    ('stockShipmentId' in order &&
      (typeof order.stockShipmentId !== 'string' || !order.stockShipmentId.trim())) ||
    ('stockReturnConflict' in order &&
      (order.stockReturnConflict !== true ||
        !order.stockShipmentId ||
        !order.stockDispatchObserved ||
        !order.stockReconciliationRequired ||
        !order.eligibilityUnverified ||
        order.stockDisposition !== 'uncertain')) ||
    (order.stockDisposition !== undefined &&
      order.stockDisposition !== 'cancelled' &&
      order.stockDisposition !== 'uncertain')
  )
    throw new InvalidStoredState('stock coverage', 'contains an incomplete Flipkart order');
  return order as StockCoverageOrder;
}

/** Check the current schema even on restore, where its receipts will be discarded. */
export function verifyStockCoverage(database: DatabaseSync): void {
  database
    .prepare('SELECT company_id, from_at, signature, checked_through FROM stock_coverage LIMIT 0')
    .all();
  for (const row of database.prepare('SELECT evidence FROM stock_coverage_orders').iterate()) {
    checkedOrder(JSON.parse(String(row.evidence)));
  }
}

export function readStockCoverage(
  database: DatabaseSync,
  companyId: string,
): StockSyncCoverage | null {
  const row = database
    .prepare('SELECT from_at, signature, checked_through FROM stock_coverage WHERE company_id = ?')
    .get(companyId);
  if (!row) return null;
  const orders = database
    .prepare(
      'SELECT account_id, evidence FROM stock_coverage_orders WHERE company_id = ? ORDER BY account_id, order_item_id',
    )
    .all(companyId)
    .map((entry) => ({
      accountId: String(entry.account_id),
      order: checkedOrder(JSON.parse(String(entry.evidence))),
    }));
  return {
    companyId,
    from: String(row.from_at),
    signature: String(row.signature),
    checkedThrough: row.checked_through === null ? null : String(row.checked_through),
    orders,
  };
}

/** Called inside the Store's write transaction. A later scan may omit an older
 * order. Only an explicit change to the reconciled start date replaces history. */
export function writeStockCoverage(database: DatabaseSync, record: StockSyncCoverage): void {
  const existing = database
    .prepare('SELECT from_at FROM stock_coverage WHERE company_id = ?')
    .get(record.companyId);
  if (existing && existing.from_at !== record.from)
    database
      .prepare('DELETE FROM stock_coverage_orders WHERE company_id = ?')
      .run(record.companyId);
  database
    .prepare(
      `
    INSERT INTO stock_coverage(company_id, from_at, signature, checked_through) VALUES (?, ?, ?, ?)
    ON CONFLICT(company_id) DO UPDATE SET from_at = excluded.from_at, signature = excluded.signature,
      checked_through = excluded.checked_through
  `,
    )
    .run(record.companyId, record.from, record.signature, record.checkedThrough);
  const save = database.prepare(`
    INSERT INTO stock_coverage_orders(company_id, account_id, order_item_id, evidence) VALUES (?, ?, ?, ?)
    ON CONFLICT(company_id, account_id, order_item_id) DO UPDATE SET evidence = excluded.evidence
    WHERE stock_coverage_orders.evidence <> excluded.evidence
  `);
  const seen = new Set<string>();
  for (const { accountId, order } of record.orders) {
    const key = JSON.stringify([accountId, order.orderItemId]);
    if (seen.has(key))
      throw new InvalidStoredState(
        'stock coverage',
        'contains a duplicate order item for one seller',
      );
    seen.add(key);
    save.run(record.companyId, accountId, order.orderItemId, JSON.stringify(checkedOrder(order)));
  }
}
