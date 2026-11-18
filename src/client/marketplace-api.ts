import type {
  MarketplaceAccount,
  MarketplaceApplyInput,
  MarketplaceApplyResult,
  MarketplaceListingStatus,
  MarketplaceListingView,
  MarketplacePage,
} from '../shared/marketplace-contracts.js';
import { requestJson } from './api.js';

export const marketplaceApi = {
  accounts: (signal?: AbortSignal) =>
    requestJson<{ accounts: MarketplaceAccount[] }>('/marketplaces', undefined, signal),
  add: (input: {
    name: string;
    marketplace: 'flipkart';
    applicationId: string;
    applicationSecret: string;
    verify: boolean;
  }) => requestJson<MarketplaceAccount>('/marketplaces/add', input),
  connection: (input: {
    accountId: string;
    action: 'check' | 'disconnect' | 'save' | 'connect';
    applicationId?: string;
    applicationSecret?: string;
  }) => requestJson<MarketplaceAccount>('/marketplaces/connection', input),
  listings: (
    accountId: string,
    search: string,
    status: MarketplaceListingStatus | '',
    page: number,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ accountId, search, status, page: String(page) });
    return requestJson<MarketplacePage>(`/marketplaces/listings?${query}`, undefined, signal);
  },
  refresh: (accountId: string) =>
    requestJson<{ account: MarketplaceAccount }>('/marketplaces/refresh', { accountId }),
  apply: (input: MarketplaceApplyInput) =>
    requestJson<MarketplaceApplyResult>('/marketplaces/apply', input),
  reconcile: (accountId: string, changeId: string) =>
    requestJson<MarketplaceApplyResult>('/marketplaces/reconcile', { accountId, changeId }),
  policy: (input: {
    accountId: string;
    listingId: string;
    locationId: string;
    version: number;
    policy: 'auto';
    confirmed: true;
  }) => requestJson<MarketplaceListingView>('/marketplaces/policy', input),
};
