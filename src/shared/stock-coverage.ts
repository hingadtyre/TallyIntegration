import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';

export const startTrackingMessage =
  'In Order matching, choose Set starting stock to confirm when Stockbridge should start tracking marketplace orders for this company.';

/** Receipt of the first verified sale and its durable shared-stock checks. */
export type StockCoverageOrder = FlipkartBillingOrder & {
  stockSyncQueued?: true;
  /** Identity, mapping and whole quantity that the seller confirmed receiving. */
  sellableReturnToken?: string;
  /** An exact outward deduction previously checked with a stable Tally balance. */
  verifiedDeduction?: { stockToken: string; billId: string; linkFingerprint?: string };
  /** Billing identified the voucher. Stock still needs its own balance and deduction checks. */
  billingDeduction?: { stockToken: string; billId: string; linkFingerprint?: string };
  /** Keep the order visible for follow-up after the seller maps its destination. */
  firstSeenUnmapped?: true;
};

export function isVerifiedSale(order: StockCoverageOrder): boolean {
  return !(
    order.marketplaceHold ||
    order.stockDisposition ||
    order.stockReturnObserved ||
    order.stockReturnConflict ||
    order.eligibilityUnverified ||
    order.stockIdentityConflict ||
    order.stockReconciliationRequired
  );
}

export function isVerifiedCancellation(order: StockCoverageOrder): boolean {
  return (
    order.stockDisposition === 'cancelled' &&
    !order.marketplaceHold &&
    !order.stockDispatchObserved &&
    !order.eligibilityUnverified &&
    !order.stockReconciliationRequired &&
    !order.stockIdentityConflict &&
    !order.stockReturnConflict &&
    !order.stockReturnObserved
  );
}

export function isVerifiedReturn(order: StockCoverageOrder): boolean {
  return !!(
    order.stockReturnVerified &&
    !order.marketplaceHold &&
    order.stockReturnObserved &&
    order.stockDisposition === 'uncertain' &&
    order.eligibilityUnverified &&
    order.stockShipmentId &&
    order.stockDispatchObserved &&
    !order.stockReturnConflict &&
    !order.stockReconciliationRequired &&
    !order.stockIdentityConflict
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
