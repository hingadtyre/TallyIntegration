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
    companyName: string;
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

export type MarketplaceEdit =
  | { kind: 'stock'; locationId: string; quantity: number; automation: 'once' | 'pause' }
  | { kind: 'price'; field: 'mrp' | 'sellingPrice'; value: number };

export interface MarketplaceApplyInput {
  accountId: string;
  listingId: string;
  version: number;
  edit: MarketplaceEdit;
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
