import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';

export const startTrackingMessage =
  'In Order matching, choose Set starting stock to confirm when Stockbridge should start tracking marketplace orders for this company.';

/** Receipt of the first verified sale and its durable shared-stock checks. */
export type StockCoverageOrder = FlipkartBillingOrder & {
  stockSyncQueued?: true;
  /** Keep the order visible for follow-up after the seller maps its destination. */
  firstSeenUnmapped?: true;
};

export function isVerifiedSale(order: StockCoverageOrder): boolean {
  return !(
    order.stockDisposition ||
    order.eligibilityUnverified ||
    order.stockIdentityConflict ||
    order.stockReconciliationRequired
  );
}

export function isVerifiedCancellation(order: StockCoverageOrder): boolean {
  return (
    order.stockDisposition === 'cancelled' &&
    !order.stockDispatchObserved &&
    !order.eligibilityUnverified &&
    !order.stockReconciliationRequired &&
    !order.stockIdentityConflict &&
    !order.stockReturnConflict
  );
}

export interface StockSyncCoverage {
  companyId: string;
  /** Inclusive start of the confirmed Indian calendar day, stored as a UTC timestamp. */
  from: string;
  signature: string;
  checkedThrough: string | null;
  orders: Array<{ accountId: string; order: StockCoverageOrder }>;
}

export interface StockCoverageStatus {
  setupVersion: string;
  from: string | null;
  billingFrom?: string;
  current: boolean;
  checkedThrough: string | null;
  issue?: string;
}
