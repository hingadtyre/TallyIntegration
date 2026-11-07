import type {
  Activity,
  Company,
  ConnectionStatus,
  Listing,
  Proposal,
  SellerAccount,
  Settings,
  Snapshot,
  StockItem,
} from '../../shared/contracts.js';

type RecordValue = Record<string, unknown>;

export class InvalidStoredState extends Error {
  constructor(field: string, reason: string) {
    super(`Invalid stored state: ${field} ${reason}. The database was not changed.`);
    this.name = 'InvalidStoredState';
  }
}

function record(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidStoredState(field, 'must be an object');
  }
  return value as RecordValue;
}

function string(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new InvalidStoredState(field, 'must be text');
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}

function timestamp(value: unknown, field: string): string {
  const result = string(value, field);
  if (!Number.isFinite(Date.parse(result)))
    throw new InvalidStoredState(field, 'must be a valid timestamp');
  return result;
}

function nullableTimestamp(value: unknown, field: string): string | null {
  return value === null ? null : timestamp(value, field);
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidStoredState(field, 'must be true or false');
  return value;
}

function number(value: unknown, field: string, minimum = -Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER ||
    value < minimum
  ) {
    throw new InvalidStoredState(field, 'must be a finite number in its allowed range');
  }
  return value;
}

function integer(value: unknown, field: string, minimum = 0): number {
  const result = number(value, field, minimum);
  if (!Number.isSafeInteger(result)) throw new InvalidStoredState(field, 'must be a whole number');
  return result;
}

function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new InvalidStoredState(field, `must be one of ${choices.join(', ')}`);
  }
  return value as T;
}

function array<T>(value: unknown, field: string, parse: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) throw new InvalidStoredState(field, 'must be an array');
  return value.map((entry, index) => parse(entry, `${field}[${index}]`));
}

function company(value: unknown, field: string): Company {
  const row = record(value, field);
  return {
    id: string(row.id, `${field}.id`),
    name: string(row.name, `${field}.name`),
    automation: boolean(row.automation, `${field}.automation`),
    source: choice(row.source, ['tally', 'demo'], `${field}.source`),
    lastSuccess: nullableTimestamp(row.lastSuccess, `${field}.lastSuccess`),
  };
}

function item(value: unknown, field: string): StockItem {
  const row = record(value, field);
  return {
    id: string(row.id, `${field}.id`),
    companyId: string(row.companyId, `${field}.companyId`),
    externalId: string(row.externalId, `${field}.externalId`),
    name: string(row.name, `${field}.name`),
    brand: string(row.brand, `${field}.brand`, true),
    unit: string(row.unit, `${field}.unit`, true),
    physical: row.physical === null ? null : number(row.physical, `${field}.physical`),
    observedAt: nullableTimestamp(row.observedAt, `${field}.observedAt`),
    version: integer(row.version, `${field}.version`),
    lowStockThreshold: number(row.lowStockThreshold, `${field}.lowStockThreshold`, 0),
  };
}

function account(value: unknown, field: string): SellerAccount {
  const row = record(value, field);
  return {
    id: string(row.id, `${field}.id`),
    marketplace: choice(row.marketplace, ['flipkart'], `${field}.marketplace`),
    name: string(row.name, `${field}.name`),
    status: choice(row.status, ['not-connected', 'demo'], `${field}.status`),
  };
}

function listing(value: unknown, field: string): Listing {
  const row = record(value, field);
  const result: Listing = {
    id: string(row.id, `${field}.id`),
    accountId: string(row.accountId, `${field}.accountId`),
    sku: string(row.sku, `${field}.sku`),
    title: string(row.title, `${field}.title`, true),
    location: string(row.location, `${field}.location`),
    itemId: nullableString(row.itemId, `${field}.itemId`),
    packSize: row.packSize === null ? null : integer(row.packSize, `${field}.packSize`, 1),
    packEvidence: string(row.packEvidence, `${field}.packEvidence`, true),
    verified: boolean(row.verified, `${field}.verified`),
    observed: row.observed === null ? null : integer(row.observed, `${field}.observed`),
    observedAt: nullableTimestamp(row.observedAt, `${field}.observedAt`),
    policy: choice(row.policy, ['auto', 'limited', 'hold'], `${field}.policy`),
    remaining: row.remaining === null ? null : integer(row.remaining, `${field}.remaining`),
    paused: boolean(row.paused, `${field}.paused`),
    version: integer(row.version, `${field}.version`),
  };
  if (result.policy === 'limited' && result.remaining === null) {
    throw new InvalidStoredState(`${field}.remaining`, 'is required for Limited sales');
  }
  return result;
}

function proposal(value: unknown, field: string): Proposal {
  const row = record(value, field);
  return {
    listingId: string(row.listingId, `${field}.listingId`),
    quantity: integer(row.quantity, `${field}.quantity`),
    calculated: integer(row.calculated, `${field}.calculated`),
    edited: boolean(row.edited, `${field}.edited`),
    itemVersion: integer(row.itemVersion, `${field}.itemVersion`, -1),
    listingVersion: integer(row.listingVersion, `${field}.listingVersion`),
    ruleVersion: string(row.ruleVersion, `${field}.ruleVersion`),
    createdAt: timestamp(row.createdAt, `${field}.createdAt`),
    stale: boolean(row.stale, `${field}.stale`),
  };
}

function activity(value: unknown, field: string): Activity {
  const row = record(value, field);
  return {
    id: string(row.id, `${field}.id`),
    at: timestamp(row.at, `${field}.at`),
    level: choice(row.level, ['info', 'warning', 'error'], `${field}.level`),
    operation: string(row.operation, `${field}.operation`),
    message: string(row.message, `${field}.message`, true),
    ...(row.companyId === undefined
      ? {}
      : { companyId: string(row.companyId, `${field}.companyId`) }),
    ...(row.listingId === undefined
      ? {}
      : { listingId: string(row.listingId, `${field}.listingId`) }),
  };
}

function settings(value: unknown): Settings {
  const row = record(value, 'settings');
  return {
    tallyUrl: string(row.tallyUrl, 'settings.tallyUrl'),
    tallySeconds: integer(row.tallySeconds, 'settings.tallySeconds', 5),
    marketplaceSeconds: integer(row.marketplaceSeconds, 'settings.marketplaceSeconds', 30),
    catalogSeconds: integer(row.catalogSeconds, 'settings.catalogSeconds', 60),
    backupFolder: string(row.backupFolder, 'settings.backupFolder'),
  };
}

function connection(value: unknown): ConnectionStatus {
  const row = record(value, 'connection');
  return {
    tally: choice(row.tally, ['not-checked', 'online', 'offline'], 'connection.tally'),
    message: string(row.message, 'connection.message', true),
    lastChecked: nullableTimestamp(row.lastChecked, 'connection.lastChecked'),
    nextPoll: nullableTimestamp(row.nextPoll, 'connection.nextPoll'),
  };
}

function unique(values: string[], field: string): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length)
    throw new InvalidStoredState(field, 'contains duplicate identities');
  return result;
}

/** The same validator protects migration input and every storage transaction.
 * Parsing creates detached values; TypeScript assertions cannot validate disk data. */
export function validateSnapshot(value: unknown): Snapshot {
  const row = record(value, 'snapshot');
  if (row.publishingEnabled !== false)
    throw new InvalidStoredState('publishingEnabled', 'must remain false in this build');
  const state: Snapshot = {
    mode: choice(row.mode, ['live', 'demo'], 'mode'),
    publishingEnabled: false,
    companies: array(row.companies, 'companies', company),
    items: array(row.items, 'items', item),
    accounts: array(row.accounts, 'accounts', account),
    listings: array(row.listings, 'listings', listing),
    proposals: array(row.proposals, 'proposals', proposal),
    activity: array(row.activity, 'activity', activity),
    settings: settings(row.settings),
    connection: connection(row.connection),
  };
  const companies = unique(
    state.companies.map((row) => row.id),
    'companies',
  );
  const items = unique(
    state.items.map((row) => row.id),
    'items',
  );
  const accounts = unique(
    state.accounts.map((row) => row.id),
    'accounts',
  );
  const listings = unique(
    state.listings.map((row) => row.id),
    'listings',
  );
  unique(
    state.proposals.map((row) => row.listingId),
    'proposals',
  );
  unique(
    state.activity.map((row) => row.id),
    'activity',
  );
  unique(
    state.items.map((row) => JSON.stringify([row.companyId, row.externalId])),
    'company stock identities',
  );
  for (const item of state.items) {
    if (!companies.has(item.companyId))
      throw new InvalidStoredState('item.companyId', 'references a missing company');
  }
  for (const listing of state.listings) {
    if (!accounts.has(listing.accountId))
      throw new InvalidStoredState('listing.accountId', 'references a missing seller account');
    if (listing.itemId !== null && !items.has(listing.itemId))
      throw new InvalidStoredState('listing.itemId', 'references a missing stock item');
  }
  for (const proposal of state.proposals) {
    if (!listings.has(proposal.listingId))
      throw new InvalidStoredState('proposal.listingId', 'references a missing listing');
  }
  return state;
}

export function parseLegacySnapshot(json: string): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidStoredState('snapshot', 'is not valid JSON');
  }
  return validateSnapshot(value);
}
