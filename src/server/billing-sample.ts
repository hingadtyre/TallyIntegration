import type { BillingEvidence, BillingScope } from './billing-matcher.js';
import type { TallyLedger } from '../adapters/tally.js';

export function sampleLedger(companyId: string): TallyLedger {
  return { externalId: `sample-sales-${companyId}`, name: 'Sample Flipkart sales' };
}

export function sampleBills(
  scope: BillingScope,
  createdAt: string | null,
  from: string,
  to: string,
): BillingEvidence {
  if (
    scope.companyId !== 'demo-a' ||
    scope.accountId !== 'flipkart-primary' ||
    !createdAt ||
    createdAt < from ||
    createdAt > to
  )
    return { orders: [], bills: [] };
  const base = {
    orderDate: createdAt,
    listingId: 'sample-listing-1',
    sku: 'SAMPLE-CEAT-1-1',
    locationId: 'Sample warehouse',
    quantity: 1,
  };
  return {
    orders: [
      {
        ...base,
        orderItemId: 'SAMPLE-LINE-1',
        orderId: 'SAMPLE-ORDER-1',
        invoiceNumber: 'SAMPLE-INV-1',
      },
      { ...base, orderItemId: 'SAMPLE-LINE-2', orderId: 'SAMPLE-ORDER-2', invoiceNumber: null },
    ],
    bills: [
      {
        externalId: 'sample-bill-1',
        number: 'SAMPLE-INV-1',
        date: new Date(Date.parse(createdAt) + 330 * 60_000).toISOString().slice(0, 10),
        reference: 'SAMPLE-ORDER-1',
        narration: 'Flipkart SAMPLE-LINE-1',
        lines: [{ itemExternalId: 'sample-a', unit: 'tyres', quantity: 1 }],
      },
    ],
  };
}
