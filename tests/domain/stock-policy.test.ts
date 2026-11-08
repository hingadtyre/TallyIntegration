import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyFlipkartTyreFloor,
  calculateStock,
  completePacks,
  InvalidStockInput,
  type StockPolicy,
} from '../../src/domain/stock-policy.js';

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

test('an allowance above calculated stock does not increase the advertised quantity', () => {
  const policy: StockPolicy = { mode: 'limited', remaining: 20 };
  assert.deepEqual(calculateStock({ physical: 4, packSize: 2, policy }), {
    completePacks: 2,
    advertised: 5,
    desired: 5,
  });
  assert.deepEqual(calculateStock({ physical: 12, packSize: 2, policy }), {
    completePacks: 6,
    advertised: 6,
    desired: 6,
  });
  assert.equal(policy.remaining, 20, 'recalculation does not consume or grant allowance');
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
