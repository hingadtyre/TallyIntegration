/** Stock arithmetic only. Connection freshness, pack evidence and dispatch permissions
 * must be validated by the application before publishing any result. */
export interface StockPolicy {
  mode: 'auto' | 'limited' | 'hold';
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
  policy: StockPolicy;
}): StockCalculation {
  // Validate stock even for a hold: missing observations are not a real zero.
  const packs = completePacks(input.physical, input.packSize);
  const advertised = applyFlipkartTyreFloor(packs);
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
    case 'hold':
      return { completePacks: packs, advertised, desired: 0 };
    default:
      throw new InvalidStockInput('Unknown stock policy.');
  }
}
