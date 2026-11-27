import { createHash } from 'node:crypto';
import { saleDay } from '../domain/sale-day.js';
import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';
import type { TallySalesBill, TallyStockItem } from '../adapters/tally.js';
import { availableForMarketplaces } from '../domain/stock-policy.js';
import { isVerifiedCancellation, isVerifiedSale } from '../shared/stock-coverage.js';
import type {
  BillCandidate,
  BillingReport,
  BillingRow,
  BillingRule,
} from '../shared/billing-contracts.js';
import type { Listing, Snapshot, StockItem } from '../shared/contracts.js';
import type { MarketplaceListing } from '../shared/marketplace-contracts.js';
import type { BillingData, BillingLink } from './storage/billing-records.js';
import { hasConfirmedPickup } from './marketplace-catalog.js';
import { isRecentObservation } from './validation.js';

export interface BillingScope {
  companyId: string;
  accountId: string;
}
export interface BillingEvidence {
  orders: FlipkartBillingOrder[];
  bills: TallySalesBill[];
  balances?: TallyStockItem[];
  /** Company-wide evidence, including order status retained across provider reads. */
  knownOrders?: ReadonlyArray<{ accountId: string; order: FlipkartBillingOrder }>;
  /** Vouchers from participating sellers, used only to detect competing claims. */
  knownBills?: ReadonlyArray<TallySalesBill>;
}

export interface VoucherMatch {
  bill: BillCandidate;
  lines: TallySalesBill['lines'];
  actualReference: string | null;
  referenceMatches: boolean;
  reason: string | null;
  link?: BillingLink;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function usesInvoiceNumber(rule: BillingRule): boolean {
  return rule.field !== 'manual' && rule.reference === 'invoiceNumber';
}

export function billItemKey(billId: string, itemExternalId: string) {
  return JSON.stringify([billId, itemExternalId]);
}

export const competingInvoiceMessage =
  'Another order could claim this Tally bill. Retry the invoice check to verify the matching sale.';

function mappedUnits(order: FlipkartBillingOrder, mapping?: Listing) {
  if (
    !mapping?.verified ||
    !mapping.packSize ||
    (mapping.packSource === 'packages' &&
      (!mapping.packageAvailable || mapping.packageCount !== mapping.packSize))
  )
    return null;
  const units = order.quantity * mapping.packSize;
  return Number.isSafeInteger(units) && units > 0 ? units : null;
}

// A reference or voucher number is an identifier. Free-text narration may
// surround it with words, but OD-12 must never match part of OD-123 or X/OD-12.
function hasReference(rule: BillingRule, bill: TallySalesBill, order: FlipkartBillingOrder) {
  const id = order[rule.reference];
  if (
    !id ||
    rule.field === 'manual' ||
    (rule.reference === 'invoiceNumber' && order.invoiceLookup === 'failed')
  )
    return false;
  const text = bill[rule.field].trim();
  if (rule.field !== 'narration') return text === id;
  return mentionsIdentifier(text, id);
}

function mentionsIdentifier(text: string, id: string) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_/.-])${escaped}(?=$|[^\\p{L}\\p{N}_/.-]|\\.(?=\\s|$))`,
    'u',
  ).test(text);
}

export { saleDay };

// Ordinary manual confirmations retain their existing digest. The prefix distinguishes
// a seller-inspected voucher that needs the stronger evidence checks on every read.
const inspectedVoucher = 'inspected-voucher-v1:';
const assignmentMarker = ':assignment:';

export function isInspectedBillLink(link: BillingLink): boolean {
  return link.fingerprint.startsWith(inspectedVoucher);
}

/** A new confirmation of identical evidence still has its own release identity. */
export function storeReviewedBillLink(link: BillingLink, nonce: string): BillingLink {
  return { ...link, fingerprint: link.fingerprint + assignmentMarker + nonce };
}

function storedProof(link: BillingLink) {
  return link.fingerprint.split(assignmentMarker, 1)[0];
}

function voucherMentions(bill: TallySalesBill, id: string) {
  return (
    bill.reference.trim() === id ||
    bill.number.trim() === id ||
    (!!bill.narration && mentionsIdentifier(bill.narration, id))
  );
}

function refersTo(bill: TallySalesBill, order: FlipkartBillingOrder) {
  return [order.orderId, order.orderItemId, order.invoiceNumber].some(
    (id) => id && voucherMentions(bill, id),
  );
}

function sameOrderIdentity(left: FlipkartBillingOrder, right: FlipkartBillingOrder) {
  return (
    left.orderId === right.orderId &&
    left.listingId === right.listingId &&
    left.sku === right.sku &&
    left.locationId === right.locationId &&
    left.quantity === right.quantity &&
    Date.parse(left.orderDate) === Date.parse(right.orderDate) &&
    (!left.invoiceNumber || !right.invoiceNumber || left.invoiceNumber === right.invoiceNumber)
  );
}

function unresolvedSale(order: FlipkartBillingOrder) {
  return !isVerifiedSale(order) || !!order.stockReturnConflict;
}

interface VoucherOrder {
  order: FlipkartBillingOrder;
  row: BillingRow;
  item?: StockItem;
  mapping?: Listing;
}

interface KnownVoucherOrder {
  accountId: string;
  order: FlipkartBillingOrder;
  mappedItemId?: string | null;
}

function inspectVoucher(
  target: VoucherOrder,
  bill: TallySalesBill,
  scope: BillingScope,
  rule: BillingRule,
  knownBills: ReadonlyArray<TallySalesBill>,
  knownOrders: KnownVoucherOrder[],
  owner: BillingLink | undefined,
): VoucherMatch {
  const { order, row, item, mapping } = target;
  const candidate: VoucherMatch = {
    bill: { id: bill.externalId, number: bill.number, date: bill.date },
    lines: bill.lines,
    actualReference: rule.field === 'manual' ? null : bill[rule.field],
    referenceMatches: hasReference(rule, bill, order),
    reason: null,
  };
  const itemLines = bill.lines.filter((line) => line.itemExternalId === item?.externalId);
  const targetIdentities = knownOrders.filter(
    (entry) => entry.accountId === scope.accountId && entry.order.orderItemId === order.orderItemId,
  );
  if (
    unresolvedSale(order) ||
    targetIdentities.some(
      (entry) => unresolvedSale(entry.order) || !sameOrderIdentity(order, entry.order),
    )
  ) {
    candidate.reason = 'The order has an unverified or conflicting sale status or identity.';
  } else if (
    !mapping?.verified ||
    !item ||
    row.baseUnits === null ||
    (mapping.marketplaceListingId && mapping.marketplaceListingId !== order.listingId)
  ) {
    candidate.reason = 'Verify the listing, pickup location, Tally item and Set of for this order.';
  } else if (bill.date < saleDay(order.orderDate)) {
    candidate.reason = 'The voucher is dated before the order.';
  } else if (!itemLines.length) {
    candidate.reason = 'The voucher has no line for the mapped Tally stock item.';
  } else if (
    itemLines.length !== 1 ||
    itemLines[0].unit !== item.unit ||
    itemLines[0].quantity !== row.baseUnits
  ) {
    candidate.reason =
      'The voucher must have one line for this stock item with the same unit and quantity.';
  } else if (
    owner &&
    (owner.accountId !== scope.accountId || owner.orderItemId !== order.orderItemId)
  ) {
    candidate.reason = 'The voucher’s stock item is already assigned to another order.';
  } else if (
    knownOrders.some(
      ({ order: known }) => known.invoiceLookup === 'failed' && isVerifiedSale(known),
    )
  ) {
    // Inspecting a voucher checks all its reference fields against the other
    // orders, including their Flipkart invoice numbers.
    candidate.reason =
      'Retry the invoice check before confirming this voucher. Its references could belong to another order.';
  } else if (
    knownOrders.some((entry) => {
      if (entry.accountId === scope.accountId) {
        if (entry.order.orderItemId === order.orderItemId) return false;
        // Separate stock items can legitimately share their parent order and invoice.
        if (
          entry.order.orderId === order.orderId &&
          entry.mappedItemId &&
          entry.mappedItemId !== item.id
        ) {
          return [entry.order.orderItemId, entry.order.invoiceNumber].some(
            (id) =>
              id && id !== order.orderId && id !== order.invoiceNumber && voucherMentions(bill, id),
          );
        }
      }
      return refersTo(bill, entry.order);
    })
  ) {
    candidate.reason = 'The voucher references another known order.';
  } else if (
    knownBills.some(
      (other) =>
        other.externalId !== bill.externalId &&
        other.date >= saleDay(order.orderDate) &&
        refersTo(other, order) &&
        other.lines.some((line) => line.itemExternalId === item.externalId),
    )
  ) {
    candidate.reason =
      'Another voucher references this order and stock item. Reconcile the bills first.';
  } else {
    const lineEvidence = bill.lines
      .map((line) => JSON.stringify([line.itemExternalId, line.unit, line.quantity]))
      .sort();
    candidate.link = {
      ...scope,
      ledgerId: rule.ledgerId,
      orderItemId: order.orderItemId,
      billId: bill.externalId,
      itemId: item.externalId,
      fingerprint:
        inspectedVoucher +
        fingerprint([
          scope.companyId,
          scope.accountId,
          rule.ledgerId,
          rule.field,
          rule.reference,
          order.orderItemId,
          order.orderId,
          order[rule.reference],
          order.listingId,
          order.sku,
          order.locationId,
          order.quantity,
          Date.parse(order.orderDate),
          mapping.id,
          mapping.packSize,
          item.externalId,
          item.unit,
          row.baseUnits,
          bill.externalId,
          bill.number,
          bill.date,
          bill.reference,
          bill.narration,
          lineEvidence,
        ]),
    };
  }
  return candidate;
}

export function matchBills(
  scope: BillingScope,
  rule: BillingRule,
  evidence: BillingEvidence,
  saved: BillingData,
  state: Snapshot,
  catalogue: MarketplaceListing[],
  lookup?: { orderItemId: string; billNumber: string },
): {
  rows: BillingRow[];
  stock: BillingReport['stock'];
  links: Map<string, Map<string, BillingLink>>;
  voucherMatches: VoucherMatch[];
  unverifiedBillItems: Set<string>;
} {
  const rows: BillingRow[] = [];
  const voucherMatches: VoucherMatch[] = [];
  const voucherOrders: VoucherOrder[] = [];
  const links = new Map<string, Map<string, BillingLink>>();
  const exact = new Map<string, string[]>();
  const claims = new Map<string, number>();
  const orderGroup = new Map<string, string>();
  const groupSizes = new Map<string, number>();
  const expectedDeductions = new Set<string>();
  const differentDeductions = new Map<string, Set<string>>();
  const stockItems = new Map<string, { item: Snapshot['items'][number]; rows: BillingRow[] }>();
  const sharedLedger = saved.rules.some(
    (r) =>
      r.companyId === scope.companyId &&
      r.accountId !== scope.accountId &&
      r.ledgerId === rule.ledgerId,
  );
  const used = new Map(
    saved.links
      .filter((l) => l.companyId === scope.companyId)
      .map((l) => [billItemKey(l.billId, l.itemId), l]),
  );
  const assigned = new Map(
    saved.links.filter((l) => l.accountId === scope.accountId).map((l) => [l.orderItemId, l]),
  );
  const listings = new Map(
    catalogue.filter((l) => l.observedAt).map((l) => [JSON.stringify([l.accountId, l.id]), l]),
  );
  const destinations = new Map(
    state.listings.map((l) => [JSON.stringify([l.accountId, l.sku, l.location]), l]),
  );
  const items = new Map(state.items.map((i) => [i.id, i]));
  const billsByStock = new Map<string, TallySalesBill[]>();
  const billsByItemReference = new Map<string, TallySalesBill[]>();
  for (const bill of evidence.bills) {
    for (const line of bill.lines) {
      if (rule.field !== 'manual') {
        const reference = rule.field === 'narration' ? null : bill[rule.field].trim();
        const itemReference = JSON.stringify([line.itemExternalId, reference]);
        const itemBills = billsByItemReference.get(itemReference);
        if (itemBills) itemBills.push(bill);
        else billsByItemReference.set(itemReference, [bill]);
      }
      const signature = JSON.stringify([line.itemExternalId, line.unit, line.quantity]);
      const bucket = billsByStock.get(signature);
      if (bucket) bucket.push(bill);
      else billsByStock.set(signature, [bill]);
    }
  }
  function mappingFor(order: FlipkartBillingOrder, accountId = scope.accountId) {
    const listing = listings.get(JSON.stringify([accountId, order.listingId]));
    const candidate = destinations.get(JSON.stringify([accountId, order.sku, order.locationId]));
    return candidate &&
      listing?.sku === order.sku &&
      (!candidate.skuMappingId || candidate.skuMappingId === listing.id) &&
      (listing.locations.some((loc) => loc.id === order.locationId) ||
        hasConfirmedPickup(candidate, listing))
      ? candidate
      : undefined;
  }
  // A shortened seller search can omit a sibling that still claims this voucher.
  // Reconcile those claims together, then report only the requested order items.
  const requestedOrders = new Set(evidence.orders.map((order) => order.orderItemId));
  const retained = new Map(
    evidence.knownOrders
      ?.filter((entry) => entry.accountId === scope.accountId)
      .map(({ order }) => [order.orderItemId, order]),
  );
  const orders = [
    ...evidence.orders,
    ...[...retained.values()].filter(
      (order) => !requestedOrders.has(order.orderItemId) && !isVerifiedCancellation(order),
    ),
  ];
  // An unavailable invoice can dispute a deduction in this ledger only for
  // the same stock item, unit and quantity, on or after the competing sale.
  const missingInvoices = usesInvoiceNumber(rule)
    ? orders
        .filter((order) => order.invoiceLookup === 'failed')
        .map((order) => ({ accountId: scope.accountId, order }))
    : [];
  if (sharedLedger) {
    const invoicePeers = new Set(
      saved.rules
        .filter(
          (r) =>
            r.companyId === scope.companyId &&
            r.accountId !== scope.accountId &&
            r.ledgerId === rule.ledgerId &&
            usesInvoiceNumber(r),
        )
        .map((r) => r.accountId),
    );
    for (const entry of evidence.knownOrders ?? [])
      if (entry.order.invoiceLookup === 'failed' && invoicePeers.has(entry.accountId))
        missingInvoices.push(entry);
  }
  const earliestMissing = new Map<string, { itemExternalId: string; date: string }>();
  for (const { accountId, order } of missingInvoices) {
    if (unresolvedSale(order)) continue;
    const mapping = mappingFor(order, accountId);
    const item = mapping?.itemId && items.get(mapping.itemId);
    const units = mappedUnits(order, mapping);
    if (!item || item.companyId !== scope.companyId || units === null) continue;
    const signature = JSON.stringify([item.externalId, item.unit, units]);
    const date = saleDay(order.orderDate);
    const previous = earliestMissing.get(signature);
    if (!previous || date < previous.date)
      earliestMissing.set(signature, { itemExternalId: item.externalId, date });
  }
  const unverifiedBillItems = new Set<string>();
  for (const [signature, { itemExternalId, date }] of earliestMissing)
    for (const bill of billsByStock.get(signature) ?? [])
      if (bill.date >= date) unverifiedBillItems.add(billItemKey(bill.externalId, itemExternalId));
  for (const order of orders) {
    const mapping = mappingFor(order);
    const item = mapping?.itemId ? items.get(mapping.itemId) : undefined;
    if (item && item.companyId !== scope.companyId) continue;
    // A shared invoice/order reference and one aggregated bill quantity
    // cannot identify a specific line in a partial or consolidated sale.
    const missingInvoice = order.invoiceLookup === 'failed' && usesInvoiceNumber(rule);
    const referenceValue = rule.field === 'manual' ? null : order[rule.reference];
    // A last-known invoice can still dispute a sibling's match even while
    // this order's own invoice reference is waiting for verification.
    if (item && referenceValue) {
      const group = JSON.stringify([item.id, referenceValue]);
      orderGroup.set(order.orderItemId, group);
      groupSizes.set(group, (groupSizes.get(group) ?? 0) + 1);
    }
    const row: BillingRow = {
      orderItemId: order.orderItemId,
      orderId: order.orderId,
      listingId: order.listingId,
      orderDate: order.orderDate,
      referenceValue: missingInvoice ? null : referenceValue,
      sku: order.sku,
      location: order.locationId,
      quantity: order.quantity,
      baseUnits: null,
      status: 'unmapped',
      reason:
        'This preview needs a verified Tally item, pickup location and Set of to match the sale.',
      bill: null,
      candidates: [],
    };
    rows.push(row);
    const prior = assigned.get(order.orderItemId);
    if (prior?.companyId === scope.companyId) row.manualBillId = prior.billId;
    if (
      lookup?.orderItemId === order.orderItemId ||
      (prior?.companyId === scope.companyId && isInspectedBillLink(prior))
    ) {
      voucherOrders.push({ order, row, item, mapping });
    }
    if (!item) continue;
    if (requestedOrders.has(order.orderItemId)) {
      const group = stockItems.get(item.id) ?? { item, rows: [] };
      group.rows.push(row);
      stockItems.set(item.id, group);
    }
    const recorded = retained.get(order.orderItemId);
    if (
      unresolvedSale(order) ||
      (recorded && (unresolvedSale(recorded) || !sameOrderIdentity(order, recorded)))
    ) {
      row.status = 'review';
      row.reason =
        'This order item’s sale status or identity needs verification. Refresh after checking the order.';
      continue;
    }
    const units = mappedUnits(order, mapping);
    if (units === null) continue;
    row.baseUnits = units;
    if (missingInvoice) {
      row.status = 'review';
      row.reason = 'Retry the invoice check to verify this sale against its Tally bill.';
      continue;
    }
    const referenceGroup = orderGroup.get(order.orderItemId);
    if (referenceGroup) expectedDeductions.add(JSON.stringify([referenceGroup, item.unit, units]));
    row.status = 'unmatched';
    row.reason = 'No corresponding sales bill found in this review.';
    const choices = new Map<string, BillingLink>();
    links.set(order.orderItemId, choices);
    const signature = JSON.stringify([item.externalId, item.unit, units]);
    let competingVoucher = false;
    let competingInvoice = false;
    for (const bill of billsByStock.get(signature) ?? []) {
      if (bill.date < saleDay(order.orderDate)) continue;
      const lineId = billItemKey(bill.externalId, item.externalId);
      const owner = used.get(lineId);
      if (
        owner &&
        (owner.accountId !== scope.accountId || owner.orderItemId !== order.orderItemId)
      ) {
        if (isInspectedBillLink(owner) && refersTo(bill, order)) competingVoucher = true;
        continue;
      }
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
      if (unverifiedBillItems.has(lineId)) {
        competingInvoice = true;
        continue;
      }
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
        storedProof(prior) === link.fingerprint
      ) {
        row.bill = candidate;
        row.status = 'matched';
        row.reason = 'Confirmed by seller.';
      }
      if (refMatches) {
        const id = lineId;
        claims.set(id, (claims.get(id) ?? 0) + 1);
        exact.set(order.orderItemId, [...(exact.get(order.orderItemId) ?? []), id]);
      }
    }
    row.candidates.sort((a, b) => a.id.localeCompare(b.id));
    if (competingVoucher) {
      row.status = 'review';
      row.bill = null;
      row.candidates = [];
      row.reason =
        'A voucher for this order has been confirmed for another order. Review the assignments.';
    } else if (competingInvoice && !row.candidates.length) {
      row.status = 'review';
      row.reason = competingInvoiceMessage;
    } else if (row.status !== 'matched' && prior) {
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
    }
    if (!referenceGroup) continue;
    const deductions = new Set<string>();
    const reference = rule.field === 'narration' ? null : order[rule.reference];
    for (const bill of billsByItemReference.get(JSON.stringify([item.externalId, reference])) ??
      []) {
      if (bill.date < saleDay(order.orderDate) || !hasReference(rule, bill, order)) continue;
      for (const line of bill.lines) {
        if (
          line.itemExternalId === item.externalId &&
          (line.unit !== item.unit || line.quantity !== units)
        )
          deductions.add(JSON.stringify([referenceGroup, line.unit, line.quantity]));
      }
    }
    if (deductions.size) differentDeductions.set(order.orderItemId, deductions);
  }
  for (const row of rows) {
    const matches = exact.get(row.orderItemId);
    const group = orderGroup.get(row.orderItemId);
    // Only a verified sibling quantity under the same reference and stock item
    // can explain a second voucher with a different deduction.
    const different = differentDeductions.get(row.orderItemId);
    if (
      different &&
      (row.status === 'unmatched' || [...different].some((key) => !expectedDeductions.has(key)))
    ) {
      row.status = 'review';
      row.bill = null;
      row.candidates = [];
      row.reason =
        'A bill references this sale with a different quantity or unit. Reconcile the stock deduction before publishing.';
      continue;
    }
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
    if (link && row.status === 'matched')
      referencedLines.add(billItemKey(link.billId, link.itemId));
  }
  for (const row of rows.filter((r) => r.status === 'review' && r.candidates.length)) {
    row.candidates = row.candidates.filter((b) => {
      const link = links.get(row.orderItemId)?.get(b.id);
      return link && !referencedLines.has(billItemKey(link.billId, link.itemId));
    });
    if (!row.candidates.length && !assigned.has(row.orderItemId)) {
      row.status = 'unmatched';
      row.reason = 'No available corresponding sales bill found in this review.';
    }
  }
  if (voucherOrders.length) {
    const knownBills = [...evidence.bills, ...(evidence.knownBills ?? [])];
    const knownOrders = [
      ...evidence.orders.map((order) => ({ accountId: scope.accountId, order })),
      ...(evidence.knownOrders ?? []),
    ].map((entry) => {
      const mapped = entry.accountId === scope.accountId && mappingFor(entry.order);
      return { ...entry, mappedItemId: mapped && mapped.verified ? mapped.itemId : null };
    });
    for (const target of voucherOrders) {
      const { order, row, item } = target;
      const prior = assigned.get(order.orderItemId);
      const restoring = prior?.companyId === scope.companyId && isInspectedBillLink(prior);
      if (restoring && row.status === 'unmapped') {
        row.status = 'review';
        row.reason = 'The stock mapping for this confirmed voucher changed. Review the assignment.';
      }
      for (const bill of evidence.bills) {
        const selected =
          lookup?.orderItemId === order.orderItemId &&
          bill.number.trim() === lookup.billNumber.trim();
        const recorded = restoring && prior.billId === bill.externalId;
        if (!selected && !recorded) continue;
        const owner = item && used.get(billItemKey(bill.externalId, item.externalId));
        const result = inspectVoucher(target, bill, scope, rule, knownBills, knownOrders, owner);
        if (
          recorded &&
          result.link?.fingerprint === storedProof(prior) &&
          result.link.itemId === prior.itemId &&
          result.link.ledgerId === prior.ledgerId
        ) {
          row.status = 'matched';
          row.reason = 'Confirmed by seller after inspecting the Tally voucher.';
          row.bill = result.bill;
        }
        if (selected) {
          if (prior || row.status === 'matched') {
            delete result.link;
            result.reason = 'This order already has a bill assignment.';
          }
          voucherMatches.push(result);
        }
      }
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
        isRecentObservation(
          item.observedAt,
          Math.max(120_000, state.settings.tallySeconds * 3000),
        ));
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
      keepBackUnits: item.keepBackUnits,
      previewAvailable:
        physical === null || unmatchedUnits === null
          ? null
          : availableForMarketplaces(physical, unmatchedUnits, item.keepBackUnits),
    };
  });
  return {
    rows: rows
      .filter((row) => requestedOrders.has(row.orderItemId))
      .sort((a, b) => a.orderItemId.localeCompare(b.orderItemId)),
    stock: stock.sort((a, b) => a.name.localeCompare(b.name)),
    links: new Map([...links].filter(([orderItemId]) => requestedOrders.has(orderItemId))),
    voucherMatches,
    unverifiedBillItems,
  };
}
