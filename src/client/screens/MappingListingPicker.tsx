import type { Listing, StockItem } from '../../shared/contracts.js';
import { SearchablePicker } from '../SearchablePicker.js';
import { searchMappingListings, suggestedMappingListings } from '../mapping-search.js';

function ListingDetails({ listing }: { listing: Listing }) {
  const hasTitle = listing.title.trim() && listing.title.trim() !== listing.sku.trim();
  return (
    <span className="mapping-listing-details">
      <strong>{hasTitle ? listing.title : <>Seller SKU {listing.sku}</>}</strong>
      <span className="mapping-listing-meta">
        {hasTitle && (
          <span>
            <b>Seller SKU</b> {listing.sku}
          </span>
        )}
        {listing.location ? (
          <span>
            <b>Location</b> {listing.location}
          </span>
        ) : (
          <span>Flipkart has not reported stock at a pickup location for this SKU.</span>
        )}
        {listing.location && !listing.observedAt && (
          <span>Refresh listings to verify this location.</span>
        )}
      </span>
      {(listing.productId || listing.marketplaceListingId) && (
        <span className="mapping-listing-meta">
          {listing.productId && (
            <span>
              <b>FSN (product ID)</b> {listing.productId}
            </span>
          )}
          {listing.marketplaceListingId && (
            <span>
              <b>Listing ID</b> {listing.marketplaceListingId}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function MappingListingPicker({
  listings,
  item,
  accountName,
  selected,
  onChoose,
  busy,
}: {
  listings: Listing[];
  item: StockItem;
  accountName: string;
  selected?: Listing;
  onChoose: (id: string) => void;
  busy: boolean;
}) {
  const suggested = suggestedMappingListings(listings, item);
  const suggestedIds = new Set(suggested.map((listing) => listing.id));
  const browseOrder = [
    ...suggested,
    ...listings.filter((listing) => !suggestedIds.has(listing.id)),
  ];

  return (
    <div className="mapping-picker">
      <div className="mapping-picker-heading">
        <span>{accountName}</span>
      </div>
      <SearchablePicker
        label="Flipkart listing"
        placeholder="SKU, title, FSN or listing ID"
        options={listings}
        selected={selected}
        getId={(listing) => listing.id}
        getLabel={(listing) => [listing.sku, listing.location].filter(Boolean).join(' · ')}
        onSelect={onChoose}
        disabled={busy}
        filterOptions={(options, query) =>
          query.trim() ? searchMappingListings(options, query) : browseOrder
        }
        groupLabel={(listing, query) => {
          if (query.trim()) return 'Search results';
          if (suggestedIds.has(listing.id)) return 'Possible matches for this item';
          return suggested.length ? 'Other unmapped listings' : 'Unmapped listings';
        }}
        renderOption={(listing) => <ListingDetails listing={listing} />}
        emptyMessage="No matching listings. Try another SKU, title, FSN or listing ID."
        pageSize={10}
        moreLabel="Show more listings"
      />
      {selected && (
        <div className="mapping-selected" role="group" aria-label="Selected listing">
          <ListingDetails listing={selected} />
        </div>
      )}
    </div>
  );
}
