/**
 * AuthorPendingBanner — inline banner for authors whose AI output is
 * queued for review (Compendiq/compendiq-ee#120).
 *
 * Renders an amber notice at the top of the page-edit / page-view
 * surface when the current user has at least one `ai_output_reviews`
 * row in `pending` status authored by them. Polls every 60s.
 *
 * Backend contract (planned, not yet in the EE overlay):
 *   GET /api/me/ai-review-pending-count → { count: number }
 *
 * The route is not registered in the EE overlay shipped with PR #122.
 * We probe it 404-tolerantly: if the response is 404, the banner hides
 * itself silently — it never crashes the page-edit flow. When the
 * overlay route lands the banner activates with no UI change required.
 *
 * The banner also hides:
 *   - in CE-only mode (the feature gate fails)
 *   - while the count is loading
 *   - when the count is 0
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Clock3, ArrowRight } from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';

interface PendingCountResponse {
  count: number;
}

interface BackendErrorBody {
  error?: string;
  message?: string;
}

type FetchError = Error & { status?: number; body?: BackendErrorBody };

async function fetchJson<T>(path: string): Promise<T> {
  const { accessToken } = useAuthStore.getState();
  const headers = new Headers();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const res = await fetch(`/api${path}`, {
    method: 'GET',
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
  return res.json();
}

export interface AuthorPendingBannerProps {
  /**
   * For tests — override the polling interval in ms. Default 60_000.
   */
  pollIntervalMs?: number;
}

export function AuthorPendingBanner({
  pollIntervalMs = 60_000,
}: AuthorPendingBannerProps = {}) {
  const { isEnterprise, hasFeature } = useEnterprise();

  // Skip the query entirely when the feature isn't available — saves a
  // wasted 404 probe every page load in CE-only deployments.
  const enabled = isEnterprise && hasFeature('ai_output_review');

  const { data, error } = useQuery<PendingCountResponse, FetchError>({
    queryKey: ['me', 'ai-review-pending-count'],
    queryFn: () => fetchJson<PendingCountResponse>('/me/ai-review-pending-count'),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? pollIntervalMs : false,
    // 404 is a "feature degraded" signal, not a transient error — don't
    // hammer the server retrying.
    retry: false,
  });

  if (!enabled) return null;
  // Hide on any error path — the banner is purely informational; a
  // missing route or transient 5xx must not block page editing.
  if (error) return null;
  if (!data || data.count <= 0) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100"
      data-testid="author-pending-banner"
    >
      <Clock3 size={16} className="mt-0.5 shrink-0 text-amber-400" />
      <div className="flex-1">
        <span data-testid="author-pending-banner-count">
          {data.count === 1
            ? 'You have 1 AI output awaiting review.'
            : `You have ${data.count} AI outputs awaiting review.`}
        </span>{' '}
        <Link
          to="/settings/ai/ai-reviews"
          className="inline-flex items-center gap-1 underline hover:text-amber-50"
          data-testid="author-pending-banner-link"
        >
          View pending <ArrowRight size={12} />
        </Link>
      </div>
    </div>
  );
}
