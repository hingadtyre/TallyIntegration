import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { BillingRule } from '../../shared/billing-contracts.js';
import { syncTable } from './marketplace-records.js';
import { InvalidStoredState } from './validation.js';

export interface BillingLink {
  companyId: string;
  accountId: string;
  orderItemId: string;
  billId: string;
  itemId: string;
  fingerprint: string;
  ledgerId: string;
}

export interface BillingData {
  rules: Array<BillingRule & { companyId: string; accountId: string }>;
  links: BillingLink[];
}

function text(value: SQLOutputValue): string {
  if (typeof value !== 'string' || !value.trim())
    throw new InvalidStoredState('billing', 'expected non-empty text');
  return value;
}

export function readBilling(database: DatabaseSync): BillingData {
  const rules = database
    .prepare('SELECT * FROM billing_rules ORDER BY company_id, account_id')
    .all()
    .map((row) => {
      const field = row.field;
      const reference = row.reference;
      if (
        field !== 'reference' &&
        field !== 'number' &&
        field !== 'narration' &&
        field !== 'manual'
      )
        throw new InvalidStoredState('billing rule', 'unknown Tally bill field');
      if (reference !== 'orderId' && reference !== 'orderItemId' && reference !== 'invoiceNumber')
        throw new InvalidStoredState('billing rule', 'unknown Flipkart reference');
      return {
        companyId: text(row.company_id),
        accountId: text(row.account_id),
        ledgerId: text(row.ledger_id),
        ledgerName: text(row.ledger_name),
        field,
        reference,
      } satisfies BillingData['rules'][number];
    });
  const links = database
    .prepare('SELECT * FROM billing_links ORDER BY account_id, order_item_id')
    .all()
    .map((row) => ({
      companyId: text(row.company_id),
      accountId: text(row.account_id),
      orderItemId: text(row.order_item_id),
      billId: text(row.bill_id),
      itemId: text(row.item_id),
      fingerprint: text(row.fingerprint),
      ledgerId: text(row.ledger_id),
    }));
  return { rules, links };
}

/** Called inside the owning Store or offline restore transaction. */
export function writeBilling(database: DatabaseSync, data: BillingData): void {
  // Upserts alone would silently let the last copy of a duplicate order win.
  const unique = (keys: string[]) => new Set(keys).size === keys.length;
  if (
    !unique(data.rules.map((row) => JSON.stringify([row.companyId, row.accountId]))) ||
    !unique(data.links.map((row) => JSON.stringify([row.accountId, row.orderItemId]))) ||
    !unique(data.links.map((row) => JSON.stringify([row.companyId, row.billId, row.itemId])))
  )
    throw new InvalidStoredState('billing', 'conflicting rules or order-to-bill assignments');
  syncTable(
    database,
    'billing_rules',
    ['company_id', 'account_id'],
    data.rules.map((rule) => ({
      company_id: rule.companyId,
      account_id: rule.accountId,
      ledger_id: rule.ledgerId,
      ledger_name: rule.ledgerName,
      field: rule.field,
      reference: rule.reference,
    })),
  );
  syncTable(
    database,
    'billing_links',
    ['account_id', 'order_item_id'],
    data.links.map((link) => ({
      company_id: link.companyId,
      account_id: link.accountId,
      order_item_id: link.orderItemId,
      bill_id: link.billId,
      item_id: link.itemId,
      fingerprint: link.fingerprint,
      ledger_id: link.ledgerId,
    })),
  );
}
