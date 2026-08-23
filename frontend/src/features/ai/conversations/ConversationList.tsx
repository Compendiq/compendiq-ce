import { useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { ApiError } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import { SECTION_LABEL } from '../../../shared/components/layout/SidebarTreeView';
import { useListRovingFocus } from '../../../shared/hooks/use-list-roving-focus';
import { conversationIdFromPath } from '../../../shared/lib/ai-routes';
import { filterConversations } from './filter-conversations';
import { groupByRecency } from './group-by-recency';
import { ConversationRow } from './ConversationRow';
import type { useConversationList } from './use-conversation-list';

export interface ConversationListProps {
  list: ReturnType<typeof useConversationList>;
  filter: string;
  onNavigate?: () => void;
  /** Test seam: the clock the recency buckets are computed against. */
  now?: () => Date;
}

const headingId = (label: string) =>
  `conversations-group-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/**
 * The recency groups, the three list states and Show more.
 *
 * Returns a FRAGMENT, not a wrapper: the scroller is `min-h-0 flex-1` inside the
 * chassis's flex column, and the degraded strip above it and the Show more row
 * below it are `shrink-0` siblings of it (amendment item 7). Wrapping them in a
 * div would put the button inside the scroll area and let it scroll out of reach.
 */
export function ConversationList({ list, filter, onNavigate, now = () => new Date() }: ConversationListProps) {
  const location = useLocation();
  const activeId = conversationIdFromPath(location.pathname);
  const navRef = useRef<HTMLElement>(null);
  const { query, rows } = list;

  const filtered = useMemo(() => filterConversations(rows, filter), [rows, filter]);
  const groups = useMemo(() => groupByRecency(filtered, now()), [filtered, now]);
  const ids = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);

  const { rovingId, handleRowFocus, handleRowKeyDown } = useListRovingFocus({
    ids,
    activeId,
    containerRef: navRef,
    itemAttr: 'data-row-id',
  });

  // A failed fetch is a failure, not an empty history (the tree learned this).
  // With rows still in hand it is a degradation instead: amber, not red.
  const failedWithNothing = query.isError && rows.length === 0;
  const degraded = query.isError && rows.length > 0;

  let body: React.ReactNode;
  if (query.isPending) {
    body = (
      <div className="space-y-1.5 py-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="h-7 animate-pulse rounded-lg bg-foreground/5"
            style={{ width: `${60 + ((i * 7) % 30)}%` }}
          />
        ))}
      </div>
    );
  } else if (failedWithNothing) {
    body = (
      <div
        className="flex flex-col items-center px-3 py-8 text-center"
        role="alert"
        data-testid="conversations-error"
      >
        <div className="mb-3 rounded-full bg-muted p-2.5">
          <AlertTriangle size={20} className="text-destructive" aria-hidden="true" />
        </div>
        <p className="text-xs font-medium text-foreground/70">Couldn&rsquo;t load conversations</p>
        <p className="mt-1 break-words line-clamp-3 text-[11px] text-muted-foreground">
          {query.error instanceof ApiError ? query.error.message : 'The request did not complete.'}
        </p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-action bg-transparent px-3 py-1.5 text-xs font-medium text-action transition-colors hover:bg-action hover:text-action-foreground disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(query.isFetching && 'animate-spin')} aria-hidden="true" />
          {query.isFetching ? 'Retrying' : 'Try again'}
        </button>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <p className="px-2 py-6 text-center text-xs text-muted-foreground">
        Your conversations will appear here. Only Q&A is saved.
      </p>
    );
  } else if (groups.length === 0) {
    body = <p className="px-2 py-4 text-center text-xs text-muted-foreground">No matching conversations</p>;
  } else {
    body = groups.map((group) => {
      const id = headingId(group.label);
      return (
        <section key={group.label} className="pb-2">
          <h3 id={id} className={cn(SECTION_LABEL, 'px-2 py-1')}>
            {group.label}
          </h3>
          <ul role="list" aria-labelledby={id} className="mt-0.5 flex flex-col gap-px">
            {group.items.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                tabIndex={rovingId === conversation.id ? 0 : -1}
                onRowFocus={handleRowFocus}
                onRowKeyDown={handleRowKeyDown}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </section>
      );
    });
  }

  return (
    <>
      {degraded && (
        <div
          role="status"
          data-testid="conversations-stale-notice"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5"
        >
          <AlertTriangle size={12} className="shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            Showing the last loaded conversations
          </span>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-action transition-colors hover:bg-[var(--glass-pill-hover)] disabled:opacity-40"
          >
            {query.isFetching ? 'Retrying' : 'Retry'}
          </button>
        </div>
      )}

      {/* The `navigation` landmark is scoped to the SETTLED states. A pending
          fetch renders the skeleton in a plain div instead: the landmark's
          accessible name does not depend on load state, so mounting it during
          the loading render would let a `findByRole('navigation', …)` resolve
          on the very first paint — before the mocked fetch has even settled —
          and every assertion that follows would race the query. Withholding it
          keeps `waitFor` on its MutationObserver path, which is what actually
          waits for the re-render. */}
      {query.isPending ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">{body}</div>
      ) : (
        <nav
          ref={navRef}
          aria-label="Conversation history"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        >
          {body}
        </nav>
      )}

      {/* Explicit paging, not infinite scroll: a button is reachable and
          announces itself. It stays available while a filter is active — it
          loads more rows INTO the filter. */}
      {query.hasNextPage && (
        <div className="shrink-0 px-2 pb-2">
          <button
            type="button"
            data-testid="conversations-show-more"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="nm-button-ghost w-full"
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </>
  );
}
