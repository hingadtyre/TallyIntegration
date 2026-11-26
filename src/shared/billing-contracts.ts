export type BillField = 'reference' | 'number' | 'narration' | 'manual';
export type OrderReference = 'orderId' | 'orderItemId' | 'invoiceNumber';

export interface BillingRule {
  ledgerId: string;
  ledgerName: string;
  field: BillField;
  reference: OrderReference;
}

export interface BillCandidate {
  id: string;
  number: string;
  date: string;
}

export interface BillLookupCandidate extends BillCandidate {
  recordedReference: string | null;
  lines: { itemName: string; unit: string; quantity: number }[];
  referenceMismatch: boolean;
  issue: string | null;
}

export interface BillLookup {
  reviewId: string;
  orderItemId: string;
  orderId: string;
  orderDate: string;
  sku: string;
  ledgerName: string;
  itemName: string;
  unit: string;
  baseUnits: number | null;
  expectedReference: string | null;
  field: BillField;
  bills: BillLookupCandidate[];
}

export interface BillingRow {
  orderItemId: string;
  orderId: string;
  listingId: string;
  orderDate?: string;
  referenceValue?: string | null;
  sku: string;
  location: string;
  quantity: number;
  baseUnits: number | null;
  status: 'matched' | 'review' | 'unmatched' | 'unmapped';
  reason: string;
  bill: BillCandidate | null;
  manualBillId?: string;
  candidates: BillCandidate[];
}

export interface BillingReport {
  previewId: string;
  period?: 'tracking';
  from: string;
  to: string;
  checkedAt: string;
  rule: BillingRule;
  rows: BillingRow[];
  stock: {
    name: string;
    unit: string;
    physical: number | null;
    keepBackUnits: number;
    unmatchedUnits: number | null;
    previewAvailable: number | null;
  }[];
}

export interface BillingWorkspace {
  rule: BillingRule | null;
  report: BillingReport | null;
  trackingFrom?: string;
}

export interface PendingListingGroup {
  listingId: string;
  sku: string;
  location: string;
  orderItemIds: string[];
  mapped: boolean;
}

export interface PendingListings {
  trackingStarted: boolean;
  checkedThrough?: string;
  listings: PendingListingGroup[];
  refreshIssue?: string;
}

export interface PendingOrderResult {
  orderItemId: string;
  status: 'matched' | 'reserved' | 'review' | 'cancelled' | 'unmapped';
  reason: string;
  baseUnits: number | null;
}

export interface TrackedBillOrder {
  orderItemId: string;
  orderId: string;
  orderDate: string;
  sku: string;
  status: PendingOrderResult['status'];
  reason: string;
  manualBillId?: string;
  manualBillNumber?: string;
  manualBillDate?: string;
  linkToken?: string;
}

export interface BilledOrderItem {
  orderId: string;
  orderItemId: string;
  orderDate: string;
  sku: string;
  bill: BillCandidate;
  method: 'automatic' | 'seller-confirmed';
}

export interface TrackedBillHistory {
  orders: TrackedBillOrder[];
  billed: BilledOrderItem[];
}

export interface PendingListingCheck {
  listingId: string;
  sku: string;
  location: string;
  rows: PendingOrderResult[];
}
