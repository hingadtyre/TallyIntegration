import type { MarketplaceData } from '../../src/server/storage/marketplace-records.js';

export function marketplaceData(
  accountId = 'flipkart-primary',
  sellerId = 'seller-a',
): MarketplaceData {
  const at = '2026-11-18T08:00:00.000Z';
  return {
    accounts: [{ id: accountId, name: 'Fixture seller', sellerId, lastRefreshedAt: at }],
    listings: [
      {
        id: 'remote-listing',
        accountId,
        sellerId,
        productId: 'product-1',
        sku: 'TYRE-PAIR',
        title: 'A pair of tyres',
        imageUrl: null,
        status: 'ACTIVE',
        mrp: 4000,
        sellingPrice: 3500,
        locations: [{ id: 'warehouse-1', quantity: 5, status: 'ACTIVE' }],
        observedAt: at,
        version: 1,
      },
    ],
    changes: [
      {
        id: 'change-1',
        accountId,
        listingId: 'remote-listing',
        sku: 'TYRE-PAIR',
        edit: { kind: 'stock', locationId: 'warehouse-1', quantity: 4, automation: 'pause' },
        state: 'pending',
        message: 'Waiting to send',
        createdAt: at,
        updatedAt: at,
      },
    ],
  };
}
