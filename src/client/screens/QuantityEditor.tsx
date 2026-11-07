import { useEffect, useState, type FormEvent } from 'react';
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
  const [value, setValue] = useState(savedValue);
  const [error, setError] = useState('');
  const dirty = value !== savedValue;

  useEffect(() => {
    onDirty(listing.id, dirty);
    return () => onDirty(listing.id, false);
  }, [dirty, listing.id, onDirty]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      setError('Enter a whole number of 0 or more.');
      return;
    }
    setError('');
    const result = await onSave(Number(value));
    if (!result.ok) setError(result.error);
  }

  let description = 'No draft';
  let descriptionClass = '';
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
      proposal.quantity === 0
        ? 'Draft: keep out of stock'
        : `Draft: allow ${proposal.quantity} more`;
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
          value={value}
          placeholder="—"
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        />
        {(dirty || proposal?.stale) && (
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
      <small className={descriptionClass} role={error ? 'alert' : undefined}>
        {description}
      </small>
    </div>
  );
}
