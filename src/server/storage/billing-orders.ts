import type { DatabaseSync } from 'node:sqlite';
import type { FlipkartBillingOrder } from '../../adapters/flipkart-billing.js';
import type { BillingFulfilment } from '../../shared/billing-contracts.js';
import { checkedOrder } from './stock-coverage.js';
import { schemaVersion } from './schema.js';

export function verifyBillingOrders(database: DatabaseSync): void {
  if (schemaVersion(database) >= 18)
    database
      .prepare(
        'SELECT company_id, account_id, signature, completed_at FROM billing_check_receipts LIMIT 0',
      )
      .all();
  database.prepare('SELECT company_id, from_at FROM billing_tracking_dates LIMIT 0').all();
  for (const row of database.prepare('SELECT evidence FROM billing_orders').iterate())
    checkedOrder(JSON.parse(String(row.evidence)), 'billing');
}

export function readBillingOrders(
  database: DatabaseSync,
  companyId: string,
  accountId: string,
  from: string,
  to: string,
  orderItemId?: string,
) {
  const rows = database
    .prepare(
      `
    SELECT fulfilment, evidence FROM billing_orders
    WHERE company_id = ? AND account_id = ?
      ${orderItemId === undefined ? '' : 'AND order_item_id = ?'}
      AND julianday(json_extract(evidence, '$.orderDate')) BETWEEN julianday(?) AND julianday(?)
    ORDER BY fulfilment, order_item_id
  `,
    )
    .all(companyId, accountId, ...(orderItemId === undefined ? [] : [orderItemId]), from, to);
  return rows.map((row) => ({
    group: row.fulfilment as BillingFulfilment,
    order: checkedOrder(JSON.parse(String(row.evidence)), 'billing'),
  }));
}

export function saveBillingOrderObservations(
  database: DatabaseSync,
  companyId: string,
  accountId: string,
  observations: { group: BillingFulfilment; order: FlipkartBillingOrder }[],
): void {
  if (!observations.length) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    const save = database.prepare(`
      INSERT INTO billing_orders (company_id, account_id, fulfilment, order_item_id, evidence)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(company_id, account_id, fulfilment, order_item_id) DO UPDATE SET evidence = excluded.evidence
      WHERE billing_orders.evidence <> excluded.evidence
    `);
    for (const { group, order } of observations)
      save.run(
        companyId,
        accountId,
        group,
        order.orderItemId,
        JSON.stringify(checkedOrder(order, 'billing')),
      );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
