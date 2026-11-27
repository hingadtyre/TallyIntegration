import type { DatabaseSync } from 'node:sqlite';
import { saleDay } from '../domain/sale-day.js';
import type { Snapshot } from '../shared/contracts.js';
import type { MarketplaceListingStatus } from '../shared/marketplace-contracts.js';
import { sampleLedger } from './billing-sample.js';
import { stockConfiguration } from './stock-configuration.js';
import { readBilling, writeBilling, type BillingData } from './storage/billing-records.js';
import {
  readMarketplace,
  writeMarketplace,
  type MarketplaceData,
} from './storage/marketplace-records.js';
import { readSnapshot, writeSnapshot } from './storage/records.js';
import { writeStockCoverage } from './storage/stock-coverage.js';

const companyId = 'demo-integration';
const sharedTyre = 'demo-integration-tyre';
const winterTyre = 'demo-integration-winter';
const pickup = 'Demo pickup';

interface SampleListing {
  id: string;
  accountId: string;
  title: string;
  productId: string;
  itemId: string | null;
  packageCount: number | null;
  observed: number | null;
  status?: MarketplaceListingStatus;
  manualSize?: number;
  pausedAllowance?: number;
}

function addCompany(
  state: Snapshot,
  market: MarketplaceData,
  billing: BillingData,
  at: string,
): void {
  state.companies.push({
    id: companyId,
    name: 'Sample Tyres · Integration',
    source: 'demo',
    automation: false,
    lastSuccess: at,
  });
  for (const [id, name] of [
    ['demo-retail', 'Sample Retail'],
    ['demo-outlet', 'Sample Outlet'],
  ]) {
    state.accounts.push({ id, name, marketplace: 'flipkart', status: 'demo' });
    market.accounts.push({ id, name, sellerId: `sample-${id}`, lastRefreshedAt: at });
    const ledger = sampleLedger(companyId, id);
    billing.rules.push({
      companyId,
      accountId: id,
      ledgerId: ledger.externalId,
      ledgerName: ledger.name,
      field: 'reference',
      reference: 'orderId',
    });
  }
  const item = {
    companyId,
    brand: 'Sample',
    unit: 'tyres',
    observedAt: at,
    version: 1,
    lowStockThreshold: 5,
  };
  state.items.push(
    {
      ...item,
      id: sharedTyre,
      externalId: sharedTyre,
      name: 'Sample Touring Tyre · 185/65 R15',
      physical: 24,
      keepBackUnits: 2,
    },
    {
      ...item,
      id: winterTyre,
      externalId: winterTyre,
      name: 'Sample Winter Tyre · 205/55 R16',
      physical: 0,
      keepBackUnits: 0,
    },
  );

  const single = {
    title: 'Sample Touring Tyre · Single',
    productId: 'sample-touring-single',
    itemId: sharedTyre,
    packageCount: 1,
  };
  const listings: SampleListing[] = [
    { ...single, id: 'demo-retail-single', accountId: 'demo-retail', observed: 20 },
    { ...single, id: 'demo-outlet-single', accountId: 'demo-outlet', observed: 17 },
    {
      ...single,
      id: 'demo-retail-pair',
      accountId: 'demo-retail',
      title: 'Sample Touring Tyre · Pair',
      productId: 'sample-touring-pair',
      manualSize: 2,
      observed: 12,
    },
    {
      ...single,
      id: 'demo-outlet-limited',
      accountId: 'demo-outlet',
      title: 'Sample Touring Tyre · Limited offer',
      pausedAllowance: 1,
      observed: 1,
    },
    {
      ...single,
      id: 'demo-retail-winter',
      accountId: 'demo-retail',
      title: 'Sample Winter Tyre · Single',
      productId: 'sample-winter-single',
      itemId: winterTyre,
      observed: 0,
      status: 'INACTIVE',
    },
    {
      ...single,
      id: 'demo-retail-unmapped',
      accountId: 'demo-retail',
      title: 'Sample Touring Tyre · Unmapped single',
      itemId: null,
      observed: 3,
    },
    {
      id: 'demo-retail-pickup',
      accountId: 'demo-retail',
      title: 'Sample Touring Tyre · Pickup pending',
      productId: 'sample-touring-pickup',
      itemId: null,
      packageCount: null,
      observed: null,
      status: 'READY_FOR_ACTIVATION',
    },
    {
      id: 'demo-retail-discontinued',
      accountId: 'demo-retail',
      title: 'Sample City Tyre · Discontinued tread',
      productId: 'sample-city-discontinued',
      itemId: null,
      packageCount: null,
      observed: null,
      status: 'ARCHIVED',
    },
    {
      id: 'demo-retail-correction',
      accountId: 'demo-retail',
      title: 'Sample City Tyre · Catalogue correction',
      productId: 'sample-city-correction',
      itemId: null,
      packageCount: null,
      observed: null,
      status: 'INACTIVATED_BY_FLIPKART',
    },
  ];
  for (const row of listings) {
    const remoteId = `sample-${row.id}`;
    const sku = row.id.toUpperCase();
    market.listings.push({
      id: remoteId,
      accountId: row.accountId,
      sellerId: `sample-${row.accountId}`,
      productId: row.productId,
      sku,
      title: row.title,
      imageUrl: null,
      status: row.status ?? 'ACTIVE',
      mrp: row.manualSize === 2 ? 10000 : 5500,
      sellingPrice: row.manualSize === 2 ? 9200 : 4800,
      packageCount: row.packageCount,
      observedAt: at,
      version: 1,
      locations:
        row.observed === null ? [] : [{ id: pickup, quantity: row.observed, status: 'ENABLED' }],
    });
    if (row.status === 'ARCHIVED' || row.status === 'INACTIVATED_BY_FLIPKART') continue;
    state.listings.push({
      id: row.id,
      accountId: row.accountId,
      sku,
      title: row.title,
      location: row.observed === null ? '' : pickup,
      skuMappingId: remoteId,
      itemId: row.itemId,
      packSize: row.itemId ? (row.manualSize ?? row.packageCount) : null,
      packSource: row.itemId ? (row.manualSize ? 'manual' : 'packages') : null,
      packEvidence: row.itemId
        ? 'Sample seller confirmed the units per sale.'
        : 'Set of needs confirmation.',
      packageCount: row.packageCount,
      packageObservedAt: row.packageCount === null ? null : at,
      packageAvailable: row.packageCount !== null,
      packConfirmedAt: row.itemId ? at : null,
      sourceScope: row.itemId ? 'company' : null,
      tyreFloor: false,
      verified: !!row.itemId,
      observed: row.observed,
      observedAt: row.observed === null ? null : at,
      policy: row.pausedAllowance === undefined ? 'auto' : 'limited',
      remaining: row.pausedAllowance ?? null,
      paused: row.pausedAllowance !== undefined,
      version: 1,
    });
  }
}

/** A complete company marks installation. Restart preserves every later seller decision. */
export function installDemoWorkspace(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    const state = readSnapshot(database);
    if (state.mode === 'demo' && !state.companies.some((company) => company.id === companyId)) {
      const market = readMarketplace(database);
      const billing = readBilling(database);
      const at = new Date().toISOString();
      addCompany(state, market, billing, at);
      writeSnapshot(database, state);
      writeMarketplace(database, market);
      writeBilling(database, billing);
      writeStockCoverage(database, {
        companyId,
        from: new Date(saleDay(at) + 'T00:00:00+05:30').toISOString(),
        signature: stockConfiguration(state, market, billing, companyId).signature,
        checkedThrough: null,
        orders: [],
      });
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
