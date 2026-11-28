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

test('an all-company refresh shows partial results and a failed selected company stays visible', async (t) => {
  const state = initialState('demo', 'unused');
  state.mode = 'live';
  state.connection.tally = 'online';
  state.companies[1].stockIssue = 'read-failed';
  state.connection.message = 'Refreshed stock for 1 company. Stock read failed for Company B.';
  t.mock.method(globalThis, 'fetch', async () => response(state));
  const { result } = renderHook(() => useWorkspace());
  await waitFor(() => assert.deepEqual(result.current.state, state));
  await act(async () => {
    await result.current.refreshTally();
  });
  assert.equal(result.current.notice, state.connection.message);
  assert.equal(result.current.error, '');
  await act(async () => {
    await result.current.refreshTally(state.companies[1].id);
  });
  assert.equal(result.current.error, state.connection.message);
  assert.equal(result.current.notice, '');
  assert.deepEqual(result.current.state?.items, state.items);
});

test('a recovered poll clears its own warning and preserves an unrelated failed command', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const state = initialState('demo', 'unused');
  let unavailable = true;
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    if (path !== '/api/state') return response({ error: 'Could not save the draft.' }, 400);
    return unavailable ? response({ error: 'Cannot read inventory.' }, 503) : response(state);
  });
  const { result } = renderHook(() => useWorkspace());
  await act(async () => {});
  assert.equal(result.current.error, 'Cannot read inventory.');
  unavailable = false;
  await act(async () => t.mock.timers.tick(15000));
  assert.equal(result.current.error, '');
  await act(async () => {
    await result.current.mutate('/proposals', {}, 'Saving', 'Saved');
  });
  unavailable = true;
  await act(async () => t.mock.timers.tick(15000));
  unavailable = false;
  await act(async () => t.mock.timers.tick(15000));
  assert.equal(result.current.error, 'Could not save the draft.');
});

test('changing context preserves the poll error and suppresses both the late backup notice and the history refresh warning', async (t) => {
  const state = initialState('demo', 'unused');
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  let finishBackup!: (value: Response) => void;
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    if (path === '/api/backup')
      return new Promise<Response>((resolve) => {
        finishBackup = resolve;
      });
    assert.equal(path, '/api/state');
    reads++;
    return reads === 2 || reads === 3
      ? response({ error: 'Workspace unavailable.' }, 503)
      : response(state);
  });
  const { result } = renderHook(() => useWorkspace());
  await act(async () => {});
  await act(async () => t.mock.timers.tick(15_000));
  let backup!: ReturnType<typeof result.current.backUpNow>;
  act(() => {
    backup = result.current.backUpNow();
  });
  act(() => result.current.clearActionFeedback());
  assert.equal(result.current.error, 'Workspace unavailable.');
  await act(async () => {
    finishBackup(response({ path: 'verified.sqlite', verified: true }));
    assert.equal((await backup).ok, true);
  });
  assert.equal(result.current.error, 'Workspace unavailable.');
  assert.equal(result.current.notice, '');
  assert.equal(result.current.busy, '');
  await act(async () => {
    await result.current.refreshSnapshot();
  });
  assert.equal(result.current.error, '');
});
