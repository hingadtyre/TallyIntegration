import { InvalidStockInput, requireNonnegativeUnits } from './stock-policy.js';

export interface AllowanceIdentity {
  sellerAccountId: string;
  listingId: string;
  generationId: string;
}

export interface ActiveAllowance extends AllowanceIdentity {
  remaining: number;
}

/** An APPROVED order already attributed to this activation generation by the
 * application. Merely copying the current generation onto an old order is unsafe. */
export interface AttributedApprovedOrder extends AllowanceIdentity {
  orderItemId: string;
  status: 'APPROVED';
  quantity: number;
}

export interface ConsumptionReceipt extends AllowanceIdentity {
  orderItemId: string;
  consumedQuantity: number;
}

function validateIdentity(identity: AllowanceIdentity): void {
  for (const value of [identity.sellerAccountId, identity.listingId, identity.generationId]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new InvalidStockInput(
        'Allowance identity must include account, listing and generation.',
      );
    }
  }
}

function sameAllowance(left: AllowanceIdentity, right: AllowanceIdentity): boolean {
  return (
    left.sellerAccountId === right.sellerAccountId &&
    left.listingId === right.listingId &&
    left.generationId === right.generationId
  );
}

/** Pure accounting primitive, not a production activation/baseline algorithm.
 *
 * The caller must first prove that the approved order qualifies for this exact
 * activation, including orders arriving during publication. Persist the returned
 * allowance and receipt together in one transaction, using a unique receipt key
 * (seller account, listing, generation, order item), and retry from current state.
 * Missing/stale order coverage must block allowance increases upstream.
 *
 * Quantity is in listing units (packs), never Tally pieces. Repeated observations
 * consume only a newly observed quantity increase; a decrease cannot refill the
 * allowance. Cancellation, return and Tally bill handlers must not restore it.
 */
export function consumeApprovedOrder(
  allowance: ActiveAllowance,
  order: AttributedApprovedOrder,
  previousReceipt: ConsumptionReceipt | null,
): { allowance: ActiveAllowance; receipt: ConsumptionReceipt; newlyConsumed: number } {
  validateIdentity(allowance);
  validateIdentity(order);
  requireNonnegativeUnits(allowance.remaining, 'Remaining allowance');
  requireNonnegativeUnits(order.quantity, 'Approved order quantity');
  if (order.quantity === 0 || order.status !== 'APPROVED') {
    throw new InvalidStockInput('Consumption requires a positive, approved order quantity.');
  }
  if (typeof order.orderItemId !== 'string' || order.orderItemId.trim() === '') {
    throw new InvalidStockInput('Consumption requires a stable order-item identity.');
  }
  if (!sameAllowance(allowance, order)) {
    throw new InvalidStockInput('Order does not belong to this exact allowance generation.');
  }
  if (previousReceipt !== null) {
    validateIdentity(previousReceipt);
    requireNonnegativeUnits(previousReceipt.consumedQuantity, 'Previously consumed quantity');
    if (
      !sameAllowance(allowance, previousReceipt) ||
      previousReceipt.orderItemId !== order.orderItemId
    ) {
      throw new InvalidStockInput(
        'Consumption receipt does not belong to this order and allowance.',
      );
    }
  }

  const consumedQuantity = Math.max(previousReceipt?.consumedQuantity ?? 0, order.quantity);
  const newlyConsumed = consumedQuantity - (previousReceipt?.consumedQuantity ?? 0);
  return {
    allowance: { ...allowance, remaining: Math.max(0, allowance.remaining - newlyConsumed) },
    receipt: {
      sellerAccountId: allowance.sellerAccountId,
      listingId: allowance.listingId,
      generationId: allowance.generationId,
      orderItemId: order.orderItemId,
      consumedQuantity,
    },
    newlyConsumed,
  };
}
