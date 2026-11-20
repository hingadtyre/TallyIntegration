import type {
  MarketplaceListing,
  MarketplaceListingStatus,
  MarketplaceLocation,
} from '../shared/marketplace-contracts.js';

const apiRoot = 'https://api.flipkart.net/sellers/listings/v3';
const maximumResponseBytes = 2 * 1024 * 1024;
const maximumBatchesPerState = 1000;
const maximumInteger = 2_147_483_647;
const listingStates: MarketplaceListingStatus[] = [
  'ACTIVE',
  'INACTIVE',
  'READY_FOR_ACTIVATION',
  'ARCHIVED',
  'INACTIVATED_BY_FLIPKART',
];

export class FlipkartListingError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = 'FlipkartListingError';
  }
}

class ProductSearchUnavailable extends FlipkartListingError {}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

function observedNumber(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximumInteger
    ? value
    : null;
}

function imageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function invalidResponse(uncertain = false): FlipkartListingError {
  return new FlipkartListingError(
    uncertain
      ? 'Flipkart returned an unexpected update result. Check the marketplace before retrying.'
      : 'Flipkart returned incomplete or inconsistent listing data. Refresh again before editing.',
    uncertain,
  );
}

function validateListing(listing: MarketplaceListing): void {
  if (
    !identity(listing.accountId) ||
    !identity(listing.id) ||
    (listing.sellerId !== null && !identity(listing.sellerId)) ||
    !identity(listing.sku) ||
    !identity(listing.productId)
  ) {
    throw new FlipkartListingError('Refresh this listing to verify its marketplace identity.');
  }
}

async function readResponse(response: Response, write: boolean): Promise<Record<string, unknown>> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    void response.body?.cancel().catch(() => undefined);
    throw invalidResponse(write);
  }
  const length = response.headers.get('content-length');
  if (
    (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumResponseBytes)) ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw invalidResponse(write);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumResponseBytes) {
        void reader.cancel().catch(() => undefined);
        throw invalidResponse(write);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!result) throw invalidResponse(write);
    return result;
  } catch {
    throw invalidResponse(write);
  }
}

/** Only the documented production host receives the account's bearer token. */
export class FlipkartListingsClient {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly standardSearchAccounts = new Set<string>();

  constructor(options: { request?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new FlipkartListingError('Invalid Flipkart request timeout.');
    }
  }

  async listListings(token: string, accountId: string): Promise<MarketplaceListing[]> {
    if (!identity(accountId)) throw new FlipkartListingError('Select a valid marketplace account.');
    if (!this.standardSearchAccounts.has(accountId)) {
      try {
        return await this.productListings(token, accountId);
      } catch (error) {
        if (!(error instanceof ProductSearchUnavailable)) throw error;
      }
    }
    const result = await this.standardListings(token, accountId);
    this.standardSearchAccounts.add(accountId);
    return result;
  }

  /** Some seller-owned applications only expose the standard paginated listing
   * search. It returns listing identities, with titles, stock and parcels in details. */
  private async standardListings(token: string, accountId: string): Promise<MarketplaceListing[]> {
    const listings: MarketplaceListing[] = [];
    const skus = new Set<string>();
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const result = await this.post(token, '/search', { filters: {}, page_id: cursor });
      if (
        !Array.isArray(result.listings) ||
        result.listings.length > 500 ||
        typeof result.has_more !== 'boolean'
      )
        throw invalidResponse();
      for (const value of result.listings) {
        const row = object(value);
        if (
          !row ||
          !identity(row.listing_id) ||
          !identity(row.product_id) ||
          !identity(row.sku_id) ||
          ids.has(row.listing_id) ||
          skus.has(row.sku_id)
        )
          throw invalidResponse();
        ids.add(row.listing_id);
        skus.add(row.sku_id);
        listings.push({
          accountId,
          id: row.listing_id,
          productId: row.product_id,
          sku: row.sku_id,
          title: row.sku_id,
          sellerId: null,
          imageUrl: null,
          status: 'INACTIVE',
          mrp: null,
          sellingPrice: null,
          locations: [],
          observedAt: null,
          version: 0,
        });
      }
      if (!result.has_more) break;
      const next = result.next_page_id;
      if (
        !result.listings.length ||
        typeof next !== 'string' ||
        !next.trim() ||
        next.length > 4096 ||
        cursors.has(next) ||
        cursors.size >= maximumBatchesPerState
      )
        throw invalidResponse();
      cursors.add(next);
      cursor = next;
    }
    const detailed: MarketplaceListing[] = [];
    for (let start = 0; start < listings.length; start += 10) {
      detailed.push(...(await this.details(token, listings.slice(start, start + 10), false, true)));
    }
    return detailed;
  }

  private async productListings(token: string, accountId: string): Promise<MarketplaceListing[]> {
    const listings: MarketplaceListing[] = [];
    const skus = new Set<string>();
    const ids = new Set<string>();
    let sellerId: string | undefined;
    for (const state of listingStates) {
      let expectedCount: number | undefined;
      let count = 0;
      for (let batchNo = 0; batchNo < maximumBatchesPerState; batchNo++) {
        const response = await this.post(token, '/product/search', {
          batchNo,
          internalState: state,
        });
        const total = response.totalListingsCount;
        const rows = response.listingData;
        if (
          typeof total !== 'number' ||
          !Number.isInteger(total) ||
          total < 0 ||
          total > maximumBatchesPerState * 20 ||
          (expectedCount !== undefined && total !== expectedCount) ||
          !Array.isArray(rows) ||
          rows.length !== Math.min(20, total - count)
        ) {
          throw invalidResponse();
        }
        expectedCount = total;
        for (const value of rows) {
          const row = object(value);
          if (
            !row ||
            !identity(row.listingId) ||
            !identity(row.sellerId) ||
            !identity(row.productId) ||
            !identity(row.sku) ||
            (sellerId !== undefined && sellerId !== row.sellerId) ||
            skus.has(row.sku) ||
            ids.has(row.listingId)
          ) {
            throw invalidResponse();
          }
          sellerId = row.sellerId;
          skus.add(row.sku);
          ids.add(row.listingId);
          const description = object(row.product_description);
          listings.push({
            id: row.listingId,
            accountId,
            sellerId,
            productId: row.productId,
            sku: row.sku,
            title:
              typeof row.product_name === 'string' && row.product_name.trim()
                ? row.product_name
                : row.sku,
            imageUrl: imageUrl(row.product_image_url),
            // The state-specific search is richer than the ACTIVE/INACTIVE field in a row.
            status: state,
            mrp: observedNumber(description?.mrp),
            sellingPrice: observedNumber(description?.ssp),
            locations: [],
            observedAt: new Date(this.now()).toISOString(),
            version: 0,
          });
        }
        count += rows.length;
        if (count === expectedCount) break;
      }
      if (count !== expectedCount) throw invalidResponse();
    }

    const detailed: MarketplaceListing[] = [];
    for (let start = 0; start < listings.length; start += 10) {
      detailed.push(...(await this.details(token, listings.slice(start, start + 10), true)));
    }
    return detailed;
  }

  async getListing(
    token: string,
    listing: MarketplaceListing,
    options: { requireCurrentStatus?: boolean } = {},
  ): Promise<MarketplaceListing> {
    validateListing(listing);
    return (await this.details(token, [listing], false, options.requireCurrentStatus))[0];
  }

  async updateStock(
    token: string,
    listing: MarketplaceListing,
    locationId: string,
    quantity: number,
  ): Promise<void> {
    validateListing(listing);
    if (observedNumber(quantity) === null) {
      throw new FlipkartListingError('Enter a whole stock quantity between 0 and 2147483647.');
    }
    const locations = listing.locations.filter((location) => location.id === locationId);
    if (
      !identity(locationId) ||
      locations.length !== 1 ||
      !['ENABLED', 'DISABLED'].includes(locations[0].status)
    ) {
      throw new FlipkartListingError('Refresh this listing to verify the selected stock location.');
    }
    const response = await this.post(
      token,
      '/update/inventory',
      {
        [listing.sku]: {
          product_id: listing.productId,
          locations: [{ id: locationId, status: locations[0].status, inventory: quantity }],
        },
      },
      true,
    );
    this.checkUpdate(response, listing.sku);
  }

  async updatePrice(
    token: string,
    listing: MarketplaceListing,
    mrp: number,
    sellingPrice: number,
  ): Promise<void> {
    validateListing(listing);
    if (
      observedNumber(mrp) === null ||
      observedNumber(sellingPrice) === null ||
      sellingPrice <= 0 ||
      sellingPrice > mrp
    ) {
      throw new FlipkartListingError(
        'Enter whole rupee prices with a positive selling price no higher than MRP.',
      );
    }
    const response = await this.post(
      token,
      '/update/price',
      {
        [listing.sku]: {
          product_id: listing.productId,
          price: { mrp, selling_price: sellingPrice, currency: 'INR' },
        },
      },
      true,
    );
    this.checkUpdate(response, listing.sku);
  }

  private async details(
    token: string,
    listings: MarketplaceListing[],
    allowSearchPrices: boolean,
    requireCurrentStatus = false,
  ): Promise<MarketplaceListing[]> {
    const response = await this.post(token, '/details', {
      sku_ids: listings.map((row) => row.sku),
    });
    const available = object(response.available);
    const skus = new Set(listings.map((listing) => listing.sku));
    if (
      !available ||
      Object.keys(available).length !== listings.length ||
      Object.keys(available).some((sku) => !skus.has(sku)) ||
      ['unavailable', 'invalid'].some(
        (key) =>
          response[key] !== undefined &&
          (!Array.isArray(response[key]) || response[key].length !== 0),
      )
    ) {
      throw invalidResponse();
    }
    return listings.map((listing) => {
      const detail = object(available[listing.sku]);
      if (
        !detail ||
        detail.listing_id !== listing.id ||
        detail.product_id !== listing.productId ||
        (detail.seller_id !== undefined &&
          (!identity(detail.seller_id) ||
            (listing.sellerId !== null && detail.seller_id !== listing.sellerId))) ||
        (detail.sellerId !== undefined &&
          (!identity(detail.sellerId) ||
            (listing.sellerId !== null && detail.sellerId !== listing.sellerId))) ||
        (detail.seller_id !== undefined &&
          detail.sellerId !== undefined &&
          detail.seller_id !== detail.sellerId) ||
        (detail.sku !== undefined && detail.sku !== listing.sku)
      ) {
        throw invalidResponse();
      }
      if (
        requireCurrentStatus &&
        detail.archived_status !== 'ARCHIVED' &&
        ((detail.archived_status !== undefined && detail.archived_status !== 'NONE') ||
          (detail.listing_status !== 'ACTIVE' && detail.listing_status !== 'INACTIVE'))
      )
        throw new FlipkartListingError(
          'Flipkart did not confirm the current listing status. Refresh listings before updating stock.',
        );
      const locations: MarketplaceLocation[] = [];
      const locationIds = new Set<string>();
      if (detail.locations !== undefined && !Array.isArray(detail.locations)) {
        throw invalidResponse();
      }
      for (const value of detail.locations ?? []) {
        const location = object(value);
        if (!location || !identity(location.id) || locationIds.has(location.id)) {
          throw invalidResponse();
        }
        locationIds.add(location.id);
        locations.push({
          id: location.id,
          quantity: observedNumber(location.inventory),
          status:
            location.status === 'ENABLED' || location.status === 'DISABLED'
              ? location.status
              : 'UNKNOWN',
        });
      }
      const price = object(detail.price);
      const hasMrp = price !== null && Object.hasOwn(price, 'mrp');
      const hasSellingPrice =
        price !== null &&
        (Object.hasOwn(price, 'selling_price') || Object.hasOwn(price, 'flipkart_selling_price'));
      const currencyValid = price?.currency === 'INR';
      // Both names occur in official v3 read documentation; never substitute ESP/settlement.
      const sellingPrice = Object.hasOwn(price ?? {}, 'selling_price')
        ? price?.selling_price
        : price?.flipkart_selling_price;
      const status: MarketplaceListingStatus =
        detail.archived_status === 'ARCHIVED'
          ? 'ARCHIVED'
          : ['ACTIVE', 'INACTIVE'].includes(listing.status) &&
              (detail.listing_status === 'ACTIVE' || detail.listing_status === 'INACTIVE')
            ? detail.listing_status
            : listing.status;
      return {
        ...listing,
        sellerId: identity(detail.seller_id)
          ? detail.seller_id
          : identity(detail.sellerId)
            ? detail.sellerId
            : listing.sellerId,
        title:
          typeof detail.product_title === 'string' && detail.product_title.trim()
            ? detail.product_title
            : listing.title,
        imageUrl: imageUrl(detail.product_image_url) ?? listing.imageUrl,
        status,
        packageCount:
          Array.isArray(detail.packages) &&
          detail.packages.length > 0 &&
          detail.packages.every((entry) => object(entry) !== null)
            ? detail.packages.length
            : null,
        mrp:
          allowSearchPrices && !hasMrp
            ? listing.mrp
            : currencyValid
              ? observedNumber(price?.mrp)
              : null,
        sellingPrice:
          allowSearchPrices && !hasSellingPrice
            ? listing.sellingPrice
            : currencyValid
              ? observedNumber(sellingPrice)
              : null,
        locations,
        observedAt: new Date(this.now()).toISOString(),
      };
    });
  }

  private checkUpdate(response: Record<string, unknown>, sku: string): void {
    if (Object.keys(response).length !== 1 || !Object.hasOwn(response, sku)) {
      throw invalidResponse(true);
    }
    const result = object(response[sku]);
    if (!result) throw invalidResponse(true);
    if (result.status === 'FAILURE') {
      throw new FlipkartListingError(
        'Flipkart rejected this listing update. Check the listing in Seller Hub before trying again.',
      );
    }
    if (result.status === 'WARNING') {
      throw new FlipkartListingError(
        'Flipkart reported a warning for this update. Check the marketplace before retrying.',
        true,
      );
    }
    if (
      result.status !== 'SUCCESS' ||
      ['errors', 'attribute_errors'].some(
        (key) =>
          result[key] !== undefined && (!Array.isArray(result[key]) || result[key].length !== 0),
      )
    ) {
      throw invalidResponse(true);
    }
  }

  private async post(
    token: string,
    path: string,
    body: unknown,
    write = false,
  ): Promise<Record<string, unknown>> {
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,16384}$/u.test(token)) {
      throw new FlipkartListingError(
        'Check this marketplace account connection before continuing.',
      );
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new FlipkartListingError(
              'Flipkart did not respond in time. Check the result before retrying.',
              write,
            ),
          );
        }, this.timeoutMs);
      });
      const operation = async () => {
        const response = await this.request(`${apiRoot}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          if (path === '/product/search' && response.status === 404)
            throw new ProductSearchUnavailable(
              'Flipkart product search is unavailable for this account.',
            );
          if (response.status === 401 || response.status === 403) {
            throw new FlipkartListingError(
              'Flipkart rejected this account access. Check the account connection.',
            );
          }
          if (response.status === 429) {
            throw new FlipkartListingError('Flipkart is limiting requests. Try again later.');
          }
          const uncertain =
            write && (response.status >= 500 || response.status === 408 || response.status < 400);
          throw new FlipkartListingError(
            uncertain
              ? 'Flipkart could not confirm this update. Check the marketplace before retrying.'
              : 'Flipkart could not complete this request. Check the listing and try again.',
            uncertain,
          );
        }
        // A 202 acknowledges processing. Only a finished HTTP 200 and the
        // exact SKU's success response establish completion of an inventory write.
        if (path === '/update/inventory' && response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);
          throw invalidResponse(true);
        }
        return readResponse(response, write);
      };
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (error instanceof FlipkartListingError) throw error;
      // Neither upstream bodies nor transport error text are safe for the public response.
      throw new FlipkartListingError(
        write
          ? 'Could not confirm the Flipkart update. Check the marketplace before retrying.'
          : 'Could not read Flipkart listings. Check the connection and try again.',
        write,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
