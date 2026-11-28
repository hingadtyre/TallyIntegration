import { randomUUID } from 'node:crypto';
import type { BillLookup, TrackedBillHistory } from '../shared/billing-contracts.js';
import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';
import { isVerifiedSale } from '../shared/stock-coverage.js';
import {
  fingerprint,
  isInspectedBillLink,
  matchBills,
  mappedUnits,
  storeReviewedBillLink,
  type BillingScope,
} from './billing-matcher.js';
import type { BillingService } from './billing-service.js';
import { invalidateReservationDrafts } from './proposals.js';
import type { CompanyBillEvidence, StockAvailabilityService } from './stock-availability.js';
import { mappedSaleItem, mappedSaleListing } from './stock-configuration.js';
import type { ExpandedBillEvidence, TrackedBillingService } from './tracked-billing.js';
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

function inspectableShipment(order: FlipkartBillingOrder) {
  return (
    !!order.postDispatchWithoutCourierReturn &&
    !!order.stockDispatchObserved &&
    !order.stockReturnObserved &&
    !order.stockReturnConflict &&
    !order.stockReconciliationRequired &&
    !order.stockIdentityConflict &&
    order.marketplaceHold !== true &&
    ['SHIPPED', 'DELIVERED', 'PICKUP_COMPLETE'].includes(order.marketplaceStatus ?? '')
  );
}

function trackedOrders(
  evidence: CompanyBillEvidence,
  scope: BillingScope,
  expanded?: ExpandedBillEvidence,
): TrackedBillHistory {
  const { ctx } = evidence;
  const links = new Map(
    ctx.billing.links
      .filter((l) => l.companyId === scope.companyId && l.accountId === scope.accountId)
      .map((l) => [l.orderItemId, l]),
  );
  const vouchers = new Map(
    evidence.vouchers.get(scope.accountId)?.map((bill) => [bill.externalId, bill]),
  );
  const history: TrackedBillHistory = {
    orders: [],
    billed: [],
    ...(expanded && { check: expanded.check }),
  };
  const failed = expanded?.failedGroups.get(scope.accountId);
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
    const groups = expanded?.groupsByOrder.get(order.orderItemId);
    const tallyIssue = expanded?.unreadableBills.has(accountId)
      ? expanded.check.billingIssue
      : undefined;
    // Legacy stock receipts did not distinguish standard from self-ship.
    const checked =
      !tallyIssue &&
      (groups?.size
        ? expanded!.observed.has(order.orderItemId) ||
          [...groups].every((group) => !failed?.has(group))
        : !failed?.has('standard') && !failed?.has('selfShip'));
    const saved = links.get(order.orderItemId);
    const uncheckedClaim =
      result.status === 'matched' &&
      ((itemId && expanded?.uncheckedItems.get(itemId)) ||
        (saved &&
          isInspectedBillLink(saved) &&
          expanded?.check.complete === false &&
          'Retry the incomplete fulfilment checks to verify the previously linked Tally bill.'));
    const stockGroup = groups?.size
      ? [...groups].every((group) => group === 'standard' || group === 'selfShip')
      : expanded?.stockOrders.has(order.orderItemId);
    const billingOnly =
      expanded &&
      result.status === 'reserved' &&
      (!expanded.stockOrders.has(order.orderItemId) ||
        !mappedSaleItem(ctx, accountId, order) ||
        !stockGroup);
    if (checked && !uncheckedClaim && result.status === 'matched' && match)
      history.billed.push({ ...identity, ...match });
    const bill = saved && vouchers.get(saved.billId);
    const stockMapping =
      !expanded ||
      (expanded.stockCoverageFrom && order.orderDate >= expanded.stockCoverageFrom && stockGroup);
    const item = itemId && ctx.items.get(itemId);
    const observed = expanded?.observed.has(order.orderItemId);
    const returnReceipt =
      result.returnReceipt &&
      expanded?.check.complete &&
      observed &&
      stockMapping &&
      itemId &&
      !expanded.uncheckedItems.has(itemId) &&
      mappedSaleItem(ctx, accountId, order) &&
      result.returnReceipt;
    const inspectOnly =
      inspectableShipment(order) &&
      !!observed &&
      !isVerifiedSale(order) &&
      mappedUnits(order, mappedSaleListing(ctx, accountId, order, 'billing') ?? undefined) !== null;
    history.orders.push({
      ...identity,
      ...(!order.stockIdentityConflict &&
        order.marketplaceStatus && {
          marketplaceStatus: order.marketplaceStatus,
          statusVerifiedAt: order.statusVerifiedAt,
          marketplaceHold: order.marketplaceHold,
        }),
      ...(expanded && !observed && { savedOnly: true }),
      ...(checked &&
        !billingOnly &&
        !(itemId && expanded?.uncheckedItems.has(itemId)) &&
        result.status === 'reserved' &&
        item &&
        result.baseUnits && { reserved: { quantity: result.baseUnits, unit: item.unit } }),
      ...(returnReceipt && { returnReceipt }),
      ...(groups?.size === 1 && { fulfilment: [...groups][0] }),
      ...(checked &&
        !saved &&
        result.status === 'unmapped' &&
        isVerifiedSale(order) &&
        order.listingId &&
        order.locationId && {
          mapping: {
            listingId: order.listingId,
            location: order.locationId,
            purpose: stockMapping ? 'stock' : 'billing',
          },
        }),
      status: !checked || uncheckedClaim ? 'review' : billingOnly ? 'unmatched' : result.status,
      reason:
        tallyIssue ??
        (!checked
          ? 'The current fulfilment check is incomplete. Retry to verify this saved order.'
          : uncheckedClaim
            ? uncheckedClaim
            : expanded && !order.locationId
              ? 'The marketplace did not provide the location needed to verify the listing. Check the order location in the seller account, then refresh tracked orders.'
              : expanded && (!order.listingId || !order.sku)
                ? 'Check the listing ID and seller SKU for this order in the seller account, then refresh tracked orders.'
                : result.status === 'unmapped' && !isVerifiedSale(order)
                  ? 'Verify the sale status and listing identity in the seller account before mapping this order.'
                  : billingOnly
                    ? 'No verified Tally bill was found for this sale.'
                    : expanded && result.status === 'cancelled'
                      ? 'The marketplace confirmed this order was cancelled before dispatch.'
                      : inspectOnly
                        ? 'Flipkart confirms this shipment. Its return status is unverified. You can inspect a Tally bill while stock and billing await verification.'
                        : result.reason),
      canFindBill:
        checked &&
        !expanded?.check.billingIssue &&
        !saved &&
        !!itemId &&
        ((isVerifiedSale(order) &&
          result.baseUnits !== null &&
          (result.status === 'reserved' || result.status === 'review')) ||
          inspectOnly),
      ...(saved && { manualBillId: saved.billId, linkToken: fingerprint(saved) }),
      ...(bill && { manualBillNumber: bill.number, manualBillDate: bill.date }),
    });
  }
  history.orders.sort(
    (a, b) => b.orderDate.localeCompare(a.orderDate) || a.orderItemId.localeCompare(b.orderItemId),
  );
  history.billed.sort(
    (a, b) =>
      b.orderDate.localeCompare(a.orderDate) ||
      a.orderId.localeCompare(b.orderId) ||
      a.orderItemId.localeCompare(b.orderItemId),
  );
  return history;
}

function inspectBill(
  evidence: CompanyBillEvidence,
  search: Search,
  expanded?: ExpandedBillEvidence,
) {
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
  const inspectOnly =
    !isVerifiedSale(target.order) &&
    inspectableShipment(target.order) &&
    expanded?.observed.has(search.orderItemId);
  if (!item || (!isVerifiedSale(target.order) && !inspectOnly))
    throw conflict(target.result.reason);
  const incomplete = expanded?.check.complete === false;
  const uncheckedClaim = expanded?.uncheckedItems.get(item.id);
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
  const baseUnits =
    row?.baseUnits ??
    (inspectOnly
      ? mappedUnits(
          target.order,
          mappedSaleListing(ctx, search.accountId, target.order, 'billing') ?? undefined,
        )
      : null);
  if (!row || baseUnits === null)
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
      const issue =
        (inspectOnly
          ? 'Flipkart has not verified this shipment’s return status. This bill can be inspected only.'
          : null) ??
        m.reason ??
        uncheckedClaim ??
        (incomplete
          ? 'Retry the incomplete fulfilment checks before confirming a bill. Another order could claim it.'
          : null);
      if (!issue && m.link) links.set(m.bill.id, m.link);
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
        issue,
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
    baseUnits,
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
    private readonly tracked?: TrackedBillingService,
  ) {}

  invalidate(accountId: string) {
    this.tracked?.invalidate(accountId);
    for (const [key, review] of this.reviews) {
      if (review.search.accountId === accountId) this.reviews.delete(key);
    }
  }

  private async check(search: Search) {
    const previewStart = () =>
      search.previewId
        ? this.billing.previewStartForOrder(search, search.previewId, search.orderItemId)
        : undefined;
    const expanded =
      this.tracked && this.store.readBillingTrackingStart(search.companyId)
        ? await this.tracked.check(search, {}, { previewFrom: previewStart() })
        : undefined;
    const evidence =
      expanded?.evidence ??
      (await this.availability.readBillEvidence(
        search.companyId,
        search.accountId,
        search.orderItemId,
        previewStart(),
      ));
    previewStart();
    const match = inspectBill(evidence, search, expanded);
    evidence.verify();
    return { evidence, match };
  }

  async command(path: string, input: Record<string, unknown>, accountId: string) {
    const { id: companyId } = requireCompany(this.store.read(), input.companyId);
    const scope = { companyId, accountId };
    const key = JSON.stringify([companyId, accountId]);
    if (path === '/api/billing/lookup-order' || path === '/api/billing/pickup-count') {
      if (!this.tracked) throw new InputError('Marketplace order lookups are unavailable.', 502);
      return this.tracked.lookup(scope, input, path.endsWith('/pickup-count'));
    }
    if (path === '/api/billing/tracked-bills') {
      if (
        !this.store.readBillingTrackingStart(companyId) ||
        !this.store
          .readBilling()
          .rules.some((r) => r.companyId === companyId && r.accountId === accountId)
      ) {
        if (input.retryGroup !== undefined || input.checkId !== undefined)
          throw conflict('The billing scope changed. Refresh tracked orders.');
        return { orders: [], billed: [] } satisfies TrackedBillHistory;
      }
      if (this.tracked) {
        const expanded = await this.tracked.check(scope, input);
        return trackedOrders(expanded.evidence, scope, expanded);
      }
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
