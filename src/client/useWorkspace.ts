import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CalculationResult,
  InventoryPublishResult,
  InventoryPublishRow,
  InventoryRefreshResult,
  Review,
  Snapshot,
} from '../shared/contracts.js';
import type { AutomationPreview } from '../shared/automation.js';
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
  const [pollError, setPollError] = useState('');
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
        if (!abort.signal.aborted && generation === snapshotGeneration.current) {
          setState(next);
          setPollError('');
        }
      } catch (cause) {
        if (!abort.signal.aborted && generation === snapshotGeneration.current)
          setPollError(errorMessage(cause));
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
      setPollError('');
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
      success: string | ((snapshot: Snapshot) => string),
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

  const calculate = useCallback(
    (companyId: string, listingIds: string[]) =>
      runAction(
        'Calculating',
        async () => {
          const { calculation, ...next } = await requestJson<CalculationResult>('/calculate', {
            companyId,
            listingIds,
          });
          if (mounted.current) setState(next);
          return calculation;
        },
        '',
      ),
    [runAction],
  );

  const previewAutomation = (companyId: string) =>
    runAction(
      'Checking company stock',
      () => requestJson<AutomationPreview>('/automation/preview', { companyId }),
      '',
    );

  const tryAutomation = (companyId: string, previewId: string, listingId: string) =>
    runAction(
      'Trying one listing',
      () =>
        requestJson<InventoryPublishRow>('/automation/trial', { companyId, previewId, listingId }),
      '',
    );

  const publishReview = useCallback(
    (reviewId: string, positiveEdits?: 'once' | 'allowance', keepBackOverrides?: string[]) =>
      runAction(
        'Publishing reviewed stock',
        async () => {
          const result = await requestJson<InventoryPublishResult>('/publish', {
            reviewId,
            positiveEdits,
            keepBackOverrides,
          });
          try {
            const next = await requestJson<Snapshot>('/state');
            if (mounted.current) setState(next);
          } catch {
            if (mounted.current)
              setError(
                'Publication results are available. Inventory will refresh on the next check.',
              );
          }
          return result;
        },
        '',
      ),
    [runAction],
  );

  const refreshSnapshot = useCallback(
    () =>
      runAction(
        'Loading saved inventory',
        async () => {
          const next = await requestJson<Snapshot>('/state');
          if (mounted.current) setState(next);
          return next;
        },
        '',
      ),
    [runAction],
  );

  const refreshInventory = useCallback(
    (companyId: string, accountId: string) =>
      runAction(
        'Refreshing inventory',
        async () => {
          const { refresh, ...next } = await requestJson<InventoryRefreshResult>(
            '/inventory/refresh',
            { companyId: companyId || undefined, accountId: accountId || undefined },
          );
          if (mounted.current) setState(next);
          if (refresh.partial) throw new Error(refresh.message);
          return refresh.message;
        },
        (message) => message,
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
          const selected = next.companies.find((company) => company.id === companyId);
          const noVerifiedCompanies =
            next.companies.length > 0 && next.companies.every((company) => company.stockIssue);
          if (
            next.mode === 'live' &&
            (next.connection.tally !== 'online' || selected?.stockIssue || noVerifiedCompanies)
          )
            throw new Error(next.connection.message);
          return next;
        },
        (next) =>
          !next.companies.length || next.companies.some((company) => company.stockIssue)
            ? next.connection.message
            : 'Refresh completed. Saved observations are shown below.',
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
    error: error || pollError,
    notice,
    mutate,
    calculate,
    refreshSnapshot,
    refreshInventory,
    refreshTally,
    prepareReview,
    previewAutomation,
    tryAutomation,
    publishReview,
    backUpNow,
    dismissError: () => {
      setError('');
      setPollError('');
    },
    dismissNotice: () => setNotice(''),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
