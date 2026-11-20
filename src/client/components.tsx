import { useEffect, useRef, type ReactNode } from 'react';
import type { Activity } from '../shared/contracts.js';
import { formatQuantity as quantity, formatDateTime as time } from './format.js';
export type IconName =
  | 'billing'
  | 'inventory'
  | 'activity'
  | 'connections'
  | 'settings'
  | 'marketplaces'
  | 'refresh'
  | 'search'
  | 'edit'
  | 'chevron'
  | 'plus'
  | 'check'
  | 'close'
  | 'arrow'
  | 'lock'
  | 'pause'
  | 'box'
  | 'info';
const iconPaths: Record<IconName, ReactNode> = {
  billing: <path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Zm3 5h8m-8 4h3m1 3 2 2 4-5" />,
  marketplaces: (
    <>
      <path d="M3 10h18l-2-6H5l-2 6ZM5 10v10h14V10M9 20v-6h6v6" />
      <path d="M3 10a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" />
    </>
  ),
  inventory: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  activity: (
    <>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </>
  ),
  connections: (
    <>
      <path
        d="m10 14 4-4M9 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
        transform="translate(1 -1)"
      />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" />
      <circle cx="15" cy="17" r="3" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  chevron: <path d="m8 4 8 8-8 8" />,
  edit: <path d="m14.5 5.5 4 4M4 20l4.5-1 12-12-3.5-3.5-12 12L4 20Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3" />
    </>
  ),
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  box: (
    <>
      <path d="m12 3 9 5v9l-9 5-9-5V8Z" />
      <path d="m3 8 9 5 9-5M12 13v9m-5-17 9 5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
};
export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {iconPaths[name]}
    </svg>
  );
}
export function ResumeSyncButton({
  sku,
  location,
  disabled,
  onResume,
}: {
  sku: string;
  location: string;
  disabled: boolean;
  onResume: () => void;
}) {
  return (
    <button
      type="button"
      className="resume-sync"
      aria-label={`Resume sync for ${sku} at ${location}`}
      title="Unlock this location and replace its draft with a fresh stock calculation. Company sync controls automatic updates."
      disabled={disabled}
      onClick={onResume}
    >
      <span className="sync-lock-label">
        <Icon name="lock" />
        Tally sync paused
      </span>
      <span className="resume-sync-action">Resume sync</span>
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      className={`modal ${wide ? 'modal-wide' : ''}`}
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Stat({
  label,
  value,
  detail,
  icon,
  selected,
  onSelect,
  disabled,
  warm = false,
}: {
  label: string;
  value: number;
  detail: string;
  icon: IconName;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
  warm?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`Show ${label.toLowerCase()}, ${quantity(value)}. ${detail}`}
      aria-pressed={selected}
      onClick={onSelect}
      disabled={disabled}
      className={`stat-card ${warm ? 'stat-warm' : ''}`}
    >
      <span className="stat-icon">
        <Icon name={icon} />
      </span>
      <span className="stat-label">{label}</span>
      <strong>{quantity(value)}</strong>
      <small>{detail}</small>
    </button>
  );
}

export function ActivityList({ events }: { events: Activity[] }) {
  return events.length ? (
    <ul className="activity-list">
      {events.map((event) => (
        <li key={event.id}>
          <span className={`activity-mark level-${event.level}`}>
            <Icon name={event.level === 'info' ? 'check' : 'info'} />
          </span>
          <div className="activity-copy">
            <strong>{event.operation.replaceAll('.', ' · ')}</strong>
            <p>{event.message}</p>
            <span className={`activity-level level-${event.level}`}>{event.level}</span>
          </div>
          <time dateTime={event.at}>{time(event.at)}</time>
        </li>
      ))}
    </ul>
  ) : (
    <div className="empty-state compact-empty">
      <Icon name="activity" />
      <h3>No activity to show</h3>
      <p>Connection checks and local changes will appear here.</p>
    </div>
  );
}
