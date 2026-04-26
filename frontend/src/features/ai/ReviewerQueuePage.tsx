/**
 * ReviewerQueuePage — admin list of AI output reviews
 * (Compendiq/compendiq-ee#120).
 *
 * Filters: status (pending / approved / rejected / edit-and-approved /
 * expired) and action type (improve / summary / generate / auto_tag /
 * apply_improvement). Each row carries the page id, action type,
 * authoring user id, and submitted-at, and a "Review" button that
 * opens the full-viewport detail page at `/settings/ai-reviews/:id`.
 *
 * Backend contract (EE overlay PR #122):
 *   GET /api/ai-reviews?status=pending&limit=50 → { reviews: [...] }
 *
 * The brief described a richer card (author username, page title,
 * use-case chip, expiry countdown). The actual list endpoint only
 * returns the thin row shape — `page_id`, `action_type`, `authored_by`,
 * `authored_at`, `status` — which is what the overlay route projects
 * from `ai_output_reviews`. We render what's available and link
 * straight to the detail page where the page title, current body, and
 * proposed body are joined in. The PR body documents this divergence.
 *
 * In CE-only deployments the GET 404s; we surface a non-fatal "EE only"
 * notice rather than crashing — same pattern as the IP allowlist tab.
 */

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Info,
  ListChecks,
} from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import {
  AI_REVIEW_ACTION_LABELS,
  AI_REVIEW_STATUSES,
  type AiReviewListItem,
  type AiReviewListResponse,
  type AiReviewStatus,
} from '@compendiq/contracts';

interface BackendErrorBody {
  error?: string;
  message?: string;
}

type FetchError = Error & { status?: number; body?: BackendErrorBody };

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers(init?.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!res.ok) {
    const body: BackendErrorBody = await res.json().catch(() => ({}));
    const err = new Error(
      body.message ?? body.error ?? res.statusText,
    ) as FetchError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  if (res.headers.get('content-type')?.includes('application/json')) {
    return res.json();
  }
  return undefined as T;
}

/**
 * "5h ago", "2d ago" — short relative-time string for queue cards.
 * Returns absolute date for anything older than ~30 days.
 */
function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_LABELS: Readonly<Record<AiReviewStatus, string>> = Object.freeze({
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
  'edit-and-approved': 'Edited & approved',
  expired: 'Expired',
});

export function ReviewerQueuePage() {
  const { isEnterprise, hasFeature } = useEnterprise();

  if (!isEnterprise || !hasFeature('ai_output_review')) {
    return (
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
        role="alert"
        data-testid="ai-review-queue-not-licensed"
      >
        AI output review is an Enterprise feature. Upgrade your license to
        access the reviewer queue.
      </div>
    );
  }

  return <ReviewerQueuePageInner />;
}

function ReviewerQueuePageInner() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<AiReviewStatus>('pending');
  const [actionFilter, setActionFilter] = useState<string>(''); // '' = any

  const { data, isLoading, error } = useQuery<AiReviewListResponse, FetchError>({
    queryKey: ['admin', 'ai-reviews', statusFilter],
    queryFn: () =>
      fetchJson<AiReviewListResponse>(
        `/ai-reviews?status=${encodeURIComponent(statusFilter)}&limit=50`,
      ),
    staleTime: 15_000,
    retry: false,
  });

  const filtered = useMemo<AiReviewListItem[]>(() => {
    if (!data) return [];
    if (!actionFilter) return data.reviews;
    return data.reviews.filter((r) => r.action_type === actionFilter);
  }, [data, actionFilter]);

  const is404 = error?.status === 404;

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="ai-review-queue-loading">
        <div className="h-16 animate-pulse rounded-lg bg-foreground/5" />
        <div className="h-16 animate-pulse rounded-lg bg-foreground/5" />
      </div>
    );
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="space-y-6"
      data-testid="ai-review-queue-page"
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ListChecks size={20} className="text-muted-foreground" />
          AI review queue
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          AI output that needs human approval before it&apos;s applied to the
          underlying page. Click <strong>Review</strong> to open the diff
          and act on a row.
        </p>
      </div>

      {/* Filters */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-lg border border-border/40 bg-foreground/[0.02] p-3"
        data-testid="ai-review-queue-filters"
      >
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Status</span>
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as AiReviewStatus)
            }
            className="rounded-md border border-border/50 bg-background px-2 py-1 text-sm"
            data-testid="ai-review-queue-status-filter"
          >
            {AI_REVIEW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Action</span>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="rounded-md border border-border/50 bg-background px-2 py-1 text-sm"
            data-testid="ai-review-queue-action-filter"
          >
            <option value="">Any</option>
            {Object.entries(AI_REVIEW_ACTION_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
          data-testid="ai-review-queue-overlay-missing"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-sm">
            The AI review API isn&apos;t registered on this deployment. The
            Enterprise overlay that exposes <code>GET /api/ai-reviews</code>{' '}
            ships in the EE backend image; until it&apos;s deployed, the
            queue is empty.
          </div>
        </div>
      )}

      {error && !is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive"
          data-testid="ai-review-queue-error"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="text-sm">
            Failed to load review queue: {error.message}
          </div>
        </div>
      )}

      {!error && filtered.length === 0 && (
        <div
          className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border/40 bg-foreground/[0.02] p-8 text-center"
          data-testid="ai-review-queue-empty"
        >
          <CheckCircle2 size={32} className="text-emerald-400" />
          <div>
            <div className="text-sm font-medium">
              {statusFilter === 'pending'
                ? 'No reviews pending'
                : `No reviews with status “${STATUS_LABELS[statusFilter]}”`}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {statusFilter === 'pending'
                ? 'Every AI output is currently auto-published or already actioned.'
                : 'Try a different filter combination.'}
            </div>
          </div>
        </div>
      )}

      {!error && filtered.length > 0 && (
        <ul className="space-y-3" data-testid="ai-review-queue-list">
          {filtered.map((r) => (
            <li
              key={r.id}
              className="nm-card flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`ai-review-row-${r.id}`}
            >
              <div className="flex-1">
                <div
                  className="text-sm font-medium"
                  data-testid={`ai-review-action-${r.id}`}
                >
                  {AI_REVIEW_ACTION_LABELS[r.action_type]}
                  <span className="ml-2 inline-flex items-center rounded-full bg-foreground/5 px-2 py-0.5 font-mono text-xs text-muted-foreground">
                    page #{r.page_id}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  <span>by </span>
                  <span className="font-mono">
                    {r.authored_by.slice(0, 8)}
                  </span>
                  <span> · {timeAgo(r.authored_at)}</span>
                  <span> · {STATUS_LABELS[r.status]}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigate(`/settings/ai-reviews/${r.id}`)}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                data-testid={`ai-review-row-review-btn-${r.id}`}
              >
                <Eye size={12} />
                Review
              </button>
            </li>
          ))}
        </ul>
      )}
    </m.div>
  );
}
