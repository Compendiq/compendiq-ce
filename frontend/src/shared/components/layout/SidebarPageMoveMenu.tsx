import { useMemo, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronsUp, CornerDownRight, Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { MoveTarget } from './sidebar-tree-move';

const MENU_ITEM =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:bg-foreground/10 focus-visible:text-foreground transition-colors';

const SEARCH_THRESHOLD = 8;

export interface SidebarPageMoveMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageTitle: string;
  parentId: string | null;
  targets: MoveTarget[];
  onMove: (parentId: string | null) => void;
  children: ReactNode;
}

export function SidebarPageMoveMenu({
  open,
  onOpenChange,
  pageTitle,
  parentId,
  targets,
  onMove,
  children,
}: SidebarPageMoveMenuProps) {
  const [query, setQuery] = useState('');
  const showSearch = targets.length > SEARCH_THRESHOLD;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return targets;
    return targets.filter((t) => t.title.toLowerCase().includes(needle));
  }, [query, targets]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
    >
      <Popover.Anchor asChild>{children}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={`Move ${pageTitle}`}
          data-testid="sidebar-move-menu"
          className={cn(
            'z-50 w-64 nm-popover-glass p-1.5',
            'motion-safe:animate-in motion-safe:fade-in-0 duration-75',
          )}
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Move into
          </p>
          {showSearch && (
            <div className="relative mb-1.5 px-1">
              <Search
                size={12}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search pages…"
                aria-label="Search pages to nest under"
                data-testid="sidebar-move-search"
                className="nm-input h-8 w-full pl-7 text-sm"
                autoFocus
              />
            </div>
          )}
          <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Pages">
            {filtered.length === 0 ? (
              <p className="px-2.5 py-3 text-center text-xs text-muted-foreground" data-testid="sidebar-move-empty">
                {query.trim() ? 'No pages matching search.' : 'No other pages to nest under.'}
              </p>
            ) : (
              filtered.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  role="option"
                  className={MENU_ITEM}
                  style={{ paddingLeft: `${10 + target.depth * 12}px` }}
                  data-testid={`sidebar-move-target-${target.id}`}
                  onClick={() => {
                    onMove(target.id);
                    onOpenChange(false);
                  }}
                >
                  <CornerDownRight size={12} className="shrink-0" aria-hidden />
                  <span className="min-w-0 truncate">{target.title}</span>
                </button>
              ))
            )}
          </div>
          {parentId && (
            <>
              <div className="my-1 h-px bg-border/60" />
              <button
                type="button"
                className={MENU_ITEM}
                data-testid="sidebar-move-to-root"
                onClick={() => {
                  onMove(null);
                  onOpenChange(false);
                }}
              >
                <ChevronsUp size={12} className="shrink-0" aria-hidden />
                Move to top level
              </button>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
