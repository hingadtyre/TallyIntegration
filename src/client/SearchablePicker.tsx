import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './components.js';

export function SearchablePicker<T>({
  inputId,
  openOnFocus = true,
  label,
  placeholder,
  options,
  selected,
  getId,
  getLabel,
  filterOptions,
  renderOption = getLabel,
  selectedIcon,
  groupLabel,
  pageSize = Infinity,
  moreLabel = 'Show more',
  emptyMessage,
  disabled,
  onSelect,
}: {
  inputId?: string;
  openOnFocus?: boolean;
  label: string;
  placeholder: string;
  options: T[];
  selected?: T;
  getId: (option: T) => string;
  getLabel: (option: T) => string;
  filterOptions?: (options: T[], query: string) => T[];
  renderOption?: (option: T) => ReactNode;
  selectedIcon?: ReactNode;
  groupLabel?: (option: T, query: string) => string;
  pageSize?: number;
  moreLabel?: string;
  emptyMessage: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const listId = id + '-options';
  // Keep the text being edited separate from the choice used by the form.
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [limit, setLimit] = useState(pageSize);
  const activeOption = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  function matchingOptions(text: string) {
    if (filterOptions) return filterOptions(options, text);
    const filter = text.trim().toLowerCase();
    return filter
      ? options.filter((option) => getLabel(option).toLowerCase().includes(filter))
      : options;
  }

  const matches = open ? matchingOptions(query ?? '') : [];
  const activeIndex = Math.min(highlight, matches.length - 1);
  const active = matches[activeIndex];
  const groups: { name: string; start: number; rows: T[] }[] = [];
  for (const [index, option] of matches.slice(0, limit).entries()) {
    const name = groupLabel?.(option, query ?? '') ?? '';
    let group = groups.at(-1);
    if (!group || group.name !== name) {
      group = { name, start: index, rows: [] };
      groups.push(group);
    }
    group.rows.push(option);
  }

  useEffect(() => {
    // Scroll the options without moving the surrounding form or dialog.
    const container = popup.current;
    if (!container || !activeOption.current) return;
    const option = activeOption.current.getBoundingClientRect();
    const bounds = container.getBoundingClientRect();
    if (option.top < bounds.top) container.scrollTop += option.top - bounds.top;
    else if (option.bottom > bounds.bottom) container.scrollTop += option.bottom - bounds.bottom;
  }, [open, active, activeIndex, query]);

  useEffect(() => {
    if (!open && document.activeElement === input.current) input.current?.select();
  }, [open]);

  function openList() {
    if (open) return;
    const index = selected
      ? Math.max(
          0,
          matchingOptions('').findIndex((row) => getId(row) === getId(selected)),
        )
      : 0;
    setHighlight(index);
    setLimit(Math.max(pageSize, index + 1));
    setOpen(true);
  }

  function closeList() {
    setQuery(null);
    setOpen(false);
  }

  function choose(option: T) {
    onSelect(getId(option));
    closeList();
  }

  return (
    <div
      className="field searchable-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closeList();
      }}
    >
      <label htmlFor={id} id={id + '-label'}>
        {label}
      </label>
      <div className="searchable-picker-control">
        <div className="searchable-picker-input">
          {query === null && selectedIcon && (
            <span id={id + '-prefix'} className="searchable-picker-prefix">
              {selectedIcon}
            </span>
          )}
          <input
            id={id}
            ref={input}
            role="combobox"
            aria-autocomplete="list"
            aria-describedby={query === null && selectedIcon ? id + '-prefix' : undefined}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open && active ? listId + '-' + activeIndex : undefined}
            autoComplete="off"
            placeholder={placeholder}
            required
            disabled={disabled}
            value={query ?? (selected ? getLabel(selected) : '')}
            onFocus={(event) => {
              event.currentTarget.select();
              if (openOnFocus) openList();
            }}
            onClick={(event) => {
              if (query === null) event.currentTarget.select();
              openList();
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
              setLimit(pageSize);
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape' && open) {
                event.preventDefault();
                event.stopPropagation();
                closeList();
              } else if (event.key === 'Enter' && open) {
                event.preventDefault();
                if (active) choose(active);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                if (!open) openList();
                else if (matches.length) {
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  const next = Math.max(0, Math.min(matches.length - 1, activeIndex + step));
                  if (next >= limit) setLimit(limit + pageSize);
                  setHighlight(next);
                }
              }
            }}
          />
          <Icon name="chevron" />
        </div>
        {open && (
          <div
            ref={popup}
            className="searchable-picker-popup"
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div id={listId} role="listbox" aria-labelledby={id + '-label'}>
              {groups.map(({ name, start, rows }) => (
                <div key={start} role={name ? 'group' : undefined} aria-label={name || undefined}>
                  {name && (
                    <div className="searchable-picker-heading" aria-hidden="true">
                      {name}
                    </div>
                  )}
                  {rows.map((option, offset) => {
                    const index = start + offset;
                    return (
                      <div
                        key={getId(option)}
                        id={listId + '-' + index}
                        role="option"
                        className="searchable-picker-option"
                        ref={index === activeIndex ? activeOption : undefined}
                        aria-selected={index === activeIndex}
                        onClick={() => choose(option)}
                      >
                        {renderOption(option)}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {!matches.length && <p role="status">{emptyMessage}</p>}
            {matches.length > limit && (
              <button
                type="button"
                className="text-button"
                tabIndex={-1}
                onClick={() => {
                  setHighlight(limit);
                  setLimit(limit + pageSize);
                  input.current?.focus();
                }}
              >
                {moreLabel} ({matches.length - limit} remaining)
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
