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
  id: string;
  accountId: string;
  sku: string;
  title: string;
  location: string;
  itemId: string | null;
  packSize: number | null;
  packEvidence: string;
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
  publishingEnabled: false;
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
  publishingEnabled: false;
}
export interface MappingInput {
  listingId: string;
  itemId: string;
  confirmPackEvidence: boolean;
}
