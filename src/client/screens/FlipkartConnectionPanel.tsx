import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FlipkartConnectionStatus, Snapshot } from '../../shared/contracts.js';
import { errorMessage, requestJson } from '../api.js';
import { Icon } from '../components.js';
import { formatDateTime as time } from '../format.js';

const statusLabels: Record<FlipkartConnectionStatus['state'], string> = {
  'not-configured': 'Not configured',
  verified: 'API credentials verified',
  'needs-attention': 'Needs attention',
  unavailable: 'Unavailable',
};

export function FlipkartConnectionPanel({ mode }: { mode: Snapshot['mode'] }) {
  return mode === 'demo' ? (
    <section className="panel connection-card">
      <div className="connection-card-top">
        <div className="service-logo flipkart-logo">F</div>
        <span className="badge badge-amber">Sample account</span>
      </div>
      <h2>Flipkart</h2>
      <p>Sample mode does not accept credentials or contact Flipkart.</p>
      <button className="button secondary" disabled>
        Connect Flipkart in the live workspace
      </button>
      <div className="connection-footer">Marketplace writes unavailable</div>
    </section>
  ) : (
    <LiveFlipkartConnection />
  );
}

function LiveFlipkartConnection() {
  const [status, setStatus] = useState<FlipkartConnectionStatus | null>(null);
  const [pending, setPending] = useState<string | null>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const applicationId = useRef<HTMLInputElement>(null);
  const applicationSecret = useRef<HTMLInputElement>(null);
  const command = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const secretInput = applicationSecret.current;
    setPending('loading');
    setError(null);
    void requestJson<FlipkartConnectionStatus>('/flipkart/connection', undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(null);
      });
    return () => {
      controller.abort();
      command.current?.abort();
      if (secretInput) secretInput.value = '';
    };
  }, [loadAttempt]);

  async function perform(
    action: 'connect' | 'save' | 'check' | 'disconnect',
    credentials?: { applicationId: string; applicationSecret: string },
  ) {
    if (pending || !status || status.state === 'unavailable') return;
    const controller = new AbortController();
    command.current = controller;
    setPending(action);
    setError(null);
    try {
      const next = await requestJson<FlipkartConnectionStatus>(
        `/flipkart/${action}`,
        credentials ?? {},
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setStatus(next);
      if (action === 'connect' || action === 'save' || action === 'disconnect') {
        if (applicationId.current) applicationId.current.value = '';
        if (applicationSecret.current) applicationSecret.current.value = '';
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        let message = errorMessage(failure);
        // A failed request must not reflect submitted credentials into the page.
        for (const value of Object.values(credentials ?? {})) {
          if (value) message = message.replaceAll(value, '[hidden]');
        }
        if (action === 'check' || action === 'disconnect') {
          setStatus(
            (current) =>
              current && {
                ...current,
                state: 'needs-attention',
                expiresAt: null,
                message:
                  action === 'check'
                    ? 'Saved access could not be verified. Retry the check or replace your credentials.'
                    : 'Local disconnection could not be confirmed. Check saved access or retry disconnecting.',
              },
          );
        }
        setError(message);
      }
    } finally {
      if (!controller.signal.aborted) setPending(null);
      if (command.current === controller) command.current = null;
    }
  }

  function connect(event: FormEvent) {
    event.preventDefault();
    submitCredentials('connect');
  }

  function submitCredentials(action: 'connect' | 'save') {
    const id = applicationId.current?.value.trim() ?? '';
    const secret = applicationSecret.current?.value ?? '';
    if (!id || !secret.trim()) {
      setError('Enter both the Application ID and Application Secret.');
      return;
    }
    void perform(action, { applicationId: id, applicationSecret: secret });
  }

  const hasSavedCredentials = !!status?.applicationIdHint || status?.state === 'needs-attention';
  const disabled = pending !== null || !status || status.state === 'unavailable';
  return (
    <section className="panel connection-card" aria-busy={pending !== null}>
      <div className="connection-card-top">
        <div className="service-logo flipkart-logo">F</div>
        <span className={`badge ${status?.state === 'verified' ? 'badge-green' : 'badge-amber'}`}>
          {status ? statusLabels[status.state] : 'Checking saved connection'}
        </span>
      </div>
      <h2>Flipkart</h2>
      <p>
        Use the Application ID and Application Secret from your own registered Self Access
        application. These are API credentials, not your seller password.
      </p>
      <p>
        Flipkart restricts Self Access to the seller's own use. Confirm that this arrangement
        applies to your installation; a successful credential check does not establish partner
        approval.
      </p>
      {status && (
        <>
          <div className="connection-note" role="status">
            {status.message}
          </div>
          <dl className="connection-details">
            <div>
              <dt>Saved application</dt>
              <dd>{status.applicationIdHint ?? '-'}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>{time(status.checkedAt)}</dd>
            </div>
            <div>
              <dt>Access expires</dt>
              <dd>{time(status.expiresAt)}</dd>
            </div>
          </dl>
        </>
      )}
      {error && (
        <p className="flipkart-connection-error" role="alert">
          {error}
        </p>
      )}
      {!status && !pending && (
        <button className="button secondary" onClick={() => setLoadAttempt((value) => value + 1)}>
          Retry connection status
        </button>
      )}
      <form className="flipkart-credentials" onSubmit={connect} autoComplete="off">
        <fieldset disabled={disabled}>
          <legend>
            {hasSavedCredentials ? 'Replace saved API credentials' : 'Save API credentials'}
          </legend>
          <label className="field">
            <span>Application ID</span>
            <input ref={applicationId} required autoComplete="off" spellCheck={false} />
          </label>
          <label className="field">
            <span>Application Secret</span>
            <input ref={applicationSecret} type="password" required autoComplete="new-password" />
            <small>Protected on this Windows computer. Excluded from database backups.</small>
          </label>
          <button className="button primary" type="submit">
            <Icon name="check" />
            {pending === 'connect' ? 'Checking credentials…' : 'Verify and save credentials'}
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => submitCredentials('save')}
          >
            {pending === 'save' ? 'Saving credentials…' : 'Save credentials for later'}
          </button>
        </fieldset>
      </form>
      <p>
        Waiting for Flipkart approval? Save credentials for later keeps them protected on this PC
        without contacting Flipkart. It replaces any previously saved credentials. After approval,
        use Check saved access to verify them.
      </p>
      <div className="flipkart-connection-actions">
        <button
          className="button secondary"
          disabled={disabled || !hasSavedCredentials}
          onClick={() => void perform('check')}
        >
          <Icon name="refresh" />
          {pending === 'check' ? 'Checking access…' : 'Check saved access'}
        </button>
        <button
          className="button secondary"
          disabled={disabled || !hasSavedCredentials}
          onClick={() => void perform('disconnect')}
        >
          {pending === 'disconnect' ? 'Removing credentials…' : 'Disconnect locally'}
        </button>
      </div>
      <p>
        Disconnect removes this app's saved credentials. It does not delete your Flipkart
        application.
      </p>
      <div className="connection-note">
        <Icon name="info" />
        <span>
          Credential verification does not identify the seller, import listings or change stock.
          Marketplace publishing remains unavailable.
        </span>
      </div>
    </section>
  );
}
