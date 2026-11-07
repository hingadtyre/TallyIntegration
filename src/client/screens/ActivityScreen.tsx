import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/contracts.js';
import { Icon, ActivityList } from '../components.js';
import { errorMessage } from '../api.js';

export function ActivityScreen({
  state,
  companyId,
  active,
}: {
  state: Snapshot;
  companyId: string;
  active: boolean;
}) {
  const [activityQuery, setActivityQuery] = useState('');
  const [activityLevel, setActivityLevel] = useState('');
  const [diagnostics, setDiagnostics] = useState(false);
  const [logText, setLogText] = useState('');
  const [followLogs, setFollowLogs] = useState(true);
  const [logsError, setLogsError] = useState('');
  const logsRef = useRef<HTMLPreElement>(null);
  const activeActivity = state.activity.filter(
    (event) =>
      (!event.companyId || event.companyId === companyId) &&
      (!activityLevel || event.level === activityLevel) &&
      `${event.message} ${event.operation}`
        .toLocaleLowerCase()
        .includes(activityQuery.toLocaleLowerCase()),
  );

  useEffect(() => {
    if (!active || !diagnostics) return;
    const abort = new AbortController();
    let running = false;
    async function load() {
      if (running) return;
      running = true;
      try {
        const response = await fetch('/api/logs', { signal: abort.signal });
        if (!response.ok) throw new Error(`Diagnostics could not be read (${response.status}).`);
        const content = await response.text();
        if (!abort.signal.aborted) {
          setLogText(content);
          setLogsError('');
        }
      } catch (cause) {
        if (!abort.signal.aborted) setLogsError(errorMessage(cause));
      } finally {
        running = false;
      }
    }
    void load();
    const timer = followLogs ? setInterval(() => void load(), 5_000) : undefined;
    return () => {
      abort.abort();
      if (timer) clearInterval(timer);
    };
  }, [active, diagnostics, followLogs]);
  useEffect(() => {
    if (followLogs && logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logText, followLogs]);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">A CLEAR RECORD</div>
          <h1>Activity</h1>
          <p>Follow stock calculations, settings changes and connection checks.</p>
        </div>
        <a className="button secondary" href="/api/logs" download="stockbridge-diagnostics.log">
          Export diagnostics
        </a>
      </div>
      <div className="segmented" aria-label="Activity view">
        <button className={!diagnostics ? 'selected' : ''} onClick={() => setDiagnostics(false)}>
          Business activity
        </button>
        <button className={diagnostics ? 'selected' : ''} onClick={() => setDiagnostics(true)}>
          Diagnostics
        </button>
      </div>
      {diagnostics ? (
        <section className="panel diagnostic-panel">
          <div className="panel-heading">
            <div>
              <h2>Application log</h2>
              <p>Technical details for troubleshooting. Read-only.</p>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={followLogs}
                onChange={(event) => setFollowLogs(event.target.checked)}
              />
              Follow every 5 seconds
            </label>
          </div>
          {logsError && (
            <p className="message error" role="alert">
              {logsError}
            </p>
          )}
          <pre
            className="log-console"
            ref={logsRef}
            tabIndex={0}
            aria-label="Application diagnostic log"
          >
            {logText || 'No diagnostic entries yet.'}
          </pre>
        </section>
      ) : (
        <section className="panel">
          <div className="filters">
            <label className="search-input">
              <Icon name="search" />
              <input
                aria-label="Search activity"
                placeholder="Search activity…"
                value={activityQuery}
                onChange={(event) => setActivityQuery(event.target.value)}
              />
            </label>
            <select
              aria-label="Activity level"
              value={activityLevel}
              onChange={(event) => setActivityLevel(event.target.value)}
            >
              <option value="">All levels</option>
              <option value="info">Information</option>
              <option value="warning">Warnings</option>
              <option value="error">Errors</option>
            </select>
          </div>
          <ActivityList events={activeActivity} />
        </section>
      )}
    </>
  );
}
