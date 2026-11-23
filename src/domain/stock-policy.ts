/** Stock arithmetic only. Connection freshness, pack evidence and dispatch permissions
 * must be validated by the application before publishing any result. */
export interface StockPolicy {
  mode: 'auto' | 'limited';
  remaining: number | null;
}

export interface StockCalculation {
  completePacks: number;
  advertised: number;
  desired: number;
}

export class InvalidStockInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStockInput';
  }
}

export function requireNonnegativeUnits(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidStockInput(`${name} must be a nonnegative safe integer.`);
  }
}

function decimalUnits(value: number) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  return { digits: BigInt(whole + fraction), scale: fraction.length - Number(exponent) };
}

/** All three values are in the stock item's Tally base unit. Reservations are whole units. */
export function availableForMarketplaces(
  physical: number,
  reservedUnits: number,
  keepBackUnits: number,
): number {
  if (Number.isInteger(physical) && Number.isInteger(keepBackUnits))
    return Math.max(0, physical - reservedUnits - keepBackUnits);
  // Subtract the source decimals exactly (8.2 minus 0.2 makes eight whole units).
  const stock = decimalUnits(physical);
  const kept = decimalUnits(keepBackUnits);
  const scale = Math.max(0, stock.scale, kept.scale);
  const divisor = 10n ** BigInt(scale);
  const net =
    stock.digits * 10n ** BigInt(scale - stock.scale) -
    kept.digits * 10n ** BigInt(scale - kept.scale) -
    BigInt(reservedUnits) * divisor;
  if (net <= 0n) return 0;
  const result = Number(String(net) + 'e-' + scale);
  // A tiny keep-back can round the result UP to a whole unit. Keep the returned
  // balance just below that boundary so it cannot manufacture a complete pack.
  if (Number.isInteger(result) && BigInt(result) > net / divisor)
    return result - (result * Number.EPSILON) / 2;
  return result;
}

/** Convert physical base units into complete sellable packs. */
export function completePacks(physical: number, packSize: number): number {
  if (!Number.isFinite(physical) || Math.abs(physical) > Number.MAX_SAFE_INTEGER) {
    throw new InvalidStockInput('Physical stock must be a finite, safely representable number.');
  }
  if (!Number.isSafeInteger(packSize) || packSize < 1) {
    throw new InvalidStockInput('Pack size must be a positive safe integer.');
  }
  return Math.floor(Math.max(0, physical) / packSize);
}

/** Seller-approved Flipkart tyre rule. This is not physical stock or a general
 * rule for other marketplaces: advertise at least five only for a complete pack. */
export function applyFlipkartTyreFloor(packs: number): number {
  requireNonnegativeUnits(packs, 'Complete packs');
  return packs === 0 ? 0 : Math.max(5, packs);
}

/** A remaining allowance is supplied by persisted order accounting. Recalculating
 * stock never grants allowance, consumes an order, or decides whether to publish. */
export function calculateStock(input: {
  physical: number;
  packSize: number;
  /** Existing callers model the original tyre policy. New mappings explicitly select a rule. */
  tyreFloor?: boolean;
  policy: StockPolicy;
}): StockCalculation {
  const packs = completePacks(input.physical, input.packSize);
  const advertised = input.tyreFloor === false ? packs : applyFlipkartTyreFloor(packs);
  const { mode, remaining } = input.policy;
  if (remaining !== null) requireNonnegativeUnits(remaining, 'Remaining allowance');

  switch (mode) {
    case 'auto':
      return { completePacks: packs, advertised, desired: advertised };
    case 'limited':
      if (remaining === null) {
        throw new InvalidStockInput('Limited sales requires a remaining allowance.');
      }
      return { completePacks: packs, advertised, desired: Math.min(advertised, remaining) };
    default:
      throw new InvalidStockInput('Unknown stock policy.');
  }
}
