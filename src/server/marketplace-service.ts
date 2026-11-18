import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FlipkartListingsClient } from '../adapters/flipkart-listings.js';
import type { FlipkartConnectionStatus } from '../shared/contracts.js';
import type {
  MarketplaceAccount,
  MarketplaceAccountRecord,
  MarketplaceListingView,
  MarketplacePage,
} from '../shared/marketplace-contracts.js';
import { recordActivity } from './activity.js';
import { FlipkartConnection } from './flipkart-connection.js';
import {
  findMarketplaceListing,
  listingView,
  seedSampleMarketplace,
  updateInventoryObservations,
} from './marketplace-catalog.js';
import { MarketplacePublication, type ListingTransport } from './marketplace-publication.js';
import type { Store } from './store.js';
import { InputError, requireText, requireWholeNumber } from './validation.js';

export type AccountConnection = Pick<
  FlipkartConnection,
  'status' | 'save' | 'connect' | 'check' | 'disconnect' | 'getAccessToken' | 'stop' | 'idle'
>;
interface MarketplaceDependencies {
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
  private readonly connections = new Map<string, AccountConnection>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly verifiedAccounts = new Set<string>();
  private readonly client: ListingTransport;
  private readonly publisher: MarketplacePublication;
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
    if (dependencies.legacyConnection)
      this.connections.set('flipkart-primary', dependencies.legacyConnection);
    store.updateMarketplace((data, state) => {
      seedSampleMarketplace(data, state);
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
    if (connection.state === 'verified' && this.verifiedAccounts.has(account.id))
      connection.message =
        'API access and seller identity verified. Listings are available in this account.';
    return {
      ...account,
      marketplace: 'flipkart',
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
    return this.serial('account-directory', async () => {
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
  }

  invalidate(accountId: string): void {
    this.verifiedAccounts.delete(accountId);
  }

  runLegacyCommand(operation: () => Promise<unknown>): Promise<unknown> {
    return this.serial('flipkart-primary', async () => {
      this.invalidate('flipkart-primary');
      try {
        return await operation();
      } finally {
        this.store.updateMarketplace((data) => {
          const account = data.accounts.find((row) => row.id === 'flipkart-primary');
          if (account) account.lastRefreshedAt = null;
        });
      }
    });
  }

  async changeConnection(input: Record<string, unknown>): Promise<MarketplaceAccount> {
    const account = this.account(input.accountId);
    return this.serial(account.id, async () => {
      if (this.mode === 'demo')
        throw new InputError('Sample accounts do not use seller credentials.', 409);
      const connection = this.connection(account.id);
      this.invalidate(account.id);
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
      return this.publicAccount(this.account(account.id));
    });
  }

  async refresh(accountId: unknown): Promise<{ account: MarketplaceAccount }> {
    const id = this.account(accountId).id;
    return this.serial(id, async () => {
      const account = this.account(id);
      if (this.mode === 'demo') {
        this.store.updateMarketplace((data) => {
          data.accounts.find((row) => row.id === account.id)!.lastRefreshedAt =
            new Date().toISOString();
          for (const listing of data.listings.filter((row) => row.accountId === account.id))
            listing.observedAt = new Date().toISOString();
        });
      } else {
        this.invalidate(account.id);
        const token = await this.connection(account.id).getAccessToken();
        const listings = await this.client.listListings(token, account.id);
        const sellers = new Set(listings.map((row) => row.sellerId));
        if (sellers.size > 1 || listings.some((row) => row.accountId !== account.id))
          throw new InputError(
            'Flipkart returned inconsistent seller identity. No listings were imported.',
            409,
          );
        const sellerId = listings[0]?.sellerId ?? account.sellerId;
        if (account.sellerId && sellerId !== account.sellerId)
          throw new InputError(
            'These credentials belong to a different seller. Reconnect the original seller or add a separate account.',
            409,
          );
        this.store.updateMarketplace((data, state) => {
          const bound = data.accounts.find((row) => row.id === account.id)!;
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
            updateInventoryObservations(state, listing);
          }
          for (const row of state.listings.filter((row) => row.accountId === account.id)) {
            if (
              !listings.some(
                (listing) =>
                  listing.sku === row.sku &&
                  listing.locations.some((location) => location.id === row.location),
              )
            ) {
              row.observed = null;
              row.observedAt = null;
              row.verified = false;
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
          const current = data.accounts.find((row) => row.id === account.id)!;
          current.sellerId = sellerId;
          current.lastRefreshedAt = new Date().toISOString();
          recordActivity(
            state,
            'marketplace-refresh',
            `${account.name}: ${listings.length} listings refreshed from Flipkart.`,
          );
        });
        if (listings.length && sellerId) this.verifiedAccounts.add(account.id);
      }
      return { account: await this.publicAccount(this.account(account.id)) };
    });
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
    return {
      listings: listings.slice((page - 1) * 20, page * 20).map((row) => listingView(row, state)),
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

  private async verifiedToken(accountId: string): Promise<string | null> {
    if (this.mode === 'demo') return null;
    const account = this.account(accountId);
    if (!this.verifiedAccounts.has(accountId) || !account.sellerId || !account.lastRefreshedAt)
      throw new InputError(
        'Refresh listings to verify this seller account before applying or checking updates.',
        409,
      );
    return this.connection(accountId).getAccessToken();
  }

  apply(input: Record<string, unknown>) {
    const account = this.account(input.accountId);
    return this.serial(account.id, async () =>
      this.publisher.apply(account.id, input, await this.verifiedToken(account.id)),
    );
  }

  reconcile(input: Record<string, unknown>) {
    const account = this.account(input.accountId);
    return this.serial(account.id, async () =>
      this.publisher.reconcile(
        account.id,
        requireText(input.changeId, 'Update'),
        await this.verifiedToken(account.id),
      ),
    );
  }

  changePolicy(input: Record<string, unknown>): Promise<MarketplaceListingView> {
    const account = this.account(input.accountId);
    return this.serial(account.id, async () => {
      if (input.confirmed !== true || input.policy !== 'auto')
        throw new InputError('Explicitly confirm returning this listing to automatic policy.');
      return this.store.updateMarketplace((data, state) => {
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
        return listingView(listing, state);
      });
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
