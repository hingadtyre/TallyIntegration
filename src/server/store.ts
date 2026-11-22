import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from '../shared/contracts.js';
import type { StockSyncCoverage } from '../shared/stock-coverage.js';
import { backupDatabase } from './storage/backup.js';
import { readBilling, writeBilling, type BillingData } from './storage/billing-records.js';
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
    change: (market: MarketplaceData, state: Snapshot) => void,
  ): void {
    this.updateMarketplace((market, state) => {
      const listing = state.listings.find((row) => row.id === listingId);
      if (!listing || (listing.itemId && listing.location)) return change(market, state);
      const previous = { ...listing };
      const billing = readBilling(this.database);
      const baselines: StockSyncCoverage[] = [];
      for (const rule of billing.rules.filter((r) => r.accountId === listing.accountId)) {
        const coverage = readStockCoverage(this.database, rule.companyId);
        if (
          coverage &&
          coverage.signature ===
            stockConfiguration(state, market, billing, rule.companyId).signature
        )
          baselines.push(coverage);
      }
      change(market, state);
      if (
        !listing.itemId ||
        (previous.itemId &&
          (previous.itemId !== listing.itemId ||
            previous.packSize !== listing.packSize ||
            previous.packSource !== listing.packSource ||
            previous.sourceScope !== listing.sourceScope))
      )
        return;
      for (const coverage of baselines) {
        const ctx = stockConfiguration(state, market, billing, coverage.companyId);
        coverage.signature = ctx.signature;
        let newlyBound = false;
        for (const entry of coverage.orders) {
          const o = entry.order;
          if (
            entry.accountId !== listing.accountId ||
            o.sku !== listing.sku ||
            o.locationId !== listing.location ||
            mappedSaleItem(ctx, entry.accountId, o) !== listing.itemId
          )
            continue;
          o.firstSeenUnmapped = true;
          if (
            o.stockDisposition ||
            o.stockIdentityConflict ||
            o.eligibilityUnverified ||
            o.stockReconciliationRequired
          )
            continue;
          o.stockSyncQueued = true;
          newlyBound = true;
        }
        if (
          newlyBound &&
          ctx.company.automation &&
          ctx.items.get(listing.itemId)?.companyId === coverage.companyId
        ) {
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

  updateBilling(change: (data: BillingData) => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const data = readBilling(this.database);
      change(data);
      writeBilling(this.database, data);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
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
