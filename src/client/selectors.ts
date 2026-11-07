import type { Listing, Snapshot, StockItem } from '../shared/contracts.js';

export interface InventoryFilters {
  companyId: string;
  accountId: string;
  query: string;
  brand: string;
  pack: string;
}
export interface ItemGroup {
  item: StockItem;
  listings: Listing[];
}

/** A matching child never brings an unmatched sibling into a bulk operation. */
export function inventoryGroups(state: Snapshot, filters: InventoryFilters): ItemGroup[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return state.items
    .filter((item) => item.companyId === filters.companyId)
    .filter((item) => !filters.brand || item.brand === filters.brand)
    .map((item) => {
      const parentMatches =
        !query ||
        `${item.name} ${item.brand} ${item.externalId}`.toLocaleLowerCase().includes(query);
      const allChildren = state.listings.filter(
        (listing) =>
          listing.itemId === item.id &&
          (!filters.accountId || listing.accountId === filters.accountId),
      );
      const listings = allChildren.filter(
        (listing) =>
          (!filters.pack || String(listing.packSize) === filters.pack) &&
          (parentMatches || `${listing.sku} ${listing.title}`.toLocaleLowerCase().includes(query)),
      );
      return {
        item,
        listings,
        visible:
          listings.length > 0 || (allChildren.length === 0 && parentMatches && !filters.pack),
      };
    })
    .filter((group) => group.visible)
    .sort((a, b) => a.item.name.localeCompare(b.item.name));
}

/** Explicit selections take precedence over filters, within the chosen company/account. */
export function actionScope(
  state: Snapshot,
  filters: InventoryFilters,
  selected: string[],
): string[] {
  const itemIds = new Set(
    state.items.filter((item) => item.companyId === filters.companyId).map((item) => item.id),
  );
  const valid = new Set(
    state.listings
      .filter(
        (listing) =>
          listing.itemId !== null &&
          itemIds.has(listing.itemId) &&
          (!filters.accountId || listing.accountId === filters.accountId),
      )
      .map((listing) => listing.id),
  );
  const selection = selected.filter((id) => valid.has(id));
  return selected.length
    ? [...new Set(selection)]
    : inventoryGroups(state, filters).flatMap((group) =>
        group.listings.map((listing) => listing.id),
      );
}
