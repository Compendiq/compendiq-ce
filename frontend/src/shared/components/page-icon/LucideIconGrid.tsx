import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { PAGE_LUCIDE_ICONS, getPageLucideIcon } from './page-lucide-icons';

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
  const icons = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PAGE_LUCIDE_ICONS;
    return PAGE_LUCIDE_ICONS.filter(
      (item) => item.label.toLowerCase().includes(q) || item.value.includes(q),
    );
  }, [query]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
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
        {icons.map((item) => {
          const Glyph = getPageLucideIcon(item.value);
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
      {icons.length === 0 && (
        <p className="text-muted-foreground px-1 py-3 text-center text-xs">
          No icons match “{query}”
        </p>
      )}
    </div>
  );
}
