import type { FlipkartConnectionStatus, PolicyMode } from './contracts.js';

export type MarketplaceListingStatus =
  'ACTIVE' | 'INACTIVE' | 'READY_FOR_ACTIVATION' | 'ARCHIVED' | 'INACTIVATED_BY_FLIPKART';

export interface MarketplaceAccountRecord {
  id: string;
  name: string;
  sellerId: string | null;
  lastRefreshedAt: string | null;
}

export interface MarketplaceAccount extends MarketplaceAccountRecord {
  catalogOwnershipVerified?: boolean;
  catalogImportError?: string;
  marketplace: 'flipkart';
  connection: FlipkartConnectionStatus;
}

export interface MarketplaceLocation {
  id: string;
  quantity: number | null;
  status: string;
}

/** Marketplace observations are independent of Tally mappings. */
export interface MarketplaceListing {
  id: string;
  accountId: string;
  sellerId: string | null;
  productId: string;
  sku: string;
  title: string;
  imageUrl: string | null;
  status: MarketplaceListingStatus;
  mrp: number | null;
  sellingPrice: number | null;
  packageCount?: number | null;
  locations: MarketplaceLocation[];
  observedAt: string | null;
  version: number;
}

export interface MarketplaceListingView extends MarketplaceListing {
  stockPolicies: Array<{
    locationId: string;
    listingId: string;
    listingVersion?: number;
    companyId?: string;
    companyName: string;
    automationStatus?: string;
    proposalIssue?: string;
    policy: PolicyMode;
    remaining: number | null;
    paused: boolean;
  }>;
}

export interface MarketplacePage {
  listings: MarketplaceListingView[];
  total: number;
  page: number;
  pageSize: number;
  lastRefreshedAt: string | null;
  changes: MarketplaceChange[];
}

type StockEdit = { kind: 'stock'; locationId: string; quantity: number };
type PriceEdit = { kind: 'price'; field: 'mrp' | 'sellingPrice'; value: number };
type StockEditAutomation = 'once' | 'pause';

/** History records the effect on Tally sync that the server actually applied. */
export type MarketplaceEdit = (StockEdit & { automation: StockEditAutomation }) | PriceEdit;

export interface MarketplaceApplyInput {
  accountId: string;
  listingId: string;
  version: number;
  /** Older clients included an automation preference on direct stock edits. */
  edit: (StockEdit & { automation?: StockEditAutomation }) | PriceEdit;
}

export interface MarketplaceChange {
  id: string;
  accountId: string;
  listingId: string;
  sku: string;
  edit: MarketplaceEdit;
  state: 'pending' | 'sending' | 'checking' | 'confirmed' | 'failed' | 'uncertain' | 'reconciled';
  /** Durable proof about this particular stock request, independent of observed quantity. */
  stockRequestFinality?: 'not-sent' | 'completed';
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceApplyResult {
  change: MarketplaceChange;
  listing: MarketplaceListingView;
}
