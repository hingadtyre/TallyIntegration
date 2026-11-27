import { MarketplaceSeller } from '../MarketplaceSeller.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Company, ItemReservations, SellerAccount } from '../../shared/contracts.js';
import { reservationCheckMaxAgeMs } from '../../shared/contracts.js';
import { requestJson } from '../api.js';
import { formatDateTime, formatQuantity } from '../format.js';

export function useInventoryReservations(company: Company | undefined, intervalSeconds: number) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; items: Record<string, ItemReservations> }>();
  const companyId = company?.id;
  const key =
    company?.stockTrackingFrom && !company.stockIssue
      ? JSON.stringify([companyId, company.stockTrackingFrom, revision])
      : '';
  useEffect(() => {
    setResult(undefined);
    if (!key) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let expiry: ReturnType<typeof setTimeout>;
    async function check() {
      let items: Record<string, ItemReservations> = {};
      try {
        items = await requestJson('/inventory/reservations', { companyId }, controller.signal);
      } catch {
        // A failed check leaves the shared balance unknown until a complete read.
      }
      if (controller.signal.aborted) return;
      clearTimeout(expiry);
      // The server verifies every item against the same company observation.
      const checkedAt = Object.values(items)[0]?.checkedAt;
      const remaining = checkedAt
        ? Date.parse(checkedAt) + reservationCheckMaxAgeMs - Date.now()
        : 0;
      if (remaining > 0) {
        setResult({ key, items });
        expiry = setTimeout(() => setResult(undefined), remaining);
      } else {
        setResult(undefined);
      }
      timer = setTimeout(() => void check(), intervalSeconds * 1000);
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(expiry);
    };
  }, [key, companyId, intervalSeconds]);
  return {
    items: key && result?.key === key ? result.items : undefined,
    refresh: () => setRevision((value) => value + 1),
  };
}

export function ReservationDetails({
  balance,
  accounts,
  unit,
}: {
  balance: ItemReservations;
  accounts: Map<string, SellerAccount>;
  unit: string;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [mode, setMode] = useState<'closed' | 'preview' | 'pinned'>('closed');
  const open = mode !== 'closed';
  const preview = () => {
    clearTimeout(timer.current);
    setMode((current) => (current === 'closed' ? 'preview' : current));
  };
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () =>
        setMode((current) =>
          current === 'preview' && document.activeElement !== trigger.current ? 'closed' : current,
        ),
      150,
    );
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const box = popup.current;
      const anchor = trigger.current?.getBoundingClientRect();
      if (!box || !anchor) return;
      box.style.left =
        Math.max(
          8,
          Math.min(anchor.left, document.documentElement.clientWidth - box.offsetWidth - 8),
        ) + 'px';
      box.style.top =
        (anchor.bottom + box.offsetHeight + 12 <= window.innerHeight
          ? anchor.bottom + 4
          : Math.max(8, anchor.top - box.offsetHeight - 4)) + 'px';
    }
    function outside(event: Event) {
      if (
        event.target instanceof window.Node &&
        !trigger.current?.contains(event.target) &&
        !popup.current?.contains(event.target)
      )
        setMode('closed');
    }
    function escape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMode('closed');
    }
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, balance]);
  return (
    <>
      <button
        type="button"
        className="text-button reserved-quantity"
        ref={trigger}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onFocus={preview}
        onBlur={leave}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') preview();
        }}
        onPointerLeave={leave}
        onClick={() => setMode((current) => (current === 'pinned' ? 'closed' : 'pinned'))}
      >
        {formatQuantity(balance.units)} reserved
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={popup}
            role="region"
            aria-label="Reserved for orders"
            className="reservation-popover"
            onPointerEnter={() => clearTimeout(timer.current)}
            onPointerLeave={leave}
          >
            <strong>
              {formatQuantity(balance.units)} {unit} reserved for orders
            </strong>
            <ul>
              {balance.bySeller.map(({ accountId, units }) => (
                <li key={accountId}>
                  <MarketplaceSeller account={accounts.get(accountId)} />
                  <b>{formatQuantity(units)}</b>
                </li>
              ))}
            </ul>
            <small>Checked {formatDateTime(balance.checkedAt)}</small>
          </div>,
          document.body,
        )}
    </>
  );
}
