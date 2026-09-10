import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { PAGE_BRAND_ICONS, getPageBrandIcon } from '@compendiq/contracts';
import { cn } from '../../lib/cn';
import { BrandMark } from './BrandMark';

export function BrandIconGrid({
  selected,
  onPick,
}: {
  selected?: string | null;
  onPick: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const icons = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PAGE_BRAND_ICONS;
    return PAGE_BRAND_ICONS.filter(
      (item) => item.label.toLowerCase().includes(q) || item.value.includes(q),
    );
  }, [query]);

  return (
    <div>
      <div className="relative mb-2 flex items-center">
        <Search size={14} className="pointer-events-none absolute left-2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search logos…"
          aria-label="Search logos"
          className="nm-input h-8 w-full pl-7 text-sm"
          data-testid="page-icon-brand-search"
        />
      </div>
      <div
        className="grid max-h-72 grid-cols-6 gap-1 overflow-y-auto"
        data-testid="page-icon-brand-grid"
      >
        {icons.map((item) => {
          const mark = getPageBrandIcon(item.value);
          if (!mark) return null;
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
              <BrandMark path={mark.path} size={18} />
            </button>
          );
        })}
      </div>
      {icons.length === 0 && (
        <p className="text-muted-foreground px-1 py-3 text-center text-xs">
          No logos match “{query}”
        </p>
      )}
    </div>
  );
}
