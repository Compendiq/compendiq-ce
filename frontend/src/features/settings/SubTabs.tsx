import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { cn } from '../../shared/lib/cn';

export interface SubTabDef {
  /** URL-segment friendly id; written to `?sub=<id>`. */
  id: string;
  /** Human label shown on the tab. */
  label: string;
  /** When false, the tab is hidden (use for EE feature gating). Default true. */
  visible?: boolean;
  /** Optional small badge text (e.g., 'EE'). */
  badge?: string;
  /** Renders this tab's body. Called lazily — only when active. */
  render: () => ReactNode;
}

interface SubTabsProps {
  /** aria-label for the tablist (e.g., 'AI Models sub-sections'). */
  ariaLabel: string;
  /** Ordered list of sub-tabs. First *visible* tab is the default. */
  tabs: SubTabDef[];
  /** Optional data-testid suffix root, e.g., 'ai-models' → 'subtab-ai-models-llm'. */
  testIdRoot?: string;
}

/**
 * Sub-tab segmented control synced to the `?sub=` query param. Used by the
 * consolidated Settings wrapper panels to expose multiple sub-sections without
 * adding more entries to the left rail.
 *
 * Why query-string and not nested routes: the wrapper panels share the same
 * `<Suspense>` and access-context shell as the rest of `/settings/:cat/:item`,
 * so a query param keeps the routing flat and avoids a second layer of
 * lazy-loaded panel boundaries.
 */
export function SubTabs({ ariaLabel, tabs, testIdRoot }: SubTabsProps) {
  const [params, setParams] = useSearchParams();
  const visible = useMemo(() => tabs.filter((t) => t.visible !== false), [tabs]);

  const requested = params.get('sub');
  const activeId =
    visible.find((t) => t.id === requested)?.id ?? visible[0]?.id ?? '';
  const active = visible.find((t) => t.id === activeId);

  const setSub = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      // Drop ?sub= when selecting the default — keeps URLs clean for the
      // common case of "just the wrapper page, default view".
      if (id === visible[0]?.id) next.delete('sub');
      else next.set('sub', id);
      setParams(next, { replace: true });
    },
    [params, setParams, visible],
  );

  if (visible.length === 0) return null;

  // Single visible tab: skip the tablist entirely, render the body directly.
  // Keeps the UI calm when EE features are absent.
  if (visible.length === 1) {
    return <div className="space-y-6">{visible[0]!.render()}</div>;
  }

  return (
    <div className="space-y-6">
      {/* `inline-flex` instead of `flex` so the tablist hugs its content
          rather than stretching to the full panel width — a 1140px-wide
          segmented control reads like a banner rather than a tab strip. */}
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-foreground/[0.04] p-1"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const ids = visible.map((t) => t.id);
          const idx = ids.indexOf(activeId);
          const nextIdx =
            e.key === 'ArrowRight'
              ? (idx + 1) % ids.length
              : (idx - 1 + ids.length) % ids.length;
          const nextId = ids[nextIdx];
          if (nextId) setSub(nextId);
        }}
      >
        {visible.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setSub(tab.id)}
              data-testid={testIdRoot ? `subtab-${testIdRoot}-${tab.id}` : undefined}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors',
                isActive
                  ? 'bg-card text-primary-ink shadow-sm ring-1 ring-primary/35 font-medium'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              <span>{tab.label}</span>
              {tab.badge && (
                <span className="rounded-sm border border-white/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {/* No motion wrapper around the body. An earlier draft used
          AnimatePresence(mode="wait") to cross-fade sub-tabs, but the same
          pattern caused stuck exit layers on React 19 + framer-motion 12
          elsewhere in this codebase (see PageTransition.tsx) — the phantom
          layer intercepts wheel events and blocks page scroll. The cross-fade
          is decorative; the scroll is load-bearing. Plain swap wins. */}
      <div>{active?.render()}</div>
    </div>
  );
}
