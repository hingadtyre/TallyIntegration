import { randomUUID } from 'node:crypto';
import { FlipkartBillingClient, FlipkartBillingError } from '../adapters/flipkart-billing.js';
import { TallyClient } from '../adapters/tally.js';
import type {
  BillingReport,
  BillingRule,
  BillingWorkspace,
  PendingListingCheck,
  PendingListingGroup,
  PendingListings,
} from '../shared/billing-contracts.js';
import type { Company, Snapshot } from '../shared/contracts.js';
import { isVerifiedCancellation } from '../shared/stock-coverage.js';
import {
  fingerprint,
  matchBills,
  saleDay,
  type BillingEvidence,
  type BillingScope,
} from './billing-matcher.js';
import { sampleBills, sampleLedger } from './billing-sample.js';
import { invalidateReservationDrafts } from './proposals.js';
import type { BillingData } from './storage/billing-records.js';
import type { StockAvailabilityService } from './stock-availability.js';
import type { Store } from './store.js';
import { InputError, requireCompany, requireText } from './validation.js';

type ReviewSpec = Pick<BillingReport, 'rule' | 'from' | 'to'>;
type Matches = ReturnType<typeof matchBills>;
type Decision = 'confirm' | 'match' | 'unmatch';

interface ReviewSession {
  report: BillingReport;
  accountId: string;
  tallyUrl: string;
  savedDecisions: string;
  reviewedEvidence: string;
}

export interface BillingSources {
  tally: (endpoint: string) => Pick<TallyClient, 'listLedgers' | 'readSalesBills' | 'readStock'>;
  orders: Pick<FlipkartBillingClient, 'readOrders'> &
    Partial<Pick<FlipkartBillingClient, 'readStockOrders'>>;
}

function configuredRule(data: BillingData, scope: BillingScope): BillingRule | null {
  const rule = data.rules.find(
    (row) => row.companyId === scope.companyId && row.accountId === scope.accountId,
  );
  if (!rule) return null;
  const { ledgerId, ledgerName, field, reference } = rule;
  return { ledgerId, ledgerName, field, reference };
}

// A voucher item can be claimed by another account in the company. An order
// item can be claimed in another company using the same seller account.
function decisionsDigest(data: BillingData, scope: BillingScope, ledgerId: string): string {
  const sharedAccounts = data.rules
    .filter(
      (row) =>
        row.companyId === scope.companyId &&
        row.ledgerId === ledgerId &&
        row.accountId !== scope.accountId,
    )
    .map((row) => row.accountId)
    .sort();
  const claims = data.links.filter(
    (row) => row.companyId === scope.companyId || row.accountId === scope.accountId,
  );
  return fingerprint([configuredRule(data, scope), sharedAccounts, claims]);
}

function evidenceDigest(rule: BillingRule, match: Matches): string {
  // Dates, quantities and bill numbers can look unchanged when a selected
  // reference, source identity or other evidence of a candidate has changed.
  const candidates: string[] = [];
  for (const choices of match.links.values()) {
    for (const link of choices.values()) {
      candidates.push(
        JSON.stringify([link.orderItemId, link.billId, link.itemId, link.fingerprint]),
      );
    }
  }
  return fingerprint([rule, match.rows, match.stock, candidates.sort()]);
}

function newReview(input: Record<string, unknown>): ReviewSpec {
  if (input.days !== 1 && input.days !== 7 && input.days !== 30)
    throw new InputError('Choose today, the last 7 days or the last 30 days.');
  const field = input.field;
  const reference = input.reference;
  if (field !== 'manual' && field !== 'number' && field !== 'reference' && field !== 'narration')
    throw new InputError('Choose a Tally reference field.');
  if (reference !== 'invoiceNumber' && reference !== 'orderId' && reference !== 'orderItemId')
    throw new InputError('Choose a Flipkart reference type.');
  const to = new Date().toISOString();
  const startOfToday = Date.parse(saleDay(to) + 'T00:00:00+05:30');
  return {
    rule: {
      ledgerId: requireText(input.ledgerId, 'Sales ledger'),
      ledgerName: '',
      field,
      reference,
    },
    from: new Date(startOfToday - (input.days - 1) * 86_400_000).toISOString(),
    to,
  };
}

function currentReview(
  session: ReviewSession | undefined,
  previewId: unknown,
  decision: Decision,
  rule: BillingRule | null,
): ReviewSession {
  if (
    !session ||
    session.report.previewId !== previewId ||
    Date.now() - Date.parse(session.report.checkedAt) > 600_000
  )
    throw new InputError(
      'This review expired or changed. Preview the current orders and bills again.',
      409,
    );
  if (decision !== 'confirm' && fingerprint(rule) !== fingerprint(session.report.rule))
    throw new InputError('Confirm the current ledger and reference choices first.', 409);
  return session;
}

function saveDecision(
  data: BillingData,
  state: Snapshot,
  decision: Decision,
  input: Record<string, unknown>,
  scope: BillingScope,
  rule: BillingRule,
  match: Matches,
): void {
  if (decision === 'confirm') {
    const previous = configuredRule(data, scope);
    if (
      !previous ||
      previous.ledgerId !== rule.ledgerId ||
      previous.field !== rule.field ||
      previous.reference !== rule.reference
    ) {
      invalidateReservationDrafts(
        state,
        new Set(
          state.items.filter((item) => item.companyId === scope.companyId).map((item) => item.id),
        ),
      );
    }
    data.rules = data.rules.filter(
      (row) => row.companyId !== scope.companyId || row.accountId !== scope.accountId,
    );
    data.rules.push({ ...scope, ...rule });
    return;
  }
  const orderItemId = requireText(input.orderItemId, 'Order item');
  const row = match.rows.find((order) => order.orderItemId === orderItemId);
  const invalidateItem = (externalId: string) => {
    const item = state.items.find(
      (item) => item.companyId === scope.companyId && item.externalId === externalId,
    );
    if (item) invalidateReservationDrafts(state, new Set([item.id]));
  };
  if (decision === 'unmatch') {
    const previous = data.links.find(
      (link) =>
        link.accountId === scope.accountId &&
        link.companyId === scope.companyId &&
        link.orderItemId === orderItemId,
    );
    if (!previous || !row?.manualBillId)
      throw new InputError('This order has no manual confirmation here.', 409);
    invalidateItem(previous.itemId);
    data.links = data.links.filter((link) => link !== previous);
    return;
  }
  const billId = requireText(input.billId, 'Sales bill');
  const link = match.links.get(orderItemId)?.get(billId);
  if (!link || row?.status !== 'review' || !row.candidates.some((bill) => bill.id === billId))
    throw new InputError('Choose an available candidate from the current review.', 409);
  data.links.push(link);
  invalidateItem(link.itemId);
}

export class BillingService {
  private readonly sessions = new Map<string, ReviewSession>();
  constructor(
    private readonly store: Store,
    private readonly sources: BillingSources = {
      tally: (endpoint) => new TallyClient(endpoint),
      orders: new FlipkartBillingClient(),
    },
  ) {}

  invalidate(accountId: string): void {
    for (const [key, session] of this.sessions)
      if (session.accountId === accountId) this.sessions.delete(key);
  }

  async pendingOrders(
    availability: StockAvailabilityService,
    input: Record<string, unknown>,
    accountId: string,
    recheck: boolean,
  ) {
    const { id: companyId } = requireCompany(this.store.read(), input.companyId);
    let refreshIssue: string | undefined;
    if (
      !recheck &&
      input.savedOnly !== true &&
      configuredRule(this.store.readBilling(), { companyId, accountId })
    ) {
      const coverage = availability.coverageCommand('/api/billing/coverage', {
        companyId,
        accountId,
      });
      if (coverage.current) {
        try {
          await availability.refreshPendingOrders(companyId, accountId);
        } catch (error) {
          refreshIssue =
            error instanceof InputError ? error.message : 'Could not refresh tracked orders.';
        }
      } else if (coverage.from) {
        refreshIssue = coverage.issue;
      }
    }
    const { orders, trackingStarted } = availability.pendingHistory(companyId, accountId);
    const groups = new Map<string, PendingListingGroup>();
    const visible = new Set<PendingListingGroup>();
    for (const { order, mapped } of orders) {
      const { listingId, sku, locationId: location } = order;
      const key = JSON.stringify([listingId, sku, location]);
      const group = groups.get(key) ?? { listingId, sku, location, mapped, orderItemIds: [] };
      group.orderItemIds.push(order.orderItemId);
      groups.set(key, group);
      if (mapped || !isVerifiedCancellation(order)) visible.add(group);
    }
    if (!recheck)
      return {
        trackingStarted,
        listings: [...visible],
        ...(refreshIssue && { refreshIssue }),
      } satisfies PendingListings;

    const listingId = requireText(input.listingId, 'Flipkart listing');
    const sku = requireText(input.sku, 'Seller SKU');
    const location = requireText(input.location, 'Seller location');
    const group = groups.get(JSON.stringify([listingId, sku, location]));
    if (!group)
      throw new InputError(
        'This listing has no saved orders for this company and seller location.',
        409,
      );
    if (input.orderItemIds !== undefined) {
      const identifiers = new Set(group.orderItemIds);
      if (
        !Array.isArray(input.orderItemIds) ||
        !input.orderItemIds.length ||
        input.orderItemIds.some((id) => typeof id !== 'string' || !identifiers.has(id))
      ) {
        throw new InputError(
          'The requested orders do not belong to this saved listing and location.',
          409,
        );
      }
    }

    // A receipt can disappear from the latest provider page or a scope can
    // change during the read. Only explicit results from the journal count.
    const checked = await availability.reviewOrders(companyId, accountId, group.orderItemIds);
    const rows = checked
      .filter(
        ({ order }) =>
          order.listingId === listingId && order.sku === sku && order.locationId === location,
      )
      .map(({ result }) => result);
    const returned = new Set(rows.map((row) => row.orderItemId));
    if (group.orderItemIds.some((id) => !returned.has(id)))
      throw new InputError(
        'The saved orders changed during the check. Refresh Order matching and retry.',
        409,
      );
    return { listingId, sku, location, rows } satisfies PendingListingCheck;
  }

  private async listLedgers(state: Snapshot, company: Company) {
    if (state.mode === 'demo') return [sampleLedger(company.id)];
    try {
      const tally = this.sources.tally(state.settings.tallyUrl);
      return await tally.listLedgers({
        externalId: company.id.slice('tally:'.length),
        name: company.name,
      });
    } catch {
      throw new InputError(
        'Could not read the ledgers for this company. Check that the company is open in Tally.',
        502,
      );
    }
  }

  private async readEvidence(
    state: Snapshot,
    company: Company,
    scope: BillingScope,
    spec: ReviewSpec,
    token: () => Promise<string | null>,
    verifyAccess: () => void,
  ): Promise<{ ledgerName: string; evidence: BillingEvidence }> {
    if (state.mode === 'demo') {
      const ledger = sampleLedger(company.id);
      if (spec.rule.ledgerId !== ledger.externalId)
        throw new InputError('Select a sample ledger for this company.');
      const observed = state.items.find((item) => item.id === 'item-a')?.observedAt ?? null;
      return {
        ledgerName: ledger.name,
        evidence: sampleBills(scope, observed, spec.from, spec.to),
      };
    }
    const access = await token();
    verifyAccess();
    if (!access) throw new InputError('Refresh listings to verify the seller account first.', 409);
    const tally = this.sources.tally(state.settings.tallyUrl);
    const identity = { externalId: company.id.slice('tally:'.length), name: company.name };
    try {
      const ledger = (await tally.listLedgers(identity)).find(
        (row) => row.externalId === spec.rule.ledgerId,
      );
      if (!ledger)
        throw new InputError('The selected ledger is no longer available in this company.', 409);
      const [orders, bills] = await Promise.all([
        this.sources.orders.readOrders(
          access,
          spec.from,
          spec.to,
          spec.rule.field !== 'manual' && spec.rule.reference === 'invoiceNumber',
        ),
        tally.readSalesBills(identity, ledger.externalId, saleDay(spec.from), saleDay(spec.to)),
      ]);
      // Only read balances here. Inventory's regular refresh can publish stock.
      return {
        ledgerName: ledger.name,
        evidence: { orders, bills, balances: await tally.readStock(identity) },
      };
    } catch (error) {
      if (error instanceof InputError) throw error;
      if (error instanceof FlipkartBillingError) throw new InputError(error.message, 502);
      throw new InputError(
        'The order or sales-bill read could not be completed. Check seller access and Tally, then preview again. No decisions were saved.',
        502,
      );
    }
  }

  async command(
    path: string,
    input: Record<string, unknown>,
    token: () => Promise<string | null>,
    verifyAccess: () => void = () => {},
  ): Promise<unknown> {
    const state = this.store.read();
    const company = requireCompany(state, input.companyId);
    const accountId = requireText(input.accountId, 'Seller account');
    if (!this.store.readMarketplace().accounts.some((account) => account.id === accountId))
      throw new InputError('Select an added Flipkart account.');
    const scope: BillingScope = { companyId: company.id, accountId };
    const key = JSON.stringify([company.id, accountId]);
    const session = this.sessions.get(key);
    const saved = this.store.readBilling();
    const rule = configuredRule(saved, scope);
    if (path === '/api/billing/workspace') {
      const current =
        session &&
        session.tallyUrl === state.settings.tallyUrl &&
        fingerprint(session.report.rule) === fingerprint(rule) &&
        session.savedDecisions === decisionsDigest(saved, scope, session.report.rule.ledgerId);
      return { rule, report: current ? session.report : null } satisfies BillingWorkspace;
    }
    if (path === '/api/billing/ledgers') return { ledgers: await this.listLedgers(state, company) };
    const action = path.slice('/api/billing/'.length);
    if (
      !path.startsWith('/api/billing/') ||
      (action !== 'preview' && action !== 'confirm' && action !== 'match' && action !== 'unmatch')
    )
      throw new InputError('Route not found.', 404);
    const previous =
      action === 'preview' ? null : currentReview(session, input.previewId, action, rule);
    const spec = previous?.report ?? newReview(input);
    const baseline = decisionsDigest(saved, scope, spec.rule.ledgerId);
    if (
      previous &&
      (previous.savedDecisions !== baseline || previous.tallyUrl !== state.settings.tallyUrl)
    )
      throw new InputError('A billing decision or Tally connection changed. Preview again.', 409);

    const { ledgerName, evidence } = await this.readEvidence(
      state,
      company,
      scope,
      spec,
      token,
      verifyAccess,
    );
    if (state.mode === 'live') verifyAccess();
    const current = this.store.read();
    let decisions = this.store.readBilling();
    if (
      current.settings.tallyUrl !== state.settings.tallyUrl ||
      decisionsDigest(decisions, scope, spec.rule.ledgerId) !== baseline ||
      (previous && previous !== this.sessions.get(key))
    )
      throw new InputError(
        'Settings or billing decisions changed during the read. Preview again.',
        409,
      );
    const requested = { ...spec.rule, ledgerName };
    const catalogue = this.store.readMarketplace().listings;
    const matchCurrent = () =>
      matchBills(scope, requested, evidence, decisions, current, catalogue);
    let match = matchCurrent();
    if (action !== 'preview') {
      if (previous?.reviewedEvidence !== evidenceDigest(requested, match))
        throw new InputError(
          'The order, bill or stock evidence changed. Preview it again before saving.',
          409,
        );
      this.store.updateBilling((data, state) =>
        saveDecision(data, state, action, input, scope, requested, match),
      );
      decisions = this.store.readBilling();
      match = matchCurrent();
    }
    const report: BillingReport = {
      previewId: randomUUID(),
      rule: requested,
      from: spec.from,
      to: spec.to,
      checkedAt: new Date().toISOString(),
      rows: match.rows,
      stock: match.stock,
    };
    this.sessions.set(key, {
      accountId,
      report,
      tallyUrl: current.settings.tallyUrl,
      savedDecisions: decisionsDigest(decisions, scope, requested.ledgerId),
      reviewedEvidence: evidenceDigest(requested, match),
    });
    return action === 'preview' ? report : ({ rule: requested, report } satisfies BillingWorkspace);
  }
}
