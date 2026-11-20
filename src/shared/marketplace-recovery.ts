/** The exact destination and quantities the seller can approve for this review. */
export interface MarketplaceStockRecoveryReview {
  reviewId: string;
  sku: string;
  locationId: string;
  observed: number;
  quantity: number;
}
