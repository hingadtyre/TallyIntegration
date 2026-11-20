import type { Listing, StockItem } from '../shared/contracts.js';

function normalize(value: string) {
  return value.normalize('NFKC').trim().toLowerCase();
}

function words(value: string) {
  return value.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** The caller supplies only the selected seller's unmapped destinations. */
export function searchMappingListings(listings: Listing[], query: string): Listing[] {
  const text = normalize(query);
  if (!text) return listings;
  const parts = text.split(/\s+/u);
  const exact: Listing[] = [];
  const prefix: Listing[] = [];
  const partial: Listing[] = [];
  for (const listing of listings) {
    const ids = [listing.sku, listing.productId ?? '', listing.marketplaceListingId ?? ''].map(
      normalize,
    );
    if (ids.includes(text)) exact.push(listing);
    else if (ids.some((id) => id.startsWith(text))) prefix.push(listing);
    else {
      const fields = [...ids, normalize(listing.title)];
      if (parts.every((part) => fields.some((field) => field.includes(part))))
        partial.push(listing);
    }
  }
  return [...exact, ...prefix, ...partial];
}

// Treat different tyre sizes as different variants even when the product name is identical.
const tyreSize = /(?<!\d)(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:z?r|-)\s*(\d{2}(?:\.\d+)?)(?![\d.])/gu;
const genericWords = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'and',
  'with',
  'set',
  'pack',
  'pcs',
  'piece',
  'pieces',
  'tyre',
  'tyres',
  'tire',
  'tires',
  'tubeless',
  'radial',
]);

function sizes(value: string) {
  return Array.from(value.matchAll(tyreSize), (match) => match.slice(1).join('/'));
}

export function suggestedMappingListings(listings: Listing[], item: StockItem): Listing[] {
  const name = normalize(item.name);
  const itemSizes = sizes(name);
  const excluded = new Set([...genericWords, ...words(normalize(item.unit))]);
  const nameWords = words(name.replace(tyreSize, ' ')).filter((word) => !excluded.has(word));
  const brand = new Set(words(normalize(item.brand)));
  const modelWords = nameWords.filter((word) => !brand.has(word));
  if (!modelWords.some((word) => /\p{L}/u.test(word))) return [];
  const model = modelWords.length === 1 ? modelWords[0] : '';
  const hasModelCode = /^[a-z][a-z0-9]{3,}$/u.test(model) && /\d{2}/u.test(model);

  return listings.filter((listing) => {
    if (!listing.observedAt) return false;
    const fields = [normalize(listing.title), normalize(listing.sku)];
    const listedSizes = fields.flatMap(sizes);
    if (itemSizes.length && listedSizes.some((size) => !itemSizes.includes(size))) return false;

    return fields.some((field) => {
      if (field === name) return true;
      const tokens = new Set(words(field.replace(tyreSize, ' ')));
      // A shared brand, size or fragment of a model is too weak to suggest a mapping.
      if (nameWords.length >= 2 && nameWords.every((word) => tokens.has(word))) return true;
      if (!tokens.has(model)) return false;
      return hasModelCode || (brand.size > 0 && [...brand].every((word) => tokens.has(word)));
    });
  });
}
