import { useRef, useState, type FormEvent } from 'react';
import type { MarketplaceAccount } from '../../shared/marketplace-contracts.js';
import { errorMessage } from '../api.js';
import { Modal } from '../components.js';
import { marketplaceApi } from '../marketplace-api.js';

export function MarketplaceAccountForm({
  account,
  demo,
  onSaved,
  onClose,
}: {
  account?: MarketplaceAccount;
  demo: boolean;
  onSaved: (account: MarketplaceAccount) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState(!!account);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const name = useRef<HTMLInputElement>(null);
  const applicationId = useRef<HTMLInputElement>(null);
  const applicationSecret = useRef<HTMLInputElement>(null);
  async function save(verify: boolean) {
    if (pending) return;
    const accountName = name.current?.value.trim() ?? account?.name ?? '';
    const id = applicationId.current?.value.trim() ?? '';
    const secret = applicationSecret.current?.value ?? '';
    if (!accountName || (!demo && (!id || !secret.trim()))) {
      setError('Enter an account name, Application ID and Application Secret.');
      return;
    }
    setPending(true);
    setError('');
    try {
      const next = account
        ? await marketplaceApi.connection({
            accountId: account.id,
            action: verify ? 'connect' : 'save',
            applicationId: id,
            applicationSecret: secret,
          })
        : await marketplaceApi.add({
            name: accountName,
            marketplace: 'flipkart',
            applicationId: id,
            applicationSecret: secret,
            verify,
          });
      if (applicationSecret.current) applicationSecret.current.value = '';
      onSaved(next);
    } catch (failure) {
      let message = errorMessage(failure);
      for (const value of [id, secret]) {
        if (value) message = message.replaceAll(value, '[hidden]');
      }
      setError(message);
    } finally {
      setPending(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void save(!demo);
  }
  return (
    <Modal
      title={account ? `Credentials for ${account.name}` : 'Add marketplace account'}
      onClose={() => !pending && onClose()}
    >
      {!chosen ? (
        <div className="marketplace-picker">
          <p>Choose your marketplace.</p>
          <button className="marketplace-choice" onClick={() => setChosen(true)}>
            <span className="service-logo flipkart-logo">F</span>
            <span>
              <strong>Flipkart</strong>
              <small>Seller-owned Self Access</small>
            </span>
            <span aria-hidden="true">→</span>
          </button>
        </div>
      ) : (
        <form className="marketplace-account-form" onSubmit={submit} autoComplete="off">
          <p>
            {demo
              ? 'Create a sample account. No credentials or external connection are used.'
              : 'Use the API credentials from this seller’s own Flipkart Self Access application.'}
          </p>
          <fieldset disabled={pending}>
            {!account && (
              <label className="field">
                <span>Account name</span>
                <input
                  ref={name}
                  required
                  placeholder={demo ? 'Sample seller' : 'For example, Main store'}
                />
              </label>
            )}
            {!demo && (
              <>
                <label className="field">
                  <span>Application ID</span>
                  <input ref={applicationId} required autoComplete="off" spellCheck={false} />
                </label>
                <label className="field">
                  <span>Application Secret</span>
                  <input
                    ref={applicationSecret}
                    aria-label="Application Secret"
                    required
                    type="password"
                    autoComplete="new-password"
                  />
                  <small>Protected on this computer and excluded from database backups.</small>
                </label>
              </>
            )}
            {error && (
              <p className="marketplace-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button className="button secondary" type="button" onClick={onClose}>
                Cancel
              </button>
              {!demo && (
                <button className="button secondary" type="button" onClick={() => void save(false)}>
                  Save without verification
                </button>
              )}
              <button className="button primary" type="submit">
                {pending ? 'Saving…' : demo ? 'Add sample account' : 'Verify and save'}
              </button>
            </div>
          </fieldset>
          {!demo && (
            <p className="marketplace-help">
              Save without verification does not contact Flipkart. Credential verification alone
              does not confirm seller identity or listing access.
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}
