import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Sparkles, RefreshCw, AlertCircle, Clock, CloudOff } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useSummaryRegenerate } from '../../hooks/use-pages';
import { isSummaryStale } from '../../lib/article-lede';
import type { SummaryStatus } from '../../hooks/use-pages';
import { useAuthStore } from '../../../stores/auth-store';
import { SanitizedHtml } from '../SanitizedHtml';

interface ArticleSummaryProps {
  pageId: string;
  summaryHtml: string | null;
  summaryStatus: SummaryStatus;
  summaryGeneratedAt: string | null;
  summaryModel: string | null;
  summaryError: string | null;
  /**
   * The article opens with a lede of its own, so this block should defer to it
   * and start collapsed. An explicit choice for this page always wins.
   */
  deferToLede?: boolean;
  /** Page's last-modified timestamp, for the staleness check. */
  lastModifiedAt?: string | null;
}

interface HealthStatus {
  services?: {
    llm?: boolean;
  };
}

/**
 * Per page. This used to be one global `article-summary-collapsed` flag, so the
 * chevron on any one summary silently set an app-wide preference — collapse the
 * summary on a page you already know, and every other page's summary is
 * collapsed too, with nothing saying so.
 */
const COLLAPSE_KEY_PREFIX = 'article-summary-collapsed:';
const LEGACY_GLOBAL_COLLAPSE_KEY = 'article-summary-collapsed';

function collapseKey(pageId: string): string {
  return `${COLLAPSE_KEY_PREFIX}${pageId}`;
}

/**
 * The stored value records an EXPLICIT user choice only. When there is none,
 * the default is computed per page (defer to a lede if the article has one), so
 * absence must stay distinguishable from `false` — hence the null check rather
 * than a `=== 'true'` coercion.
 */
function getCollapseState(pageId: string, deferToLede: boolean): boolean {
  try {
    // One-time cleanup: the global key is meaningless now, and leaving it
    // behind would strand a `true` in storage forever.
    localStorage.removeItem(LEGACY_GLOBAL_COLLAPSE_KEY);
    const stored = localStorage.getItem(collapseKey(pageId));
    if (stored === null) return deferToLede;
    return stored === 'true';
  } catch {
    return deferToLede;
  }
}

function setCollapseState(pageId: string, collapsed: boolean): void {
  try {
    localStorage.setItem(collapseKey(pageId), String(collapsed));
  } catch {
    // Ignore storage errors
  }
}

export function ArticleSummary({
  pageId,
  summaryHtml,
  summaryStatus,
  summaryGeneratedAt,
  summaryModel,
  summaryError,
  deferToLede = false,
  lastModifiedAt = null,
}: ArticleSummaryProps) {
  // Initialiser runs once per mount, and PageViewPage keys this component on the
  // page id so navigating between articles genuinely remounts it — without that
  // key React would reconcile by position and carry one page's collapse state
  // onto the next.
  const [collapsed, setCollapsed] = useState(() => getCollapseState(pageId, deferToLede));
  const regenerateMutation = useSummaryRegenerate();
  // #356: backend route is admin-only (`requireAdmin`). Hide the
  // Regenerate / Retry buttons for non-admins so we don't ship a
  // visible-but-403ing control to viewers.
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  // While a summary is pending we promise it "will be generated shortly" —
  // a promise that can't be kept when the LLM provider is down. #1052:
  // /api/health returns the `services` payload only to an authenticated admin,
  // so attach the access token. Both 200 (ok) and 503 (degraded) carry the
  // payload, so parse the body regardless of status. Non-admins get a coarse
  // `{ status }` (no `services`), so the offline note simply won't show.
  const { data: health } = useQuery<HealthStatus>({
    queryKey: ['health'],
    queryFn: () => {
      const { accessToken } = useAuthStore.getState();
      return fetch('/api/health', {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        credentials: 'include',
      }).then((r) => r.json() as Promise<HealthStatus>);
    },
    staleTime: 30_000,
    retry: false,
    enabled: summaryStatus === 'pending',
  });

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setCollapseState(pageId, next);
      return next;
    });
  }, [pageId]);

  // Same predicate the summary worker uses to re-queue a stale summary. It runs
  // on a batch interval, so between an edit and the next batch the page shows a
  // summary of content that no longer exists — this is the only thing that says
  // so, and unlike Regenerate it is not admin-gated.
  const stale = isSummaryStale(lastModifiedAt, summaryGeneratedAt);

  const handleRegenerate = useCallback(() => {
    regenerateMutation.mutate(pageId, {
      onSuccess: () => toast.success('Summary regeneration queued'),
      onError: (err) => {
        // #356: surface the server's specific message instead of a generic
        // toast (mirrors the #357 verify-button fix). ApiError.message already
        // carries the backend reply (e.g. "Page not found", "Admin access
        // required"); fall back to the generic copy only if the error has
        // no message.
        const msg = err instanceof Error && err.message
          ? err.message
          : 'Failed to queue summary regeneration';
        toast.error(msg);
      },
    });
  }, [pageId, regenerateMutation]);

  // Don't render if no summary and not in a visible state
  if (summaryStatus === 'skipped') return null;

  // Pending / summarizing states: show a subtle indicator
  if (summaryStatus === 'pending' || summaryStatus === 'summarizing') {
    // Pending + LLM provider down: "will be generated shortly" never
    // materializes — say so instead of dangling the promise. An in-flight
    // generation ('summarizing') already left the queue, so keep its text.
    if (summaryStatus === 'pending' && health?.services?.llm === false) {
      return (
        <div
          className="mb-6 flex items-center gap-2 rounded-lg border border-border bg-foreground/[0.03] px-4 py-3"
          data-testid="article-summary-offline"
        >
          <CloudOff size={16} className="text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            AI summary unavailable — LLM provider offline
          </span>
        </div>
      );
    }
    return (
      <div
        className="mb-6 flex items-center gap-2 rounded-lg border border-status-ai/20 bg-status-ai/5 px-4 py-3"
        data-testid="article-summary-pending"
      >
        <Clock size={16} className={cn('text-status-ai', summaryStatus === 'summarizing' && 'animate-pulse')} />
        <span className="text-sm text-muted-foreground">
          {summaryStatus === 'summarizing'
            ? 'Generating AI summary...'
            : 'AI summary will be generated shortly'}
        </span>
      </div>
    );
  }

  // Failed state: show error with retry
  if (summaryStatus === 'failed') {
    return (
      <div
        className="mb-6 flex items-center justify-between gap-2 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3"
        data-testid="article-summary-failed"
      >
        <div className="flex items-center gap-2">
          <AlertCircle size={16} className="text-destructive" />
          <span className="text-sm text-destructive">
            Summary generation failed{summaryError ? `: ${summaryError}` : ''}
          </span>
        </div>
        {isAdmin && (
          <button
            onClick={handleRegenerate}
            disabled={regenerateMutation.isPending}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
            data-testid="summary-retry-button"
          >
            <RefreshCw size={12} className={cn(regenerateMutation.isPending && 'animate-spin')} />
            Retry
          </button>
        )}
      </div>
    );
  }

  // Summarized state: show the full banner
  if (summaryStatus !== 'summarized' || !summaryHtml) return null;

  // Violet, not Steel, for every part of this block. ADR-010 reserves violet for
  // AI and Steel for brand + interaction; this block used to switch families
  // between states — status-ai while pending, primary once delivered — so the
  // same Sparkles glyph read violet in the Assistant tab and Steel here, one
  // click apart on the same route. Steel additionally implied the card was a
  // control.
  return (
    <div
      className="mb-6 rounded-lg border border-status-ai/20 bg-status-ai/5"
      data-testid="article-summary"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={toggleCollapse}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(); } }}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left"
      >
        {/* `min-w-0` + `shrink-0` per item: once this block defers to the lede,
            the collapsed header IS the whole component on a phone, and the row
            used to wrap into "AI / Summary", "2d / ago" and a hyphen-broken
            "(gemma-4-e4b-it- / mlx)" — the least important fact taking a third
            of the width. Nothing wraps now; the model name is the one part that
            drops below `sm`, because it is the one nobody reads on a phone. */}
        <div className="flex min-w-0 items-center gap-2">
          {/* status-ai, not primary: violet marks AI in every state (#1250). */}
          <Sparkles size={16} className="shrink-0 text-status-ai" />
          <span className="shrink-0 whitespace-nowrap text-sm font-medium text-foreground">
            AI Summary
          </span>
          {summaryGeneratedAt && (
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {formatRelativeTime(summaryGeneratedAt)}
            </span>
          )}
          {summaryModel && (
            <span className="hidden truncate text-xs text-muted-foreground/60 sm:inline">
              ({summaryModel})
            </span>
          )}
          {/* Amber, and in the HEADER rather than the body: the header renders
              whether or not the block is collapsed, so deferring to the lede can
              never hide the fact that the summary describes older content.
              ADR-010 reserves amber for exactly this — attention, not refusal. */}
          {stale && (
            <span
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
              data-testid="article-summary-stale"
              title="This page has been edited since the summary was generated. A new summary is queued automatically."
            >
              <AlertCircle size={12} className="shrink-0" />
              Page edited since
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isAdmin && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRegenerate();
              }}
              disabled={regenerateMutation.isPending}
              className="rounded-md p-1 text-muted-foreground/60 hover:bg-foreground/5 hover:text-muted-foreground"
              title="Regenerate summary"
              data-testid="summary-regenerate-button"
            >
              <RefreshCw size={14} className={cn(regenerateMutation.isPending && 'animate-spin')} />
            </button>
          )}
          {collapsed ? (
            <ChevronRight size={16} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={16} className="text-muted-foreground" />
          )}
        </div>
      </div>

      {!collapsed && (
        <SanitizedHtml
          className="border-t border-status-ai/10 px-4 pb-4 pt-2 text-sm text-foreground/90 prose prose-sm max-w-none dark:prose-invert"
          data-testid="article-summary-content"
          html={summaryHtml}
        />
      )}
    </div>
  );
}
