import { useState, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Sparkles, RefreshCw, AlertCircle, Clock } from 'lucide-react';
import DOMPurify from 'dompurify';
import { toast } from 'sonner';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useSummaryRegenerate } from '../../hooks/use-pages';
import type { SummaryStatus } from '../../hooks/use-pages';
import { useAuthStore } from '../../../stores/auth-store';

interface ArticleSummaryProps {
  pageId: string;
  summaryHtml: string | null;
  summaryStatus: SummaryStatus;
  summaryGeneratedAt: string | null;
  summaryModel: string | null;
  summaryError: string | null;
}

const COLLAPSE_KEY = 'article-summary-collapsed';

function getCollapseState(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

function setCollapseState(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, String(collapsed));
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
}: ArticleSummaryProps) {
  const [collapsed, setCollapsed] = useState(getCollapseState);
  const regenerateMutation = useSummaryRegenerate();
  // #356: backend route is admin-only (`requireAdmin`). Hide the
  // Regenerate / Retry buttons for non-admins so we don't ship a
  // visible-but-403ing control to viewers.
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  // Sanitize LLM-generated HTML to prevent XSS
  const sanitizedHtml = useMemo(
    () => (summaryHtml ? DOMPurify.sanitize(summaryHtml) : ''),
    [summaryHtml],
  );

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      setCollapseState(next);
      return next;
    });
  }, []);

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
    return (
      <div
        className="mb-6 flex items-center gap-2 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3"
        data-testid="article-summary-pending"
      >
        <Clock size={16} className={cn('text-purple-400', summaryStatus === 'summarizing' && 'animate-pulse')} />
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
        className="mb-6 flex items-center justify-between gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3"
        data-testid="article-summary-failed"
      >
        <div className="flex items-center gap-2">
          <AlertCircle size={16} className="text-red-400" />
          <span className="text-sm text-red-400">
            Summary generation failed{summaryError ? `: ${summaryError}` : ''}
          </span>
        </div>
        {isAdmin && (
          <button
            onClick={handleRegenerate}
            disabled={regenerateMutation.isPending}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
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

  return (
    <div
      className="mb-6 rounded-lg border border-primary/20 bg-primary/5"
      data-testid="article-summary"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={toggleCollapse}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(); } }}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-primary" />
          <span className="text-sm font-medium text-foreground">AI Summary</span>
          {summaryGeneratedAt && (
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(summaryGeneratedAt)}
            </span>
          )}
          {summaryModel && (
            <span className="text-xs text-muted-foreground/60">
              ({summaryModel})
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
        <div
          className="border-t border-primary/10 px-4 pb-4 pt-2 text-sm text-foreground/90 prose prose-sm max-w-none dark:prose-invert"
          data-testid="article-summary-content"
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
        />
      )}
    </div>
  );
}
