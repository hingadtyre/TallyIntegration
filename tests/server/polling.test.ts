import assert from 'node:assert/strict';
import test from 'node:test';
import { PollingLoop, type PollingTimers } from '../../src/server/polling.js';

class ManualClock implements PollingTimers {
  time = 0;
  private nextId = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();
  now(): number {
    return this.time;
  }
  schedule(callback: () => void, delay: number): () => void {
    const id = ++this.nextId;
    this.tasks.set(id, { at: this.time + delay, callback });
    return () => {
      this.tasks.delete(id);
    };
  }
  get pending(): number {
    return this.tasks.size;
  }
  get nextDelay(): number | null {
    if (!this.tasks.size) return null;
    return Math.min(...[...this.tasks.values()].map((task) => task.at)) - this.time;
  }
  async fireNext(): Promise<void> {
    const next = [...this.tasks.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    assert.ok(next, 'expected a scheduled check');
    this.time = next[1].at;
    this.tasks.delete(next[0]);
    next[1].callback();
    await flushTasks();
  }
}

function flushTasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test('an interval change waits for the active check and schedules the next run without overlap', async () => {
  const clock = new ManualClock();
  const current = deferred<boolean>();
  const nextRuns: (string | null)[] = [];
  let interval = 30_000;
  let calls = 0;
  const loop = new PollingLoop({
    task: () => {
      calls++;
      return current.promise;
    },
    intervalMilliseconds: () => interval,
    enabled: () => true,
    nextRunChanged: (at) => nextRuns.push(at),
    unexpectedError: (error) => {
      throw error;
    },
    timers: clock,
  });
  loop.start();
  assert.equal(clock.nextDelay, 30_000);
  await clock.fireNext();
  assert.equal(calls, 1);
  assert.equal(clock.pending, 0);
  assert.equal(nextRuns.at(-1), null);
  interval = 60_000;
  loop.settingsChanged();
  assert.equal(clock.pending, 0, 'settings cannot schedule a concurrent check');
  current.resolve(true);
  await loop.idle();
  await flushTasks();
  assert.equal(clock.nextDelay, 60_000);
  assert.equal(nextRuns.at(-1), new Date(90_000).toISOString());
  interval = 5_000;
  loop.settingsChanged();
  assert.equal(clock.nextDelay, 5_000, 'an idle interval change takes effect immediately');
  loop.stop();
  assert.equal(clock.pending, 0);
  assert.equal(nextRuns.at(-1), null);
});

test('failed checks back off and a successful check restores the configured interval', async () => {
  const clock = new ManualClock();
  const results = [false, false, true];
  const loop = new PollingLoop({
    task: async () => results.shift()!,
    intervalMilliseconds: () => 30_000,
    enabled: () => true,
    nextRunChanged: () => undefined,
    unexpectedError: (error) => {
      throw error;
    },
    timers: clock,
  });
  loop.start();
  await clock.fireNext();
  assert.equal(clock.nextDelay, 60_000);
  await clock.fireNext();
  assert.equal(clock.nextDelay, 120_000);
  await clock.fireNext();
  assert.equal(clock.nextDelay, 30_000);
  loop.stop();
});

test('manual requests serialize and stopping during a check prevents another automatic run', async () => {
  const clock = new ManualClock();
  const first = deferred<boolean>();
  let active = 0;
  let maximumActive = 0;
  const operations: string[] = [];
  const loop = new PollingLoop({
    task: async () => true,
    intervalMilliseconds: () => 30_000,
    enabled: () => true,
    nextRunChanged: () => undefined,
    unexpectedError: (error) => {
      throw error;
    },
    timers: clock,
  });
  loop.start();
  const firstRun = loop.runNow(async () => {
    operations.push('first started');
    maximumActive = Math.max(maximumActive, ++active);
    await first.promise;
    active--;
    operations.push('first finished');
    return true;
  });
  const secondRun = loop.runNow(async () => {
    operations.push('second started');
    maximumActive = Math.max(maximumActive, ++active);
    active--;
    return true;
  });
  assert.deepEqual(operations, ['first started']);
  loop.stop();
  first.resolve(true);
  await Promise.all([firstRun, secondRun]);
  assert.deepEqual(operations, ['first started', 'first finished', 'second started']);
  assert.equal(maximumActive, 1);
  assert.equal(clock.pending, 0);
});

test('an unexpected check error is reported and polling remains recoverable', async () => {
  const clock = new ManualClock();
  const failure = new Error('fixture check failed');
  const errors: unknown[] = [];
  const loop = new PollingLoop({
    task: async () => {
      throw failure;
    },
    intervalMilliseconds: () => 30_000,
    enabled: () => true,
    nextRunChanged: () => undefined,
    unexpectedError: (error) => errors.push(error),
    timers: clock,
  });
  loop.start();
  await clock.fireNext();
  assert.deepEqual(errors, [failure]);
  assert.equal(clock.nextDelay, 60_000);
  loop.stop();
});

test('sample mode has no scheduled checks, while an explicit local refresh remains available', async () => {
  const clock = new ManualClock();
  let calls = 0;
  const loop = new PollingLoop({
    task: async () => {
      calls++;
      return true;
    },
    intervalMilliseconds: () => 30_000,
    enabled: () => false,
    nextRunChanged: () => undefined,
    unexpectedError: (error) => {
      throw error;
    },
    timers: clock,
  });
  loop.start();
  assert.equal(clock.pending, 0);
  await loop.runNow();
  assert.equal(calls, 1);
  assert.equal(clock.pending, 0);
  loop.stop();
});
