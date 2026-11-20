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

/** The table keys this editor by saved proposal version so successful saves reset its local input. */
export function QuantityEditor({
  proposal,
  listing,
  disabled,
  onSave,
  onDirty,
}: QuantityEditorProps) {
  const savedValue = proposal ? String(proposal.quantity) : '';
  const descriptionId = useId();
  const [value, setValue] = useState(savedValue);
  const [reenteredCalculatedZero, setReenteredCalculatedZero] = useState(false);
  const [error, setError] = useState('');
  const dirty = value !== savedValue || reenteredCalculatedZero;
  const canSave = dirty || (proposal?.stale && proposal.edited);

  useEffect(() => {
    onDirty(listing.id, dirty);
    return () => onDirty(listing.id, false);
  }, [dirty, listing.id, onDirty]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled || !canSave) return;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      setError('Enter a whole number of 0 or more.');
      return;
    }
    setError('');
    const result = await onSave(Number(value));
    if (!result.ok) setError(result.error);
  }

  let description = listing.proposalIssue
    ? `Last calculation could not verify stock. ${listing.proposalIssue} Use Calculate to retry.`
    : 'No draft';
  let descriptionClass = listing.proposalIssue && !proposal ? 'text-amber' : '';
  if (error) {
    description = error;
    descriptionClass = 'text-danger';
  } else if (dirty) {
    description = 'Save this draft ↗';
    descriptionClass = 'text-amber';
  } else if (proposal?.stale) {
    description = proposal.edited ? 'Save again to review' : 'Needs recalculation';
    descriptionClass = 'text-danger';
  } else if (proposal?.edited) {
    description =
      proposal.quantity === 0 ? 'Publishing pauses Tally sync' : 'Choose how to publish at review';
    descriptionClass = 'text-teal';
  } else if (proposal) {
    description = 'Calculated draft';
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
          aria-describedby={descriptionId}
          value={value}
          placeholder="-"
          disabled={disabled}
          onInput={(event) =>
            setReenteredCalculatedZero(
              proposal?.quantity === 0 && !proposal.edited && event.currentTarget.value === '0',
            )
          }
          onChange={(event) => setValue(event.target.value)}
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
    </div>
  );
}
