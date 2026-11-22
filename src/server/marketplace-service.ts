import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FlipkartListingError, FlipkartListingsClient } from '../adapters/flipkart-listings.js';
import type {
  FlipkartConnectionStatus,
  InventoryPublishRow,
  Snapshot,
} from '../shared/contracts.js';
import { checkAutomationDestination, indexAutomationCatalog } from './automation-preview.js';
import { inventoryTarget, type InventoryIntent } from './inventory-publication.js';
import type {
  MarketplaceAccount,
  MarketplaceAccountRecord,
  MarketplaceListing,
  MarketplaceListingView,
  MarketplacePage,
} from '../shared/marketplace-contracts.js';
import { recordActivity } from './activity.js';
import { BillingService, type BillingSources } from './billing-service.js';
import { FlipkartConnection } from './flipkart-connection.js';
import {
  cataloguesOverlap,
  findMarketplaceListing,
  listingView,
  markPackageCountsUnavailable,
  seedSampleMarketplace,
  updateInventoryObservations,
} from './marketplace-catalog.js';
import {
  MarketplacePublication,
  sameListingIdentity,
  type ListingTransport,
} from './marketplace-publication.js';
import { desiredStock } from './proposals.js';
import { StockAvailabilityService } from './stock-availability.js';
import { MarketplaceStockRecovery } from './marketplace-stock-recovery.js';
import type { Store } from './store.js';
import { InputError, requireText, requireWholeNumber } from './validation.js';

export type AccountConnection = Pick<
  FlipkartConnection,
  'status' | 'save' | 'connect' | 'check' | 'disconnect' | 'getAccessToken' | 'stop' | 'idle'
>;
interface MarketplaceDependencies {
  billingSources?: BillingSources;
  client?: ListingTransport;
  createConnection?: (accountId: string) => AccountConnection;
  legacyConnection?: AccountConnection;
}

const sampleStatus: FlipkartConnectionStatus = {
  state: 'unavailable',
  checkedAt: null,
  expiresAt: null,
  applicationIdHint: null,
  message: 'Sample account. No marketplace connection or external updates.',
};

/** Account commands serialize credentials, imports and writes within each seller account. */
export class MarketplaceService {
  readonly blockedSyncReasons = new Map<string, string>();
  private readonly connections = new Map<string, AccountConnection>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly verifiedAccounts = new Set<string>();
  private readonly verificationRevision = new Map<string, number>();
  private readonly verifiedImportErrors = new Map<string, string>();
  private readonly client: ListingTransport;
  private readonly publisher: MarketplacePublication;
  private readonly billing: BillingService;
  private readonly availability: StockAvailabilityService;
  private readonly orderListeners = new Set<(companyId: string, batch?: object) => void>();
  private readonly recovery: MarketplaceStockRecovery;
  private stopped = false;
  private readonly mode: 'live' | 'demo';

  constructor(
    private readonly store: Store,
    private readonly dataDirectory: string,
    private readonly dependencies: MarketplaceDependencies = {},
  ) {
    this.mode = store.read().mode;
    this.client = dependencies.client ?? new FlipkartListingsClient();
    this.publisher = new MarketplacePublication(store, this.client);
    this.billing = new BillingService(store, dependencies.billingSources);
    this.availability = new StockAvailabilityService(
      store,
      dependencies.billingSources,
      async (id) => {
        const verify = this.sellerGuard(id);
        const token = await this.verifiedToken(id);
        verify();
        return { token, verify };
      },
      (companyId, batch) => {
        for (const listener of this.orderListeners) listener(companyId, batch);
      },
    );
    if (dependencies.legacyConnection)
      this.connections.set('flipkart-primary', dependencies.legacyConnection);
    this.recovery = new MarketplaceStockRecovery(
      store,
      this.client,
      this.publisher,
      (companyId, itemId) => this.availableStock(companyId, itemId),
    );
    store.updateMarketplace((data, state) => {
      seedSampleMarketplace(data, state);
      if (this.mode === 'live') markPackageCountsUnavailable(state);
      for (const change of data.changes) {
        if (['pending', 'sending', 'checking'].includes(change.state)) {
          change.state = 'uncertain';
          change.message =
            'Stockbridge restarted before confirming this update. Refresh the account and check result; it will not be replayed.';
          change.updatedAt = new Date().toISOString();
        }
      }
    });
  }

  private serial<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const run = (this.pending.get(accountId) ?? Promise.resolve()).then(() => {
      if (this.stopped)
        throw new InputError('Stockbridge is stopping. Try again after restarting.', 503);
      return operation();
    });
    this.pending.set(
      accountId,
      run.catch(() => undefined),
    );
    return run;
  }

  private account(id: unknown): MarketplaceAccountRecord {
    const account = this.store.readMarketplace().accounts.find((row) => row.id === id);
    if (!account) throw new InputError('Choose an added marketplace account.', 404);
    return account;
  }

  private connection(id: string): AccountConnection {
    if (!this.connections.has(id)) {
      if (this.dependencies.createConnection)
        this.connections.set(id, this.dependencies.createConnection(id));
      else {
        // IDs are generated locally, never taken from an unvalidated filesystem path.
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(id))
          throw new InputError('Invalid account identity.', 409);
        const directory =
          id === 'flipkart-primary'
            ? this.dataDirectory
            : join(this.dataDirectory, 'marketplace-credentials', id);
        mkdirSync(directory, { recursive: true });
        this.connections.set(id, new FlipkartConnection(directory, this.mode));
      }
    }
    return this.connections.get(id)!;
  }

  private async publicAccount(account: MarketplaceAccountRecord): Promise<MarketplaceAccount> {
    const connection =
      this.mode === 'demo' ? { ...sampleStatus } : await this.connection(account.id).status();
    const catalogOwnershipVerified = this.verifiedAccounts.has(account.id);
    if (connection.state === 'verified' && catalogOwnershipVerified)
      connection.message = account.sellerId
        ? 'API access and seller identity verified. Listings are available in this account.'
        : 'API access and listing ownership verified. Flipkart did not supply a seller ID.';
    return {
      ...account,
      marketplace: 'flipkart',
      catalogOwnershipVerified,
      ...(this.verifiedImportErrors.has(account.id) && {
        catalogImportError: this.verifiedImportErrors.get(account.id)!,
      }),
      connection,
    };
  }

  /** Existing protected credentials are adopted without moving or re-encrypting their file. */
  private async adoptLegacyAccount(): Promise<void> {
    if (
      this.mode !== 'live' ||
      this.store.readMarketplace().accounts.some((row) => row.id === 'flipkart-primary')
    )
      return;
    const oldStatus = await this.connection('flipkart-primary').status();
    if (!oldStatus.applicationIdHint) return;
    this.store.updateMarketplace((data, state) => {
      const existing = state.accounts.find((row) => row.id === 'flipkart-primary');
      const account = existing ?? {
        id: 'flipkart-primary',
        name: 'Flipkart seller',
        marketplace: 'flipkart' as const,
        status: 'not-connected' as const,
      };
      if (!existing) state.accounts.push(account);
      if (!data.accounts.some((row) => row.id === account.id))
        data.accounts.push({
          id: account.id,
          name: account.name,
          sellerId: null,
          lastRefreshedAt: null,
        });
    });
  }

  async initialize(): Promise<void> {
    return this.serial('account-directory', () => this.adoptLegacyAccount());
  }

  async accounts(): Promise<{ accounts: MarketplaceAccount[] }> {
    return this.serial('account-directory', async () => {
      await this.adoptLegacyAccount();
      return {
        accounts: await Promise.all(
          this.store.readMarketplace().accounts.map((account) => this.publicAccount(account)),
        ),
      };
    });
  }

  async add(input: Record<string, unknown>): Promise<MarketplaceAccount> {
    const added = await this.serial('account-directory', async () => {
      if (input.marketplace !== 'flipkart')
        throw new InputError('Flipkart is the supported marketplace.');
      const name = requireText(input.name, 'Account name').trim();
      if (!name || name.length > 100)
        throw new InputError('Use an account name of 1 to 100 characters.');
      if (typeof input.verify !== 'boolean')
        throw new InputError('Choose whether to verify the credentials now.');
      const id = randomUUID();
      if (this.mode === 'live') {
        const connection = this.connection(id);
        const credentials = {
          applicationId: input.applicationId,
          applicationSecret: input.applicationSecret,
        };
        if (input.verify) await connection.connect(credentials);
        else await connection.save(credentials);
      }
      const account: MarketplaceAccountRecord = {
        id,
        name,
        sellerId: this.mode === 'demo' ? `sample-${id}` : null,
        lastRefreshedAt: null,
      };
      try {
        this.store.updateMarketplace((data, state) => {
          data.accounts.push(account);
          state.accounts.push({
            id,
            name,
            marketplace: 'flipkart',
            status: this.mode === 'demo' ? 'demo' : 'not-connected',
          });
          recordActivity(
            state,
            'marketplace-account-added',
            `${name}: account added. Refresh listings to verify seller identity.`,
          );
          if (this.mode === 'demo') {
            const sample = data.listings[0];
            if (sample) {
              const listing = {
                ...structuredClone(sample),
                id: `sample-${id}`,
                accountId: id,
                sellerId: `sample-${id}`,
                version: 1,
                observedAt: new Date().toISOString(),
              };
              data.listings.push(listing);
              updateInventoryObservations(state, listing);
              account.lastRefreshedAt = listing.observedAt;
            }
          }
        });
      } catch (error) {
        if (this.mode === 'live') await this.connection(id).disconnect();
        throw error;
      }
      return this.publicAccount(account);
    });
    if (this.mode === 'live' && input.verify === true && added.connection.state === 'verified')
      return this.serial(added.id, () => this.importVerifiedAccount(added.id));
    return added;
  }

  invalidate(accountId: string): void {
    this.verifiedAccounts.delete(accountId);
    this.verificationRevision.set(accountId, (this.verificationRevision.get(accountId) ?? 0) + 1);
    this.billing.invalidate(accountId);
  }

  runLegacyCommand(
    operation: () => Promise<FlipkartConnectionStatus>,
    verifyAndImport = false,
  ): Promise<FlipkartConnectionStatus> {
    return this.serial('flipkart-primary', async () => {
      this.invalidate('flipkart-primary');
      this.verifiedImportErrors.delete('flipkart-primary');
      this.store.update((state) => markPackageCountsUnavailable(state, 'flipkart-primary'));
      let result: FlipkartConnectionStatus;
      try {
        result = await operation();
      } finally {
        this.store.updateMarketplace((data) => {
          const account = data.accounts.find((row) => row.id === 'flipkart-primary');
          if (account) account.lastRefreshedAt = null;
        });
      }
      if (verifyAndImport && result.state === 'verified') {
        await this.adoptLegacyAccount();
        const account = await this.importVerifiedAccount('flipkart-primary');
        return { ...result, message: account.catalogImportError ?? account.connection.message };
      }
      return result;
    });
  }

  async changeConnection(input: Record<string, unknown>): Promise<MarketplaceAccount> {
    const account = this.account(input.accountId);
    return this.serial(account.id, async () => {
      if (this.mode === 'demo')
        throw new InputError('Sample accounts do not use seller credentials.', 409);
      const connection = this.connection(account.id);
      this.invalidate(account.id);
      this.verifiedImportErrors.delete(account.id);
      this.store.update((state) => markPackageCountsUnavailable(state, account.id));
      switch (input.action) {
        case 'check':
          await connection.check();
          break;
        case 'disconnect':
          await connection.disconnect();
          break;
        case 'save':
          await connection.save({
            applicationId: input.applicationId,
            applicationSecret: input.applicationSecret,
          });
          break;
        case 'connect':
          await connection.connect({
            applicationId: input.applicationId,
            applicationSecret: input.applicationSecret,
          });
          break;
        default:
          throw new InputError('Unknown account connection action.');
      }
      this.store.updateMarketplace((data, state) => {
        data.accounts.find((row) => row.id === account.id)!.lastRefreshedAt = null;
        recordActivity(
          state,
          'marketplace-connection',
          `${account.name}: ${String(input.action)} completed. Refresh listings before editing.`,
        );
      });
      if (input.action === 'check' || input.action === 'connect')
        return this.importVerifiedAccount(account.id);
      return this.publicAccount(this.account(account.id));
    });
  }

  /** Caller holds this account's queue. Token verification may succeed even when
   * the catalogue import fails. Keep the saved connection and make it retryable. */
  private async importVerifiedAccount(id: string): Promise<MarketplaceAccount> {
    const account = this.account(id);
    if ((await this.connection(id).status()).state !== 'verified')
      return this.publicAccount(account);
    try {
      return (await this.refreshAccount(account)).account;
    } catch (error) {
      const reason =
        error instanceof InputError || error instanceof FlipkartListingError
          ? error.message
          : 'The listing import did not complete.';
      this.verifiedImportErrors.set(id, 'API access verified. ' + reason);
      return this.publicAccount(this.account(id));
    }
  }

  async refresh(accountId: unknown): Promise<{ account: MarketplaceAccount }> {
    const id = this.account(accountId).id;
    return this.serial(id, () => this.refreshAccount(this.account(id)));
  }

  private async refreshAccount(
    account: MarketplaceAccountRecord,
  ): Promise<{ account: MarketplaceAccount }> {
    if (this.mode === 'demo') {
      this.store.updateMarketplace((data, state) => {
        const observedAt = new Date().toISOString();
        data.accounts.find((row) => row.id === account.id)!.lastRefreshedAt = observedAt;
        for (const listing of data.listings.filter((row) => row.accountId === account.id)) {
          listing.observedAt = observedAt;
          updateInventoryObservations(state, listing);
        }
      });
    } else {
      this.invalidate(account.id);
      try {
        const token = await this.connection(account.id).getAccessToken();
        const listings = await this.client.listListings(token, account.id);
        const sellers = new Set(listings.map((row) => row.sellerId));
        if (sellers.size > 1 || listings.some((row) => row.accountId !== account.id))
          throw new InputError(
            'Flipkart returned inconsistent seller identity. No listings were imported.',
            409,
          );
        const reportedSeller = listings[0]?.sellerId ?? null;
        const sellerId = reportedSeller ?? account.sellerId;
        if (account.sellerId && reportedSeller && reportedSeller !== account.sellerId)
          throw new InputError(
            'These credentials belong to a different seller. Reconnect the original seller or add a separate account.',
            409,
          );
        this.store.updateMarketplace((data, state) => {
          const bound = data.accounts.find((row) => row.id === account.id)!;
          // The standard API authenticates ownership of exact listing IDs but omits
          // seller ID. Across refreshes require at least one previously owned identity.
          // Disjoint catalogues require a new tile; shared product IDs or SKUs alone
          // are common across sellers and cannot prove continuity.
          const owned = data.listings.filter((row) => row.accountId === account.id);
          const needsOverlap = !reportedSeller || !bound.sellerId;
          if (
            needsOverlap &&
            (owned.length || bound.sellerId) &&
            listings.length &&
            !cataloguesOverlap(owned, listings)
          ) {
            throw new InputError(
              'This catalogue has no listing identities in common with this account. Check the credentials or add a separate seller account.',
              409,
            );
          }
          const incoming = new Map(listings.map((row) => [row.id, row]));
          if (
            data.listings.some((other) => {
              const row = incoming.get(other.id);
              return (
                row &&
                other.accountId !== account.id &&
                (!other.sellerId || !row.sellerId || other.sellerId === row.sellerId)
              );
            })
          ) {
            throw new InputError(
              'This seller is already added. Use its existing account tile.',
              409,
            );
          }
          if (bound.sellerId && sellerId !== bound.sellerId)
            throw new InputError(
              'These credentials belong to a different seller. Reconnect the original seller or add a separate account.',
              409,
            );
          if (
            sellerId &&
            data.accounts.some((row) => row.id !== account.id && row.sellerId === sellerId)
          )
            throw new InputError(
              'This seller is already added. Use its existing account tile.',
              409,
            );
          for (const listing of listings) {
            // Preserve a previously authenticated seller binding when the current API
            // proves catalogue continuity without repeating the provider's seller ID.
            listing.sellerId = sellerId;
            const previous = data.listings.find(
              (row) => row.accountId === account.id && row.id === listing.id,
            );
            const previousSku = data.listings.find(
              (row) => row.accountId === account.id && row.sku === listing.sku,
            );
            if (
              previous &&
              (previous.productId !== listing.productId || previous.sku !== listing.sku)
            )
              throw new InputError(
                'A listing identity changed. Resolve the existing mapping before importing it.',
                409,
              );
            if (previousSku && previousSku.id !== listing.id) {
              const inventoryRows = state.listings.filter(
                (row) => row.accountId === account.id && row.sku === listing.sku,
              );
              if (
                inventoryRows.some(
                  (row) =>
                    row.itemId !== null ||
                    row.policy !== 'auto' ||
                    row.remaining !== null ||
                    row.paused,
                ) ||
                data.changes.some(
                  (row) =>
                    row.accountId === account.id &&
                    row.sku === listing.sku &&
                    ['pending', 'sending', 'checking', 'uncertain'].includes(row.state),
                )
              )
                throw new InputError(
                  'A listing identity changed. Resolve its existing mapping, stock policy or unconfirmed update before importing it.',
                  409,
                );
              // A recreated, unprotected SKU starts with new Inventory identities and pack evidence.
              const retiredIds = new Set(inventoryRows.map((row) => row.id));
              state.listings = state.listings.filter((row) => !retiredIds.has(row.id));
              state.proposals = state.proposals.filter((row) => !retiredIds.has(row.listingId));
              data.listings = data.listings.filter((row) => row !== previousSku);
              recordActivity(
                state,
                'marketplace-listing-replaced',
                `${listing.sku}: recreated marketplace listing imported without a Tally mapping or stock policy.`,
              );
            }
            listing.version = (previous?.version ?? previousSku?.version ?? 0) + 1;
            if (!previous) {
              for (const row of state.listings.filter(
                (row) =>
                  row.accountId === account.id && row.sku === listing.sku && row.itemId !== null,
              )) {
                row.verified = false;
                row.version++;
              }
            }
            if (!listing.locations.length && previous?.observedAt) {
              for (const row of state.listings) {
                if (
                  row.accountId === listing.accountId &&
                  row.sku === listing.sku &&
                  row.itemId &&
                  row.sourceScope === 'company' &&
                  previous.locations.some(
                    (loc) => loc.id === row.location && loc.status === 'ENABLED',
                  )
                )
                  row.skuMappingId = listing.id;
              }
            }
            updateInventoryObservations(state, listing);
          }
          for (const row of state.listings.filter((row) => row.accountId === account.id)) {
            if (
              !listings.some(
                (listing) =>
                  listing.sku === row.sku &&
                  (listing.locations.some((location) => location.id === row.location) ||
                    (row.skuMappingId === listing.id &&
                      (!row.location || !listing.locations.length))),
              )
            ) {
              row.observed = null;
              row.observedAt = null;
              row.verified = false;
              row.packageAvailable = false;
              row.version++;
            }
          }
          // Retain stale identities so a reused SKU never inherits an older Tally mapping.
          const missing = data.listings
            .filter(
              (row) =>
                row.accountId === account.id &&
                !listings.some((imported) => imported.id === row.id),
            )
            .map((row) => ({
              ...row,
              observedAt: null,
              version: row.version + 1,
              locations: row.locations.map((location) => ({ ...location, quantity: null })),
            }));
          data.listings = [
            ...data.listings.filter((row) => row.accountId !== account.id),
            ...listings,
            ...missing,
          ];
          if (reportedSeller) {
            for (const row of data.listings.filter(
              (row) => row.accountId === account.id && !row.sellerId,
            ))
              row.sellerId = reportedSeller;
          }
          const current = data.accounts.find((row) => row.id === account.id)!;
          current.sellerId = sellerId;
          current.lastRefreshedAt = new Date().toISOString();
          recordActivity(
            state,
            'marketplace-refresh',
            `${account.name}: ${listings.length} listings refreshed from Flipkart.`,
          );
        });
        if (listings.length) this.verifiedAccounts.add(account.id);
      } catch (error) {
        this.store.update((state) => markPackageCountsUnavailable(state, account.id));
        throw error;
      }
    }
    this.verifiedImportErrors.delete(account.id);
    return { account: await this.publicAccount(this.account(account.id)) };
  }

  page(parameters: URLSearchParams): MarketplacePage {
    const account = this.account(parameters.get('accountId'));
    const search = (parameters.get('search') ?? '').trim().toLocaleLowerCase();
    const status = parameters.get('status') ?? '';
    const page = requireWholeNumber(Number(parameters.get('page') ?? '1'), 'Page', 1, 1_000_000);
    const data = this.store.readMarketplace();
    const listings = data.listings.filter(
      (row) =>
        row.accountId === account.id &&
        (!status || status === 'all' || row.status === status) &&
        (!search ||
          `${row.sku} ${row.title} ${row.productId}`.toLocaleLowerCase().includes(search)),
    );
    const state = this.store.read();
    const visible = listings.slice((page - 1) * 20, page * 20);
    const skus = new Set(visible.map((listing) => listing.sku));
    this.describeAutomation(
      state,
      data,
      state.listings.filter((row) => row.accountId === account.id && skus.has(row.sku)),
    );
    return {
      listings: visible.map((row) => listingView(row, state)),
      total: listings.length,
      page,
      pageSize: 20,
      lastRefreshedAt: account.lastRefreshedAt,
      changes: data.changes
        .filter((row) => row.accountId === account.id)
        .filter(
          (row, index) =>
            index < 200 || ['pending', 'sending', 'checking', 'uncertain'].includes(row.state),
        ),
    };
  }

  catalogVerified(accountId: string): boolean {
    return this.mode === 'demo' || this.verifiedAccounts.has(accountId);
  }

  /** Enrich the response from saved observations; displaying a status never polls a source. */
  describeAutomation(
    state: Snapshot,
    market = this.store.readMarketplace(),
    rows = state.listings,
    catalog?: ReturnType<typeof indexAutomationCatalog>,
  ) {
    const companies = new Map(state.companies.map((company) => [company.id, company]));
    const items = new Map(state.items.map((item) => [item.id, item]));
    const trackingIssues = new Map<string, string | null>();
    for (const row of rows) {
      const item = items.get(row.itemId ?? '');
      const company = item && companies.get(item.companyId);
      if (!company) row.automationStatus = 'Not mapped to Tally';
      else if (row.paused) row.automationStatus = 'Paused';
      else if (!company.automation) row.automationStatus = 'Company updates off';
      else {
        try {
          catalog ??= indexAutomationCatalog(market);
          checkAutomationDestination(
            state,
            row,
            catalog,
            this.catalogVerified(row.accountId),
            item,
          );
          const positive = desiredStock(state, row, 'current', undefined, item) > 0;
          if (state.mode === 'live') {
            if (!trackingIssues.has(company.id)) {
              trackingIssues.set(
                company.id,
                this.availability.coverageCommand('/api/billing/coverage', {
                  companyId: company.id,
                  accountId: row.accountId,
                }).issue ?? null,
              );
            }
            const issue = trackingIssues.get(company.id);
            if (positive && issue) throw new InputError(issue);
            if (positive && row.policy === 'limited')
              throw new InputError('Positive Limited sales need verified allowance accounting.');
          }
          const queued = row.syncPendingItemVersion != null || !!row.orderSyncPending;
          const lastBlocker =
            (queued && this.blockedSyncReasons.get(row.id)) ||
            (positive && this.blockedSyncReasons.get('orders:' + company.id));
          row.automationStatus = lastBlocker
            ? 'Last check blocked. ' + lastBlocker
            : queued
              ? 'Queued for a stock check'
              : trackingIssues.get(company.id)
                ? 'Ready for the next Tally change. ' + trackingIssues.get(company.id)
                : 'Ready for the next Tally change or verified sale';
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
          row.automationStatus = 'Waiting. ' + error.message;
        }
      }
    }
  }

  private currentListingView(listing: MarketplaceListing) {
    const state = this.store.read();
    const rows = state.listings.filter(
      (row) => row.accountId === listing.accountId && row.sku === listing.sku,
    );
    this.describeAutomation(state, this.store.readMarketplace(), rows);
    return listingView(listing, state);
  }

  private async verifiedToken(accountId: string): Promise<string | null> {
    if (this.mode === 'demo') return null;
    const account = this.account(accountId);
    if (!this.verifiedAccounts.has(accountId) || !account.lastRefreshedAt)
      throw new InputError(
        'Refresh listings to verify this seller account before applying or checking updates.',
        409,
      );
    return this.connection(accountId).getAccessToken();
  }

  apply(input: Record<string, unknown>) {
    const account = this.account(input.accountId);
    return this.serial(account.id, async () => {
      const result = await this.publisher.apply(
        account.id,
        input,
        await this.verifiedToken(account.id),
      );
      if (result) result.listing = this.currentListingView(result.listing);
      return result;
    });
  }

  private sellerGuard(accountId: string): () => void {
    const revision = this.verificationRevision.get(accountId);
    return () => {
      if (
        this.stopped ||
        (this.mode === 'live' && !this.verifiedAccounts.has(accountId)) ||
        revision !== this.verificationRevision.get(accountId)
      )
        throw new InputError(
          'Seller verification changed during the billing review. Refresh listings and try again.',
          409,
        );
    };
  }

  async billingCommand(path: string, input: Record<string, unknown>) {
    const account = this.account(input.accountId);
    if (path === '/api/billing/coverage' || path === '/api/billing/coverage/start')
      return this.availability.coverageCommand(path, input);
    if (path === '/api/billing/pending' || path === '/api/billing/pending/recheck') {
      return this.serial('stock-evidence:' + requireText(input.companyId, 'Tally company'), () =>
        this.billing.pendingOrders(this.availability, input, account.id, path.endsWith('/recheck')),
      );
    }
    // A long period of order history must not delay an urgent stock correction.
    // Revalidate seller ownership if credentials or catalogue access change meanwhile.
    return this.serial('billing:' + account.id, () =>
      this.billing.command(
        path,
        input,
        () => this.verifiedToken(account.id),
        this.sellerGuard(account.id),
      ),
    );
  }

  availableStock(companyId: string, itemId: string, batch?: object, readOnly = false) {
    return this.serial('stock-evidence:' + companyId, () =>
      this.availability.forItem(companyId, itemId, batch, readOnly),
    );
  }

  async observeAutomationListing(listing: MarketplaceListing) {
    const verify = this.sellerGuard(listing.accountId);
    const token = await this.verifiedToken(listing.accountId);
    const current =
      token === null
        ? listing
        : await this.client.getListing(token, listing, { requireCurrentStatus: true });
    verify();
    if (!sameListingIdentity(listing, current))
      throw new InputError(
        'Flipkart returned a different listing. Refresh the seller account before enabling updates.',
        409,
      );
    return { current, verify };
  }

  checkStockOrders(companyId: string, batch: object): Promise<void> {
    return this.serial('stock-evidence:' + companyId, () =>
      this.availability.checkOrders(companyId, batch),
    );
  }

  onStockOrdersPending(listener: (companyId: string, batch?: object) => void): () => void {
    this.orderListeners.add(listener);
    return () => {
      this.orderListeners.delete(listener);
    };
  }

  async publishInventory(
    intent: InventoryIntent,
    batch?: object,
    verifyReview?: () => void,
  ): Promise<InventoryPublishRow> {
    const state = this.store.read();
    const row = state.listings.find((entry) => entry.id === intent.listingId);
    const identity = { listingId: intent.listingId, sku: row?.sku ?? '' };
    try {
      if (!row) throw new InputError('The listing is no longer mapped.', 409);
      const marketplace = this.store
        .readMarketplace()
        .listings.find((entry) => entry.accountId === row.accountId && entry.sku === row.sku);
      if (!marketplace)
        throw new InputError('Refresh the seller account to locate this listing.', 409);
      // Keep slow order and bill reads off the seller's write queue so an
      // explicit zero or pause can still take effect during reconciliation.
      const protectedStock =
        !intent.draft?.edited &&
        (this.mode === 'live' || this.store.readStockCoverage(intent.companyId)) &&
        desiredStock(state, row) > 0;
      const evidence = protectedStock
        ? await this.availableStock(intent.companyId, row.itemId!, batch)
        : undefined;
      return await this.serial(row.accountId, async () => {
        const verifySeller = this.sellerGuard(row.accountId);
        const token = await this.verifiedToken(row.accountId);
        const { listing, quantity } = inventoryTarget(
          this.store.read(),
          intent,
          marketplace,
          evidence?.available,
        );
        const result = await this.publisher.apply(
          row.accountId,
          {
            listingId: marketplace.id,
            version: marketplace.version,
            edit: { kind: 'stock', locationId: listing.location, quantity, automation: 'once' },
          },
          token,
          intent,
          {
            available: evidence?.available,
            verify: () => {
              verifyReview?.();
              verifySeller();
              evidence?.verify();
            },
          },
        );
        if (!result)
          return {
            ...identity,
            status: 'unchanged',
            message:
              intent.draft?.edited && quantity === 0
                ? 'Stock is already zero. Tally sync paused for this location.'
                : 'The current marketplace quantity already matches.',
          };
        const status =
          result.change.state === 'confirmed' || result.change.state === 'failed'
            ? result.change.state
            : 'uncertain';
        return { ...identity, status, message: result.change.message };
      });
    } catch (error) {
      return {
        ...identity,
        status: 'blocked',
        message:
          error instanceof InputError
            ? error.message
            : 'Could not verify the seller account or listing. Refresh and retry.',
      };
    }
  }

  /** Revisit imported accounts and retry a verified connection's failed first import. */
  async refreshInventoryAccounts(): Promise<boolean> {
    const data = this.store.readMarketplace();
    const accounts = data.accounts.filter(
      (account) => account.lastRefreshedAt || this.verifiedImportErrors.has(account.id),
    );
    let succeeded = true;
    for (const account of accounts) {
      if (this.stopped) break;
      try {
        await this.serial(account.id, async () => {
          // A Save for later or Disconnect may have queued since the schedule was read.
          const current = this.account(account.id);
          if (current.lastRefreshedAt || this.verifiedImportErrors.has(account.id))
            await this.refreshAccount(current);
        });
      } catch {
        succeeded = false;
        this.store.update((state) =>
          recordActivity(
            state,
            'catalog-refresh',
            `${account.name}: could not refresh Flipkart listings. Check the account connection.`,
            { level: 'warning' },
          ),
        );
      }
    }
    return succeeded;
  }

  reconcile(input: Record<string, unknown>) {
    const account = this.account(input.accountId);
    return this.serial(account.id, async () => {
      const result = await this.publisher.reconcile(
        account.id,
        requireText(input.changeId, 'Update'),
        await this.verifiedToken(account.id),
      );
      return { ...result, listing: this.currentListingView(result.listing) };
    });
  }

  recoverStock(input: Record<string, unknown>, action: 'review' | 'approve') {
    const account = this.account(input.accountId);
    const changeId = requireText(input.changeId, 'Update');
    return this.serial(account.id, async () => {
      const verify = this.sellerGuard(account.id);
      const token = await this.verifiedToken(account.id);
      verify();
      if (action === 'review') return this.recovery.review(account.id, changeId, token, verify);
      const result = await this.recovery.approve(
        account.id,
        changeId,
        requireText(input.reviewId, 'Recovery review'),
        token,
        verify,
      );
      return { ...result, listing: this.currentListingView(result.listing) };
    });
  }

  changePolicy(input: Record<string, unknown>): Promise<MarketplaceListingView> {
    const account = this.account(input.accountId);
    return this.serial(account.id, async () => {
      if (input.confirmed !== true || input.policy !== 'auto')
        throw new InputError('Explicitly confirm returning this listing to automatic policy.');
      const updated = this.store.updateMarketplace((data, state) => {
        const listing = findMarketplaceListing(
          data,
          account.id,
          requireText(input.listingId, 'Listing'),
        );
        if (listing.version !== input.version)
          throw new InputError('Refresh the listing before changing its policy.', 409);
        const rows = state.listings.filter(
          (row) =>
            row.accountId === account.id &&
            row.sku === listing.sku &&
            row.location === input.locationId,
        );
        if (!rows.length) throw new InputError('Choose a valid inventory destination.');
        for (const row of rows) {
          // A pending correction belongs to the old restriction. Returning to
          // Auto must wait for its own Tally change or an explicit publication.
          if (row.policy !== 'auto') {
            row.syncPendingItemVersion = null;
            row.orderSyncPending = null;
          }
          row.policy = 'auto';
          row.remaining = null;
          row.version++;
        }
        state.proposals = state.proposals.filter(
          (proposal) => !rows.some((row) => row.id === proposal.listingId),
        );
        listing.version++;
        recordActivity(
          state,
          'marketplace-policy',
          `${listing.sku}: seller explicitly returned the location to automatic policy. Pause retained; marketplace stock unchanged.`,
        );
        return listing;
      });
      return this.currentListingView(updated);
    });
  }

  stop(): void {
    this.stopped = true;
  }
  async idle(): Promise<void> {
    await Promise.all([...this.pending.values()]);
    if (this.stopped) for (const connection of this.connections.values()) connection.stop();
    await Promise.all([...this.connections.values()].map((connection) => connection.idle()));
  }
}
