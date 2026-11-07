import type { Company, Listing, Snapshot } from '../shared/contracts.js';

export class InputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'InputError';
  }
}

export function requireWholeNumber(value: unknown, name: string, min = 0, max = 1_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new InputError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value as number;
}

export function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) {
    throw new InputError(`${name} is required.`);
  }
  return value;
}

export function requireCompany(state: Snapshot, id: unknown): Company {
  const company = state.companies.find((row) => row.id === id);
  if (!company) throw new InputError('Select a valid Tally company.');
  return company;
}

/** Validate the complete command scope before the transaction changes any row. */
export function requireListings(state: Snapshot, companyId: unknown, ids: unknown): Listing[] {
  requireCompany(state, companyId);
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 5000 ||
    ids.some((id) => typeof id !== 'string')
  ) {
    throw new InputError('Select one or more listings.');
  }
  return [...new Set(ids as string[])].map((id) => {
    const listing = state.listings.find((row) => row.id === id);
    const belongsToCompany = state.items.some(
      (item) => item.id === listing?.itemId && item.companyId === companyId,
    );
    if (!listing || !belongsToCompany)
      throw new InputError('A listing is outside the selected company.');
    return listing;
  });
}
