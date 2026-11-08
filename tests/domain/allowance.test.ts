import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateStock,
  InvalidStockInput,
  type StockPolicy,
} from '../../src/domain/stock-policy.js';
import {
  consumeApprovedOrder,
  type ActiveAllowance,
  type AttributedApprovedOrder,
} from '../../src/domain/allowance.js';

const auto: StockPolicy = { mode: 'auto', remaining: null };

const allowance = (remaining = 1): ActiveAllowance => ({
  sellerAccountId: 'seller-a',
  listingId: 'pair-listing',
  generationId: 'activation-1',
  remaining,
});
const approvedOrder = (quantity = 1): AttributedApprovedOrder => ({
  ...allowance(),
  orderItemId: 'order-item-1',
  status: 'APPROVED',
  quantity,
});

test('one approved pair order exhausts one listing-unit allowance before Tally billing', () => {
  const original = allowance();
  const result = consumeApprovedOrder(original, approvedOrder(), null);
  assert.equal(result.newlyConsumed, 1, 'a pair is one listing unit, not two allowance units');
  assert.equal(result.allowance.remaining, 0);
  assert.equal(original.remaining, 1, 'pure calculation must not mutate persisted input');
  for (const physical of [4, 2, 20]) {
    assert.equal(
      calculateStock({
        physical,
        packSize: 2,
        policy: { mode: 'limited', remaining: result.allowance.remaining },
      }).desired,
      0,
    );
  }
  const sibling = calculateStock({ physical: 4, packSize: 1, policy: auto });
  assert.equal(sibling.desired, 5, 'the sibling listing retains its policy');
});

test('repeated observations and quantity decreases cannot deduct twice or restore allowance', () => {
  const first = consumeApprovedOrder(allowance(5), approvedOrder(2), null);
  const repeat = consumeApprovedOrder(first.allowance, approvedOrder(2), first.receipt);
  assert.equal(repeat.newlyConsumed, 0);
  assert.equal(repeat.allowance.remaining, 3);
  const decrease = consumeApprovedOrder(repeat.allowance, approvedOrder(1), repeat.receipt);
  assert.equal(decrease.allowance.remaining, 3);
  assert.equal(decrease.receipt.consumedQuantity, 2);
  const increase = consumeApprovedOrder(decrease.allowance, approvedOrder(3), decrease.receipt);
  assert.equal(increase.newlyConsumed, 1);
  assert.equal(increase.allowance.remaining, 2);
});

test('an order exceeding the remaining allowance records full consumption and stays at zero', () => {
  const first = consumeApprovedOrder(allowance(), approvedOrder(3), null);
  assert.equal(first.allowance.remaining, 0);
  assert.equal(first.receipt.consumedQuantity, 3);
  assert.equal(
    consumeApprovedOrder(first.allowance, approvedOrder(3), first.receipt).newlyConsumed,
    0,
  );
});

test('account, listing, generation and order-item mismatches are blocked', () => {
  for (const key of ['sellerAccountId', 'listingId', 'generationId'] as const) {
    assert.throws(
      () => consumeApprovedOrder(allowance(), { ...approvedOrder(), [key]: 'different' }, null),
      InvalidStockInput,
    );
  }
  const first = consumeApprovedOrder(allowance(2), approvedOrder(), null);
  assert.throws(
    () =>
      consumeApprovedOrder(
        first.allowance,
        { ...approvedOrder(), orderItemId: 'other-order' },
        first.receipt,
      ),
    InvalidStockInput,
  );
  for (const key of ['sellerAccountId', 'listingId', 'generationId'] as const) {
    assert.throws(
      () =>
        consumeApprovedOrder(first.allowance, approvedOrder(), {
          ...first.receipt,
          [key]: 'different',
        }),
      InvalidStockInput,
    );
  }
});

test('incomplete identities and invalid receipts cannot consume allowance', () => {
  const first = consumeApprovedOrder(allowance(5), approvedOrder(), null);
  for (const key of ['sellerAccountId', 'listingId', 'generationId'] as const) {
    assert.throws(
      () => consumeApprovedOrder({ ...allowance(), [key]: ' ' }, approvedOrder(), null),
      InvalidStockInput,
    );
    assert.throws(
      () => consumeApprovedOrder(allowance(), { ...approvedOrder(), [key]: ' ' }, null),
      InvalidStockInput,
    );
    assert.throws(
      () =>
        consumeApprovedOrder(first.allowance, approvedOrder(), { ...first.receipt, [key]: ' ' }),
      InvalidStockInput,
    );
  }
  for (const consumedQuantity of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        consumeApprovedOrder(first.allowance, approvedOrder(), {
          ...first.receipt,
          consumedQuantity,
        }),
      InvalidStockInput,
    );
  }
  assert.equal(first.allowance.remaining, 4);
  assert.equal(first.receipt.consumedQuantity, 1);
});

test('malformed order observations cannot consume allowance', () => {
  for (const quantity of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(
      () => consumeApprovedOrder(allowance(), approvedOrder(quantity), null),
      InvalidStockInput,
    );
  }
  assert.throws(
    () => consumeApprovedOrder(allowance(), { ...approvedOrder(), orderItemId: '' }, null),
    InvalidStockInput,
  );
  assert.throws(
    () =>
      consumeApprovedOrder(
        allowance(),
        { ...approvedOrder(), status: 'CANCELLED' } as unknown as AttributedApprovedOrder,
        null,
      ),
    InvalidStockInput,
  );
  assert.throws(
    () => consumeApprovedOrder({ ...allowance(), remaining: -1 }, approvedOrder(), null),
    InvalidStockInput,
  );
});
