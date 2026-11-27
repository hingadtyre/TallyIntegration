import { randomUUID } from 'node:crypto';
import { FlipkartBillingClient, type FlipkartBillingOrder } from '../adapters/flipkart-billing.js';
import { TallyClient, type TallySalesBill, type TallyStockItem } from '../adapters/tally.js';
import { availableForMarketplaces } from '../domain/stock-policy.js';
import type { BilledOrderItem, PendingOrderResult } from '../shared/billing-contracts.js';
import type { ItemReservations, StockItem } from '../shared/contracts.js';
import { reservationCheckMaxAgeMs } from '../shared/contracts.js';
import {
  isVerifiedCancellation,
  isVerifiedSale,
  startTrackingMessage,
  type StockCoverageOrder,
  type StockSyncCoverage,
} from '../shared/stock-coverage.js';
import {
  billItemKey,
  competingInvoiceMessage,
  fingerprint,
  isInspectedBillLink,
  matchBills,
  saleDay,
} from './billing-matcher.js';
import { sampleBills } from './billing-sample.js';
import { checkCalculationStock, saveCalculation } from './inventory-calculation.js';
import { invalidateReservationDrafts, queueOrderProposal } from './proposals.js';
import { mappedSaleItem, mappedSaleListing, stockConfiguration } from './stock-configuration.js';
import type { BillingSources } from './billing-service.js';
import type { Store } from './store.js';
import { InputError, isRecentObservation, requireText } from './validation.js';

const day = 86_400_000;
const nowIso = () => new Date().toISOString();
const hold = (reason: string) => new InputError(reason, 409);

export function coverageIssue(coverage: StockSyncCoverage, signature: string, now: number) {
  if (coverage.signature !== signature)
    return 'This company’s stock or billing setup changed. In Order matching, choose Review starting stock and check the affected sales.';
  const lastCheck = Date.parse(coverage.checkedThrough ?? coverage.from);
  if (!Number.isFinite(lastCheck) || lastCheck > now || now - lastCheck > 30 * day)
    return 'Stockbridge has a gap in order coverage. In Order matching, choose Review starting stock after reconciling earlier sales.';
  return null;
}
type Access = (accountId: string) => Promise<{ token: string | null; verify: () => void }>;
type CheckedStock = {
  itemVersion: number;
  physical: number;
  reservedUnits: number;
  available: number;
  verify: () => void;
};
type ReviewedOrder = { order: StockCoverageOrder; result: PendingOrderResult };
type CompanyCheck = {
  canReuseForInventory: () => boolean;
  inventoryBalances: () => Promise<Record<string, ItemReservations>>;
  reservationItems: () => Set<string>;
  forItem: (id: string) => Promise<CheckedStock>;
  review: (accountId: string, orderItemIds?: string[]) => Promise<ReviewedOrder[]>;
  billEvidence: () => Promise<CompanyBillEvidence>;
};
export type CompanyBillEvidence = {
  ctx: ReturnType<typeof stockConfiguration>;
  coverage: StockSyncCoverage;
  trackingFrom: string | undefined;
  vouchers: Map<string, TallySalesBill[]>;
  orders: ReconciledOrder[];
  verify: () => void;
};
type CheckMode = 'publish' | 'preview' | 'review' | 'bills' | 'inventory';
type ReviewScope = { accountId: string; orderItemIds?: string[] | 'all' };

function configuration(store: Store, companyId: string) {
  return stockConfiguration(store.read(), store.readMarketplace(), store.readBilling(), companyId);
}

export function rulesForCheck(
  ctx: ReturnType<typeof configuration>,
  coverage: StockSyncCoverage,
  scope?: ReviewScope,
  checkingBills = false,
  requireStockSetup = checkingBills,
) {
  if (!scope) return ctx.rules;
  const seller = ctx.rules.find((rule) => rule.accountId === scope.accountId);
  if (!seller) throw hold('Confirm bill matching for this seller in Order matching.');
  if (!scope.orderItemIds) return [seller];

  const requested = scope.orderItemIds === 'all' ? null : new Set(scope.orderItemIds);
  const stockItems = new Set<string>();
  for (const { accountId, order } of coverage.orders) {
    if (accountId !== seller.accountId || (requested && !requested.has(order.orderItemId)))
      continue;
    const itemId = mappedSaleItem(ctx, accountId, order);
    if (itemId) stockItems.add(itemId);
  }
  // The selected sale might be new in Flipkart or come from a short preview
  // before company tracking started. Include this seller's stock sources.
  if (checkingBills && (!requested || !stockItems.size)) {
    for (const row of ctx.bindings)
      if (row.accountId === seller.accountId && row.itemId) stockItems.add(row.itemId);
  }
  // A voucher can appear through its party ledger or an inventory line's sales
  // ledger. Keep competing claims for the same stock item even across ledgers.
  const accounts = new Set(
    ctx.bindings
      .filter((row) => row.itemId && stockItems.has(row.itemId))
      .map((row) => row.accountId),
  );
  if (requireStockSetup && [...accounts].some((id) => !ctx.rules.some((r) => r.accountId === id)))
    throw hold(
      'Confirm bill matching for every seller sharing this stock item before checking the bill.',
    );
  return ctx.rules.filter(
    (rule) => rule.ledgerId === seller.ledgerId || accounts.has(rule.accountId),
  );
}

function confirmedStart(value: unknown) {
  const date = requireText(value, 'Starting date');
  const start = Date.parse(date + 'T00:00:00+05:30');
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
    !Number.isFinite(start) ||
    saleDay(new Date(start).toISOString()) !== date
  )
    throw new InputError('Choose a valid starting date in India.');
  const today = Date.parse(saleDay(nowIso()) + 'T00:00:00+05:30');
  if (start > today || today - start > 29 * day)
    throw new InputError('Choose today or one of the previous 29 days.');
  return new Date(start).toISOString();
}

function orderGeometry(o: FlipkartBillingOrder) {
  return JSON.stringify([
    o.orderId,
    o.listingId,
    o.sku,
    o.locationId,
    o.quantity,
    Date.parse(o.orderDate),
  ]);
}

function orderEvidence(o: StockCoverageOrder) {
  return JSON.stringify([
    orderGeometry(o),
    o.invoiceNumber,
    o.invoiceLookup === 'failed',
    o.eligibilityUnverified ?? false,
    o.stockDisposition ?? null,
    o.stockIdentityConflict ?? false,
    o.stockDispatchObserved ?? false,
    o.stockReconciliationRequired ?? false,
    o.stockShipmentId ?? null,
    o.preDispatchWithoutCourierReturn ?? false,
    o.stockReturnConflict ?? false,
    o.firstSeenUnmapped ?? false,
  ]);
}

export function mergeOrders(
  coverage: StockSyncCoverage,
  accountId: string,
  observed: FlipkartBillingOrder[],
  ctx: ReturnType<typeof configuration>,
) {
  const changedItems = new Set<string>();
  const proposalListings = new Set<string>();
  const journal = new Map(
    coverage.orders.map((entry) => [
      JSON.stringify([entry.accountId, entry.order.orderItemId]),
      entry,
    ]),
  );
  for (const observation of observed) {
    const key = JSON.stringify([accountId, observation.orderItemId]);
    const prior = journal.get(key)?.order;
    // Warehouse billing observations can lack a location. A later known location
    // fills this gap. Two different known locations still conflict.
    const order =
      prior?.locationId && !observation.locationId
        ? { ...observation, locationId: prior.locationId }
        : observation;
    const scopedReturnConflict = prior?.stockReturnConflict || order.stockReturnConflict;
    const shipmentChanged =
      prior?.stockShipmentId &&
      order.stockShipmentId &&
      prior.stockShipmentId !== order.stockShipmentId;
    // A changed identity or quantity cannot safely be reinterpreted using an
    // older bill. Retain the original identity and the need for reconciliation.
    if (
      prior &&
      (prior.stockIdentityConflict ||
        shipmentChanged ||
        (scopedReturnConflict
          ? !prior.stockShipmentId || prior.stockShipmentId !== order.stockShipmentId
          : (prior.stockDispatchObserved && order.stockDisposition === 'cancelled') ||
            (prior.stockDisposition === 'cancelled' && order.stockDispatchObserved)) ||
        orderGeometry(prior.locationId ? prior : { ...prior, locationId: order.locationId }) !==
          orderGeometry(order) ||
        (prior.invoiceNumber && order.invoiceNumber && prior.invoiceNumber !== order.invoiceNumber))
    ) {
      // Both the original and newly reported item might draw from this pool.
      // Keep the first observation and require reconciliation for the whole pool.
      journal.set(key, {
        accountId,
        order: {
          ...prior,
          stockIdentityConflict: true,
          stockDisposition: 'uncertain',
          eligibilityUnverified: true,
        },
      });
    } else {
      // A skipped invoice read has no bearing on earlier evidence. A positively
      // identified invoice that disappears needs verification before using it again.
      const invoiceNeedsRetry =
        order.invoiceLookup === 'failed' ||
        (!order.invoiceNumber &&
          ((order.invoiceLookup !== undefined && !!prior?.invoiceNumber) ||
            (order.invoiceLookup !== 'no-number' && prior?.invoiceLookup === 'failed')));
      const needsReview =
        prior?.stockReconciliationRequired ||
        order.stockReconciliationRequired ||
        (order.preDispatchWithoutCourierReturn &&
          (prior?.stockDispatchObserved || prior?.stockDisposition === 'cancelled'));
      journal.set(key, {
        accountId,
        order: {
          ...order,
          invoiceNumber: order.invoiceNumber ?? prior?.invoiceNumber ?? null,
          ...(invoiceNeedsRetry && { invoiceLookup: 'failed' as const }),
          ...(prior?.stockShipmentId && { stockShipmentId: prior.stockShipmentId }),
          ...((prior?.firstSeenUnmapped || (!prior && !mappedSaleItem(ctx, accountId, order))) && {
            firstSeenUnmapped: true,
          }),
          ...(scopedReturnConflict && { stockReturnConflict: true }),
          ...(prior?.stockSyncQueued && { stockSyncQueued: true }),
          ...(prior?.stockDispatchObserved && { stockDispatchObserved: true }),
          ...(needsReview && {
            stockReconciliationRequired: true,
            stockDisposition: 'uncertain',
            eligibilityUnverified: true,
          }),
        },
      });
    }
    const current = journal.get(key)!.order;
    if (isVerifiedSale(current) && (!prior || !isVerifiedSale(prior))) {
      const listing = mappedSaleListing(ctx, accountId, current);
      if (listing?.itemId && ctx.items.get(listing.itemId)?.companyId === ctx.company.id)
        proposalListings.add(listing.id);
    }
    if (!prior || orderEvidence(current) !== orderEvidence(prior)) {
      for (const id of affectedStockItems(ctx, accountId, current)) changedItems.add(id);
    }
  }
  return { orders: [...journal.values()], changedItems, proposalListings };
}

// Different journals and simultaneous programme searches do not establish an
// order of events. A clean sale must not overwrite contradictory evidence.
export function mergeBillingObservations(
  coverage: StockSyncCoverage,
  accountId: string,
  observations: FlipkartBillingOrder[],
  ctx: ReturnType<typeof stockConfiguration>,
) {
  const sales = new Set(observations.filter(isVerifiedSale).map((order) => order.orderItemId));
  const ordered = observations.map((order) =>
    isVerifiedCancellation(order) && sales.has(order.orderItemId)
      ? { ...order, stockDisposition: 'uncertain' as const, eligibilityUnverified: true as const }
      : order,
  );
  const priority = (order: FlipkartBillingOrder) =>
    isVerifiedSale(order) ? 0 : isVerifiedCancellation(order) ? 1 : 2;
  ordered.sort((a, b) => priority(a) - priority(b));
  const merged = mergeOrders(coverage, accountId, ordered, ctx).orders;
  // A number and an explicitly missing number from the same check conflict,
  // regardless of which programme was searched first. A skipped lookup is neutral.
  const missingInvoices = new Set(
    observations
      .filter((order) => !order.invoiceNumber && order.invoiceLookup !== undefined)
      .map((order) => order.orderItemId),
  );
  const failedInvoices = new Set(
    observations
      .filter((order) => order.invoiceLookup === 'failed')
      .map((order) => order.orderItemId),
  );
  for (const row of merged)
    if (
      row.accountId === accountId &&
      (failedInvoices.has(row.order.orderItemId) ||
        (row.order.invoiceNumber && missingInvoices.has(row.order.orderItemId)))
    )
      row.order.invoiceLookup = 'failed';
  return merged;
}

export function mergeRetainedBillOrders(
  coverage: StockSyncCoverage,
  accountId: string,
  archived: FlipkartBillingOrder[],
  ctx: ReturnType<typeof stockConfiguration>,
) {
  const retained = coverage.orders
    .filter((row) => row.accountId === accountId)
    .map((row) => row.order);
  return mergeBillingObservations(
    { ...coverage, orders: coverage.orders.filter((row) => row.accountId !== accountId) },
    accountId,
    [...retained, ...archived],
    ctx,
  );
}

function journalVersion(c: StockSyncCoverage | null) {
  return (
    c &&
    fingerprint([
      c.from,
      c.signature,
      c.orders
        .map(({ accountId, order }) =>
          JSON.stringify([accountId, order.orderItemId, orderEvidence(order)]),
        )
        .sort(),
    ])
  );
}

/** Record the accepted sale and its affected listings in one transaction. The
 * receipt survives a shortened/failed survey and a seller reopening the app. */
function saveOrderReceipts(
  store: Store,
  ctx: ReturnType<typeof configuration>,
  coverage: StockSyncCoverage,
  accountId: string,
  changedItems: Set<string>,
  proposalListings: Set<string>,
  reviewOnly: boolean,
) {
  const affected = new Set<string>();
  for (const entry of coverage.orders) {
    const o = entry.order;
    if (reviewOnly || entry.accountId !== accountId || o.stockSyncQueued || !isVerifiedSale(o))
      continue;
    const itemId = mappedSaleItem(ctx, accountId, o);
    if (!itemId || ctx.items.get(itemId)?.companyId !== ctx.company.id) continue;
    o.stockSyncQueued = true;
    affected.add(itemId);
  }
  if (!affected.size && !changedItems.size && !proposalListings.size) {
    store.saveStockCoverage(coverage);
    return false;
  }
  const token = randomUUID();
  let queued = false;
  store.saveStockCoverage(coverage, (state) => {
    invalidateReservationDrafts(state, changedItems);
    for (const listing of state.listings)
      if (proposalListings.has(listing.id)) queueOrderProposal(state, listing);
    if (!state.companies.some((c) => c.id === ctx.company.id && c.automation)) return;
    for (const listing of state.listings)
      if (listing.itemId && affected.has(listing.itemId) && listing.verified && !listing.paused) {
        listing.orderSyncPending = token;
        queued = true;
      }
  });
  return queued;
}

type ReconciledOrder = ReviewedOrder & {
  accountId: string;
  itemId: string | null;
  match?: Pick<BilledOrderItem, 'bill' | 'method'>;
  // Null covers the company when the order itself changed identity.
  affectedItems: string[] | null;
};

function unresolvedDestinations(
  ctx: ReturnType<typeof configuration>,
  accountId: string,
  order: StockCoverageOrder,
) {
  const catalogueSku = ctx.market.listings.find(
    (l) => l.accountId === accountId && l.id === order.listingId,
  )?.sku;
  return ctx.bindings
    .filter(
      (l) =>
        l.accountId === accountId &&
        l.location === order.locationId &&
        (l.sku === order.sku || l.sku === catalogueSku),
    )
    .map((l) => l.itemId!);
}

function affectedStockItems(
  ctx: ReturnType<typeof configuration>,
  accountId: string,
  order: StockCoverageOrder,
) {
  if (order.stockIdentityConflict)
    return ctx.state.items
      .filter((item) => item.companyId === ctx.company.id)
      .map((item) => item.id);
  const itemId = mappedSaleItem(ctx, accountId, order);
  const items = itemId ? [itemId] : unresolvedDestinations(ctx, accountId, order);
  return items.filter((id) => ctx.items.get(id)?.companyId === ctx.company.id);
}

export function reconcileOrders(
  ctx: ReturnType<typeof configuration>,
  coverage: StockSyncCoverage,
  vouchers: Map<string, TallySalesBill[]>,
  purpose: 'stock' | 'billing' = 'stock',
) {
  const reconciled: ReconciledOrder[] = [];
  const claims = new Map<string, ReconciledOrder>();
  const unverifiedClaims = new Set<string>();
  const knownBills = [...vouchers.values()].flat();
  for (const rule of ctx.rules) {
    const orders = coverage.orders
      .filter((e) => e.accountId === rule.accountId)
      .map((e) => e.order);
    const { rows, unverifiedBillItems } = matchBills(
      rule,
      rule,
      {
        orders: orders.filter((o) => o.stockDisposition !== 'cancelled'),
        bills: vouchers.get(rule.accountId) ?? [],
        knownOrders: coverage.orders,
        knownBills,
      },
      ctx.billing,
      ctx.state,
      ctx.market.listings,
    );
    for (const key of unverifiedBillItems) unverifiedClaims.add(key);
    const byId = new Map(rows.map((row) => [row.orderItemId, row]));
    for (const order of orders) {
      const itemId = mappedSaleItem(ctx, rule.accountId, order, purpose);
      const result: PendingOrderResult = {
        orderItemId: order.orderItemId,
        status: 'unmapped',
        reason: 'This order is waiting for its listing and location to be mapped.',
        baseUnits: null,
      };
      const entry: ReconciledOrder = {
        accountId: rule.accountId,
        order,
        itemId,
        result,
        affectedItems: itemId ? [itemId] : unresolvedDestinations(ctx, rule.accountId, order),
      };
      reconciled.push(entry);
      if (order.stockIdentityConflict) {
        entry.affectedItems = null;
        result.status = 'review';
        result.reason =
          'A recorded order changed its identity, quantity or dispatch history. Settle the sale and confirm a new starting date.';
        continue;
      }
      if (isVerifiedCancellation(order)) {
        result.status = 'cancelled';
        result.reason = 'The verified cancellation releases this order’s reservation.';
        continue;
      }
      if (!itemId) {
        if (entry.affectedItems?.length) {
          result.status = 'review';
          result.reason =
            'An order has no unique verified stock mapping. Check its listing and location in Inventory.';
        }
        continue;
      }
      if (ctx.items.get(itemId)?.companyId !== ctx.company.id) continue;
      if (
        order.stockDisposition ||
        order.eligibilityUnverified ||
        order.stockReconciliationRequired
      ) {
        result.status = 'review';
        result.reason =
          'An order for this item has an unresolved sale, return or cancellation status. Check the order before increasing stock.';
        continue;
      }
      const row = byId.get(order.orderItemId);
      result.baseUnits = row?.baseUnits ?? null;
      if (!row || row.baseUnits === null || row.status === 'review' || row.status === 'unmapped') {
        result.status = 'review';
        result.reason =
          'An order needs billing or pack review. ' +
          (row?.reason ?? 'Check Order matching and Inventory.');
        continue;
      }
      if (row.status === 'matched' && row.bill) {
        const key = billItemKey(row.bill.id, ctx.items.get(itemId)!.externalId);
        const claimed = claims.get(key);
        if (claimed) {
          delete claimed.match;
          claimed.result.status = result.status = 'review';
          claimed.result.reason = result.reason =
            'Two seller orders claim the same Tally bill and stock item. Review their bill matches.';
        } else {
          result.status = 'matched';
          result.reason = row.reason;
          entry.match = {
            bill: row.bill,
            method: row.manualBillId === row.bill.id ? 'seller-confirmed' : 'automatic',
          };
          claims.set(key, entry);
        }
      } else {
        result.status = 'reserved';
        result.reason =
          'The units are reserved until a matching Tally stock deduction is verified.';
      }
    }
  }
  for (const key of unverifiedClaims) {
    const claimed = claims.get(key);
    if (!claimed?.match) continue;
    delete claimed.match;
    claimed.result.status = 'review';
    claimed.result.reason = competingInvoiceMessage;
  }
  return reconciled;
}

function reservationTotals(orders: ReconciledOrder[], itemId: string) {
  let heldUnits = 0;
  const bySeller = new Map<string, number>();
  let billingIssue: string | undefined;
  for (const entry of orders) {
    const { affectedItems, result } = entry;
    if (affectedItems && !affectedItems.includes(itemId)) continue;
    if (result.status === 'review') {
      if (!entry.itemId || !affectedItems) throw hold(result.reason);
      billingIssue ??= result.reason;
    }
    if (result.status === 'reserved') {
      const units = result.baseUnits!;
      heldUnits += units;
      bySeller.set(entry.accountId, (bySeller.get(entry.accountId) ?? 0) + units);
    }
  }
  if (billingIssue) throw hold(billingIssue);
  if (!Number.isSafeInteger(heldUnits))
    throw hold('The unbilled order quantity could not be verified.');
  return {
    units: heldUnits,
    bySeller: Array.from(bySeller, ([accountId, units]) => ({ accountId, units })),
  };
}

export class StockAvailabilityService {
  private readonly sources: BillingSources;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly recentScans = new Map<string, { until: number; check: WeakRef<CompanyCheck> }>();
  private readonly batches = new WeakMap<
    object,
    Map<string, { until: number; read: Promise<CompanyCheck> }>
  >();
  constructor(
    private readonly store: Store,
    sources: BillingSources | undefined,
    private readonly access: Access,
    private readonly onPending?: (companyId: string, batch?: object) => void,
  ) {
    this.sources = sources ?? {
      tally: (url) => new TallyClient(url),
      orders: new FlipkartBillingClient(),
    };
  }

  coverageCommand(path: string, input: Record<string, unknown>) {
    const companyId = requireText(input.companyId, 'Company');
    const ctx = configuration(this.store, companyId);
    const accountId = requireText(input.accountId, 'Seller account');
    if (!ctx.market.accounts.some((a) => a.id === accountId))
      throw new InputError('Select a valid seller account.', 404);
    let saved = this.store.readStockCoverage(companyId);
    if (path === '/api/billing/tracking/start') {
      if (saved)
        throw new InputError('Review starting stock to change the company tracking date.', 409);
      if (!ctx.rules.some((rule) => rule.accountId === accountId))
        throw new InputError(
          'Confirm bill matching for this seller before setting a tracking date.',
          409,
        );
      this.store.saveBillingTrackingStart(companyId, confirmedStart(input.fromDate));
    } else if (path === '/api/billing/coverage/start') {
      if (input.confirmed !== true)
        throw new InputError('Confirm the earlier sales and stock sources before starting.');
      const from = confirmedStart(input.fromDate);
      if (
        !ctx.accounts.includes(accountId) ||
        ctx.accounts.some((account) => !ctx.rules.some((r) => r.accountId === account))
      )
        throw hold(
          'Confirm a billing rule in Order matching for every seller account mapped to this company.',
        );
      if (
        saved &&
        saved.signature !== ctx.signature &&
        saved.orders.some((e) => e.order.orderDate >= from)
      )
        throw hold(
          'The stock setup changed. Settle the recorded orders first and select a starting day after those sales.',
        );
      if (!saved || saved.from !== from || coverageIssue(saved, ctx.signature, Date.now())) {
        saved = {
          companyId,
          from,
          signature: ctx.signature,
          checkedThrough: null,
          orders: saved?.orders.filter((e) => e.order.orderDate >= from) ?? [],
        };
        const items = new Set(
          ctx.state.items.filter((item) => item.companyId === companyId).map((item) => item.id),
        );
        this.store.saveStockCoverage(saved, (state) => invalidateReservationDrafts(state, items));
      }
    } else if (path !== '/api/billing/coverage')
      throw new InputError('Unknown stock coverage action.', 404);
    const issue = saved ? coverageIssue(saved, ctx.signature, Date.now()) : startTrackingMessage;
    const billingFrom = !saved && this.store.readBillingTrackingStart(companyId);
    return {
      from: saved?.from ?? null,
      ...(billingFrom && { billingFrom }),
      current: issue === null,
      checkedThrough: issue ? null : (saved?.checkedThrough ?? null),
      ...(issue && { issue }),
    };
  }

  async forItem(
    companyId: string,
    itemId: string,
    batch?: object,
    readOnly = false,
  ): Promise<CheckedStock> {
    return (await this.companyCheck(companyId, batch, readOnly ? 'preview' : 'publish')).forItem(
      itemId,
    );
  }

  async checkOrders(companyId: string, batch: object): Promise<void> {
    this.recentScans.delete(companyId);
    let check: CompanyCheck | InputError;
    try {
      check = await this.companyCheck(companyId, batch);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      check = error;
    }
    const state = this.store.read();
    const companyItems = new Set(
      state.items.filter((item) => item.companyId === companyId).map((item) => item.id),
    );
    const calculated = new Map(
      state.proposals.filter((draft) => !draft.edited).map((draft) => [draft.listingId, draft]),
    );
    // A failed seller read leaves the affected items unknown. A complete scan
    // can limit ledger checks to items with sales and previously invalidated drafts.
    const reservations =
      calculated.size && !(check instanceof InputError) ? check.reservationItems() : null;
    const selected = state.listings.filter(
      (row) =>
        row.itemId &&
        companyItems.has(row.itemId) &&
        (row.orderProposalPending ||
          (calculated.has(row.id) &&
            (!reservations || reservations.has(row.itemId) || calculated.get(row.id)?.stale))),
    );
    if (selected.length) {
      // Bills can match or cease to match without changing a shipment, local Tally
      // version, or publication setting. Reuse this scan's ledger/balance reads.
      const sources = await checkCalculationStock(state, selected, (itemId) => {
        if (check instanceof InputError) throw check;
        return check.forItem(itemId);
      });
      saveCalculation(this.store, state, companyId, selected, { sources, refreshStale: true });
    }
    if (check instanceof InputError) throw check;
    this.recentScans.set(companyId, { until: Date.now() + 20_000, check: new WeakRef(check) });
  }

  async inventoryReservations(companyId: string) {
    const recent = this.recentScans.get(companyId);
    const shared = recent && Date.now() <= recent.until ? recent.check.deref() : undefined;
    if (shared?.canReuseForInventory()) return shared.inventoryBalances();
    this.recentScans.delete(companyId);
    const check = await this.companyCheck(companyId, undefined, 'inventory');
    return check.inventoryBalances();
  }

  async refreshPendingOrders(companyId: string, accountId?: string): Promise<void> {
    await this.companyCheck(companyId, undefined, 'review', accountId ? { accountId } : undefined);
  }

  pendingHistory(companyId: string, accountId: string) {
    const ctx = configuration(this.store, companyId);
    const coverage = this.store.readStockCoverage(companyId);
    const trackingStarted = !!coverage && ctx.rules.some((rule) => rule.accountId === accountId);
    const checkedThrough =
      trackingStarted &&
      coverage.checkedThrough &&
      !coverageIssue(coverage, ctx.signature, Date.now())
        ? coverage.checkedThrough
        : undefined;
    const orders = (coverage?.orders ?? []).flatMap(({ accountId: seller, order }) => {
      if (seller !== accountId) return [];
      const itemId = mappedSaleItem(ctx, seller, order);
      if (itemId && (ctx.items.get(itemId)?.companyId !== companyId || !order.firstSeenUnmapped))
        return [];
      return [{ order, mapped: !!itemId }];
    });
    return { orders, trackingStarted, checkedThrough };
  }

  async reviewOrders(
    companyId: string,
    accountId: string,
    orderItemIds?: string[],
  ): Promise<ReviewedOrder[]> {
    const check = await this.companyCheck(companyId, undefined, 'review', {
      accountId,
      orderItemIds: orderItemIds ?? 'all',
    });
    return check.review(accountId, orderItemIds);
  }

  async readBillEvidence(
    companyId: string,
    accountId: string,
    orderItemId?: string,
    previewFrom?: string,
  ): Promise<CompanyBillEvidence> {
    const check = await this.companyCheck(
      companyId,
      undefined,
      'bills',
      { accountId, orderItemIds: orderItemId ? [orderItemId] : 'all' },
      previewFrom,
    );
    return check.billEvidence();
  }

  private async companyCheck(
    companyId: string,
    batch?: object,
    mode: CheckMode = 'publish',
    scope?: ReviewScope,
    previewFrom?: string,
  ): Promise<CompanyCheck> {
    let checks = batch && this.batches.get(batch);
    if (batch && !checks) {
      checks = new Map();
      this.batches.set(batch, checks);
    }
    const cacheKey = JSON.stringify([companyId, mode]);
    const recent = checks?.get(cacheKey);
    if (recent && Date.now() <= recent.until) return recent.read;
    // Each reader merges an entire company journal. Serialize local readers so
    // overlapping destination updates never replace each other's observations.
    const previous = this.pending.get(companyId);
    const result = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.capture(companyId, batch, mode, scope, previewFrom));
    this.pending.set(companyId, result);
    if (checks) {
      const entry = { until: Infinity, read: result };
      checks.set(cacheKey, entry);
      // The result is shared only with destinations in this Inventory operation.
      // A new operation always starts new reads, including after a failed batch.
      void result
        .finally(() => {
          entry.until = Date.now() + 20_000;
        })
        .catch(() => {});
    }
    try {
      return await result;
    } finally {
      if (this.pending.get(companyId) === result) this.pending.delete(companyId);
    }
  }

  private async capture(
    companyId: string,
    batch?: object,
    mode: CheckMode = 'publish',
    scope?: ReviewScope,
    previewFrom?: string,
  ): Promise<CompanyCheck> {
    const ctx = configuration(this.store, companyId);
    const saved = this.store.readStockCoverage(companyId);
    const trackingFrom = saved?.from;
    let expected = journalVersion(saved);
    const coverage =
      saved ??
      (mode === 'bills' && previewFrom
        ? {
            companyId,
            signature: ctx.signature,
            from: previewFrom,
            orders: [],
            checkedThrough: null,
          }
        : null);
    if (!coverage) throw hold(startTrackingMessage);
    const to = nowIso();
    const issue = coverageIssue(coverage, ctx.signature, Date.parse(to));
    if (issue) throw hold(issue);
    if (mode === 'bills' && previewFrom && previewFrom < coverage.from) coverage.from = previewFrom;
    const persistOrders = mode === 'publish' || mode === 'review' || mode === 'inventory';
    const demo = ctx.state.mode === 'demo';
    const rules = rulesForCheck(ctx, coverage, scope, mode === 'bills');
    const checkInspectedInvoices =
      mode === 'bills' ||
      ctx.billing.links.some((link) => link.companyId === companyId && isInspectedBillLink(link));
    const tally = this.sources.tally(ctx.state.settings.tallyUrl);
    const identity = { externalId: companyId.slice('tally:'.length), name: ctx.company.name };
    const guards: Array<() => void> = [];
    const archivedClaims = () =>
      rules.map(({ accountId }) => ({
        accountId,
        orders: this.store
          .readBillingOrders(companyId, accountId, coverage.from, to)
          .map(({ order }) => order),
      }));
    let claimsVersion: string | undefined;
    const verify = () => {
      for (const guard of guards) guard();
      const current = configuration(this.store, companyId);
      if (
        current.signature !== ctx.signature ||
        current.reviewState !== ctx.reviewState ||
        journalVersion(this.store.readStockCoverage(companyId)) !== expected ||
        (claimsVersion !== undefined && fingerprint(archivedClaims()) !== claimsVersion)
      )
        throw hold(
          'Stock, orders or billing setup changed during this check. Retry with fresh evidence.',
        );
      return current;
    };
    const balances = async () => {
      const values = new Map<string, TallyStockItem>();
      if (!demo)
        for (const item of await tally.readStock(identity, saleDay(to))) {
          if (values.has(item.externalId))
            throw hold('Tally returned duplicate stock items. Refresh the company.');
          values.set(item.externalId, item);
        }
      return values;
    };
    const sampleVouchers = new Map<string, TallySalesBill[]>();
    try {
      for (const rule of rules) {
        let orders: FlipkartBillingOrder[];
        if (demo) {
          const sampleAt =
            coverage.orders.find((e) => e.accountId === rule.accountId)?.order.orderDate ??
            ctx.items.get('item-a')?.observedAt ??
            null;
          const sample = sampleBills(rule, sampleAt, coverage.from, to);
          orders = sample.orders;
          sampleVouchers.set(rule.accountId, sample.bills);
        } else {
          const auth = await this.access(rule.accountId);
          guards.push(auth.verify);
          auth.verify();
          if (!auth.token || !this.sources.orders.readStockOrders)
            throw hold('Verify each participating seller account and its shipment access.');
          orders = await this.sources.orders.readStockOrders(
            auth.token,
            coverage.from,
            to,
            checkInspectedInvoices ||
              (rule.field !== 'manual' && rule.reference === 'invoiceNumber'),
          );
        }
        verify();
        const merged = mergeOrders(coverage, rule.accountId, orders, ctx);
        coverage.orders = merged.orders;
        if (persistOrders) {
          const queued = saveOrderReceipts(
            this.store,
            ctx,
            coverage,
            rule.accountId,
            merged.changedItems,
            merged.proposalListings,
            mode !== 'publish',
          );
          expected = journalVersion(coverage);
          if (queued) this.onPending?.(companyId, batch);
        }
      }
      verify();
      // This watermark describes a complete order scan. Publication additionally
      // checks the bills and balances below even if every receipt is familiar.
      if (rules.length === ctx.rules.length) {
        coverage.checkedThrough = to;
        if (persistOrders) this.store.saveStockCoverage(coverage);
      }
      const readVouchers = async () => {
        const vouchers = new Map(sampleVouchers);
        if (!demo) {
          const ledgers = new Map<string, TallySalesBill[]>();
          for (const rule of rules) {
            let bills = ledgers.get(rule.ledgerId);
            if (!bills) {
              bills = await tally.readSalesBills(
                identity,
                rule.ledgerId,
                saleDay(coverage.from),
                saleDay(to),
              );
              ledgers.set(rule.ledgerId, bills);
            }
            vouchers.set(rule.accountId, bills);
          }
        }
        return vouchers;
      };
      const reconcileStockBills = (vouchers: Map<string, TallySalesBill[]>) => {
        const participants = { ...ctx, rules };
        const stock = reconcileOrders(participants, coverage, vouchers);
        if (!stock.some((row) => row.match || isVerifiedCancellation(row.order))) return stock;
        const claims = archivedClaims();
        claimsVersion = fingerprint(claims);
        if (!claims.some(({ orders }) => orders.length)) return stock;

        // Billing history can contest a voucher or supply dispatch evidence for
        // an existing stock receipt. Only stock receipts can reserve units.
        const combined = { ...coverage };
        for (const { accountId, orders } of claims)
          if (orders.length)
            combined.orders = mergeRetainedBillOrders(combined, accountId, orders, ctx);
        const verified = new Map(
          reconcileOrders(participants, combined, vouchers, 'billing').map((row) => [
            JSON.stringify([row.accountId, row.order.orderItemId]),
            row,
          ]),
        );
        for (const row of stock) {
          const other = verified.get(JSON.stringify([row.accountId, row.order.orderItemId]));
          if (
            isVerifiedCancellation(row.order) &&
            other &&
            (other.order.stockDispatchObserved ||
              other.order.stockReconciliationRequired ||
              other.order.stockIdentityConflict)
          ) {
            row.result.status = 'review';
            row.result.reason =
              'The saved order history conflicts with a cancellation before dispatch. Reconcile the sale before increasing stock.';
            if (other.order.stockIdentityConflict) row.affectedItems = null;
          }
          if (!row.match || other?.match?.bill.id === row.match.bill.id) continue;
          delete row.match;
          row.result.status = 'review';
          row.result.reason =
            'The tracked orders do not establish a unique match for this Tally bill. Review the orders claiming it before releasing stock.';
        }
        return stock;
      };
      const readBooks = async () => {
        try {
          const before = await balances();
          const vouchers = await readVouchers();
          const after = await balances();
          verify();
          return { before, after, orders: reconcileStockBills(vouchers) };
        } catch (error) {
          if (error instanceof InputError) throw error;
          throw hold(
            'Could not verify all marketplace orders and Tally sales bills. Check the connections and retry.',
          );
        }
      };
      let books: ReturnType<typeof readBooks> | undefined;
      const checked = new Map<string, CheckedStock>();
      function checkedPhysical(
        item: StockItem,
        before: Map<string, TallyStockItem>,
        after: Map<string, TallyStockItem>,
      ) {
        const physical =
          mode === 'review' && !demo
            ? (before.get(item.externalId)?.physical ?? null)
            : item.physical;
        if (physical === null)
          throw hold('Refresh the current Tally stock item before checking its available units.');
        if (
          !demo &&
          [before, after].some((values) => {
            const value = values.get(item.externalId);
            return !value || value.unit !== item.unit || value.physical !== physical;
          })
        )
          throw hold(
            'The Tally balance changed while checking bills. Refresh Tally stock and retry.',
          );
        return physical;
      }
      const checkBalance = async (itemId: string) => {
        const item = ctx.items.get(itemId);
        if (!item || item.companyId !== companyId)
          throw hold('Refresh the current Tally stock item before publishing.');
        const { before, after, orders } = await (books ??= readBooks());
        // A bill can reach Tally before Inventory's next stock poll. Order
        // matching can use the live balance. Publishing must also match Inventory.
        const physical = checkedPhysical(item, before, after);
        const verifyItem = () => {
          const current = verifyStockCheck().items.get(itemId);
          if (
            mode !== 'review' &&
            (current?.version !== item.version || current.physical !== item.physical)
          )
            throw hold('Tally stock changed during this check. Retry with the current balance.');
        };
        verifyItem();
        return { item, physical, orders, verify: verifyItem };
      };
      function verifyStockCheck() {
        if (saleDay(nowIso()) !== saleDay(to))
          throw hold(
            'The Tally business date changed during the order check. Refresh the company and retry.',
          );
        if (!isRecentObservation(to, reservationCheckMaxAgeMs))
          throw hold(
            'The order check is outside the current two-minute window. Retry, or reconcile older sales and confirm a more recent starting date in Order matching.',
          );
        return verify();
      }
      return {
        canReuseForInventory: () => {
          try {
            const current = verifyStockCheck();
            return [...current.items.values()].every(
              (item) =>
                item.companyId !== companyId || ctx.items.get(item.id)?.version === item.version,
            );
          } catch {
            return false;
          }
        },
        inventoryBalances: async () => {
          const { before, after, orders } = await (books ??= readBooks());
          const current = verifyStockCheck();
          const items: Record<string, ItemReservations> = {};
          const byItem = new Map<string, ReconciledOrder[]>();
          for (const row of orders) {
            if (row.result.status !== 'reserved' && row.result.status !== 'review') continue;
            if (!row.affectedItems) return items;
            for (const id of row.affectedItems) {
              const rows = byItem.get(id);
              if (rows) rows.push(row);
              else byItem.set(id, [row]);
            }
          }
          for (const item of ctx.items.values()) {
            if (
              item.companyId !== companyId ||
              current.items.get(item.id)?.version !== item.version
            )
              continue;
            try {
              const physical = checkedPhysical(item, before, after);
              const totals = reservationTotals(byItem.get(item.id) ?? [], item.id);
              items[item.id] = { checkedAt: to, itemVersion: item.version, physical, ...totals };
            } catch (error) {
              if (!(error instanceof InputError)) throw error;
              // Incomplete evidence for one item leaves its balance unknown.
            }
          }
          return items;
        },
        billEvidence: async () => {
          try {
            const vouchers = await readVouchers();
            const verifyBills = () => {
              verify();
              if (saleDay(to) !== saleDay(nowIso()) || !isRecentObservation(to, 600_000))
                throw hold('This bill check expired. Find the bill again.');
            };
            verifyBills();
            return {
              ctx,
              coverage,
              trackingFrom,
              vouchers,
              orders: reconcileStockBills(vouchers),
              verify: verifyBills,
            };
          } catch (error) {
            if (error instanceof InputError) throw error;
            throw hold(
              'Could not verify all participating sellers and their Tally sales bills. Check the connections and retry.',
            );
          }
        },
        reservationItems: () =>
          new Set(
            coverage.orders.flatMap(({ accountId, order }) =>
              affectedStockItems(ctx, accountId, order),
            ),
          ),
        forItem: async (itemId: string) => {
          const previous = checked.get(itemId);
          if (previous) {
            previous.verify();
            return previous;
          }
          const evidence = await checkBalance(itemId);
          const reservedUnits = reservationTotals(evidence.orders, itemId).units;
          const value = {
            itemVersion: evidence.item.version,
            physical: evidence.physical,
            reservedUnits,
            available: availableForMarketplaces(
              evidence.physical,
              reservedUnits,
              evidence.item.keepBackUnits,
            ),
            verify: evidence.verify,
          };
          checked.set(itemId, value);
          return value;
        },
        review: async (accountId, orderItemIds) => {
          const { orders } = await (books ??= readBooks());
          const requested = orderItemIds && new Set(orderItemIds);
          const selected = orders.filter(
            (e) =>
              e.accountId === accountId &&
              (!requested || requested.has(e.order.orderItemId)) &&
              (!e.itemId ||
                (e.order.firstSeenUnmapped && ctx.items.get(e.itemId)?.companyId === companyId)),
          );
          const guards = [];
          for (const itemId of new Set(selected.map((e) => e.itemId))) {
            if (itemId) guards.push((await checkBalance(itemId)).verify);
          }
          verify();
          for (const guard of guards) guard();
          return selected.map(({ order, result, match }) => ({
            order,
            result: match ? { ...result, bill: match.bill } : result,
          }));
        },
      };
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw hold(
        'Could not verify all marketplace orders and Tally sales bills. Check the connections and retry.',
      );
    }
  }
}
