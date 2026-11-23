import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Listing, Proposal, Snapshot } from '../../shared/contracts.js';
import type { ActionResult } from '../api.js';
import { Icon } from '../components.js';

interface QuantityEditorProps {
  proposal?: Proposal;
  listing: Listing;
  disabled: boolean;
  onSave: (quantity: number) => Promise<ActionResult<Snapshot>>;
  onDirty: (listingId: string, dirty: boolean) => void;
}

export function QuantityEditor({
  proposal,
  listing,
  disabled,
  onSave,
  onDirty,
}: QuantityEditorProps) {
  const savedValue = proposal ? String(proposal.quantity) : '';
  const descriptionId = useId();
  const [typedValue, setTypedValue] = useState<string | null>(null);
  const [error, setError] = useState('');
  const value = typedValue ?? savedValue;
  const dirty = typedValue !== null;
  const canSave = dirty || (proposal?.stale && proposal.edited);

  useEffect(() => {
    onDirty(listing.id, dirty);
    return () => onDirty(listing.id, false);
  }, [dirty, listing.id, onDirty]);

  function edit(text: string) {
    // Saving an explicitly typed quantity is a seller decision, even if it
    // happens to equal the calculated proposal currently on screen.
    const alreadySaved = text === savedValue && (!proposal || proposal.edited);
    setTypedValue(alreadySaved ? null : text);
    setError('');
  }

  function discard() {
    setTypedValue(null);
    setError('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || !canSave) return;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      setError('Enter a whole number of 0 or more.');
      return;
    }
    setError('');
    const result = await onSave(Number(value));
    if (result.ok) setTypedValue((current) => (current === typedValue ? null : current));
    else setError(result.error);
  }

  const orderCheck = listing.proposalIssue
    ? `${listing.proposalIssue} Stockbridge will check again automatically.`
    : 'Checking orders and Tally stock…';
  const showOrderCheckAlongsideDraft = proposal?.edited && listing.orderProposalPending;
  let description = 'No draft';
  let descriptionClass = listing.proposalIssue && !proposal ? 'text-amber' : '';
  if (error) {
    description = error;
    descriptionClass = 'text-danger';
  } else if (dirty) {
    description = 'Unsaved draft';
    descriptionClass = 'text-amber';
  } else if (proposal?.stale && proposal.edited) {
    description = 'Save again to review';
    descriptionClass = 'text-danger';
  } else if (proposal?.stale) {
    description = listing.proposalIssue
      ? `Previous proposal. ${listing.proposalIssue}`
      : 'Updating proposal…';
    descriptionClass = listing.proposalIssue ? 'text-amber' : '';
  } else if (proposal?.edited) {
    description =
      proposal.quantity === 0 ? 'Publishing pauses Tally sync' : 'Choose how to publish at review';
    descriptionClass = 'text-teal';
  } else if (proposal) {
    description = 'Calculated draft';
  } else if (listing.orderProposalPending) {
    description = orderCheck;
  } else if (listing.proposalIssue) {
    description = `Last calculation could not verify stock. ${listing.proposalIssue} Use Calculate to retry.`;
  }

  return (
    <div className="proposal-cell">
      <form className="quantity-editor" onSubmit={save}>
        <input
          type="number"
          min="0"
          step="1"
          inputMode="numeric"
          aria-label={`Proposed stock for ${listing.sku}`}
          aria-describedby={
            showOrderCheckAlongsideDraft ? `${descriptionId} ${descriptionId}-order` : descriptionId
          }
          data-unsaved={dirty || undefined}
          value={value}
          placeholder="-"
          disabled={disabled}
          onInput={(event) => {
            // React skips change when a replacement has the same DOM value.
            if (proposal && !proposal.edited && event.currentTarget.value === savedValue)
              edit(savedValue);
          }}
          onChange={(event) => edit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && dirty) discard();
          }}
        />
        {canSave && (
          <button
            className="save-quantity"
            type="submit"
            disabled={disabled}
            aria-label={`Save draft quantity for ${listing.sku}`}
            title="Save draft"
          >
            <Icon name="check" />
          </button>
        )}
      </form>
      <small id={descriptionId} className={descriptionClass} role={error ? 'alert' : undefined}>
        {description}
      </small>
      {showOrderCheckAlongsideDraft && (
        <small id={`${descriptionId}-order`} className={listing.proposalIssue ? 'text-amber' : ''}>
          {orderCheck}
        </small>
      )}
      {dirty && (
        <button
          type="button"
          className="text-button"
          aria-label={`Discard edit for ${listing.sku}`}
          disabled={disabled}
          onClick={discard}
        >
          Discard edit
        </button>
      )}
    </div>
  );
}
