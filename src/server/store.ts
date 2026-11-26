import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../shared/contracts.js';
import type { BillingFulfilment } from '../shared/billing-contracts.js';
import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';
import {
  isVerifiedCancellation,
  isVerifiedSale,
  type StockSyncCoverage,
} from '../shared/stock-coverage.js';
import { backupDatabase } from './storage/backup.js';
import { readBilling, writeBilling, type BillingData } from './storage/billing-records.js';
import { readBillingOrders, saveBillingOrderObservations } from './storage/billing-orders.js';
import { prepareDatabase } from './storage/migrations.js';
import {
  readMarketplace,
  writeMarketplace,
  type MarketplaceData,
} from './storage/marketplace-records.js';
import { readSnapshot, writeSnapshot } from './storage/records.js';
import { CURRENT_SCHEMA_VERSION } from './storage/schema.js';
import { readStockCoverage, writeStockCoverage } from './storage/stock-coverage.js';
import { mappedSaleItem, stockConfiguration } from './stock-configuration.js';
import { invalidateReservationDrafts } from './proposals.js';

/** SQLite owns records and transactions; callers receive a detached read model. */
export class Store {
  readonly schemaVersion = CURRENT_SCHEMA_VERSION;
  readonly migrationBackupPath: string | null;
  private readonly database: DatabaseSync;

  constructor(
    readonly file: string,
    private readonly mode: Snapshot['mode'],
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.migrationBackupPath = prepareDatabase(this.database, file, mode);
      this.database.exec('PRAGMA journal_mode = WAL;');
      this.update((state) => {
        state.connection.nextPoll = null;
        if (mode === 'live') {
          state.connection.tally = 'not-checked';
          state.connection.message = 'Fresh Tally verification required after startup.';
          for (const company of state.companies) company.stockIssue = 'not-checked';
        }
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  read(): Snapshot {
    this.database.exec('BEGIN');
    try {
      const state = readSnapshot(this.database);
      this.database.exec('COMMIT');
      return state;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  update<T>(change: (state: Snapshot) => T): T {
    // Lock before reading so another Store cannot overwrite a newer commit
    // using an old in-memory snapshot.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const state = readSnapshot(this.database);
      const result = change(state);
      if (state.mode !== this.mode)
        throw new Error('The workspace mode cannot be changed after creation.');
      writeSnapshot(this.database, state);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  readMarketplace(): MarketplaceData {
    this.database.exec('BEGIN');
    try {
      const market = readMarketplace(this.database);
      this.database.exec('COMMIT');
      return market;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Persist the outbound intention and any Inventory pause in one commit. */
  updateMarketplace<T>(change: (market: MarketplaceData, state: Snapshot) => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const state = readSnapshot(this.database);
      const market = readMarketplace(this.database);
      const result = change(market, state);
      if (state.mode !== this.mode)
        throw new Error('The workspace mode cannot be changed after creation.');
      writeSnapshot(this.database, state);
      writeMarketplace(this.database, market);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  backup(target: string): void {
    backupDatabase(this.database, target);
  }

  /** Extend an already confirmed company's evidence only for a first mapping.
   * The mapping, original baseline, retained orders and pending sibling checks
   * commit together. Existing conversions and stale baselines require review. */
  updateMapping(
    listingId: unknown,
    change: (
      market: MarketplaceData,
      state: Snapshot,
      baselines: { coverage: StockSyncCoverage; current: boolean }[],
    ) => void,
  ): void {
    this.updateMarketplace((market, state) => {
      const listing = state.listings.find((row) => row.id === listingId);
      if (!listing || (listing.itemId && listing.location)) return change(market, state, []);
      const previous = { ...listing };
      const billing = readBilling(this.database);
      const baselines: { coverage: StockSyncCoverage; current: boolean }[] = [];
      for (const rule of billing.rules.filter((r) => r.accountId === listing.accountId)) {
        const coverage = readStockCoverage(this.database, rule.companyId);
        if (coverage)
          baselines.push({
            coverage,
            current:
              coverage.signature ===
              stockConfiguration(state, market, billing, rule.companyId).signature,
          });
      }
      change(market, state, baselines);
      if (
        !listing.itemId ||
        (previous.itemId &&
          (previous.itemId !== listing.itemId ||
            previous.packSize !== listing.packSize ||
            previous.packSource !== listing.packSource ||
            previous.sourceScope !== listing.sourceScope))
      )
        return;
      for (const { coverage, current } of baselines) {
        const ctx = stockConfiguration(state, market, billing, coverage.companyId);
        let newlyBound = false;
        const orders = coverage.orders.filter(
          ({ accountId, order }) =>
            accountId === listing.accountId &&
            order.sku === listing.sku &&
            order.locationId === listing.location &&
            mappedSaleItem(ctx, accountId, order) === listing.itemId,
        );
        const inCompany = ctx.items.get(listing.itemId)?.companyId === coverage.companyId;
        if (inCompany && orders.length) {
          invalidateReservationDrafts(state, new Set([listing.itemId]));
          if (orders.some(({ order }) => !isVerifiedCancellation(order)))
            listing.orderProposalPending = true;
        }
        // A waiting order can request a local calculation, but only a current
        // baseline can extend its mapping evidence or authorize order-based sync.
        if (!current) continue;
        coverage.signature = ctx.signature;
        for (const { order: o } of orders) {
          o.firstSeenUnmapped = true;
          if (!isVerifiedSale(o)) continue;
          o.stockSyncQueued = true;
          newlyBound = true;
        }
        if (newlyBound && ctx.company.automation && inCompany) {
          const token = randomUUID();
          for (const sibling of state.listings)
            if (sibling.itemId === listing.itemId && sibling.verified && !sibling.paused)
              sibling.orderSyncPending = token;
        }
        writeStockCoverage(this.database, coverage);
      }
    });
  }

  readBilling(): BillingData {
    this.database.exec('BEGIN');
    try {
      const result = readBilling(this.database);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  readBillingOrders(
    companyId: string,
    accountId: string,
    from: string,
    to: string,
    orderItemId?: string,
  ) {
    return readBillingOrders(this.database, companyId, accountId, from, to, orderItemId);
  }

  saveBillingOrders(
    companyId: string,
    accountId: string,
    group: BillingFulfilment,
    orders: FlipkartBillingOrder[],
  ): void {
    this.saveBillingOrderObservations(
      companyId,
      accountId,
      orders.map((order) => ({ group, order })),
    );
  }

  saveBillingOrderObservations(
    companyId: string,
    accountId: string,
    observations: { group: BillingFulfilment; order: FlipkartBillingOrder }[],
  ): void {
    saveBillingOrderObservations(this.database, companyId, accountId, observations);
  }

  updateBilling(change: (data: BillingData, state: Snapshot) => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const data = readBilling(this.database);
      const state = readSnapshot(this.database);
      change(data, state);
      writeBilling(this.database, data);
      writeSnapshot(this.database, state);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  readStockTrackingStart(companyId: string): string | undefined {
    const row = this.database
      .prepare('SELECT from_at FROM stock_coverage WHERE company_id = ?')
      .get(companyId);
    return row && String(row.from_at);
  }

  readBillingTrackingStart(companyId: string): string | undefined {
    const stockFrom = this.readStockTrackingStart(companyId);
    if (stockFrom) return stockFrom;
    const row = this.database
      .prepare('SELECT from_at FROM billing_tracking_dates WHERE company_id = ?')
      .get(companyId);
    return row && String(row.from_at);
  }

  saveBillingTrackingStart(companyId: string, from: string): void {
    this.database
      .prepare(
        'INSERT INTO billing_tracking_dates(company_id, from_at) VALUES (?, ?) ON CONFLICT(company_id) DO UPDATE SET from_at = excluded.from_at',
      )
      .run(companyId, from);
  }

  readStockCoverage(companyId: string): StockSyncCoverage | null {
    this.database.exec('BEGIN');
    try {
      const result = readStockCoverage(this.database, companyId);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  saveStockCoverage(record: StockSyncCoverage, queue?: (state: Snapshot) => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      writeStockCoverage(this.database, record);
      if (queue) {
        const state = readSnapshot(this.database);
        queue(state);
        if (state.mode !== this.mode) throw new Error('The workspace mode cannot be changed.');
        writeSnapshot(this.database, state);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
