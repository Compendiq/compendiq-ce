import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Globe, Search, X } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import {
  readRecentLibrarySpaces,
  rememberRecentLibrarySpace,
} from './library-space-history';

interface LibrarySpace {
  key: string;
  name: string;
}

interface LibrarySpaceFilterProps {
  spaces?: LibrarySpace[];
  selectedKey: string;
  selectedName?: string;
  onSelect: (spaceKey: string) => void;
}

const SEARCH_THRESHOLD = 8;

export function LibrarySpaceFilter({ spaces = [], selectedKey, selectedName, onSelect }: LibrarySpaceFilterProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentKeys, setRecentKeys] = useState(readRecentLibrarySpaces);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const searchable = spaces.length > SEARCH_THRESHOLD;

  const accessibleRecentKeys = useMemo(() => {
    const available = new Set(spaces.map((space) => space.key));
    return recentKeys.filter((key) => available.has(key));
  }, [recentKeys, spaces]);

  const filteredSpaces = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return spaces;
    return spaces.filter((space) => (
      space.name.toLocaleLowerCase().includes(normalizedQuery)
      || space.key.toLocaleLowerCase().includes(normalizedQuery)
    ));
  }, [query, spaces]);

  const recentSpaces = useMemo(() => {
    if (query.trim()) return [];
    return accessibleRecentKeys
      .map((key) => filteredSpaces.find((space) => space.key === key))
      .filter((space): space is LibrarySpace => space != null);
  }, [accessibleRecentKeys, filteredSpaces, query]);

  const otherSpaces = useMemo(() => {
    const recent = new Set(recentSpaces.map((space) => space.key));
    return filteredSpaces.filter((space) => !recent.has(space.key));
  }, [filteredSpaces, recentSpaces]);

  const visibleOptions = useMemo(
    () => [{ key: '', name: 'All spaces' }, ...recentSpaces, ...otherSpaces],
    [otherSpaces, recentSpaces],
  );

  useEffect(() => {
    const selectedIndex = visibleOptions.findIndex((space) => space.key === selectedKey);
    const queryFallback = query.trim() && visibleOptions.length > 1 ? 1 : 0;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : queryFallback);
  }, [query, selectedKey, visibleOptions]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const selectSpace = useCallback((spaceKey: string) => {
    onSelect(spaceKey);
    if (spaceKey) setRecentKeys(rememberRecentLibrarySpace(spaceKey));
    close();
  }, [close, onSelect]);

  const moveActive = useCallback((nextIndex: number, moveFocus: boolean) => {
    const bounded = Math.max(0, Math.min(nextIndex, visibleOptions.length - 1));
    setActiveIndex(bounded);
    if (moveFocus) optionRefs.current[bounded]?.focus();
  }, [visibleOptions.length]);

  const handleSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(activeIndex + 1, false);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(activeIndex - 1, false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = visibleOptions[activeIndex];
      if (option) selectSpace(option.key);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }, [activeIndex, close, moveActive, selectSpace, visibleOptions]);

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
      moveActive(visibleOptions.length - 1, true);
    }
  }, [moveActive, visibleOptions.length]);

  const renderOption = (space: LibrarySpace, index: number) => {
    const selected = space.key === selectedKey;
    const active = index === activeIndex;
    return (
      <button
        key={space.key || 'all-spaces'}
        ref={(element) => { optionRefs.current[index] = element; }}
        id={`library-space-option-${space.key || 'all'}`}
        type="button"
        role="option"
        aria-selected={selected}
        aria-label={space.key ? `${space.name} (${space.key})` : space.name}
        onClick={() => selectSpace(space.key)}
        onMouseEnter={() => setActiveIndex(index)}
        onKeyDown={(event) => handleOptionKeyDown(event, index)}
        className={cn(
          'flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-foreground outline-none transition-colors',
          active && 'bg-accent',
        )}
      >
        {space.key ? (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-accent text-xs font-semibold text-muted-foreground" aria-hidden="true">
            {space.name.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <Globe size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate">{space.name}</span>
        {space.key && <span className="shrink-0 text-xs text-muted-foreground">{space.key}</span>}
        {selected && <Check size={14} className="shrink-0 text-action" aria-hidden="true" />}
      </button>
    );
  };

  return (
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
          className="library-search-select flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground sm:h-8 sm:max-w-48 sm:flex-none sm:px-2 sm:text-xs"
          data-testid="space-filter-control"
          title={selectedKey ? `Space: ${selectedName ?? selectedKey}` : 'All spaces'}
          aria-label={`Filter by space, current: ${selectedName ?? 'All spaces'}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? 'library-space-options' : undefined}
        >
          <Globe size={14} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{selectedName ?? 'All spaces'}</span>
          <ChevronDown size={12} className="ml-auto shrink-0" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={8}
          className="nm-card-elevated z-50 w-[min(22rem,calc(100vw-1rem))] overflow-hidden p-0"
          aria-label="Space search scope"
          data-testid="space-filter-menu"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (searchable) searchRef.current?.focus();
            else optionRefs.current[Math.max(0, visibleOptions.findIndex((space) => space.key === selectedKey))]?.focus();
          }}
        >
          <div className="border-b border-border px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">Search scope</p>
          </div>
          {searchable && (
            <div className="border-b border-border p-2">
              <div className="flex h-9 items-center gap-2 rounded-md bg-background px-2.5">
                <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="text"
                  role="combobox"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search spaces by name or key"
                  aria-label="Search spaces"
                  aria-expanded="true"
                  aria-controls="library-space-options"
                  aria-activedescendant={visibleOptions[activeIndex] ? `library-space-option-${visibleOptions[activeIndex].key || 'all'}` : undefined}
                  autoComplete="off"
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                {query && (
                  <button type="button" onClick={() => setQuery('')} className="nm-icon-button size-7 shrink-0" aria-label="Clear space search">
                    <X size={13} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}
          <div id="library-space-options" role="listbox" aria-label="Spaces" className="max-h-[min(22rem,var(--radix-popover-content-available-height))] overflow-y-auto p-1.5">
            {renderOption(visibleOptions[0]!, 0)}
            {recentSpaces.length > 0 && (
              <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground" aria-hidden="true">Recent</p>
            )}
            {recentSpaces.map((space, index) => renderOption(space, index + 1))}
            {otherSpaces.length > 0 && (
              <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground" aria-hidden="true">
                {recentSpaces.length > 0 ? 'All spaces' : 'Spaces'}
              </p>
            )}
            {otherSpaces.map((space, index) => renderOption(space, index + 1 + recentSpaces.length))}
            {visibleOptions.length === 1 && query.trim() && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground" role="status">No spaces match “{query.trim()}”</p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
