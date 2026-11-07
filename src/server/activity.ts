import { randomUUID } from 'node:crypto';
import type { Activity, Snapshot } from '../shared/contracts.js';

/** Business history is part of the same transaction as the command it describes. */
export function recordActivity(
  state: Snapshot,
  operation: string,
  message: string,
  details: Pick<Partial<Activity>, 'companyId' | 'listingId' | 'level'> = {},
): void {
  state.activity.unshift({
    id: randomUUID(),
    at: new Date().toISOString(),
    level: 'info',
    operation,
    message,
    ...details,
  });
  const oldestRetainedTime = Date.now() - 90 * 86400_000;
  // This is display-history retention, not deletion of operational order receipts.
  state.activity = state.activity.filter((event) => Date.parse(event.at) >= oldestRetainedTime);
}
