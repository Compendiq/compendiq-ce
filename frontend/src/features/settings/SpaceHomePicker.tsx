import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Home, RotateCcw, Search, Loader2, Check } from 'lucide-react';
import { toast } from 'sonner';
import { useSetSpaceHome } from '../../shared/hooks/use-spaces';
import { useSearch } from '../../shared/hooks/use-standalone';
import { usePage } from '../../shared/hooks/use-pages';
import { usePermission } from '../../shared/hooks/use-permission';
import { cn } from '../../shared/lib/cn';

interface SpaceHomePickerProps {
  spaceKey: string;
  /** Resolved homepage id from `useSpaces()` — custom override OR Confluence default. */
  resolvedHomePageId: string | null;
  /** Raw custom override (null when the space falls back to the Confluence default). */
  customHomePageId: number | null | undefined;
}

/**
 * #379: Per-space home page picker. Renders a small "Set home" affordance
 * inside Settings → Spaces; opens a Radix Popover with a search-style
 * page selector scoped to the current space. The "Use Confluence default"
 * button clears the override (PUT homePageId: null).
 *
 * RBAC: gated on `usePermission('manage', 'space', spaceKey)`. The same
 * permission the backend enforces in PUT /api/spaces/:key/home — so a
 * non-permitted user just sees a disabled trigger with a tooltip, and
 * even if they bypass the gate the backend returns 403 which surfaces
 * as a sonner toast through the mutation's error path.
 */
export function SpaceHomePicker({
  spaceKey,
  resolvedHomePageId,
  customHomePageId,
}: SpaceHomePickerProps) {
  const { allowed: canManage, loading: permLoading } = usePermission(
    'manage',
    'space',
    spaceKey,
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const setHome = useSetSpaceHome();

  // Show the resolved current home (page title + breadcrumb-ish hint).
  // The search hook is enabled at q.length >= 2 so the page lookup here
  // is independent and only fires when we have an id to look up.
  const currentHome = usePage(resolvedHomePageId ?? undefined);

  // Page search results scoped to this space (acceptance bullet:
  // "search-style page selector scoped to the current space").
  const search = useSearch({ q: query.trim(), spaceKey });

  const setOverride = (homePageId: number | null) => {
    setHome.mutate(
      { spaceKey, homePageId },
      {
        onSuccess: () => {
          toast.success(
            homePageId === null
              ? 'Reverted to the Confluence default home page.'
              : 'Space home page updated.',
          );
          setOpen(false);
          setQuery('');
        },
        onError: (err) => {
          toast.error(err.message || 'Could not update the space home page.');
        },
      },
    );
  };

  // Hide while the permission check is loading to avoid flicker; show a
  // disabled trigger when the user can't manage the space (acceptance:
  // "non-permitted user shows a disabled state or hides the control").
  if (permLoading) return null;

  const triggerLabel = customHomePageId != null ? 'Custom home set' : 'Use default home';

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={!canManage}
          aria-disabled={!canManage}
          aria-label={`Set home page for ${spaceKey}`}
          title={
            canManage
              ? `Pick a custom home page for ${spaceKey}`
              : 'You need admin or manage permission to set the home page'
          }
          data-testid={`space-home-picker-trigger-${spaceKey}`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'flex shrink-0 items-center gap-1.5 rounded-md border border-border/50 px-2.5 py-1 text-xs',
            'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            canManage
              ? 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
              : 'cursor-not-allowed opacity-50',
            customHomePageId != null && 'border-primary/40 text-primary',
          )}
        >
          <Home size={12} />
          {triggerLabel}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          onClick={(e) => e.stopPropagation()}
          className="z-50 w-80 rounded-lg border border-border bg-card p-3 shadow-lg outline-none"
          data-testid={`space-home-picker-content-${spaceKey}`}
        >
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">Space home page</p>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {customHomePageId != null
                  ? 'Currently using a custom override.'
                  : 'Currently using the Confluence default.'}
              </p>
            </div>
          </div>

          {/* Resolved current home display. The space may resolve to no
              homepage at all (Confluence space without one + no override),
              in which case this block stays hidden. */}
          {resolvedHomePageId && (
            <div
              className="mb-2 flex items-center gap-2 rounded-md bg-foreground/5 px-2 py-1.5"
              data-testid="space-home-picker-current"
            >
              <Check size={12} className="text-primary" />
              <p className="min-w-0 truncate text-xs">
                <span className="text-muted-foreground">Current: </span>
                <span className="font-medium">
                  {currentHome.data?.title ?? `Page #${resolvedHomePageId}`}
                </span>
              </p>
            </div>
          )}

          {/* Search input. spaceKey is forwarded so results stay scoped to
              this space — backend `PUT /spaces/:key/home` rejects pages
              from other spaces (except shared standalone), so cross-space
              picking would just be a wasted round-trip. */}
          <div className="relative mb-2">
            <Search
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search pages in ${spaceKey}…`}
              className="w-full rounded-md border border-border/50 bg-background py-1.5 pl-7 pr-2 text-xs focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
              data-testid={`space-home-picker-search-${spaceKey}`}
              autoFocus
            />
          </div>

          {/* Search results — empty state only when we've issued a query
              (useSearch is enabled at q.length >= 2). */}
          <div className="max-h-56 overflow-y-auto" role="listbox" aria-label="Page results">
            {query.trim().length < 2 ? (
              <p className="px-1 py-2 text-[11px] text-muted-foreground">
                Type at least 2 characters to search.
              </p>
            ) : search.isLoading ? (
              <div className="flex items-center justify-center py-3 text-muted-foreground">
                <Loader2 size={14} className="animate-spin" />
              </div>
            ) : (search.data?.items ?? []).length === 0 ? (
              <p className="px-1 py-2 text-[11px] text-muted-foreground">No matching pages.</p>
            ) : (
              <ul className="space-y-0.5">
                {(search.data?.items ?? []).map((p) => {
                  const isCurrent =
                    resolvedHomePageId != null && String(p.id) === String(resolvedHomePageId);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        disabled={setHome.isPending}
                        onClick={() => setOverride(p.id)}
                        className={cn(
                          'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                          'hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          isCurrent && 'bg-primary/10 text-primary',
                        )}
                        data-testid={`space-home-picker-result-${p.id}`}
                      >
                        <span className="flex-1 truncate">{p.title}</span>
                        {isCurrent && <Check size={12} className="shrink-0 text-primary" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* "Use Confluence default" — clears the override. Disabled when
              there isn't one to clear, so the action is unambiguous. */}
          <div className="mt-2 flex items-center justify-end border-t border-border/40 pt-2">
            <button
              type="button"
              onClick={() => setOverride(null)}
              disabled={setHome.isPending || customHomePageId == null}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              data-testid={`space-home-picker-reset-${spaceKey}`}
            >
              <RotateCcw size={12} />
              Use Confluence default
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
