import type { Company, Listing } from '../shared/contracts.js';

const indiaDay = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium',
  timeZone: 'Asia/Kolkata',
});

export function formatIndiaDay(value: string): string {
  return indiaDay.format(new Date(value));
}

export function formatCompanyStockIssue(issue: NonNullable<Company['stockIssue']>): string {
  if (issue === 'unloaded') return 'Company unloaded in Tally';
  if (issue === 'read-failed') return 'Stock read failed';
  return 'Fresh stock check needed';
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'Not yet observed';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function formatQuantity(value: number | null): string {
  return value === null
    ? '-'
    : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 17 }).format(value);
}

export function formatUnits(quantity: number, source: 'listing' | 'Tally'): string {
  return `${quantity} ${source} unit${quantity === 1 ? '' : 's'}`;
}

export function formatRemainingSales(remaining: number | null): string {
  if (remaining === null) return 'Remaining allowance unknown';
  return `${remaining} ${remaining === 1 ? 'sale' : 'sales'} remaining`;
}

export function formatPolicy(listing: Listing): string {
  if (listing.policy === 'limited') {
    if (listing.remaining === 0) return 'Allowance used up';
    return formatRemainingSales(listing.remaining);
  }
  return 'Auto';
}
