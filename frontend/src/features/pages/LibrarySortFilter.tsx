import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ArrowUpDown, Check, ChevronDown } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import type { SortKey } from './pages-filter-params';

export interface SortOptionItem {
  value: SortKey;
  label: string;
}

export const SORT_OPTIONS: readonly SortOptionItem[] = [
  { value: 'modified', label: 'Last Modified' },
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'quality', label: 'Quality Score' },
  { value: 'relevance', label: 'Relevance' },
] as const;

interface LibrarySortFilterProps {
  value: SortKey;
  onChange: (sort: SortKey) => void;
  className?: string;
}

export function LibrarySortFilter({ value, onChange, className }: LibrarySortFilterProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectedOption = useMemo(
    () => SORT_OPTIONS.find((opt) => opt.value === value) ?? SORT_OPTIONS[0]!,
    [value],
  );

  useEffect(() => {
    const selectedIndex = SORT_OPTIONS.findIndex((opt) => opt.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [open, value]);

  const selectSort = useCallback((sort: SortKey) => {
    onChange(sort);
    setOpen(false);
  }, [onChange]);

  const moveActive = useCallback((nextIndex: number, moveFocus: boolean) => {
    const bounded = Math.max(0, Math.min(nextIndex, SORT_OPTIONS.length - 1));
    setActiveIndex(bounded);
    if (moveFocus) optionRefs.current[bounded]?.focus();
  }, []);

  const handleOptionKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
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
      moveActive(SORT_OPTIONS.length - 1, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  }, [moveActive]);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            'library-search-select flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
            open && 'bg-accent text-foreground',
            className,
          )}
          data-testid="sort-filter-control"
          title={`Sort: ${selectedOption.label}`}
          aria-label={`Sort pages, current: ${selectedOption.label}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? 'library-sort-options' : undefined}
        >
          <ArrowUpDown size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{selectedOption.label}</span>
          <ChevronDown
            size={12}
            className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="nm-card-elevated z-50 w-48 overflow-hidden p-0"
          aria-label="Sort pages"
          data-testid="sort-filter-menu"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const index = Math.max(0, SORT_OPTIONS.findIndex((opt) => opt.value === value));
            optionRefs.current[index]?.focus();
          }}
        >
          <div className="border-b border-border px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">Sort order</p>
          </div>
          <div
            id="library-sort-options"
            role="listbox"
            aria-label="Sort options"
            className="p-1 space-y-0.5"
          >
            {SORT_OPTIONS.map((opt, index) => {
              const selected = opt.value === value;
              const active = index === activeIndex;
              return (
                <button
                  key={opt.value}
                  ref={(el) => { optionRefs.current[index] = el; }}
                  id={`library-sort-option-${opt.value}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => selectSort(opt.value)}
                  onMouseEnter={() => setActiveIndex(index)}
                  onKeyDown={(e) => handleOptionKeyDown(e, index)}
                  className={cn(
                    'flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground outline-none transition-colors',
                    (active || selected) && 'bg-accent',
                  )}
                >
                  <span className={cn(selected ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                    {opt.label}
                  </span>
                  {selected && <Check size={14} className="shrink-0 text-action" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
