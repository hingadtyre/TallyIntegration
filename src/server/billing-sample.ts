import type { BillingScope } from './billing-matcher.js';
import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';
import type { TallyLedger, TallySalesBill } from '../adapters/tally.js';
import { saleDay } from '../domain/sale-day.js';
import type { BillingFulfilment } from '../shared/billing-contracts.js';
import type { StockItem } from '../shared/contracts.js';
import type { StockSyncCoverage } from '../shared/stock-coverage.js';

export function sampleLedger(companyId: string, accountId: string): TallyLedger {
  if (
    companyId === 'demo-integration' &&
    (accountId === 'demo-retail' || accountId === 'demo-outlet')
  ) {
    return {
      externalId: `sample-sales-${accountId}`,
      name: accountId === 'demo-retail' ? 'Sample Retail sales' : 'Sample Outlet sales',
    };
  }
  return { externalId: `sample-sales-${companyId}`, name: 'Sample Flipkart sales' };
}

export function sampleOrderDate(
  scope: BillingScope,
  items: StockItem[],
  retained: StockSyncCoverage['orders'] = [],
): string | null {
  if (scope.companyId === 'demo-integration')
    return items.find((item) => item.id === 'demo-integration-tyre')?.observedAt ?? null;
  return (
    retained.find((entry) => entry.accountId === scope.accountId)?.order.orderDate ??
    items.find((item) => item.id === 'item-a')?.observedAt ??
    null
  );
}

type SampleOrders = Record<BillingFulfilment, FlipkartBillingOrder[]>;

function integrationOrders(
  accountId: 'demo-retail' | 'demo-outlet',
  at: string,
  orders: SampleOrders,
  bills: TallySalesBill[],
) {
  const outlet = accountId === 'demo-outlet';
  const statusVerifiedAt = new Date().toISOString();
  const order = (id: number, extra: Partial<FlipkartBillingOrder> = {}): FlipkartBillingOrder => ({
    orderId: `DEMO-ORDER-${id}`,
    orderItemId: `DEMO-LINE-${id}`,
    stockShipmentId: `DEMO-SHIPMENT-${id}`,
    invoiceNumber: null,
    listingId: outlet ? 'sample-demo-outlet-single' : 'sample-demo-retail-single',
    sku: outlet ? 'DEMO-OUTLET-SINGLE' : 'DEMO-RETAIL-SINGLE',
    locationId: 'Demo pickup',
    quantity: 1,
    orderDate: at,
    marketplaceStatus: 'APPROVED',
    marketplaceHold: false,
    statusVerifiedAt,
    ...extra,
  });
  if (outlet) {
    orders.standard.push(order(2001));
    return;
  }
  const billed = (id: number, quantity = 1, reference = `DEMO-ORDER-${id}`) => {
    const sale = order(id, {
      quantity,
      invoiceNumber: `DEMO-BILL-${id}`,
      stockDispatchObserved: true,
      marketplaceStatus: 'SHIPPED',
    });
    bills.push({
      externalId: `demo-bill-${id}`,
      number: `DEMO-BILL-${id}`,
      date: saleDay(at),
      reference,
      narration: `Flipkart ${sale.orderItemId}`,
      lines: [{ itemExternalId: 'demo-integration-tyre', unit: 'tyres', quantity }],
    });
    return sale;
  };
  orders.standard.push(
    billed(1001),
    order(1002, { preDispatchWithoutCourierReturn: true, marketplaceStatus: 'READY_TO_DISPATCH' }),
    order(1005, { stockDisposition: 'cancelled', marketplaceStatus: 'CANCELLED' }),
  );
  orders.selfShip.push(
    billed(1003, 2, 'DEMO-ORDRE-1003'),
    order(1004, { sku: 'DEMO-RETAIL-UNMAPPED', listingId: 'sample-demo-retail-unmapped' }),
  );
  orders.express.push(billed(1006));
  orders.smart.push(order(1007));
  orders.fbf.push(order(1008));
}

export function sampleBills(
  scope: BillingScope,
  createdAt: string | null,
  from: string,
  to: string,
) {
  const byFulfilment: SampleOrders = {
    standard: [],
    selfShip: [],
    express: [],
    smart: [],
    fbf: [],
  };
  const bills: TallySalesBill[] = [];
  if (createdAt && createdAt >= from && createdAt <= to) {
    if (
      scope.companyId === 'demo-integration' &&
      (scope.accountId === 'demo-retail' || scope.accountId === 'demo-outlet')
    ) {
      integrationOrders(scope.accountId, createdAt, byFulfilment, bills);
    } else if (scope.companyId === 'demo-a' && scope.accountId === 'flipkart-primary') {
      originalSampleOrders(createdAt, byFulfilment.standard, bills);
    }
  }
  const stockOrders = [...byFulfilment.standard, ...byFulfilment.selfShip];
  return {
    byFulfilment,
    stockOrders,
    previewOrders: stockOrders.filter((order) => order.stockDisposition !== 'cancelled'),
    bills,
  };
}

function originalSampleOrders(
  createdAt: string,
  orders: FlipkartBillingOrder[],
  bills: TallySalesBill[],
) {
  const base = {
    orderDate: createdAt,
    listingId: 'sample-listing-1',
    sku: 'SAMPLE-CEAT-1-1',
    locationId: 'Sample warehouse',
    quantity: 1,
  };
  orders.push(
    {
      ...base,
      orderItemId: 'SAMPLE-LINE-1',
      orderId: 'SAMPLE-ORDER-1',
      invoiceNumber: 'SAMPLE-INV-1',
    },
    { ...base, orderItemId: 'SAMPLE-LINE-2', orderId: 'SAMPLE-ORDER-2', invoiceNumber: null },
  );
  bills.push({
    externalId: 'sample-bill-1',
    number: 'SAMPLE-INV-1',
    date: saleDay(createdAt),
    reference: 'SAMPLE-ORDER-1',
    narration: 'Flipkart SAMPLE-LINE-1',
    lines: [{ itemExternalId: 'sample-a', unit: 'tyres', quantity: 1 }],
  });
}
