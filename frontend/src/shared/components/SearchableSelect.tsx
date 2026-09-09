import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { cn } from '../lib/cn';

export interface SearchableSelectOption {
  value: string;
  label: string;
}

export interface SearchableSelectProps {
  id?: string;
  value: string;
  options: readonly SearchableSelectOption[] | SearchableSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
  ariaLabel?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
  describedBy?: string;
}

export function SearchableSelect({
  id,
  value,
  options,
  onChange,
  placeholder = 'Select',
  testId,
  ariaLabel,
  searchable = true,
  searchPlaceholder,
  emptyMessage = 'No matches found',
  className,
  disabled = false,
  describedBy,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const generatedId = useId();

  const filteredOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter(
      (opt) => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q),
    );
  }, [options, query, searchable]);

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === value),
    [options, value],
  );

  const displayLabel = selectedOption ? selectedOption.label : placeholder;
  const isSelected = Boolean(value);
  const accessibleLabel = ariaLabel || 'Select';
  const listboxId = testId ? `${testId}-options` : `searchable-select-options-${generatedId}`;

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
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const option = filteredOptions[index];
        if (option) selectOption(option.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    },
    [close, filteredOptions, moveActive, selectOption],
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

  return (
    <div className={cn('relative w-full', className)}>
      <select
        id={id}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        tabIndex={-1}
        className="sr-only"
      >
        {options.map((opt) => (
          <option key={opt.value || '__empty__'} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <Popover.Root
        open={open}
        onOpenChange={(nextOpen) => {
          if (disabled) return;
          setOpen(nextOpen);
          if (!nextOpen) setQuery('');
        }}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            data-testid={testId ? `${testId}-control` : undefined}
            aria-label={`${accessibleLabel}, current: ${displayLabel}`}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listboxId : undefined}
            className={cn(
              'flex h-8 w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-md border border-border-interactive bg-card px-2.5 text-[0.8125rem] leading-none text-foreground outline-none transition-colors',
              'hover:bg-accent',
              'focus-visible:border-primary focus-visible:shadow-[0_0_0_1px_var(--color-primary)]',
              isSelected && 'font-medium',
              open && 'border-border-interactive bg-accent',
              disabled && 'cursor-not-allowed opacity-50 hover:bg-card',
            )}
          >
            <span className={cn('truncate text-left', !isSelected && 'text-muted-foreground')}>
              {displayLabel}
            </span>
            <ChevronDown
              size={14}
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
            className="nm-popover-glass z-50 w-[max(var(--radix-popover-trigger-width),12rem)] max-w-[calc(100vw-2rem)] overflow-hidden p-0 text-xs"
            data-testid={testId ? `${testId}-menu` : 'searchable-select-menu'}
            aria-label={accessibleLabel}
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
            {searchable && (
              <div className="border-b border-border/60 p-1.5">
                <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-2">
                  <Search size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    role="searchbox"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder={searchPlaceholder ?? 'Search...'}
                    aria-label={`Search ${accessibleLabel}`}
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
              id={listboxId}
              role="listbox"
              aria-label={accessibleLabel}
              className="max-h-60 overflow-y-auto p-1 space-y-0.5"
            >
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-4 text-center text-xs text-muted-foreground">{emptyMessage}</p>
              ) : (
                filteredOptions.map((opt, index) => {
                  const selected = opt.value === value;
                  const active = index === activeIndex;
                  return (
                    <button
                      key={opt.value || '__empty__'}
                      ref={(el) => {
                        optionRefs.current[index] = el;
                      }}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => selectOption(opt.value)}
                      onMouseEnter={() => setActiveIndex(index)}
                      onKeyDown={(e) => handleOptionKeyDown(e, index)}
                      data-testid={testId ? `${testId}-option-${opt.value || 'empty'}` : undefined}
                      className={cn(
                        'flex min-h-8 w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs outline-none transition-colors',
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
