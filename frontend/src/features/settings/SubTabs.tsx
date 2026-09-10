import { useCallback, useMemo, useRef, type ReactNode } from 'react';
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
export function SubTabs({ ariaLabel, tabs, testIdRoot = 'tab' }: SubTabsProps) {
  const [params, setParams] = useSearchParams();
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
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

  const rootSlug = testIdRoot || 'tab';
  const panelId = `subtabpanel-${rootSlug}-${activeId}`;
  const tabId = `subtab-${rootSlug}-${activeId}`;

  return (
    <div className="space-y-6">
      {/* `inline-flex` instead of `flex` so the tablist hugs its content
          rather than stretching to the full panel width — a 1140px-wide
          segmented control reads like a banner rather than a tab strip. */}
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="inline-flex flex-wrap items-center gap-0.5 rounded-md bg-muted p-0.5"
        onKeyDown={(e) => {
          const ids = visible.map((t) => t.id);
          const idx = ids.indexOf(activeId);
          let targetId: string | undefined;

          if (e.key === 'ArrowRight') {
            targetId = ids[(idx + 1) % ids.length];
          } else if (e.key === 'ArrowLeft') {
            targetId = ids[(idx - 1 + ids.length) % ids.length];
          } else if (e.key === 'Home') {
            targetId = ids[0];
          } else if (e.key === 'End') {
            targetId = ids[ids.length - 1];
          }

          if (targetId) {
            e.preventDefault();
            setSub(targetId);
            tabRefs.current.get(targetId)?.focus();
          }
        }}
      >
        {visible.map((tab) => {
          const isActive = tab.id === activeId;
          const currentTabId = `subtab-${rootSlug}-${tab.id}`;
          const currentPanelId = `subtabpanel-${rootSlug}-${tab.id}`;
          return (
            <button
              key={tab.id}
              id={currentTabId}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              role="tab"
              aria-selected={isActive}
              aria-controls={currentPanelId}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setSub(tab.id)}
              data-testid={`subtab-${rootSlug}-${tab.id}`}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isActive
                  ? 'panel-tab-active font-medium'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              <span>{tab.label}</span>
              {tab.badge && (
                <span className="rounded-sm border border-border px-1.5 py-0.5 text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId}
        tabIndex={0}
        className="outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {active?.render()}
      </div>
    </div>
  );
}
