import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../../shared/lib/cn';

export interface FilterDropdownOption {
  value: string;
  label: string;
  description?: string;
}

export interface LibraryFilterDropdownProps {
  id?: string;
  label?: string;
  value: string;
  options: readonly FilterDropdownOption[] | FilterDropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
  ariaLabel?: string;
  className?: string;
  searchable?: boolean;
}

export function LibraryFilterDropdown({
  id,
  label,
  value,
  options,
  onChange,
  placeholder = 'All',
  testId,
  ariaLabel,
  className,
  searchable = false,
}: LibraryFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const filteredOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((opt) => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q));
  }, [options, query, searchable]);

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value],
  );

  const displayLabel = selectedOption ? selectedOption.label : placeholder;
  const isSelected = Boolean(value);

  useEffect(() => {
    const idx = filteredOptions.findIndex((opt) => opt.value === value);
    setActiveIndex(idx >= 0 ? idx : 0);
  }, [filteredOptions, open, value]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const selectOption = useCallback(
    (optValue: string) => {
      onChange(optValue);
      close();
    },
    [close, onChange],
  );

  const moveActive = useCallback(
    (nextIndex: number, moveFocus: boolean) => {
      const bounded = Math.max(0, Math.min(nextIndex, filteredOptions.length - 1));
      setActiveIndex(bounded);
      optionRefs.current[bounded]?.scrollIntoView?.({ block: 'nearest' });
      if (moveFocus) optionRefs.current[bounded]?.focus();
    },
    [filteredOptions.length],
  );

  const handleOptionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActive(index + 1, true);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(index - 1, true);
      } else if (event.key === 'Home') {
        event.preventDefault();
        moveActive(0, true);
      } else if (event.key === 'End') {
        event.preventDefault();
        moveActive(filteredOptions.length - 1, true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    },
    [close, filteredOptions.length, moveActive],
  );

  const handleSearchKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveActive(activeIndex + 1, false);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveActive(activeIndex - 1, false);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const option = filteredOptions[activeIndex];
        if (option) selectOption(option.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    },
    [activeIndex, close, filteredOptions, moveActive, selectOption],
  );

  const accessibleLabel = ariaLabel || (label ? `Filter by ${label}` : 'Filter option');

  return (
    <div className={cn('relative w-full', className)}>
      {/* Backing native select for accessibility & programmatic test harness compatibility */}
      <select
        id={id}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={accessibleLabel}
        className="sr-only"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <Popover.Root
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery('');
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            data-testid={testId ? `${testId}-control` : undefined}
            aria-label={`${accessibleLabel}, current: ${displayLabel}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open && testId ? `${testId}-options` : undefined}
            className={cn(
              'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground outline-none transition-colors hover:border-border-interactive hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring',
              isSelected && 'font-medium text-foreground',
              open && 'border-border-interactive bg-accent/30',
            )}
          >
            <span className={cn('truncate text-left', !isSelected && 'text-muted-foreground')}>
              {displayLabel}
            </span>
            <ChevronDown
              size={13}
              className={cn(
                'shrink-0 text-muted-foreground transition-transform duration-150',
                open && 'rotate-180 text-foreground',
              )}
              aria-hidden="true"
            />
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className="nm-card-elevated z-50 w-[max(var(--radix-popover-trigger-width),12rem)] max-w-[calc(100vw-2rem)] overflow-hidden p-0 text-xs shadow-overlay"
            data-testid={testId ? `${testId}-menu` : 'filter-dropdown-menu'}
            aria-label={label || 'Filter options'}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              if (searchable) {
                searchInputRef.current?.focus();
              } else {
                const idx = Math.max(0, filteredOptions.findIndex((opt) => opt.value === value));
                optionRefs.current[idx]?.focus();
              }
            }}
          >
            {label && (
              <div className="border-b border-border px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
              </div>
            )}

            {searchable && options.length > 6 && (
              <div className="border-b border-border p-1.5">
                <div className="flex h-8 items-center gap-1.5 rounded-md bg-background px-2">
                  <Search size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    role="searchbox"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={`Search ${label?.toLowerCase() || 'options'}...`}
                    aria-label={`Search ${label || 'options'}`}
                    className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="nm-icon-button size-5 shrink-0"
                      aria-label="Clear search"
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div
              id={testId ? `${testId}-options` : undefined}
              role="listbox"
              aria-label={label || 'Options'}
              className="max-h-60 overflow-y-auto p-1 space-y-0.5"
            >
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">No matches found</p>
              ) : (
                filteredOptions.map((opt, index) => {
                  const selected = opt.value === value;
                  const active = index === activeIndex;
                  return (
                    <button
                      key={opt.value || '__all__'}
                      ref={(el) => {
                        optionRefs.current[index] = el;
                      }}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => selectOption(opt.value)}
                      onMouseEnter={() => setActiveIndex(index)}
                      onKeyDown={(e) => handleOptionKeyDown(e, index)}
                      data-testid={testId ? `${testId}-option-${opt.value || 'all'}` : undefined}
                      className={cn(
                        'flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs outline-none transition-colors',
                        (active || selected) && 'bg-accent text-foreground',
                        !active && !selected && 'text-foreground hover:bg-accent/60',
                      )}
                    >
                      <span className={cn('truncate', selected ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                        {opt.label}
                      </span>
                      {selected && (
                        <Check size={13} className="shrink-0 text-action" aria-hidden="true" />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
