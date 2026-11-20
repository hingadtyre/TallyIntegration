import { createHash } from 'node:crypto';
import { saleDay } from '../domain/sale-day.js';
import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';
import type { TallySalesBill, TallyStockItem } from '../adapters/tally.js';
import type { BillingReport, BillingRow, BillingRule } from '../shared/billing-contracts.js';
import type { Snapshot } from '../shared/contracts.js';
import type { MarketplaceListing } from '../shared/marketplace-contracts.js';
import type { BillingData, BillingLink } from './storage/billing-records.js';

export interface BillingScope {
  companyId: string;
  accountId: string;
}
export interface BillingEvidence {
  orders: FlipkartBillingOrder[];
  bills: TallySalesBill[];
  balances?: TallyStockItem[];
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// A reference or voucher number is an identifier. Free-text narration may
// surround it with words, but OD-12 must never match part of OD-123 or X/OD-12.
function hasReference(rule: BillingRule, bill: TallySalesBill, order: FlipkartBillingOrder) {
  const id = order[rule.reference];
  if (!id || rule.field === 'manual') return false;
  const text = bill[rule.field].trim();
  if (rule.field !== 'narration') return text === id;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_/.-])${escaped}(?=$|[^\\p{L}\\p{N}_/.-]|\\.(?=\\s|$))`,
    'u',
  ).test(text);
}

export { saleDay };

export function matchBills(
  scope: BillingScope,
  rule: BillingRule,
  evidence: BillingEvidence,
  saved: BillingData,
  state: Snapshot,
  catalogue: MarketplaceListing[],
): {
  rows: BillingRow[];
  stock: BillingReport['stock'];
  links: Map<string, Map<string, BillingLink>>;
} {
  const rows: BillingRow[] = [];
  const links = new Map<string, Map<string, BillingLink>>();
  const exact = new Map<string, string[]>();
  const claims = new Map<string, number>();
  const orderGroup = new Map<string, string>();
  const groupSizes = new Map<string, number>();
  const stockItems = new Map<string, { item: Snapshot['items'][number]; rows: BillingRow[] }>();
  const sharedLedger = saved.rules.some(
    (r) =>
      r.companyId === scope.companyId &&
      r.accountId !== scope.accountId &&
      r.ledgerId === rule.ledgerId,
  );
  const key = (billId: string, itemId: string) => JSON.stringify([billId, itemId]);
  const used = new Map(
    saved.links
      .filter((l) => l.companyId === scope.companyId)
      .map((l) => [key(l.billId, l.itemId), l]),
  );
  const assigned = new Map(
    saved.links.filter((l) => l.accountId === scope.accountId).map((l) => [l.orderItemId, l]),
  );
  const listings = new Map(
    catalogue.filter((l) => l.accountId === scope.accountId && l.observedAt).map((l) => [l.id, l]),
  );
  const destinations = new Map(
    state.listings
      .filter((l) => l.accountId === scope.accountId)
      .map((l) => [JSON.stringify([l.sku, l.location]), l]),
  );
  const items = new Map(state.items.map((i) => [i.id, i]));
  const billsByStock = new Map<string, TallySalesBill[]>();
  const billsByItem = new Map<string, TallySalesBill[]>();
  for (const bill of evidence.bills) {
    for (const line of bill.lines) {
      const itemBills = billsByItem.get(line.itemExternalId);
      if (itemBills) itemBills.push(bill);
      else billsByItem.set(line.itemExternalId, [bill]);
      const signature = JSON.stringify([line.itemExternalId, line.unit, line.quantity]);
      const bucket = billsByStock.get(signature);
      if (bucket) bucket.push(bill);
      else billsByStock.set(signature, [bill]);
    }
  }
  for (const order of evidence.orders) {
    const listing = listings.get(order.listingId);
    const mapping =
      listing?.sku === order.sku && listing.locations.some((loc) => loc.id === order.locationId)
        ? destinations.get(JSON.stringify([order.sku, order.locationId]))
        : undefined;
    const item = mapping?.itemId ? items.get(mapping.itemId) : undefined;
    if (item && item.companyId !== scope.companyId) continue;
    // A shared invoice/order reference and one aggregated bill quantity
    // cannot identify a specific line in a partial or consolidated sale.
    if (item && rule.field !== 'manual' && order[rule.reference]) {
      const group = JSON.stringify([item.id, order[rule.reference]]);
      orderGroup.set(order.orderItemId, group);
      groupSizes.set(group, (groupSizes.get(group) ?? 0) + 1);
    }
    const row: BillingRow = {
      orderItemId: order.orderItemId,
      orderId: order.orderId,
      orderDate: order.orderDate,
      referenceValue: rule.field === 'manual' ? null : order[rule.reference],
      sku: order.sku,
      location: order.locationId,
      quantity: order.quantity,
      baseUnits: null,
      status: 'unmapped',
      reason: 'Verify the listing, location and Set of in Inventory.',
      bill: null,
      candidates: [],
    };
    rows.push(row);
    const prior = assigned.get(order.orderItemId);
    if (prior?.companyId === scope.companyId) row.manualBillId = prior.billId;
    if (!item) continue;
    const group = stockItems.get(item.id) ?? { item, rows: [] };
    group.rows.push(row);
    stockItems.set(item.id, group);
    if (order.eligibilityUnverified) {
      row.status = 'review';
      row.reason =
        'Flipkart did not verify this order item’s sale status. Refresh after checking the order.';
      continue;
    }
    if (
      !mapping?.verified ||
      !mapping.packSize ||
      (mapping.packSource === 'packages' &&
        (!mapping.packageAvailable || mapping.packageCount !== mapping.packSize))
    )
      continue;
    const units = order.quantity * mapping.packSize;
    if (!Number.isSafeInteger(units) || units <= 0) continue;
    row.baseUnits = units;
    row.status = 'unmatched';
    row.reason = 'No corresponding sales bill found in this review.';
    const choices = new Map<string, BillingLink>();
    links.set(order.orderItemId, choices);
    const signature = JSON.stringify([item.externalId, item.unit, units]);
    for (const bill of billsByStock.get(signature) ?? []) {
      if (bill.date < saleDay(order.orderDate)) continue;
      const owner = used.get(key(bill.externalId, item.externalId));
      if (owner && (owner.accountId !== scope.accountId || owner.orderItemId !== order.orderItemId))
        continue;
      const refMatches = hasReference(rule, bill, order);
      // Missing references can still be reviewed by the seller. A conflicting
      // reference in the configured field must never become an assumed match.
      if (
        rule.field !== 'manual' &&
        !refMatches &&
        bill[rule.field].trim() &&
        order[rule.reference]
      )
        continue;
      const link: BillingLink = {
        ...scope,
        orderItemId: order.orderItemId,
        billId: bill.externalId,
        itemId: item.externalId,
        ledgerId: rule.ledgerId,
        fingerprint: fingerprint([
          rule.field,
          rule.reference,
          order.orderId,
          order.listingId,
          order.sku,
          order.locationId,
          order.quantity,
          order.orderDate,
          bill.date,
          bill.number,
          item.unit,
          units,
          rule.field === 'manual' ? null : [order[rule.reference], bill[rule.field]],
        ]),
      };
      const candidate = { id: bill.externalId, number: bill.number, date: bill.date };
      choices.set(bill.externalId, link);
      row.candidates.push(candidate);
      if (
        prior?.companyId === scope.companyId &&
        prior.billId === link.billId &&
        prior.itemId === link.itemId &&
        prior.ledgerId === link.ledgerId &&
        prior.fingerprint === link.fingerprint
      ) {
        row.bill = candidate;
        row.status = 'matched';
        row.reason = 'Confirmed by seller.';
      }
      if (refMatches) {
        const id = key(link.billId, link.itemId);
        claims.set(id, (claims.get(id) ?? 0) + 1);
        exact.set(order.orderItemId, [...(exact.get(order.orderItemId) ?? []), id]);
      }
    }
    row.candidates.sort((a, b) => a.id.localeCompare(b.id));
    if (row.status !== 'matched' && prior) {
      row.status = 'review';
      row.reason =
        prior.companyId === scope.companyId
          ? 'Previous confirmation needs review.'
          : 'This order has a confirmation in another company.';
      row.candidates = [];
    } else if (row.status !== 'matched' && row.candidates.length) {
      row.status = 'review';
      row.reason = sharedLedger
        ? 'This ledger is shared by seller accounts. Confirm the bill.'
        : 'Select the corresponding sales bill.';
    } else if (
      row.status === 'unmatched' &&
      rule.field !== 'manual' &&
      billsByItem
        .get(item.externalId)
        ?.some(
          (bill) =>
            bill.date >= saleDay(order.orderDate) &&
            hasReference(rule, bill, order) &&
            bill.lines.some(
              (line) =>
                line.itemExternalId === item.externalId &&
                (line.unit !== item.unit || line.quantity !== units),
            ),
        )
    ) {
      row.status = 'review';
      row.reason =
        'A bill references this sale with a different quantity or unit. Reconcile the stock deduction before publishing.';
    }
  }
  for (const row of rows) {
    const matches = exact.get(row.orderItemId);
    const group = orderGroup.get(row.orderItemId);
    if (
      row.status === 'review' &&
      !sharedLedger &&
      group &&
      groupSizes.get(group) === 1 &&
      matches?.length === 1 &&
      claims.get(matches[0]) === 1 &&
      row.candidates.length === 1
    ) {
      row.status = 'matched';
      row.bill = row.candidates[0];
      row.reason = 'Reference, stock item and quantity match.';
    }
  }
  // A blank reference on another order is only a possible manual candidate.
  // An exact link to a different order already consumes this bill's item.
  const referencedLines = new Set<string>();
  for (const row of rows) {
    const link = row.bill && links.get(row.orderItemId)?.get(row.bill.id);
    if (link && row.status === 'matched') referencedLines.add(key(link.billId, link.itemId));
  }
  for (const row of rows.filter((r) => r.status === 'review' && r.candidates.length)) {
    row.candidates = row.candidates.filter((b) => {
      const link = links.get(row.orderItemId)?.get(b.id);
      return link && !referencedLines.has(key(link.billId, link.itemId));
    });
    if (!row.candidates.length && !assigned.has(row.orderItemId)) {
      row.status = 'unmatched';
      row.reason = 'No available corresponding sales bill found in this review.';
    }
  }
  const company = state.companies.find((c) => c.id === scope.companyId);
  const stock = [...stockItems.values()].map(({ item, rows: itemRows }) => {
    const total = itemRows.reduce(
      (sum, row) => sum + (row.status === 'matched' ? 0 : (row.baseUnits ?? NaN)),
      0,
    );
    const unmatchedUnits = Number.isSafeInteger(total) ? total : null;
    const fresh =
      state.mode === 'demo' ||
      (state.connection.tally === 'online' &&
        company?.lastSuccess &&
        !company.stockIssue &&
        item.observedAt &&
        Date.now() - Date.parse(item.observedAt) <=
          Math.max(120_000, state.settings.tallySeconds * 3000));
    const physical = evidence.balances
      ? (evidence.balances.find((i) => i.externalId === item.externalId && i.unit === item.unit)
          ?.physical ?? null)
      : fresh
        ? item.physical
        : null;
    return {
      name: item.name,
      unit: item.unit,
      physical,
      unmatchedUnits,
      previewAvailable:
        physical === null || unmatchedUnits === null
          ? null
          : Math.max(0, physical - unmatchedUnits),
    };
  });
  return {
    rows: rows.sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)),
    stock: stock.sort((a, b) => a.name.localeCompare(b.name)),
    links,
  };
}
