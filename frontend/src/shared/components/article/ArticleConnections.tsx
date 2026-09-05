import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ConnectionEvent, ConnectionItem, ConnectionReason, PageConnections } from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../lib/api';

interface ArticleConnectionsProps {
  pageId: string;
}

type ConnectionGroup = 'linked' | 'section' | 'related';

const GROUPS: Array<{ key: ConnectionGroup; heading: string }> = [
  { key: 'linked', heading: 'Linked articles' },
  { key: 'section', heading: 'In this section' },
  { key: 'related', heading: 'Related articles' },
];



function reasonText(reason: ConnectionReason): string {
  switch (reason.type) {
    case 'explicit_link':
      return reason.direction === 'incoming' ? 'Links to this article' : 'Linked from this article';
    case 'parent_child':
      return reason.direction === 'parent' ? 'Parent page' : 'Child of this page';
    case 'embedding_similarity':
      return `Similar content · ${reason.score.toFixed(2)}`;
    case 'label_overlap':
      return `Shares labels: ${reason.labels.join(', ')}`;
  }
}

function ConnectionList({
  group,
  items,
  onConnectionClick,
}: {
  group: ConnectionGroup;
  items: ConnectionItem[];
  onConnectionClick: (targetPageId: string, group: ConnectionGroup) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby={`article-connections-${group}`}>
      <h3 id={`article-connections-${group}`} className="mb-1 text-sm font-semibold text-foreground">
        {GROUPS.find((item) => item.key === group)?.heading}
      </h3>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.pageId} className="min-w-0 px-3 py-2">
            <Link
              to={`/pages/${encodeURIComponent(item.pageId)}`}
              className="nm-focus-ring break-words text-sm font-medium text-primary underline decoration-primary/50 underline-offset-2 hover:decoration-primary"
              onClick={() => onConnectionClick(item.pageId, group)}
            >
              {item.title}
            </Link>
            <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">
              {item.reasons.map(reasonText).join(' · ')}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Related, hierarchical, and directly linked pages for one mounted article visit.
 * The visit id intentionally belongs to this keyed panel, so a route visit may
 * record one new impression while rerenders and refetches cannot.
 */
export function ArticleConnections({ pageId }: ArticleConnectionsProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const retryTargetRef = useRef<HTMLHeadingElement | null>(null);
  const [visitId] = useState(() => crypto.randomUUID());
  const [retryInFlight, setRetryInFlight] = useState(false);
  const [restoreFocusAfterRetry, setRestoreFocusAfterRetry] = useState(false);
  const impressionSentRef = useRef(false);
  const panelVisibleRef = useRef(false);

  const query = useQuery({
    queryKey: ['pages', pageId, 'connections'],
    queryFn: () => apiFetch<PageConnections>(`/pages/${encodeURIComponent(pageId)}/connections`),
  });

  const accessFailure = query.failureReason ?? query.error;
  const permissionError = accessFailure instanceof ApiError && [401, 403, 404].includes(accessFailure.statusCode);
  const connections = permissionError ? undefined : query.data;

  const recordEvent = useCallback(
    (event: ConnectionEvent) => {
      // Telemetry must never delay navigation or interaction feedback.
      void apiFetch(`/pages/${encodeURIComponent(pageId)}/connections/events`, {
        method: 'POST',
        body: JSON.stringify(event),
      }).catch(() => undefined);
    },
    [pageId],
  );

  useEffect(() => {
    if (!query.isSuccess || !connections || !panelVisibleRef.current || impressionSentRef.current) return;
    impressionSentRef.current = true;
    recordEvent({ event: 'impression', visitId });
  }, [connections, query.isSuccess, recordEvent, visitId]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const observer = new IntersectionObserver(([entry]) => {
      panelVisibleRef.current = entry?.isIntersecting ?? false;
      if (panelVisibleRef.current && query.isSuccess && connections && !impressionSentRef.current) {
        impressionSentRef.current = true;
        recordEvent({ event: 'impression', visitId });
      }
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [connections, query.isSuccess, recordEvent, visitId]);

  useEffect(() => {
    if (!restoreFocusAfterRetry || retryInFlight || query.isError) return;
    setRestoreFocusAfterRetry(false);
    const active = document.activeElement;
    if (active && active !== document.body) return;
    retryTargetRef.current?.focus();
  }, [query.isError, restoreFocusAfterRetry, retryInFlight]);

  const retry = useCallback(() => {
    if (retryInFlight) return;
    setRetryInFlight(true);
    setRestoreFocusAfterRetry(true);
    void query
      .refetch()
      .then(
        (result) => setRestoreFocusAfterRetry(!result.isError),
        () => setRestoreFocusAfterRetry(false),
      )
      .finally(() => setRetryInFlight(false));
  }, [query, retryInFlight]);

  const onGraphLaunch = useCallback(() => {
    recordEvent({ event: 'graph_launch', visitId });
  }, [recordEvent, visitId]);

  const onConnectionClick = useCallback(
    (targetPageId: string, group: ConnectionGroup) => {
      recordEvent({ event: 'connection_click', visitId, targetPageId, group });
    },
    [recordEvent, visitId],
  );

  const loading = query.isPending && !connections;
  const failedWithoutCache = (query.isError || permissionError || retryInFlight) && !connections;
  const stale = (query.isError || retryInFlight) && Boolean(connections);

  return (
    <section ref={panelRef} aria-labelledby="article-connections-heading" className="mt-8 border-t border-border pt-5">
      <div className="mb-4 flex min-w-0 items-baseline justify-between gap-3 max-sm:flex-wrap">
        <h2 ref={retryTargetRef} tabIndex={-1} id="article-connections-heading" className="nm-focus-ring text-base font-semibold text-foreground">
          Connections
        </h2>
        <Link
          to={`/graph?focus=${encodeURIComponent(pageId)}`}
          className="nm-focus-ring shrink-0 text-sm text-primary underline underline-offset-2"
          onClick={onGraphLaunch}
        >
          Explore connections
        </Link>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading connections…</p>}

      {failedWithoutCache && (
        <div role="status" className="text-sm text-muted-foreground">
          <p>
            Couldn&apos;t load connections.
          </p>
          <button
            type="button"
            className="nm-focus-ring mt-2 text-sm font-medium text-primary underline underline-offset-2 aria-disabled:cursor-default aria-disabled:opacity-70"
            onClick={retry}
            aria-disabled={retryInFlight || undefined}
          >
            {retryInFlight ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {stale && (
        <div role="status" className="mb-3 text-sm text-muted-foreground">
          <p>Couldn&apos;t refresh connections. Showing the last loaded results.</p>
          <button
            type="button"
            className="nm-focus-ring mt-1 text-sm font-medium text-primary underline underline-offset-2 aria-disabled:cursor-default aria-disabled:opacity-70"
            onClick={retry}
            aria-disabled={retryInFlight || undefined}
          >
            {retryInFlight ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}

      {connections && (connections.linked.length === 0 && connections.section.length === 0 && connections.related.length === 0 ? (
        <p className="text-sm text-muted-foreground">No connections found for this article.</p>
      ) : (
        <div className="space-y-4">
          {GROUPS.map(({ key }) => (
            <ConnectionList key={key} group={key} items={connections[key]} onConnectionClick={onConnectionClick} />
          ))}
        </div>
      ))}
    </section>
  );
}
