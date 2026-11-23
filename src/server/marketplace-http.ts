import type { MarketplaceService } from './marketplace-service.js';
import { InputError } from './validation.js';

export async function runMarketplaceCommand(
  service: MarketplaceService,
  path: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (path) {
    case '/api/marketplaces/add':
      return service.add(input);
    case '/api/marketplaces/connection':
      return service.changeConnection(input);
    case '/api/marketplaces/refresh':
      return service.refresh(input.accountId);
    case '/api/marketplaces/apply':
      return service.apply(input);
    case '/api/marketplaces/keep-back/review':
      return service.reviewKeepBack(input);
    case '/api/marketplaces/reconcile':
      return service.reconcile(input);
    case '/api/marketplaces/recovery/review':
      return service.recoverStock(input, 'review');
    case '/api/marketplaces/recovery/approve':
      return service.recoverStock(input, 'approve');
    case '/api/marketplaces/policy':
      return service.changePolicy(input);
    default:
      throw new InputError('Route not found.', 404);
  }
}
