import { useCallback, useEffect, useRef, useState } from 'react';
import type { Review, Snapshot } from '../shared/contracts.js';
import { errorMessage, requestJson, type ActionResult } from './api.js';

interface BackupResult {
  path: string;
  verified: true;
}

/** Owns the server snapshot and command feedback, not individual screen controls. */
export function useWorkspace() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const actionInFlight = useRef(false);
  const snapshotGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    let pollInFlight = false;

    async function loadSnapshot() {
      if (pollInFlight || actionInFlight.current) return;
      pollInFlight = true;
      const generation = ++snapshotGeneration.current;
      try {
        const next = await requestJson<Snapshot>('/state', undefined, abort.signal);
        // A slow observation must not replace a newer successful command response.
        if (!abort.signal.aborted && generation === snapshotGeneration.current) setState(next);
      } catch (cause) {
        if (!abort.signal.aborted && generation === snapshotGeneration.current)
          setError(errorMessage(cause));
      } finally {
        pollInFlight = false;
      }
    }

    void loadSnapshot();
    const timer = setInterval(() => void loadSnapshot(), 15_000);
    return () => {
      mounted.current = false;
      abort.abort();
      clearInterval(timer);
    };
  }, []);

  const runAction = useCallback(
    async <T>(
      label: string,
      operation: () => Promise<T>,
      success: string | ((value: T) => string),
    ): Promise<ActionResult<T>> => {
      if (actionInFlight.current)
        return { ok: false, error: 'Wait for the current action to finish.' };
      actionInFlight.current = true;
      snapshotGeneration.current++;
      setBusy(label);
      setError('');
      setNotice('');
      try {
        const value = await operation();
        if (mounted.current) setNotice(typeof success === 'function' ? success(value) : success);
        return { ok: true, value };
      } catch (cause) {
        const message = errorMessage(cause);
        if (mounted.current) setError(message);
        return { ok: false, error: message };
      } finally {
        actionInFlight.current = false;
        if (mounted.current) setBusy('');
      }
    },
    [],
  );

  const mutate = useCallback(
    (
      path: string,
      body: unknown,
      label: string,
      success: string,
    ): Promise<ActionResult<Snapshot>> =>
      runAction(
        label,
        async () => {
          const next = await requestJson<Snapshot>(path, body);
          if (mounted.current) setState(next);
          return next;
        },
        success,
      ),
    [runAction],
  );

  const prepareReview = useCallback(
    (companyId: string, listingIds: string[]) =>
      runAction(
        'Preparing review',
        () => requestJson<Review>('/review', { companyId, listingIds }),
        '',
      ),
    [runAction],
  );

  const refreshTally = useCallback(
    (companyId?: string): Promise<ActionResult<Snapshot>> =>
      runAction(
        'Refreshing Tally',
        async () => {
          const next = await requestJson<Snapshot>('/refresh', companyId ? { companyId } : {});
          // A completed request can contain a failed Tally check and retained observations.
          if (mounted.current) setState(next);
          if (next.connection.tally === 'offline') throw new Error(next.connection.message);
          return next;
        },
        'Refresh completed. Saved observations are shown below.',
      ),
    [runAction],
  );

  const backUpNow = useCallback(
    () =>
      runAction(
        'Creating backup',
        async () => {
          const backup = await requestJson<BackupResult>('/backup', {});
          try {
            const next = await requestJson<Snapshot>('/state');
            if (mounted.current) setState(next);
          } catch {
            // The backup already succeeded. A failed history refresh must not turn
            // that confirmed result into an apparent backup failure.
            if (mounted.current) setError('Backup verified. Activity could not be refreshed yet.');
          }
          return backup;
        },
        (backup) => `Verified backup saved: ${backup.path}`,
      ),
    [runAction],
  );

  return {
    state,
    busy,
    error,
    notice,
    mutate,
    refreshTally,
    prepareReview,
    backUpNow,
    dismissError: () => setError(''),
    dismissNotice: () => setNotice(''),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
