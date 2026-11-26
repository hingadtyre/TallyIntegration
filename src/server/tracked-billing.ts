import { randomUUID } from 'node:crypto';
import {
  FlipkartBillingClient,
  FlipkartBillingError,
  type FlipkartBillingOrder,
} from '../adapters/flipkart-billing.js';
import { TallyClient, type TallySalesBill } from '../adapters/tally.js';
import {
  billingFulfilments,
  type BillingFulfilment,
  type TrackedBillHistory,
} from '../shared/billing-contracts.js';
import { isVerifiedSale, type StockSyncCoverage } from '../shared/stock-coverage.js';
import {
  fingerprint,
  isInspectedBillLink,
  saleDay,
  usesInvoiceNumber,
  type BillingScope,
} from './billing-matcher.js';
import { sampleBills } from './billing-sample.js';
import type { BillingSources } from './billing-service.js';
import {
  coverageIssue,
  mergeBillingObservations,
  mergeRetainedBillOrders,
  reconcileOrders,
  rulesForCheck,
  type CompanyBillEvidence,
} from './stock-availability.js';
import { stockConfiguration } from './stock-configuration.js';
import type { Store } from './store.js';
import { InputError } from './validation.js';

type Check = NonNullable<TrackedBillHistory['check']>;
type Access = (id: string) => Promise<{ token: string | null; verify: () => void }>;
type GroupResult = {
  accountId: string;
  group: BillingFulfilment;
  error?: string;
  invoiceError?: string;
  observed?: string[];
};
type GroupRead = GroupResult & { orders: FlipkartBillingOrder[] };
type Session = {
  id: string;
  from: string;
  to: string;
  signature: string;
  results: GroupResult[];
  guards: Map<string, () => void>;
  revisions: Map<string, number>;
  expires: number;
};

export interface ExpandedBillEvidence {
  evidence: CompanyBillEvidence;
  check: Check;
  groupsByOrder: Map<string, Set<BillingFulfilment>>;
  stockOrders: Set<string>;
  stockCoverageFrom?: string;
  failedGroups: Map<string, Set<BillingFulfilment>>;
  observed: Set<string>;
  uncheckedItems: Map<string, string>;
}

const changed = () =>
  new InputError('This order check changed or expired. Refresh tracked orders.', 409);

/** Billing observations are journalled separately from orders used to reserve inventory. */
export class TrackedBillingService {
  private readonly sessions = new Map<string, Session>();
  private readonly revisions = new Map<string, number>();
  constructor(
    private readonly store: Store,
    private readonly sources: BillingSources = {
      tally: (endpoint) => new TallyClient(endpoint),
      orders: new FlipkartBillingClient(),
    },
    private readonly access: Access,
  ) {}

  invalidate(accountId: string) {
    for (const [key, session] of this.sessions)
      if (session.results.some((row) => row.accountId === accountId)) this.sessions.delete(key);
  }

  async check(
    scope: BillingScope,
    input: Record<string, unknown> = {},
    inspection?: { previewFrom?: string },
  ) {
    const { companyId, accountId } = scope;
    const key = JSON.stringify([companyId, accountId]);
    const configuration = () =>
      stockConfiguration(
        this.store.read(),
        this.store.readMarketplace(),
        this.store.readBilling(),
        companyId,
      );
    const ctx = configuration();
    const trackingFrom = this.store.readBillingTrackingStart(companyId);
    if (!trackingFrom) throw new InputError('Choose a billing tracking start date first.', 409);
    const from =
      inspection?.previewFrom && inspection.previewFrom < trackingFrom
        ? inspection.previewFrom
        : trackingFrom;
    const signature = fingerprint([ctx.signature, ctx.reviewState, trackingFrom]);
    const previous = this.sessions.get(key);
    const retry = input.retryGroup !== undefined || input.checkId !== undefined;
    const group = billingFulfilments.find((value) => value === input.retryGroup);
    if (retry) {
      if (
        !previous ||
        !group ||
        input.checkId !== previous.id ||
        previous.from !== from ||
        previous.signature !== signature ||
        Date.now() >= previous.expires ||
        !previous.results.some((row) => row.group === group && (row.error || row.invoiceError))
      )
        throw changed();
      for (const guard of previous.guards.values()) guard();
    }
    const to = retry && previous ? previous.to : new Date().toISOString();
    const initialStock = this.store.readStockCoverage(companyId);
    const coverage: StockSyncCoverage = {
      companyId,
      from,
      signature: ctx.signature,
      checkedThrough: null,
      orders: (initialStock?.orders ?? []).filter(
        ({ order }) => order.orderDate >= from && order.orderDate <= to,
      ),
    };
    const rules = rulesForCheck(ctx, coverage, { accountId, orderItemIds: 'all' }, true, false);
    // Inspecting a voucher also checks references on the other participating sellers' orders.
    const checkInspectedInvoices =
      !!inspection ||
      ctx.billing.links.some(
        (link) =>
          link.companyId === companyId &&
          isInspectedBillLink(link) &&
          rules.some((rule) => rule.accountId === link.accountId),
      );
    const invoiceAccounts = new Set(
      rules
        .filter((rule) => checkInspectedInvoices || usesInvoiceNumber(rule))
        .map((rule) => rule.accountId),
    );
    const revisions = new Map<string, number>();
    for (const rule of rules) {
      const id = JSON.stringify([companyId, rule.accountId]);
      const current = this.revisions.get(id) ?? 0;
      if (retry && previous?.revisions.get(id) !== current) throw changed();
      revisions.set(id, current);
    }
    const guards = new Map(retry ? previous?.guards : []);
    const verifyAccess = () => {
      for (const guard of guards.values()) guard();
    };
    const verify = () => {
      verifyAccess();
      for (const [id, version] of revisions)
        if ((this.revisions.get(id) ?? 0) !== version) throw changed();
      const current = configuration();
      if (
        current.signature !== ctx.signature ||
        current.reviewState !== ctx.reviewState ||
        this.store.readBillingTrackingStart(companyId) !== trackingFrom
      )
        throw changed();
    };
    const reads: GroupRead[] = [];
    const vouchers = new Map<string, TallySalesBill[]>();
    const byLedger = new Map<string, TallySalesBill[]>();
    const demo = ctx.state.mode === 'demo';
    const identity = { externalId: companyId.slice('tally:'.length), name: ctx.company.name };
    const tally = this.sources.tally(ctx.state.settings.tallyUrl);
    for (const rule of rules) {
      const sampleAt =
        coverage.orders.find((e) => e.accountId === rule.accountId)?.order.orderDate ??
        ctx.items.get('item-a')?.observedAt ??
        null;
      const sample = demo ? sampleBills(rule, sampleAt, from, to) : null;
      const groups =
        retry && previous
          ? previous.results
              .filter(
                (row) =>
                  row.accountId === rule.accountId &&
                  row.group === group &&
                  (row.error || row.invoiceError),
              )
              .map((row) => row.group)
          : billingFulfilments;
      let token: string | null = null;
      if (!demo && groups.length) {
        try {
          const auth = await this.access(rule.accountId);
          guards.set(rule.accountId, auth.verify);
          token = auth.token;
        } catch {
          // Missing credentials for one seller must not discard the other reads.
        }
        verifyAccess();
      }
      for (const fulfilment of groups) {
        try {
          let orders: FlipkartBillingOrder[];
          if (sample) orders = fulfilment === 'standard' ? sample.orders : [];
          else if (token && this.sources.orders.readFulfilmentOrders)
            orders = await this.sources.orders.readFulfilmentOrders(
              token,
              from,
              to,
              fulfilment,
              invoiceAccounts.has(rule.accountId),
            );
          else
            throw new FlipkartBillingError(
              'Verify access to the participating Flipkart seller and refresh its listings.',
            );
          reads.push({ accountId: rule.accountId, group: fulfilment, orders });
        } catch (cause) {
          reads.push({
            accountId: rule.accountId,
            group: fulfilment,
            orders: [],
            error:
              cause instanceof FlipkartBillingError
                ? cause.message
                : 'Could not complete this Flipkart order check.',
          });
        }
        verifyAccess();
      }
      let bills = byLedger.get(rule.ledgerId);
      if (!bills) {
        try {
          bills =
            sample?.bills ??
            (await tally.readSalesBills(identity, rule.ledgerId, saleDay(from), saleDay(to)));
        } catch {
          throw new InputError(
            'Could not read the Tally sales bills for this check. Verify the company and ledger, then refresh.',
            502,
          );
        }
        byLedger.set(rule.ledgerId, bills);
      }
      vouchers.set(rule.accountId, bills);
    }
    verify();
    if (!inspection && this.sessions.get(key) !== previous) throw changed();
    const results: GroupResult[] = [
      ...(retry && previous
        ? previous.results
            .filter(
              (old) =>
                !reads.some((row) => row.accountId === old.accountId && row.group === old.group),
            )
            .map((row) => ({ ...row }))
        : []),
      ...reads.map(({ accountId: seller, group, error, orders }) => ({
        accountId: seller,
        group,
        error,
        ...(seller === accountId &&
          !error && { observed: orders.map((order) => order.orderItemId) }),
      })),
    ];

    // Merge synchronously with the latest journal after the remote reads. Concurrent
    // stock polls and checks for another seller may have captured additional claims.
    const stock = this.store.readStockCoverage(companyId);
    coverage.orders = (stock?.orders ?? []).filter(
      ({ order }) => order.orderDate >= from && order.orderDate <= to,
    );
    const stockCoverageCurrent = !!stock && !coverageIssue(stock, ctx.signature, Date.now());
    const stockOrders = new Set(
      stockCoverageCurrent
        ? coverage.orders
            .filter((e) => e.accountId === accountId && isVerifiedSale(e.order))
            .map((e) => e.order.orderItemId)
        : [],
    );
    const groupsByOrder = new Map<string, Set<BillingFulfilment>>();
    for (const rule of rules) {
      const saved = this.store.readBillingOrders(companyId, rule.accountId, from, to);
      const fresh = reads.filter((read) => !read.error && read.accountId === rule.accountId);
      const freshOrders = fresh.flatMap((read) =>
        read.orders.map((order) => ({ group: read.group, order })),
      );
      const observations = [...saved, ...freshOrders];
      if (rule.accountId === accountId)
        for (const { order, group } of observations) {
          const seen = groupsByOrder.get(order.orderItemId) ?? new Set<BillingFulfilment>();
          seen.add(group);
          groupsByOrder.set(order.orderItemId, seen);
        }
      coverage.orders = mergeRetainedBillOrders(
        coverage,
        rule.accountId,
        saved.map((row) => row.order),
        ctx,
      );
      coverage.orders = mergeBillingObservations(
        coverage,
        rule.accountId,
        fresh.flatMap((read) => read.orders),
        ctx,
      );
      const reconciled = new Map(
        coverage.orders
          .filter((row) => row.accountId === rule.accountId)
          .map(({ order }) => [order.orderItemId, order]),
      );
      if (invoiceAccounts.has(rule.accountId)) {
        const incomplete = new Set(
          observations
            .filter(({ order }) => {
              const current = reconciled.get(order.orderItemId);
              return current?.invoiceLookup === 'failed' && isVerifiedSale(current);
            })
            .map(({ group }) => group),
        );
        for (const result of results) {
          if (result.accountId !== rule.accountId) continue;
          if (incomplete.has(result.group))
            result.invoiceError = 'Flipkart invoice numbers could not be verified for some orders.';
          else delete result.invoiceError;
        }
      }
      if (!inspection && fresh.length) {
        const id = JSON.stringify([companyId, rule.accountId]);
        const revision = revisions.get(id)! + 1;
        this.revisions.set(id, revision);
        revisions.set(id, revision);
        // An order item can be recorded in more than one programme. Keep its invoice
        // evidence consistent even when a retry only returns one of those memberships.
        const seen = new Set(freshOrders.map(({ order }) => order.orderItemId));
        const updates = saved.flatMap(({ group, order }) => {
          if (!seen.has(order.orderItemId)) return [];
          const current = reconciled.get(order.orderItemId)!;
          if (
            current.stockIdentityConflict ||
            (current.invoiceNumber === order.invoiceNumber &&
              current.invoiceLookup === order.invoiceLookup)
          )
            return [];
          return [
            {
              group,
              order: {
                ...order,
                invoiceNumber: current.invoiceNumber,
                invoiceLookup: current.invoiceLookup,
              },
            },
          ];
        });
        this.store.saveBillingOrderObservations(companyId, rule.accountId, [
          ...updates,
          ...freshOrders.map(({ group, order }) => ({
            group,
            order: reconciled.get(order.orderItemId)!,
          })),
        ]);
      }
    }
    const observed = new Set(results.flatMap((row) => row.observed ?? []));
    const orders = reconcileOrders({ ...ctx, rules }, coverage, vouchers, 'billing');
    const failedGroups = new Map<string, Set<BillingFulfilment>>();
    for (const row of results) {
      if (!row.error) continue;
      const groups = failedGroups.get(row.accountId) ?? new Set<BillingFulfilment>();
      groups.add(row.group);
      failedGroups.set(row.accountId, groups);
    }
    const configured = new Set(ctx.rules.map((rule) => rule.accountId));
    const uncheckedItems = new Map<string, string>();
    for (const { itemId, accountId: peer } of ctx.bindings) {
      if (!itemId || peer === accountId) continue;
      if (!configured.has(peer))
        uncheckedItems.set(
          itemId,
          'Another seller shares this stock item. Confirm its bill matching rule to verify the bill.',
        );
      else if (failedGroups.has(peer))
        uncheckedItems.set(
          itemId,
          'Another seller shares this stock item and its order check is incomplete. Retry to verify the bill.',
        );
    }
    const evidence: CompanyBillEvidence = { ctx, coverage, trackingFrom, vouchers, orders, verify };
    const visible = orders.filter(
      (row) =>
        row.accountId === accountId &&
        (!row.itemId || ctx.items.get(row.itemId)?.companyId === companyId),
    );
    const checks = billingFulfilments.map((type) => {
      const groupResults = results.filter((row) => row.group === type);
      const selected = groupResults.find((row) => row.accountId === accountId);
      const count =
        selected && !selected.error
          ? visible.filter(({ order }) => groupsByOrder.get(order.orderItemId)?.has(type)).length
          : null;
      const issues: string[] = [];
      for (const row of groupResults) {
        const issue = row.error ?? row.invoiceError;
        if (!issue) continue;
        if (row.accountId === accountId) issues.push(issue);
        else {
          const seller =
            ctx.market.accounts.find((account) => account.id === row.accountId)?.name ??
            row.accountId;
          issues.push(
            row.error
              ? 'Stockbridge could not check orders for ' + seller + '.'
              : 'Stockbridge could not check Flipkart invoice details for ' + seller + '.',
          );
        }
      }
      return { group: type, count, ...(issues.length > 0 && { error: issues.join(' ') }) };
    });
    const check: Check = {
      id: randomUUID(),
      from,
      to,
      groups: checks,
      complete: checks.every((row) => row.count !== null && !row.error),
    };
    if (!inspection)
      this.sessions.set(key, {
        id: check.id,
        from,
        to,
        signature,
        results,
        guards,
        revisions,
        expires: Date.now() + 600_000,
      });
    return {
      check,
      evidence,
      groupsByOrder,
      stockOrders,
      ...(stockCoverageCurrent && { stockCoverageFrom: stock.from }),
      failedGroups,
      observed,
      uncheckedItems,
    } satisfies ExpandedBillEvidence;
  }
}
