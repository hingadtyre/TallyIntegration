import type { Listing } from '../shared/contracts.js';

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Not yet observed';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatQuantity(value: number | null): string {
  return value === null ? '-' : new Intl.NumberFormat().format(value);
}

export function formatPolicy(listing: Listing): string {
  if (listing.policy === 'hold') return 'Kept out of stock';
  if (listing.policy === 'limited') {
    if (listing.remaining === 0) return 'Allowance used up';
    return `${listing.remaining} ${listing.remaining === 1 ? 'sale' : 'sales'} remaining`;
  }
  return 'Auto';
}
