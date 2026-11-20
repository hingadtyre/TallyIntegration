export interface AutomationPreviewRow {
  listingId: string;
  accountId: string;
  account: string;
  sku: string;
  location: string;
  itemName: string;
  observed: number | null;
  proposed: number | null;
  status: 'ready' | 'waiting' | 'paused';
  reason: string | null;
}

export interface AutomationPreview {
  id: string;
  companyId: string;
  companyName: string;
  createdAt: string;
  rows: AutomationPreviewRow[];
}
