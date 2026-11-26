import { randomUUID } from 'node:crypto';
import type { BillLookup, TrackedBillHistory } from '../shared/billing-contracts.js';
import { isVerifiedSale } from '../shared/stock-coverage.js';
import {
  fingerprint,
  matchBills,
  storeReviewedBillLink,
  type BillingScope,
} from './billing-matcher.js';
import type { BillingService } from './billing-service.js';
import { invalidateReservationDrafts } from './proposals.js';
import type { CompanyBillEvidence, StockAvailabilityService } from './stock-availability.js';
import type { BillingData, BillingLink } from './storage/billing-records.js';
import type { Snapshot } from '../shared/contracts.js';
import type { Store } from './store.js';
import { InputError, requireCompany, requireText } from './validation.js';

const conflict = (message: string) => new InputError(message, 409);

type Search = BillingScope & { orderItemId: string; billNumber: string; previewId?: string };
type Review = { id: string; search: Search; expires: number; evidence: string };

function billDecisions(data: BillingData, scope: BillingScope) {
  return fingerprint([
    data.rules.filter((r) => r.companyId === scope.companyId),
    data.links.filter((l) => l.companyId === scope.companyId || l.accountId === scope.accountId),
  ]);
}

function invalidateBillStock(state: Snapshot, link: BillingLink) {
  const item = state.items.find(
    (i) => i.companyId === link.companyId && i.externalId === link.itemId,
  );
  if (item) invalidateReservationDrafts(state, new Set([item.id]));
}

function trackedOrders(evidence: CompanyBillEvidence, scope: BillingScope): TrackedBillHistory {
  const { ctx } = evidence;
  const links = new Map(
    ctx.billing.links
      .filter((l) => l.companyId === scope.companyId && l.accountId === scope.accountId)
      .map((l) => [l.orderItemId, l]),
  );
  const vouchers = new Map(
    evidence.vouchers.get(scope.accountId)?.map((bill) => [bill.externalId, bill]),
  );
  const history: TrackedBillHistory = { orders: [], billed: [] };
  for (const { accountId, itemId, order, result, match } of evidence.orders) {
    if (
      accountId !== scope.accountId ||
      (itemId && ctx.items.get(itemId)?.companyId !== scope.companyId)
    )
      continue;
    const identity = {
      orderItemId: order.orderItemId,
      orderId: order.orderId,
      orderDate: order.orderDate,
      sku: order.sku,
    };
    if (result.status === 'matched' && match) history.billed.push({ ...identity, ...match });
    const saved = links.get(order.orderItemId);
    const bill = saved && vouchers.get(saved.billId);
    if (
      !saved &&
      (!itemId ||
        !isVerifiedSale(order) ||
        result.baseUnits === null ||
        (result.status !== 'reserved' && result.status !== 'review'))
    )
      continue;
    history.orders.push({
      ...identity,
      status: result.status,
      reason: result.reason,
      ...(saved && { manualBillId: saved.billId, linkToken: fingerprint(saved) }),
      ...(bill && { manualBillNumber: bill.number, manualBillDate: bill.date }),
    });
  }
  history.orders.sort(
    (a, b) => a.orderDate.localeCompare(b.orderDate) || a.orderItemId.localeCompare(b.orderItemId),
  );
  history.billed.sort(
    (a, b) =>
      b.orderDate.localeCompare(a.orderDate) ||
      a.orderId.localeCompare(b.orderId) ||
      a.orderItemId.localeCompare(b.orderItemId),
  );
  return history;
}

function inspectBill(evidence: CompanyBillEvidence, search: Search) {
  const { ctx, coverage } = evidence;
  const rule = ctx.rules.find((r) => r.accountId === search.accountId);
  if (!rule) throw conflict('Confirm bill matching for this company and seller first.');
  const target = evidence.orders.find(
    (e) => e.accountId === search.accountId && e.order.orderItemId === search.orderItemId,
  );
  if (!target || (target.itemId && ctx.items.get(target.itemId)?.companyId !== search.companyId))
    throw conflict(
      'This order item could not be verified for this seller and company in the reviewed period.',
    );
  const item = target.itemId ? ctx.items.get(target.itemId) : undefined;
  if (!item || !isVerifiedSale(target.order)) throw conflict(target.result.reason);
  const { rows, voucherMatches } = matchBills(
    { companyId: search.companyId, accountId: search.accountId },
    rule,
    {
      orders: coverage.orders.filter((e) => e.accountId === search.accountId).map((e) => e.order),
      bills: evidence.vouchers.get(search.accountId) ?? [],
      knownOrders: coverage.orders,
      knownBills: [...evidence.vouchers.values()].flat(),
    },
    ctx.billing,
    ctx.state,
    ctx.market.listings,
    search,
  );
  const row = rows.find((r) => r.orderItemId === search.orderItemId);
  if (!row || row.baseUnits === null)
    throw conflict('Verify the stock item, pickup location and Set of for this order first.');
  const expectedReference = row.referenceValue ?? null;
  const itemNames = new Map(
    ctx.state.items
      .filter((i) => i.companyId === search.companyId)
      .map((i) => [i.externalId, i.name]),
  );
  const links = new Map<string, BillingLink>();
  const bills = voucherMatches
    .sort((a, b) => a.bill.id.localeCompare(b.bill.id))
    .map((m) => {
      if (!m.reason && m.link) links.set(m.bill.id, m.link);
      return {
        ...m.bill,
        recordedReference: m.actualReference,
        referenceMismatch:
          !!expectedReference && !!m.actualReference?.trim() && !m.referenceMatches,
        lines: [...m.lines]
          .sort((a, b) => a.itemExternalId.localeCompare(b.itemExternalId))
          .map((line) => ({
            itemName: itemNames.get(line.itemExternalId) ?? line.itemExternalId,
            unit: line.unit,
            quantity: line.quantity,
          })),
        issue: m.reason,
      };
    });
  const result: Omit<BillLookup, 'reviewId'> = {
    orderItemId: row.orderItemId,
    orderId: row.orderId,
    orderDate: target.order.orderDate,
    sku: row.sku,
    ledgerName: rule.ledgerName,
    itemName: item.name,
    unit: item.unit,
    baseUnits: row.baseUnits,
    expectedReference,
    field: rule.field,
    bills,
  };
  const version = fingerprint([
    result,
    [...links],
    ctx.signature,
    ctx.reviewState,
    evidence.trackingFrom,
    billDecisions(ctx.billing, search),
  ]);
  return { result, links, version };
}

export class BillLookupService {
  private readonly reviews = new Map<string, Review>();
  constructor(
    private readonly store: Store,
    private readonly availability: StockAvailabilityService,
    private readonly billing: BillingService,
  ) {}

  invalidate(accountId: string) {
    for (const [key, review] of this.reviews) {
      if (review.search.accountId === accountId) this.reviews.delete(key);
    }
  }

  private async check(search: Search) {
    const previewStart = () =>
      search.previewId
        ? this.billing.previewStartForOrder(search, search.previewId, search.orderItemId)
        : undefined;
    const evidence = await this.availability.readBillEvidence(
      search.companyId,
      search.accountId,
      search.orderItemId,
      previewStart(),
    );
    previewStart();
    const match = inspectBill(evidence, search);
    evidence.verify();
    return { evidence, match };
  }

  async command(path: string, input: Record<string, unknown>, accountId: string) {
    const { id: companyId } = requireCompany(this.store.read(), input.companyId);
    const scope = { companyId, accountId };
    const key = JSON.stringify([companyId, accountId]);
    if (path === '/api/billing/tracked-bills') {
      if (
        !this.store.readStockTrackingStart(companyId) ||
        !this.store
          .readBilling()
          .rules.some((r) => r.companyId === companyId && r.accountId === accountId)
      )
        return { orders: [], billed: [] } satisfies TrackedBillHistory;
      const evidence = await this.availability.readBillEvidence(companyId, accountId);
      return trackedOrders(evidence, scope);
    }
    const orderItemId = requireText(input.orderItemId, 'Order item');
    if (path === '/api/billing/find-bill') {
      const billNumber = requireText(input.billNumber, 'Tally bill number');
      const previewId =
        input.previewId === undefined ? undefined : requireText(input.previewId, 'Billing preview');
      const search = { ...scope, orderItemId, billNumber, previewId };
      const { match } = await this.check(search);
      const reviewId = randomUUID();
      this.reviews.set(key, {
        id: reviewId,
        search,
        expires: Date.now() + 600_000,
        evidence: match.version,
      });
      return { reviewId, ...match.result } satisfies BillLookup;
    }
    const billId = requireText(input.billId, 'Sales bill');
    if (path === '/api/billing/release-bill') {
      const linkToken = requireText(input.linkToken, 'Saved bill match');
      this.store.updateBilling((data, state) => {
        const saved = data.links.find(
          (l) =>
            l.companyId === companyId && l.accountId === accountId && l.orderItemId === orderItemId,
        );
        if (!saved || saved.billId !== billId || fingerprint(saved) !== linkToken)
          throw conflict('This bill match changed. Refresh the order before releasing it.');
        data.links = data.links.filter((l) => l !== saved);
        invalidateBillStock(state, saved);
      });
    } else if (path === '/api/billing/link-bill') {
      const currentReview = () => {
        const review = this.reviews.get(key);
        if (
          !review ||
          review.id !== input.reviewId ||
          review.search.orderItemId !== orderItemId ||
          Date.now() >= review.expires
        )
          throw conflict('This bill review expired or changed. Find the bill again.');
        return review;
      };
      const { match, evidence } = await this.check(currentReview().search);
      if (match.version !== currentReview().evidence)
        throw conflict('The order, bill or its claims changed. Find the bill again.');
      const link = match.links.get(billId);
      const candidate = match.result.bills.find((b) => b.id === billId);
      if (!link || !candidate || candidate.issue)
        throw conflict(candidate?.issue ?? 'Choose an eligible bill from this review.');
      if (candidate.referenceMismatch && input.acceptReferenceMismatch !== true)
        throw conflict('Confirm the different Tally reference before linking this bill.');
      evidence.verify();
      this.store.updateBilling((data, state) => {
        if (billDecisions(data, scope) !== billDecisions(evidence.ctx.billing, scope))
          throw conflict('A billing decision changed. Find the bill again.');
        data.links.push(storeReviewedBillLink(link, randomUUID()));
        invalidateBillStock(state, link);
      });
    } else {
      throw new InputError('Unknown bill review action.', 404);
    }
    this.reviews.delete(key);
    this.billing.invalidate(accountId);
    return { saved: true };
  }
}
