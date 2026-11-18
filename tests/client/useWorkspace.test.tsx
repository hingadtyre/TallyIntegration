import assert from 'node:assert/strict';
import test from 'node:test';
import { act, renderHook, response, waitFor } from '../support/client-dom.js';
import { initialState } from '../../src/server/seed.js';
import { useWorkspace } from '../../src/client/useWorkspace.js';

test('saved-state refresh supersedes an older poll and prevents overlapping workspace commands', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const initial = initialState('demo', 'unused');
  const updated = {
    ...initial,
    accounts: [
      ...initial.accounts,
      {
        id: 'added-account',
        name: 'Added sample store',
        marketplace: 'flipkart' as const,
        status: 'demo' as const,
      },
    ],
  };
  let reads = 0;
  let finishPoll!: (value: Response) => void;
  let finishRefresh!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(String(input), '/api/state');
    reads++;
    if (reads === 1) return response(initial);
    return new Promise<Response>((resolve) => {
      if (reads === 2) finishPoll = resolve;
      else finishRefresh = resolve;
    });
  });
  const { result } = renderHook(() => useWorkspace());
  await act(async () => {});
  assert.deepEqual(result.current.state, initial);
  await act(async () => t.mock.timers.tick(15_000));
  let refresh!: ReturnType<typeof result.current.refreshSnapshot>;
  act(() => {
    refresh = result.current.refreshSnapshot();
  });
  const overlapping = await result.current.mutate('/pause', {}, 'Pausing', 'Paused');
  assert.deepEqual(overlapping, { ok: false, error: 'Wait for the current action to finish.' });
  await act(async () => {
    finishRefresh(response(updated));
    await refresh;
  });
  await act(async () => finishPoll(response(initial)));
  assert.deepEqual(result.current.state, updated);
  assert.equal(result.current.state?.mode, 'demo');
  assert.equal(reads, 3);
});

test('a failed saved-state refresh retains the existing inventory and exposes the error', async (t) => {
  const initial = initialState('demo', 'unused');
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    assert.equal(String(input), '/api/state');
    return ++reads === 1
      ? response(initial)
      : response({ error: 'Saved inventory is unavailable.' }, 503);
  });
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => assert.deepEqual(result.current.state, initial));
  await act(async () => {
    await result.current.refreshSnapshot();
  });
  assert.deepEqual(result.current.state, initial);
  assert.equal(result.current.error, 'Saved inventory is unavailable.');
  assert.equal(result.current.busy, '');
});
