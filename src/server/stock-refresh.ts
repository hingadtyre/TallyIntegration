import type { TallyCompany, TallyStockItem } from '../adapters/tally.js';
import type { Snapshot } from '../shared/contracts.js';
import { recordActivity } from './activity.js';
import type { Diagnostics } from './diagnostics.js';
import type { Store } from './store.js';

export interface TallyReader {
  listCompanies(): Promise<TallyCompany[]>;
  readStock(company: TallyCompany): Promise<TallyStockItem[]>;
}
export type TallyReaderFactory = (endpoint: string) => TallyReader;
interface CompanyObservation {
  company: TallyCompany;
  items: TallyStockItem[];
}

function mergeObservations(
  state: Snapshot,
  discovered: TallyCompany[],
  observations: CompanyObservation[],
  at: string,
): void {
  const loadedIds = new Set(discovered.map((row) => `tally:${row.externalId}`));
  for (const company of state.companies.filter(
    (row) => row.source === 'tally' && !loadedIds.has(row.id),
  )) {
    company.lastSuccess = null;
    for (const item of state.items.filter((row) => row.companyId === company.id)) {
      if (item.observedAt !== null) item.version++;
      item.observedAt = null;
    }
  }
  for (const observation of observations) {
    const companyId = `tally:${observation.company.externalId}`;
    const company = state.companies.find((row) => row.id === companyId);
    if (company) {
      company.name = observation.company.name;
      company.lastSuccess = at;
    } else
      state.companies.push({
        id: companyId,
        name: observation.company.name,
        source: 'tally',
        automation: false,
        lastSuccess: at,
      });

    const seenIds = new Set<string>();
    for (const incoming of observation.items) {
      const itemId = `${companyId}:${incoming.externalId}`;
      if (seenIds.has(itemId)) throw new Error('Duplicate Tally stock identity.');
      seenIds.add(itemId);
      const existing = state.items.find((row) => row.id === itemId);
      if (existing) {
        if (
          existing.name !== incoming.name ||
          existing.unit !== incoming.unit ||
          existing.physical !== incoming.physical
        )
          existing.version++;
        Object.assign(existing, incoming, { observedAt: at });
      } else {
        state.items.push({
          ...incoming,
          id: itemId,
          companyId,
          brand: '',
          observedAt: at,
          version: 1,
          lowStockThreshold: 5,
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
}

/** Reads external observations, then applies one complete verified snapshot atomically. */
export class StockRefresh {
  constructor(
    private readonly store: Store,
    private readonly createReader: TallyReaderFactory,
    private readonly diagnostics: Diagnostics,
  ) {}

  async run(companyId?: string): Promise<boolean> {
    const startedAt = Date.now();
    const initial = this.store.read();
    if (initial.mode === 'demo') {
      this.store.update((state) => {
        state.connection.lastChecked = new Date().toISOString();
        state.connection.message = 'Sample observations retained. No Tally or marketplace calls.';
        recordActivity(state, 'refresh', 'Sample data refreshed. No external calls.');
      });
      return true;
    }

    try {
      const reader = this.createReader(initial.settings.tallyUrl);
      const discovered = await reader.listCompanies();
      const targets =
        companyId === undefined
          ? discovered
          : discovered.filter((row) => `tally:${row.externalId}` === companyId);
      if (companyId !== undefined && targets.length === 0)
        throw new Error('The selected company is not currently loaded in Tally.');
      const observations: CompanyObservation[] = [];
      for (const company of targets)
        observations.push({ company, items: await reader.readStock(company) });
      this.store.update((state) => {
        if (state.settings.tallyUrl !== initial.settings.tallyUrl)
          throw new Error('Tally address changed during refresh. Try again.');
        const at = new Date().toISOString();
        mergeObservations(state, discovered, observations, at);
        state.connection = {
          tally: 'online',
          message: `${observations.length} company snapshots refreshed. Marketplace API setup is still pending.`,
          lastChecked: at,
          nextPoll: null,
        };
        const itemCount = observations.reduce(
          (count, observation) => count + observation.items.length,
          0,
        );
        recordActivity(
          state,
          'tally-refresh',
          `Read ${observations.length} companies and ${itemCount} stock items. No source writes.`,
        );
      });
      this.diagnostics.write('tally-refresh', `Completed in ${Date.now() - startedAt} ms`);
      return true;
    } catch (error) {
      this.store.update((state) => {
        state.connection = {
          tally: 'offline',
          message:
            'Tally could not provide a verified snapshot. Check that Tally is open, its HTTP server is enabled, and the intended company is loaded. Previous observations are retained.',
          lastChecked: new Date().toISOString(),
          nextPoll: null,
        };
        recordActivity(
          state,
          'tally-refresh',
          'Refresh failed or returned unverified data. Previous stock retained; proposals require fresh verification.',
          { level: 'warning' },
        );
      });
      this.diagnostics.error('tally-refresh', error);
      return false;
    }
  }
}
