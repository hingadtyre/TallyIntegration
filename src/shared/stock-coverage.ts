import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';

/** Receipt of the first verified sale and its durable shared-stock checks. */
export type StockCoverageOrder = FlipkartBillingOrder & { stockSyncQueued?: true };

export interface StockSyncCoverage {
  companyId: string;
  /** Inclusive start of the confirmed Indian calendar day, stored as a UTC timestamp. */
  from: string;
  signature: string;
  checkedThrough: string | null;
  orders: Array<{ accountId: string; order: StockCoverageOrder }>;
}

export interface StockCoverageStatus {
  from: string | null;
  current: boolean;
  checkedThrough: string | null;
}
