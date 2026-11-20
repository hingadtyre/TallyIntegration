import { randomUUID } from 'node:crypto';
import { FlipkartBillingClient, type FlipkartBillingOrder } from '../adapters/flipkart-billing.js';
import { TallyClient, type TallySalesBill, type TallyStockItem } from '../adapters/tally.js';
import type { StockSyncCoverage } from '../shared/stock-coverage.js';
import { fingerprint, matchBills, saleDay } from './billing-matcher.js';
import { sampleBills } from './billing-sample.js';
import type { BillingSources } from './billing-service.js';
import type { Store } from './store.js';
import { InputError, requireCompany, requireText } from './validation.js';

const day = 86_400_000;
const nowIso = () => new Date().toISOString();
const hold = (reason: string) => new InputError(reason, 409);
type Access = (accountId: string) => Promise<{ token: string | null; verify: () => void }>;
type CheckedStock = { available: number; verify: () => void };
type CompanyCheck = { forItem: (id: string) => Promise<CheckedStock> };

function configuration(store: Store, companyId: string) {
  const state = store.read();
  const company = requireCompany(state, companyId);
  const market = store.readMarketplace();
  const billing = store.readBilling();
  const items = new Map(state.items.map((item) => [item.id, item]));
  const rules = billing.rules.filter((r) => r.companyId === companyId);
  const accounts = [
    ...new Set([
      ...rules.map((r) => r.accountId),
      ...state.listings
        .filter((l) => items.get(l.itemId ?? '')?.companyId === companyId)
        .map((l) => l.accountId),
    ]),
  ].sort();
  const bindings = state.listings.filter((l) => l.itemId && accounts.includes(l.accountId));
  const catalogue = new Map<string, typeof market.listings>();
  for (const remote of market.listings) {
    const key = JSON.stringify([remote.accountId, remote.sku]);
    const entries = catalogue.get(key) ?? [];
    entries.push(remote);
    catalogue.set(key, entries);
  }
  // Only source identities and conversion rules belong in the baseline. Ordinary
  // stock, listing metadata and refresh times can change on every poll.
  const mappingKeys = bindings
    .map((l) => {
      const item = items.get(l.itemId!)!;
      const remote = (catalogue.get(JSON.stringify([l.accountId, l.sku])) ?? []).filter((r) =>
        r.locations.some((loc) => loc.id === l.location),
      );
      return JSON.stringify([
        l.id,
        l.accountId,
        l.sku,
        l.location,
        l.itemId,
        item?.companyId,
        item?.externalId,
        item?.unit,
        l.packSize,
        l.packSource,
        l.packConfirmedAt,
        l.sourceScope,
        l.verified,
        remote.map((r) => JSON.stringify([r.id, r.productId, r.sellerId])).sort(),
      ]);
    })
    .sort();
  const signature = fingerprint([
    company.id,
    state.settings.tallyUrl,
    accounts.map((id) => [id, market.accounts.find((a) => a.id === id)?.sellerId]),
    rules.map((r) => JSON.stringify([r.accountId, r.ledgerId, r.field, r.reference])).sort(),
    mappingKeys,
  ]);
  const reviewState = fingerprint([
    billing.links
      .filter((link) => link.companyId === companyId || accounts.includes(link.accountId))
      .map((link) => JSON.stringify(link))
      .sort(),
    bindings
      .filter((l) => l.packSource === 'packages')
      .map((l) => JSON.stringify([l.id, l.packageAvailable, l.packageCount]))
      .sort(),
  ]);
  return {
    state,
    company,
    market,
    billing,
    accounts,
    rules,
    items,
    bindings,
    signature,
    reviewState,
  };
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
    throw new InputError(
      'Choose today or one of the previous 29 days, after reconciling all earlier sales.',
    );
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

function mergeOrders(
  coverage: StockSyncCoverage,
  accountId: string,
  observed: FlipkartBillingOrder[],
) {
  const journal = new Map(
    coverage.orders.map((entry) => [
      JSON.stringify([entry.accountId, entry.order.orderItemId]),
      entry,
    ]),
  );
  for (const order of observed) {
    const key = JSON.stringify([accountId, order.orderItemId]);
    const prior = journal.get(key)?.order;
    // A changed identity or quantity cannot safely be reinterpreted using an
    // older bill. Retain the original identity and the need for reconciliation.
    if (
      prior &&
      (prior.stockIdentityConflict ||
        (prior.stockDispatchObserved && order.stockDisposition === 'cancelled') ||
        (prior.stockDisposition === 'cancelled' && order.stockDispatchObserved) ||
        orderGeometry(prior) !== orderGeometry(order) ||
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
      const needsReview = prior?.stockReconciliationRequired || order.stockReconciliationRequired;
      journal.set(key, {
        accountId,
        order: {
          ...order,
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
  }
  return [...journal.values()];
}

function journalVersion(c: StockSyncCoverage | null) {
  return (
    c &&
    fingerprint([
      c.from,
      c.signature,
      c.orders
        .map(({ accountId, order: o }) =>
          JSON.stringify([
            accountId,
            o.orderItemId,
            orderGeometry(o),
            o.invoiceNumber,
            o.eligibilityUnverified ?? false,
            o.stockDisposition ?? null,
            o.stockIdentityConflict ?? false,
            o.stockDispatchObserved ?? false,
            o.stockReconciliationRequired ?? false,
          ]),
        )
        .sort(),
    ])
  );
}

function mappedSaleItem(
  ctx: ReturnType<typeof configuration>,
  accountId: string,
  order: FlipkartBillingOrder,
) {
  const destinations = ctx.bindings.filter(
    (l) => l.accountId === accountId && l.sku === order.sku && l.location === order.locationId,
  );
  const remote = ctx.market.listings.filter(
    (l) =>
      l.accountId === accountId &&
      l.sku === order.sku &&
      l.locations.some((loc) => loc.id === order.locationId),
  );
  return destinations.length === 1 &&
    destinations[0].verified &&
    (ctx.state.mode !== 'live' || destinations[0].sourceScope === 'company') &&
    remote.length === 1 &&
    remote[0].observedAt &&
    remote[0].id === order.listingId
    ? destinations[0].itemId
    : null;
}

/** Record the accepted sale and its affected listings in one transaction. The
 * receipt survives a shortened/failed survey and a seller reopening the app. */
function saveOrderReceipts(
  store: Store,
  ctx: ReturnType<typeof configuration>,
  coverage: StockSyncCoverage,
  accountId: string,
) {
  const affected = new Set<string>();
  for (const entry of coverage.orders) {
    const o = entry.order;
    if (
      entry.accountId !== accountId ||
      o.stockSyncQueued ||
      o.stockDisposition ||
      o.eligibilityUnverified ||
      o.stockIdentityConflict ||
      o.stockReconciliationRequired
    )
      continue;
    const itemId = mappedSaleItem(ctx, accountId, o);
    if (!itemId || ctx.items.get(itemId)?.companyId !== ctx.company.id) continue;
    o.stockSyncQueued = true;
    affected.add(itemId);
  }
  if (!affected.size) {
    store.saveStockCoverage(coverage);
    return false;
  }
  const token = randomUUID();
  let queued = false;
  store.saveStockCoverage(coverage, (state) => {
    if (!state.companies.some((c) => c.id === ctx.company.id && c.automation)) return;
    for (const listing of state.listings)
      if (listing.itemId && affected.has(listing.itemId) && listing.verified && !listing.paused) {
        listing.orderSyncPending = token;
        queued = true;
      }
  });
  return queued;
}

function unbilledUnits(
  ctx: ReturnType<typeof configuration>,
  itemId: string,
  coverage: StockSyncCoverage,
  vouchers: Map<string, TallySalesBill[]>,
) {
  let heldUnits = 0;
  const claims = new Set<string>();
  for (const rule of ctx.rules) {
    const orders = coverage.orders
      .filter((e) => e.accountId === rule.accountId && e.order.stockDisposition !== 'cancelled')
      .map((e) => e.order);
    const { rows } = matchBills(
      rule,
      rule,
      { orders, bills: vouchers.get(rule.accountId) ?? [] },
      ctx.billing,
      ctx.state,
      ctx.market.listings,
    );
    const targetByLine = new Map<string, string>();
    for (const order of orders) {
      if (order.stockIdentityConflict)
        throw hold(
          'A recorded order changed its identity, quantity or dispatch history. Settle the sale and confirm a new starting date.',
        );
      const mappedId = mappedSaleItem(ctx, rule.accountId, order);
      if (!mappedId)
        throw hold(
          'An order has no unique verified stock mapping. Check its listing and location in Inventory.',
        );
      if (
        mappedId === itemId &&
        (order.stockDisposition === 'uncertain' || order.eligibilityUnverified)
      )
        throw hold(
          'A Flipkart order for this item has an unresolved sale, return or cancellation status. Check the order before increasing stock.',
        );
      targetByLine.set(order.orderItemId, mappedId);
    }
    for (const row of rows) {
      if (targetByLine.get(row.orderItemId) !== itemId) continue;
      if (row.baseUnits === null || row.status === 'review' || row.status === 'unmapped')
        throw hold(
          'An order needs billing or pack review. Check Order matching and Inventory before increasing stock.',
        );
      if (row.status === 'matched' && row.bill) {
        // A single posting can be returned by more than one ledger query.
        if (claims.has(row.bill.id))
          throw hold(
            'Two seller orders claim the same Tally bill and stock item. Review their bill matches.',
          );
        claims.add(row.bill.id);
      } else heldUnits += row.baseUnits;
    }
  }
  if (!Number.isSafeInteger(heldUnits))
    throw hold('The unbilled order quantity could not be verified.');
  return heldUnits;
}

export class StockAvailabilityService {
  private readonly sources: BillingSources;
  private readonly pending = new Map<string, Promise<unknown>>();
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
    if (path === '/api/billing/coverage/start') {
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
      if (!ctx.bindings.some((l) => ctx.items.get(l.itemId!)?.companyId === companyId))
        throw hold('Verify a stock mapping for this company in Inventory first.');
      if (
        saved &&
        saved.signature !== ctx.signature &&
        saved.orders.some((e) => e.order.orderDate >= from)
      )
        throw hold(
          'The stock setup changed. Settle the recorded orders first and select a starting day after those sales.',
        );
      saved = {
        companyId,
        from,
        signature: ctx.signature,
        checkedThrough: null,
        orders: saved?.orders.filter((e) => e.order.orderDate >= from) ?? [],
      };
      this.store.saveStockCoverage(saved);
    } else if (path !== '/api/billing/coverage')
      throw new InputError('Unknown stock coverage action.', 404);
    const lastCheck = saved && Date.parse(saved.checkedThrough ?? saved.from);
    const current =
      saved?.signature === ctx.signature &&
      lastCheck !== null &&
      lastCheck <= Date.now() &&
      Date.now() - lastCheck <= 30 * day;
    return {
      from: saved?.from ?? null,
      current,
      checkedThrough: current ? (saved?.checkedThrough ?? null) : null,
    };
  }

  async forItem(
    companyId: string,
    itemId: string,
    batch?: object,
    readOnly = false,
  ): Promise<CheckedStock> {
    return (await this.companyCheck(companyId, batch, readOnly)).forItem(itemId);
  }

  async checkOrders(companyId: string, batch: object): Promise<void> {
    await this.companyCheck(companyId, batch);
  }

  private async companyCheck(
    companyId: string,
    batch?: object,
    readOnly = false,
  ): Promise<CompanyCheck> {
    let checks = batch && this.batches.get(batch);
    if (batch && !checks) {
      checks = new Map();
      this.batches.set(batch, checks);
    }
    const cacheKey = JSON.stringify([companyId, readOnly]);
    const recent = checks?.get(cacheKey);
    if (recent && Date.now() <= recent.until) return recent.read;
    // Each reader merges an entire company journal. Serialize local readers so
    // overlapping destination updates never replace each other's observations.
    const previous = this.pending.get(companyId);
    const result = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.capture(companyId, batch, readOnly));
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
    readOnly = false,
  ): Promise<CompanyCheck> {
    const ctx = configuration(this.store, companyId);
    const coverage = this.store.readStockCoverage(companyId);
    if (!coverage || coverage.signature !== ctx.signature)
      throw hold(
        'Confirm the current stock coverage in Order matching before publishing calculated stock.',
      );
    const to = nowIso();
    const since = Date.parse(coverage.checkedThrough ?? coverage.from);
    if (since > Date.parse(to) || Date.parse(to) - since > 30 * day)
      throw hold(
        'Stockbridge has a gap in order coverage. Reconcile earlier sales and confirm a recent starting date.',
      );
    const demo = ctx.state.mode === 'demo';
    const tally = this.sources.tally(ctx.state.settings.tallyUrl);
    const identity = { externalId: companyId.slice('tally:'.length), name: ctx.company.name };
    const guards: Array<() => void> = [];
    let expected = journalVersion(coverage);
    const verify = () => {
      for (const guard of guards) guard();
      const current = configuration(this.store, companyId);
      if (
        current.signature !== ctx.signature ||
        current.reviewState !== ctx.reviewState ||
        journalVersion(this.store.readStockCoverage(companyId)) !== expected
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
      for (const rule of ctx.rules) {
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
            throw hold('Verify each participating Flipkart seller and its shipment access.');
          orders = await this.sources.orders.readStockOrders(
            auth.token,
            coverage.from,
            to,
            rule.field !== 'manual' && rule.reference === 'invoiceNumber',
          );
        }
        verify();
        coverage.orders = mergeOrders(coverage, rule.accountId, orders);
        if (!readOnly) {
          const queued = saveOrderReceipts(this.store, ctx, coverage, rule.accountId);
          expected = journalVersion(coverage);
          if (queued) this.onPending?.(companyId, batch);
        }
      }
      verify();
      // This watermark describes a complete order scan. Publication additionally
      // checks the bills and balances below even if every receipt is familiar.
      coverage.checkedThrough = to;
      if (!readOnly) this.store.saveStockCoverage(coverage);
      const readBooks = async () => {
        try {
          const before = await balances();
          const vouchers = new Map(sampleVouchers);
          if (!demo)
            for (const rule of ctx.rules) {
              vouchers.set(
                rule.accountId,
                await tally.readSalesBills(
                  identity,
                  rule.ledgerId,
                  saleDay(coverage.from),
                  saleDay(to),
                ),
              );
            }
          const after = await balances();
          verify();
          return { before, after, vouchers };
        } catch (error) {
          if (error instanceof InputError) throw error;
          throw hold(
            'Could not verify all Flipkart orders and Tally sales bills. Check the connections and retry.',
          );
        }
      };
      let books: ReturnType<typeof readBooks> | undefined;
      const checked = new Map<string, CheckedStock>();
      return {
        forItem: async (itemId: string) => {
          const previous = checked.get(itemId);
          if (previous) {
            previous.verify();
            return previous;
          }
          const item = ctx.items.get(itemId);
          if (!item || item.companyId !== companyId || item.physical === null)
            throw hold('Refresh the current Tally stock item before publishing.');
          const { before, after, vouchers } = await (books ??= readBooks());
          if (
            !demo &&
            [before, after].some((values) => {
              const value = values.get(item.externalId);
              return !value || value.unit !== item.unit || value.physical !== item.physical;
            })
          )
            throw hold(
              'The Tally balance changed while checking bills. Refresh Tally stock and retry.',
            );
          const verifyItem = () => {
            if (saleDay(nowIso()) !== saleDay(to))
              throw hold(
                'The Tally business date changed during the order check. Refresh the company and retry.',
              );
            if (Date.now() - Date.parse(to) > 120_000)
              throw hold(
                'The order check is over two minutes old. Retry, or reconcile older sales and confirm a more recent starting date in Order matching.',
              );
            const current = verify().items.get(itemId);
            if (current?.version !== item.version || current.physical !== item.physical)
              throw hold('Tally stock changed during this check. Retry with the current balance.');
          };
          verifyItem();
          const reserved = unbilledUnits(ctx, itemId, coverage, vouchers);
          const value = { available: Math.max(0, item.physical - reserved), verify: verifyItem };
          checked.set(itemId, value);
          return value;
        },
      };
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw hold(
        'Could not verify all Flipkart orders and Tally sales bills. Check the connections and retry.',
      );
    }
  }
}
