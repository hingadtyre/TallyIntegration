export type PolicyMode = 'auto' | 'limited' | 'hold';
export interface Company {
  id: string;
  name: string;
  automation: boolean;
  source: 'tally' | 'demo';
  lastSuccess: string | null;
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
  /** A Tally balance change still awaiting dispatch for this destination. */
  syncPendingItemVersion?: number | null;
  id: string;
  accountId: string;
  sku: string;
  title: string;
  location: string;
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
}
export interface InventoryPublishResult {
  rows: InventoryPublishRow[];
}
export interface MappingInput {
  listingId: string;
  itemId: string;
  expectedUnit?: string;
  confirmPackEvidence: boolean;
  packSource?: 'packages' | 'manual';
  packSize?: number;
  listingVersion?: number;
  sourceScope?: 'company';
  tyreFloor?: boolean;
}
