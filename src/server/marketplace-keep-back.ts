import { createHash } from 'node:crypto';
import { completePacks } from '../domain/stock-policy.js';
import type { Snapshot } from '../shared/contracts.js';
import { keepBackUnitIssue } from '../shared/contracts.js';
import type {
  MarketplaceKeepBackReview,
  MarketplaceListing,
} from '../shared/marketplace-contracts.js';
import { requireStockSource } from './proposals.js';
import { InputError } from './validation.js';

export type CheckedAvailability = (
  companyId: string,
  itemId: string,
) => Promise<{ physical: number; reservedUnits: number; available: number; verify: () => void }>;

export function keepBackSource(state: Snapshot, listing: MarketplaceListing, location: string) {
  const mappings = state.listings.filter(
    (row) =>
      row.accountId === listing.accountId && row.sku === listing.sku && row.location === location,
  );
  for (const row of mappings) {
    const item = state.items.find((entry) => entry.id === row.itemId);
    if (!item?.keepBackUnits) continue;
    if (item.keepBackPreviousUnit !== undefined) throw new InputError(keepBackUnitIssue, 409);
    if (mappings.length !== 1)
      throw new InputError(
        'Check the conflicting stock mappings for this pickup in Inventory.',
        409,
      );
    const version = JSON.stringify([
      listing.accountId,
      listing.id,
      listing.version,
      location,
      row.id,
      row.version,
      row.packSize,
      item.companyId,
      item.id,
      item.version,
      item.keepBackUnits,
      item.physical,
      item.unit,
    ]);
    return { item, row, version };
  }
  return null;
}

export async function checkManualKeepBack(
  state: Snapshot,
  listing: MarketplaceListing,
  location: string,
  availableStock?: CheckedAvailability,
) {
  const source = keepBackSource(state, listing, location);
  if (!source) return null;
  const { item, row } = source;
  let packs: number | null = null;
  let reservedUnits: number | null = null;
  let verify: (() => void) | undefined;
  if (availableStock && (row.packSource !== 'packages' || listing.packageCount === row.packSize)) {
    try {
      const { packSize } = requireStockSource(state, row, item);
      const checked = await availableStock(item.companyId, item.id);
      checked.verify();
      packs = completePacks(checked.available, packSize);
      reservedUnits = checked.reservedUnits;
      verify = checked.verify;
    } catch (error) {
      // Manual updates are still available when order or stock evidence is missing.
      // In that case every positive quantity requires the unknown-availability warning.
      if (!(error instanceof InputError)) throw error;
    }
  }
  const review: MarketplaceKeepBackReview = {
    itemName: item.name,
    unit: item.unit,
    keepBackUnits: item.keepBackUnits,
    completePacks: packs,
    reviewKey: createHash('sha256')
      .update(JSON.stringify([source.version, reservedUnits, packs]))
      .digest('hex'),
  };
  return {
    review,
    version: source.version,
    usesPackageCount: row.packSource === 'packages',
    verify,
  };
}
