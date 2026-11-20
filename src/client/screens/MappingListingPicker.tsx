import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Listing, StockItem } from '../../shared/contracts.js';
import { Icon } from '../components.js';
import { searchMappingListings, suggestedMappingListings } from '../mapping-search.js';

const pageSize = 10;

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
        <span>
          <b>Location</b> {listing.location}
        </span>
        {!listing.observedAt && <span>Refresh listings to verify this location.</span>}
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
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const nextPageFocus = useRef('');
  const previousId = useRef(selected?.id);
  useLayoutEffect(() => {
    if (previousId.current !== selected?.id) {
      (selected ? changeRef.current : searchRef.current)?.focus();
      previousId.current = selected?.id;
    }
  }, [selected]);

  if (selected) {
    return (
      <div className="mapping-selected" role="group" aria-label="Selected listing">
        <div className="mapping-picker-heading">
          <strong>Selected listing</strong>
          <button
            ref={changeRef}
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => onChoose('')}
          >
            Change listing
          </button>
        </div>
        <ListingDetails listing={selected} />
      </div>
    );
  }

  const searching = Boolean(query.trim());
  const results = searchMappingListings(listings, query);
  const suggested = searching ? [] : suggestedMappingListings(listings, item);
  const suggestedIds = new Set(suggested.map((listing) => listing.id));
  const remaining = results.filter((listing) => !suggestedIds.has(listing.id));
  const ordered = [...suggested, ...remaining];

  function changeSearch(value: string) {
    setQuery(value);
    setLimit(pageSize);
  }
  function resultGroup(heading: string, rows: Listing[]) {
    return (
      rows.length > 0 && (
        <section className="mapping-result-group" aria-label={heading}>
          <h3>{heading}</h3>
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="mapping-result"
                  ref={(node) => {
                    if (node && nextPageFocus.current === row.id) {
                      node.focus();
                      nextPageFocus.current = '';
                    }
                  }}
                  disabled={busy}
                  onClick={() => onChoose(row.id)}
                >
                  <ListingDetails listing={row} />
                  <Icon name="chevron" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )
    );
  }

  return (
    <div className="mapping-picker">
      <div className="mapping-picker-heading">
        <label htmlFor={searchId}>Search listings</label>
        <span>{accountName}</span>
      </div>
      <div className="search-input">
        <Icon name="search" />
        <input
          id={searchId}
          ref={searchRef}
          type="search"
          value={query}
          disabled={busy}
          placeholder="SKU, title, FSN or listing ID"
          onChange={(event) => changeSearch(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear search"
            disabled={busy}
            onClick={() => {
              changeSearch('');
              searchRef.current?.focus();
            }}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="mapping-results" key={query}>
        {resultGroup('Possible matches for this item', suggested.slice(0, limit))}
        {resultGroup(
          searching
            ? 'Search results'
            : suggested.length
              ? 'Other unmapped listings'
              : 'Unmapped listings',
          remaining.slice(0, Math.max(0, limit - suggested.length)),
        )}
        {ordered.length > limit && (
          <button
            type="button"
            className="text-button mapping-more"
            disabled={busy}
            onClick={() => {
              nextPageFocus.current = ordered[limit].id;
              setLimit(limit + pageSize);
            }}
          >
            Show more listings ({ordered.length - limit} remaining)
          </button>
        )}
        {results.length === 0 && (
          <p className="mapping-no-results" role="status">
            No matching listings. Try another SKU, title, FSN or listing ID.
          </p>
        )}
      </div>
    </div>
  );
}
