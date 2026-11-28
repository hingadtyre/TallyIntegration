import type { Listing, Snapshot, StockItem } from '../shared/contracts.js';

export type StockView = 'all' | 'mapped' | 'low' | 'drafts';

export function isLowStock(item: StockItem): boolean {
  return item.physical !== null && item.physical <= item.lowStockThreshold;
}

export interface InventoryFilters {
  companyId: string;
  accountId: string;
  query: string;
  brand: string;
  pack: string;
  view?: StockView;
}
export interface ItemGroup {
  item: StockItem;
  listings: Listing[];
}

/** A matching child never brings an unmatched sibling into a bulk operation. */
export function inventoryGroups(state: Snapshot, filters: InventoryFilters): ItemGroup[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const drafts =
    filters.view === 'drafts' ? new Set(state.proposals.map((row) => row.listingId)) : null;
  const byItem = new Map<string, Listing[]>();
  for (const listing of state.listings) {
    if (!listing.itemId || (filters.accountId && listing.accountId !== filters.accountId)) continue;
    const siblings = byItem.get(listing.itemId);
    if (siblings) siblings.push(listing);
    else byItem.set(listing.itemId, [listing]);
  }
  return state.items
    .filter((item) => item.companyId === filters.companyId)
    .filter((item) => filters.view !== 'low' || isLowStock(item))
    .filter((item) => !filters.brand || item.brand === filters.brand)
    .map((item) => {
      const parentMatches =
        !query ||
        `${item.name} ${item.brand} ${item.externalId}`.toLocaleLowerCase().includes(query);
      const allChildren = byItem.get(item.id) ?? [];
      const listings = allChildren.filter(
        (listing) =>
          (!drafts || drafts.has(listing.id)) &&
          (!filters.pack || String(listing.packSize) === filters.pack) &&
          (parentMatches || `${listing.sku} ${listing.title}`.toLocaleLowerCase().includes(query)),
      );
      return {
        item,
        listings,
        visible:
          listings.length > 0 ||
          (filters.view !== 'mapped' &&
            !drafts &&
            allChildren.length === 0 &&
            parentMatches &&
            !filters.pack),
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
  filteredGroups?: ItemGroup[],
): string[] {
  if (!selected.length)
    return (filteredGroups ?? inventoryGroups(state, filters)).flatMap((group) =>
      group.listings.map((listing) => listing.id),
    );
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
  return [...new Set(selection)];
}
