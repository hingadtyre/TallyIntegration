import type { FlipkartBillingOrder } from '../adapters/flipkart-billing.js';
import { billingOnlyMapping, type Snapshot } from '../shared/contracts.js';
import type { BillingData } from './storage/billing-records.js';
import type { MarketplaceData } from './storage/marketplace-records.js';
import { fingerprint } from './billing-matcher.js';
import { hasConfirmedPickup } from './marketplace-catalog.js';
import { requireCompany } from './validation.js';

export function stockConfiguration(
  state: Snapshot,
  market: MarketplaceData,
  billing: BillingData,
  companyId: string,
) {
  const company = requireCompany(state, companyId);
  const items = new Map(state.items.map((item) => [item.id, item]));
  const rules = billing.rules.filter((r) => r.companyId === companyId);
  const accounts = [
    ...new Set([
      ...rules.map((r) => r.accountId),
      ...state.listings
        .filter((l) => items.get(l.itemId ?? '')?.companyId === companyId)
        .map((l) => l.accountId),
    ]),
  ].sort();
  const bindings = state.listings.filter((l) => l.itemId && accounts.includes(l.accountId));
  const catalogue = new Map<string, typeof market.listings>();
  for (const remote of market.listings) {
    const key = JSON.stringify([remote.accountId, remote.sku]);
    const entries = catalogue.get(key) ?? [];
    entries.push(remote);
    catalogue.set(key, entries);
  }
  // Only source identities and conversion rules belong in the baseline. Ordinary
  // stock, listing metadata and refresh times can change on every poll.
  const mappingKeys: string[] = [];
  const billingOnlyKeys: string[] = [];
  for (const l of bindings) {
    const item = items.get(l.itemId!)!;
    const remote = (catalogue.get(JSON.stringify([l.accountId, l.sku])) ?? []).filter((r) =>
      l.skuMappingId ? r.id === l.skuMappingId : r.locations.some((loc) => loc.id === l.location),
    );
    const key = JSON.stringify([
      l.id,
      l.accountId,
      l.sku,
      l.location,
      l.itemId,
      item?.companyId,
      item?.externalId,
      item?.unit,
      l.packSize,
      l.packSource,
      l.packConfirmedAt,
      l.sourceScope,
      l.verified,
      remote.map((r) => JSON.stringify([r.id, r.productId, r.sellerId])).sort(),
    ]);
    (billingOnlyMapping(l) ? billingOnlyKeys : mappingKeys).push(key);
  }
  const signature = fingerprint([
    company.id,
    state.settings.tallyUrl,
    accounts.map((id) => [id, market.accounts.find((a) => a.id === id)?.sellerId]),
    rules.map((r) => JSON.stringify([r.accountId, r.ledgerId, r.field, r.reference])).sort(),
    mappingKeys.sort(),
  ]);
  const reviewState = fingerprint([
    billingOnlyKeys.sort(),
    billing.links
      .filter((link) => link.companyId === companyId || accounts.includes(link.accountId))
      .map((link) => JSON.stringify(link))
      .sort(),
    bindings
      .filter((l) => l.packSource === 'packages')
      .map((l) => JSON.stringify([l.id, l.packageAvailable, l.packageCount]))
      .sort(),
  ]);
  return {
    state,
    company,
    market,
    billing,
    accounts,
    rules,
    items,
    bindings,
    signature,
    reviewState,
  };
}

export function mappedSaleListing(
  ctx: ReturnType<typeof stockConfiguration>,
  accountId: string,
  order: FlipkartBillingOrder,
  purpose: 'stock' | 'billing' = 'stock',
) {
  const destinations = ctx.bindings.filter(
    (l) => l.accountId === accountId && l.sku === order.sku && l.location === order.locationId,
  );
  if (destinations.length !== 1) return null;
  const [destination] = destinations;
  const remote = ctx.market.listings.filter(
    (l) =>
      l.accountId === accountId &&
      l.sku === order.sku &&
      (!destination.skuMappingId || destination.skuMappingId === l.id) &&
      (l.locations.some((loc) => loc.id === order.locationId) ||
        hasConfirmedPickup(destination, l)),
  );
  return destination.verified &&
    (billingOnlyMapping(destination)
      ? purpose === 'billing'
      : ctx.state.mode !== 'live' || destination.sourceScope === 'company') &&
    remote.length === 1 &&
    remote[0].observedAt &&
    remote[0].id === order.listingId
    ? destination
    : null;
}

export function mappedSaleItem(
  ctx: ReturnType<typeof stockConfiguration>,
  accountId: string,
  order: FlipkartBillingOrder,
  purpose: 'stock' | 'billing' = 'stock',
) {
  return mappedSaleListing(ctx, accountId, order, purpose)?.itemId ?? null;
}
