import type { SellerAccount } from '../shared/contracts.js';

import { marketplaceBrand } from '../shared/marketplaces.js';

type Marketplace = SellerAccount['marketplace'];

export function MarketplaceLogo({
  marketplace,
  size = 16,
}: {
  marketplace?: Marketplace;
  size?: number;
}) {
  const brand = marketplaceBrand(marketplace);
  return brand ? <img src={brand.logo} alt={brand.name} width={size} height={size} /> : null;
}

export function MarketplaceSeller({
  account,
}: {
  account?: { name: string; marketplace?: Marketplace };
}) {
  if (!account) return <>Seller account unavailable</>;
  return (
    <span className="inventory-seller" title={account.name}>
      <MarketplaceLogo marketplace={account.marketplace} /> {account.name}
    </span>
  );
}
