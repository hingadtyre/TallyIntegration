import type { SellerAccount } from '../shared/contracts.js';

import { marketplaceBrand } from '../shared/marketplaces.js';
import { SearchablePicker } from './SearchablePicker.js';

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

export function SellerAccountPicker({
  accounts,
  selected,
  onSelect,
  inputId,
}: {
  accounts: SellerAccount[];
  selected?: SellerAccount;
  onSelect: (id: string) => void;
  inputId?: string;
}) {
  return (
    <div className="account-select">
      <SearchablePicker
        inputId={inputId}
        openOnFocus={false}
        label="Seller account"
        placeholder={accounts.length ? 'Choose seller account' : 'No seller account'}
        options={accounts}
        selected={selected}
        getId={(seller) => seller.id}
        getLabel={(seller) => seller.name}
        selectedIcon={
          selected?.marketplace && <MarketplaceLogo marketplace={selected.marketplace} />
        }
        renderOption={(seller) => <MarketplaceSeller account={seller} />}
        emptyMessage="No matching seller accounts."
        disabled={!accounts.length}
        onSelect={onSelect}
      />
    </div>
  );
}
