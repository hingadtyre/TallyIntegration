import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyFlipkartTyreFloor,
  calculateStock,
  completePacks,
  InvalidStockInput,
  type StockPolicy,
} from '../src/domain/stock-policy.js';
import {
  consumeApprovedOrder,
  type ActiveAllowance,
  type AttributedApprovedOrder,
} from '../src/domain/allowance.js';

const auto: StockPolicy = { mode: 'auto', remaining: null };

test('one physical tyre advertises five singles but no larger pack', () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((packSize) => calculateStock({ physical: 1, packSize, policy: auto }).desired),
    [5, 0, 0, 0],
  );
});

test('four physical tyres independently supply every eligible pack and duplicate', () => {
  assert.deepEqual(
    [1, 2, 3, 4].map((packSize) => calculateStock({ physical: 4, packSize, policy: auto })),
    [
      { completePacks: 4, advertised: 5, desired: 5 },
      { completePacks: 2, advertised: 5, desired: 5 },
      { completePacks: 1, advertised: 5, desired: 5 },
      { completePacks: 1, advertised: 5, desired: 5 },
    ],
  );
  const input = { physical: 4, packSize: 2, policy: auto };
  assert.deepEqual(calculateStock(input), calculateStock(input));
  assert.equal(input.physical, 4, 'calculating a listing must not reserve source stock');
});

test('zero and negative source stock produce zero for every pack', () => {
  for (const physical of [0, -1, -10]) {
    for (const packSize of [1, 2, 3, 4]) {
      assert.equal(calculateStock({ physical, packSize, policy: auto }).desired, 0);
    }
  }
});

test('pack arithmetic floors incomplete packs; advertising floor is a separate policy', () => {
  assert.equal(completePacks(11, 4), 2);
  assert.equal(completePacks(1.5, 1), 1);
  assert.equal(applyFlipkartTyreFloor(0), 0);
  assert.equal(applyFlipkartTyreFloor(3), 5);
  assert.equal(applyFlipkartTyreFloor(7), 7);
  assert.deepEqual(calculateStock({ physical: 20, packSize: 2, policy: auto }), {
    completePacks: 10,
    advertised: 10,
    desired: 10,
  });
});

test('limited sales uses remaining listing units, while a hold persists through purchases', () => {
  const limited: StockPolicy = { mode: 'limited', remaining: 1 };
  assert.deepEqual(calculateStock({ physical: 4, packSize: 2, policy: limited }), {
    completePacks: 2,
    advertised: 5,
    desired: 1,
  });
  assert.equal(calculateStock({ physical: 1, packSize: 2, policy: limited }).desired, 0);
  assert.equal(calculateStock({ physical: 20, packSize: 2, policy: limited }).desired, 1);
  assert.equal(limited.remaining, 1);
  assert.equal(
    calculateStock({ physical: 100, packSize: 1, policy: { mode: 'hold', remaining: 0 } }).desired,
    0,
  );
  assert.equal(
    calculateStock({ physical: 100, packSize: 1, policy: { mode: 'limited', remaining: 0 } })
      .desired,
    0,
  );
});

test('invalid observations are rejected even when policy would otherwise hold at zero', () => {
  for (const physical of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => calculateStock({ physical, packSize: 1, policy: { mode: 'hold', remaining: 0 } }),
      InvalidStockInput,
    );
  }
  for (const packSize of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => completePacks(10, packSize), InvalidStockInput);
  }
  for (const packs of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => applyFlipkartTyreFloor(packs), InvalidStockInput);
  }
  for (const remaining of [null, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => calculateStock({ physical: 5, packSize: 1, policy: { mode: 'limited', remaining } }),
      InvalidStockInput,
    );
  }
  assert.throws(
    () =>
      calculateStock({
        physical: 5,
        packSize: 1,
        policy: { mode: 'unknown', remaining: null } as unknown as StockPolicy,
      }),
    InvalidStockInput,
  );
});

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
  assert.throws(
    () =>
      consumeApprovedOrder(first.allowance, approvedOrder(), {
        ...first.receipt,
        generationId: 'old-generation',
      }),
    InvalidStockInput,
  );
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
