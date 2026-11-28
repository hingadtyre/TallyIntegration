import { validateTallyUrl, type TallyCompany, type TallyStockItem } from '../adapters/tally.js';
import type { Company, Snapshot } from '../shared/contracts.js';
import { recordActivity } from './activity.js';
import type { Diagnostics } from './diagnostics.js';
import type { Store } from './store.js';

export interface TallyReader {
  listCompanies(): Promise<TallyCompany[]>;
  readStock(company: TallyCompany): Promise<TallyStockItem[]>;
}
export type TallyReaderFactory = (endpoint: string) => TallyReader;
function mergeStock(state: Snapshot, company: Company, items: TallyStockItem[], at: string): void {
  const companyId = company.id;
  company.lastSuccess = at;
  delete company.stockIssue;
  const seenIds = new Set<string>();
  for (const incoming of items) {
    const itemId = `${companyId}:${incoming.externalId}`;
    seenIds.add(itemId);
    const existing = state.items.find((row) => row.id === itemId);
    if (existing) {
      const balanceChanged = existing.physical !== incoming.physical;
      const unitChanged = existing.unit !== incoming.unit;
      const metadataChanged = unitChanged || existing.name !== incoming.name;
      const availableAgain = existing.observedAt === null;
      if (unitChanged && existing.keepBackUnits > 0)
        existing.keepBackPreviousUnit ??= existing.unit;
      if (balanceChanged || metadataChanged) existing.version++;
      Object.assign(existing, incoming, { observedAt: at });
      if (balanceChanged || metadataChanged || availableAgain) {
        for (const listing of state.listings.filter((row) => row.itemId === itemId)) {
          if (unitChanged) {
            listing.verified = false;
            listing.syncPendingItemVersion = null;
            listing.orderSyncPending = null;
            listing.version++;
            listing.packEvidence = 'Tally base unit changed. Review the mapping and Set of.';
          } else if (
            incoming.physical !== null &&
            (balanceChanged || listing.syncPendingItemVersion != null) &&
            company.automation &&
            !listing.paused &&
            listing.verified
          ) {
            listing.syncPendingItemVersion = existing.version;
          }
        }
      }
    } else {
      state.items.push({
        ...incoming,
        id: itemId,
        companyId,
        brand: '',
        observedAt: at,
        version: 1,
        lowStockThreshold: 5,
        keepBackUnits: 0,
      });
    }
  }
  for (const missing of state.items.filter(
    (row) => row.companyId === companyId && !seenIds.has(row.id),
  )) {
    if (missing.physical !== null) missing.version++;
    missing.physical = null;
    missing.observedAt = null;
  }
}

/** Only a complete read of a company can replace its saved stock. */
export class StockRefresh {
  private endpointRevision = 0;

  constructor(
    private readonly store: Store,
    private readonly createReader: TallyReaderFactory,
    private readonly diagnostics: Diagnostics,
  ) {}

  sourceChanged(): void {
    this.endpointRevision++;
  }

  async run(companyId?: string): Promise<boolean> {
    const startedAt = Date.now();
    const initial = this.store.read();
    if (initial.mode === 'demo') {
      this.store.update((state) => {
        const at = new Date().toISOString();
        const demoCompanies = state.companies.filter((company) => company.source === 'demo');
        const demoCompanyIds = new Set(demoCompanies.map((company) => company.id));
        // An offline restore invalidates observations; explicit sample refresh can
        // revalidate those local fixtures without inventing a real source read.
        for (const company of demoCompanies) {
          company.lastSuccess ??= at;
          delete company.stockIssue;
        }
        for (const item of state.items) {
          if (demoCompanyIds.has(item.companyId)) item.observedAt ??= at;
        }
        state.connection.lastChecked = at;
        state.connection.message = 'Sample observations retained. No Tally or marketplace calls.';
        recordActivity(state, 'refresh', 'Sample data refreshed. No external calls.');
      });
      return true;
    }

    const revision = this.endpointRevision;
    const endpoint = initial.settings.tallyUrl;
    const save = (change: (state: Snapshot) => void) =>
      this.store.update((state) => {
        // The seller may change the address and even switch back during a slow read.
        if (
          revision !== this.endpointRevision ||
          (state.settings.tallyUrl !== endpoint &&
            validateTallyUrl(state.settings.tallyUrl) !== validateTallyUrl(endpoint))
        )
          return false;
        change(state);
        return true;
      });
    let reader: TallyReader;
    let discovered: TallyCompany[];
    try {
      reader = this.createReader(endpoint);
      discovered = await reader.listCompanies();
    } catch (error) {
      this.diagnostics.error('tally-refresh', error);
      save((state) => {
        for (const company of state.companies) {
          if (company.source === 'tally') company.stockIssue = 'read-failed';
        }
        state.connection = {
          tally: 'offline',
          message:
            'Could not discover Tally companies. Open Tally, load your company and check the connection address. Any previously saved stock is retained.',
          lastChecked: new Date().toISOString(),
          nextPoll: state.connection.nextPoll,
        };
        recordActivity(state, 'tally-refresh', state.connection.message, { level: 'warning' });
      });
      return false;
    }

    const loadedIds = new Set(discovered.map((row) => `tally:${row.externalId}`));
    const unavailable: string[] = [];
    const connected = save((state) => {
      for (const company of state.companies) {
        if (company.source !== 'tally' || loadedIds.has(company.id)) continue;
        company.stockIssue = 'unloaded';
        for (const item of state.items.filter((row) => row.companyId === company.id)) {
          if (item.observedAt !== null) item.version++;
          item.observedAt = null;
        }
        if (!companyId || company.id === companyId) unavailable.push(company.name);
      }
      state.connection = {
        tally: 'online',
        message: 'Connected to Tally. Checking company stock.',
        lastChecked: new Date().toISOString(),
        nextPoll: state.connection.nextPoll,
      };
    });
    if (!connected) return false;

    let refreshed = 0;
    const failed: string[] = [];
    for (const discoveredCompany of discovered) {
      const id = `tally:${discoveredCompany.externalId}`;
      if (companyId && id !== companyId) continue;
      let stock: TallyStockItem[] | undefined;
      try {
        const items = await reader.readStock(discoveredCompany);
        if (new Set(items.map((item) => item.externalId)).size !== items.length)
          throw new Error('Duplicate Tally stock identity.');
        stock = items;
      } catch (error) {
        this.diagnostics.error('tally-refresh', error);
      }
      // An independent order poll or seller action can run during the next company's read.
      // Make both new balances and failures visible before yielding to that read.
      const recorded = save((state) => {
        let company = state.companies.find((row) => row.id === id);
        if (!company) {
          company = {
            id,
            name: discoveredCompany.name,
            source: 'tally',
            automation: false,
            lastSuccess: null,
          };
          state.companies.push(company);
        }
        company.name = discoveredCompany.name;
        if (stock) {
          mergeStock(state, company, stock, new Date().toISOString());
          refreshed++;
        } else {
          company.stockIssue = 'read-failed';
          failed.push(company.name);
        }
      });
      if (!recorded) return false;
    }

    const messages = [
      `Refreshed stock for ${refreshed} ${refreshed === 1 ? 'company' : 'companies'}.`,
    ];
    if (!discovered.length) messages.push('No companies are loaded in Tally.');
    if (failed.length) messages.push(`Stock read failed for ${failed.join(', ')}.`);
    if (unavailable.length) messages.push(`Unloaded in Tally: ${unavailable.join(', ')}.`);
    const completed = save((state) => {
      state.connection.message = messages.join(' ');
      state.connection.lastChecked = new Date().toISOString();
      recordActivity(state, 'tally-refresh', state.connection.message, {
        companyId,
        level: failed.length || unavailable.length ? 'warning' : 'info',
      });
    });
    this.diagnostics.write('tally-refresh', `Completed in ${Date.now() - startedAt} ms`);
    // A healthy company continues on its configured schedule even if a peer fails.
    return completed && (refreshed > 0 || (!failed.length && !unavailable.length));
  }
}
