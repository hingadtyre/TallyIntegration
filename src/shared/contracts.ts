import type { MarketplaceKeepBackReview } from './marketplace-contracts.js';

export type PolicyMode = 'auto' | 'limited';
export interface Company {
  id: string;
  name: string;
  automation: boolean;
  source: 'tally' | 'demo';
  lastSuccess: string | null;
  stockIssue?: 'read-failed' | 'unloaded' | 'not-checked';
}
export interface StockItem {
  id: string;
  companyId: string;
  externalId: string;
  name: string;
  brand: string;
  unit: string;
  physical: number | null;
  observedAt: string | null;
  version: number;
  lowStockThreshold: number;
  /** Tally base units the seller keeps out of calculated marketplace stock. */
  keepBackUnits: number;
}
export interface SellerAccount {
  id: string;
  marketplace: 'flipkart';
  name: string;
  status: 'not-connected' | 'demo';
}
/** Token issuance is not verification of seller identity, listings or publication access. */
export interface FlipkartConnectionStatus {
  state: 'not-configured' | 'verified' | 'needs-attention' | 'unavailable';
  checkedAt: string | null;
  expiresAt: string | null;
  applicationIdHint: string | null;
  message: string;
}
export interface Listing {
  /** Read-only identifiers from this destination's last successful catalogue import. */
  productId?: string;
  marketplaceListingId?: string;
  /** Read-only status of automatic publication for this destination. */
  automationStatus?: string;
  /** Reason the last calculation after Resume could not supply a proposed quantity. */
  proposalIssue?: string;
  /** A Tally balance change still awaiting dispatch for this destination. */
  syncPendingItemVersion?: number | null;
  /** A verified order queued a decrease check for this shared stock item. */
  orderSyncPending?: string | null;
  id: string;
  accountId: string;
  sku: string;
  title: string;
  location: string;
  /** Marketplace identity for a mapping created before Flipkart supplied a location. */
  skuMappingId?: string;
  pickupChoices?: string[];
  itemId: string | null;
  packSize: number | null;
  packEvidence: string;
  packSource?: 'packages' | 'manual' | null;
  packageCount?: number | null;
  packageObservedAt?: string | null;
  packageAvailable?: boolean;
  packConfirmedAt?: string | null;
  sourceScope?: 'company' | null;
  tyreFloor?: boolean;
  verified: boolean;
  observed: number | null;
  observedAt: string | null;
  policy: PolicyMode;
  remaining: number | null;
  paused: boolean;
  version: number;
}
export interface Proposal {
  listingId: string;
  quantity: number;
  calculated: number;
  edited: boolean;
  itemVersion: number;
  listingVersion: number;
  ruleVersion: string;
  createdAt: string;
  stale: boolean;
}
export interface CalculationRow {
  listingId: string;
  status: 'ready' | 'preserved' | 'blocked';
  reason?: string;
  fix?: 'pack';
}
/** Per-row results belong only to the Calculate command that requested them. */
export interface CalculationResult extends Snapshot {
  calculation: CalculationRow[];
}
export interface Activity {
  id: string;
  at: string;
  level: 'info' | 'warning' | 'error';
  operation: string;
  message: string;
  companyId?: string;
  listingId?: string;
}
export interface Settings {
  tallyUrl: string;
  tallySeconds: number;
  marketplaceSeconds: number;
  catalogSeconds: number;
  backupFolder: string;
}
export interface ConnectionStatus {
  tally: 'not-checked' | 'online' | 'offline';
  message: string;
  lastChecked: string | null;
  nextPoll: string | null;
}
export interface Snapshot {
  mode: 'live' | 'demo';
  publishingEnabled: boolean;
  companies: Company[];
  items: StockItem[];
  accounts: SellerAccount[];
  listings: Listing[];
  proposals: Proposal[];
  activity: Activity[];
  settings: Settings;
  connection: ConnectionStatus;
}
export interface ReviewRow {
  keepBackWarning?: MarketplaceKeepBackReview;
  /** Whether the destination was paused when the seller opened this review. */
  paused?: boolean;
  /** Present for positive manual edits, including null when Update once is eligible. */
  oneTimeProblem?: string | null;
  listingId: string;
  sku: string;
  account: string;
  location: string;
  quantity: number | null;
  observed: number | null;
  policy: string;
  stale: boolean;
  problem: string | null;
}
export interface Review {
  id: string;
  companyId: string;
  createdAt: string;
  rows: ReviewRow[];
  publishingEnabled: boolean;
}
export interface InventoryPublishRow {
  listingId: string;
  sku: string;
  status: 'confirmed' | 'unchanged' | 'blocked' | 'failed' | 'uncertain';
  message: string;
  /** A changed calculated quantity saved for a fresh, listing-scoped review. */
  latestQuantity?: number;
}
export interface InventoryPublishResult {
  rows: InventoryPublishRow[];
}
export interface MappingInput {
  listingId: string;
  pickupLocation?: string;
  itemId: string;
  orderSource?: { companyId: string; accountId: string; listingId: string; locationId: string };
  keepPaused?: boolean;
  expectedUnit?: string;
  confirmPackEvidence: boolean;
  packSource?: 'packages' | 'manual';
  packSize?: number;
  listingVersion?: number;
  sourceScope?: 'company';
  tyreFloor?: boolean;
}
