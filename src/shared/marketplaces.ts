import type { SellerAccount } from './contracts.js';

type Marketplace = SellerAccount['marketplace'];
const brands: Record<Marketplace, { name: string; logo: string; sellerHub: string }> = {
  flipkart: { name: 'Flipkart', logo: '/flipkart.png', sellerHub: 'https://seller.flipkart.com/' },
};

export function marketplaceBrand(marketplace?: Marketplace) {
  return marketplace ? brands[marketplace] : undefined;
}

export function marketplaceName(marketplace?: Marketplace) {
  return marketplaceBrand(marketplace)?.name;
}
