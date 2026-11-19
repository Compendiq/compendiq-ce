import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  getCachedPageLucideCatalog,
  loadPageLucideCatalog,
  type PageLucideCatalog,
} from './page-lucide-loader';

const INITIAL_VISIBLE_ICONS = 96;

export function LucideIconGrid({
  selected,
  filled = false,
  onFilledChange,
  onPick,
}: {
  selected?: string | null;
  filled?: boolean;
  onFilledChange?: (filled: boolean) => void;
  onPick: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [catalog, setCatalog] = useState<PageLucideCatalog | null>(getCachedPageLucideCatalog);

  useEffect(() => {
    if (catalog) return;
    let active = true;
    void loadPageLucideCatalog().then((loaded) => {
      if (active) setCatalog(loaded);
    });
    return () => {
      active = false;
    };
  }, [catalog]);

  const icons = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    if (!q) return catalog.PAGE_LUCIDE_ICONS;
    return catalog.PAGE_LUCIDE_ICONS.filter(
      (item) => item.label.toLowerCase().includes(q) || item.value.includes(q),
    );
  }, [catalog, query]);

  const visibleIcons = showAll || query.trim().length > 0
    ? icons
    : icons.slice(0, INITIAL_VISIBLE_ICONS);
  const remainingCount = icons.length - visibleIcons.length;

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShowAll(false);
            }}
            placeholder="Search icons…"
            aria-label="Search icons"
            className="nm-input h-8 w-full pl-7 text-sm"
            data-testid="page-icon-search"
          />
        </div>
        <div className="inline-flex shrink-0 rounded-md bg-muted p-0.5" role="group" aria-label="Icon style">
          <button
            type="button"
            onClick={() => onFilledChange?.(false)}
            aria-pressed={!filled}
            className={cn(
              'rounded-sm px-2 py-1 text-xs font-medium transition-colors',
              !filled ? 'nm-pill-active' : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid="page-icon-style-outline"
          >
            Outline
          </button>
          <button
            type="button"
            onClick={() => onFilledChange?.(true)}
            aria-pressed={filled}
            className={cn(
              'rounded-sm px-2 py-1 text-xs font-medium transition-colors',
              filled ? 'nm-pill-active' : 'text-muted-foreground hover:text-foreground',
            )}
            data-testid="page-icon-style-filled"
          >
            Filled
          </button>
        </div>
      </div>
      <div
        className="grid max-h-72 grid-cols-6 gap-1 overflow-y-auto"
        data-testid="page-icon-lucide-grid"
      >
        {visibleIcons.map((item) => {
          const Glyph = catalog?.getPageLucideIcon(item.value);
          if (!Glyph) return null;
          const isSelected = selected === item.value;
          return (
            <button
              key={item.value}
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-pressed={isSelected}
              className={cn(
                'nm-focus-ring flex size-10 items-center justify-center rounded-md border',
                isSelected
                  ? 'border-border-interactive bg-foreground/8 text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
              onClick={() => onPick(item.value)}
            >
              <Glyph
                size={18}
                aria-hidden
                fill={filled ? 'currentColor' : 'none'}
                className={cn(filled && 'page-icon-filled')}
              />
            </button>
          );
        })}
      </div>
      {remainingCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 w-full rounded-md border border-border py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          data-testid="page-icon-show-all"
        >
          Show all {icons.length} icons
        </button>
      )}
      {catalog && icons.length === 0 && (
        <p className="text-muted-foreground px-1 py-3 text-center text-xs">
          No icons match “{query}”
        </p>
      )}
    </div>
  );
}
