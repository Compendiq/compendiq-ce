/**
 * SyncConflictsPage — admin list of pages with `pages.conflict_pending = TRUE`
 * (Compendiq/compendiq-ee#118 Phase D).
 *
 * Each row carries the page title, space, when the conflict was detected,
 * and a "Review" button that opens `SyncConflictResolveDialog` for a
 * side-by-side diff.
 *
 * Backend contract (Phase C, lands separately):
 *   GET  /api/admin/sync-conflicts           → list of pending conflicts
 *   POST /api/admin/sync-conflicts/:id/resolve  body { resolution }
 *
 * Until Phase C lands, the GET 404s in CE-only deployments. We surface
 * an inline notice rather than crashing — same pattern as the policy tab.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  GitMerge,
  Info,
} from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { SyncConflictResolveDialog } from './SyncConflictResolveDialog';

export interface SyncConflict {
  id: number;
  pageId: number;
  pageTitle: string;
  spaceKey: string;
  spaceName: string | null;
  detectedAt: string;
  pendingConfluenceVersion: number;
  // Live (Compendiq-side) bodies for diff display.
  localBodyHtml: string;
  localBodyText: string;
  // Pending Confluence-side bodies.
  pendingBodyHtml: string;
  pendingBodyText: string;
}

interface SyncConflictListResponse {
  conflicts: SyncConflict[];
}

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
  const res = await fetch(`/api${path}`, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    const body: BackendErrorBody = await res.json().catch(() => ({}));
    const err = new Error(body.message ?? body.error ?? res.statusText) as FetchError;
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

export function SyncConflictsPage() {
  const { isEnterprise, hasFeature } = useEnterprise();

  if (!isEnterprise || !hasFeature('sync_conflict_resolution')) {
    return (
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
        role="alert"
        data-testid="sync-conflicts-not-licensed"
      >
        Sync conflict resolution is an Enterprise feature. Upgrade your
        license to access the conflict review queue.
      </div>
    );
  }

  return <SyncConflictsPageInner />;
}

function SyncConflictsPageInner() {
  const [selected, setSelected] = useState<SyncConflict | null>(null);

  const { data, isLoading, error, refetch } = useQuery<
    SyncConflictListResponse,
    FetchError
  >({
    queryKey: ['admin', 'sync-conflicts'],
    queryFn: () => fetchJson<SyncConflictListResponse>('/admin/sync-conflicts'),
    staleTime: 15_000,
    retry: false,
  });

  const is404 = error?.status === 404;

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="sync-conflicts-loading">
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
      data-testid="sync-conflicts-page"
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <GitMerge size={20} className="text-muted-foreground" />
          Sync conflicts
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pages where a Confluence-side change has been queued for admin
          review because it conflicts with an unpublished local edit.
        </p>
      </div>

      {is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
          data-testid="sync-conflicts-overlay-missing"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-sm">
            The sync conflict API isn&apos;t registered on this deployment.
            The Enterprise overlay that exposes{' '}
            <code>GET /api/admin/sync-conflicts</code> ships in a separate
            release; until it&apos;s deployed, the queue is empty.
          </div>
        </div>
      )}

      {error && !is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive"
          data-testid="sync-conflicts-error"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="text-sm">
            Failed to load conflicts: {error.message}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!error && data && data.conflicts.length === 0 && (
        <div
          className="flex flex-col items-center justify-center gap-3 rounded-lg border border-border/40 bg-foreground/[0.02] p-8 text-center"
          data-testid="sync-conflicts-empty"
        >
          <CheckCircle2 size={32} className="text-emerald-400" />
          <div>
            <div className="text-sm font-medium">No conflicts pending</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Every synced page is currently in agreement with Confluence.
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {!error && data && data.conflicts.length > 0 && (
        <ul className="space-y-3" data-testid="sync-conflicts-list">
          {data.conflicts.map((c) => (
            <li
              key={c.id}
              className="nm-card flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`sync-conflict-row-${c.id}`}
            >
              <div className="flex-1">
                <div className="text-sm font-medium" data-testid={`sync-conflict-title-${c.id}`}>
                  {c.pageTitle}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  <span className="font-mono">{c.spaceKey}</span>
                  {c.spaceName && <span> · {c.spaceName}</span>}
                  <span> · pending Confluence v{c.pendingConfluenceVersion}</span>
                  <span> · detected {new Date(c.detectedAt).toLocaleString()}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelected(c)}
                className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                data-testid={`sync-conflict-review-btn-${c.id}`}
              >
                <GitMerge size={12} />
                Review
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <SyncConflictResolveDialog
          conflict={selected}
          onClose={() => setSelected(null)}
          onResolved={() => {
            setSelected(null);
            refetch();
          }}
        />
      )}
    </m.div>
  );
}

