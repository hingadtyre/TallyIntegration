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

export interface BillingRow {
  orderItemId: string;
  orderId: string;
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
  from: string;
  to: string;
  checkedAt: string;
  rule: BillingRule;
  rows: BillingRow[];
  stock: {
    name: string;
    unit: string;
    physical: number | null;
    unmatchedUnits: number | null;
    previewAvailable: number | null;
  }[];
}

export interface BillingWorkspace {
  rule: BillingRule | null;
  report: BillingReport | null;
}
