/**
 * SyncConflictPolicyTab — admin UI for the sync-conflict policy
 * (Compendiq/compendiq-ee#118).
 *
 * Lets the admin pick between three policies:
 *   - confluence-wins: legacy behaviour, overwrite local with Confluence.
 *   - compendiq-wins:  keep local edits when Confluence updates them
 *                      remotely; never automatically overwrite.
 *   - manual-review:   queue Confluence-side changes that conflict with
 *                      local edits for the admin to resolve via the
 *                      "Sync conflicts" tab.
 *
 * Backend contract:
 *   GET  /api/admin/sync-conflict-policy → { policy }
 *   PUT  /api/admin/sync-conflict-policy   body: { policy }
 *
 * Until the EE overlay PR (Phase C) lands, both routes 404 in CE-only
 * deployments. We surface a non-fatal "EE only" notice in that case
 * rather than crashing — the rest of the UI stays usable.
 */

import { useEffect, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Save,
  GitMerge,
  Info,
} from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { cn } from '../../shared/lib/cn';

export type SyncConflictPolicy =
  | 'confluence-wins'
  | 'compendiq-wins'
  | 'manual-review';

const VALID_POLICIES: ReadonlySet<SyncConflictPolicy> = new Set([
  'confluence-wins',
  'compendiq-wins',
  'manual-review',
]);

interface PolicyResponse {
  policy: SyncConflictPolicy;
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

interface PolicyOption {
  value: SyncConflictPolicy;
  label: string;
  description: string;
  warning?: string;
}

const POLICY_OPTIONS: readonly PolicyOption[] = [
  {
    value: 'confluence-wins',
    label: 'Confluence wins',
    description:
      'When a Confluence-side change differs from a local edit, the Confluence version is applied and the local change is discarded. This is the legacy behaviour.',
    warning:
      'Local edits made between syncs will be silently overwritten on the next sync.',
  },
  {
    value: 'compendiq-wins',
    label: 'Compendiq wins',
    description:
      'When a Confluence-side change differs from a local edit, the local edit is preserved and the inbound change is skipped. The admin can later push the local edit back to Confluence manually.',
    warning:
      'Compendiq and Confluence will drift apart until the local edit is pushed back to Confluence — this can compound over many sync cycles.',
  },
  {
    value: 'manual-review',
    label: 'Manual review',
    description:
      'Conflicts are queued in a per-page review list. The admin diff-views the local body against the inbound Confluence body and chooses which to keep, page-by-page. Pages without conflicts continue to sync normally.',
  },
];

export function SyncConflictPolicyTab() {
  const { isEnterprise, hasFeature } = useEnterprise();

  if (!isEnterprise || !hasFeature('sync_conflict_resolution')) {
    return (
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
        role="alert"
        data-testid="sync-conflict-policy-not-licensed"
      >
        Sync conflict resolution is an Enterprise feature. Upgrade your
        license to configure conflict-resolution policies.
      </div>
    );
  }

  return <SyncConflictPolicyTabInner />;
}

function SyncConflictPolicyTabInner() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<PolicyResponse, FetchError>({
    queryKey: ['admin', 'sync-conflict-policy'],
    queryFn: () => fetchJson<PolicyResponse>('/admin/sync-conflict-policy'),
    staleTime: 30_000,
    retry: false,
  });

  const [selected, setSelected] = useState<SyncConflictPolicy>('confluence-wins');
  const [initialised, setInitialised] = useState(false);

  // Hydrate the radio selection from the loaded value once.
  useEffect(() => {
    if (!data || initialised) return;
    if (VALID_POLICIES.has(data.policy)) {
      setSelected(data.policy);
    }
    setInitialised(true);
  }, [data, initialised]);

  const dirty = initialised && data && data.policy !== selected;

  const saveMutation = useMutation({
    mutationFn: (policy: SyncConflictPolicy) =>
      fetchJson<void>('/admin/sync-conflict-policy', {
        method: 'PUT',
        body: JSON.stringify({ policy }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'sync-conflict-policy'] });
      toast.success('Sync conflict policy saved');
    },
    onError: (err: FetchError) => {
      toast.error(`Failed to save: ${err.message}`);
    },
  });

  const handleSave = useCallback(() => {
    if (!dirty) return;
    saveMutation.mutate(selected);
  }, [dirty, saveMutation, selected]);

  // CE-only deployments: until the EE overlay PR lands, the GET endpoint
  // 404s. Surface that as a friendly notice rather than the bare error
  // message — admins on CE-with-licence are most likely to see this.
  const is404 = error?.status === 404;

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="sync-conflict-policy-loading">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-lg bg-foreground/5" />
        ))}
      </div>
    );
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="space-y-6"
      data-testid="sync-conflict-policy-tab"
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <GitMerge size={20} className="text-muted-foreground" />
          Sync conflict resolution
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how Compendiq handles a Confluence-side change to a page
          that has unpublished local edits.
        </p>
      </div>

      {is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
          data-testid="sync-conflict-policy-overlay-missing"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-sm">
            The sync conflict policy API isn&apos;t registered on this
            deployment. The Enterprise overlay that exposes <code>GET</code> /{' '}
            <code>PUT /api/admin/sync-conflict-policy</code> ships in a
            separate release; until it&apos;s deployed, conflicts are
            handled with the default <strong>Confluence wins</strong>{' '}
            policy.
          </div>
        </div>
      )}

      {error && !is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive"
          data-testid="sync-conflict-policy-error"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="text-sm">
            Failed to load policy: {error.message}
          </div>
        </div>
      )}

      {/* Radio group */}
      <div className="space-y-3" role="radiogroup" aria-label="Sync conflict policy">
        {POLICY_OPTIONS.map((opt) => {
          const isActive = selected === opt.value;
          return (
            <label
              key={opt.value}
              htmlFor={`policy-${opt.value}`}
              className={cn(
                'glass-card flex cursor-pointer items-start gap-3 p-4 transition-all',
                isActive
                  ? 'ring-1 ring-primary'
                  : 'hover:bg-foreground/[0.03]',
              )}
              data-testid={`sync-conflict-policy-option-${opt.value}`}
            >
              <input
                id={`policy-${opt.value}`}
                type="radio"
                name="sync-conflict-policy"
                value={opt.value}
                checked={isActive}
                onChange={() => setSelected(opt.value)}
                className="mt-1 h-4 w-4 cursor-pointer accent-primary"
                data-testid={`sync-conflict-policy-radio-${opt.value}`}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{opt.label}</span>
                  {data?.policy === opt.value && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                      <CheckCircle2 size={10} /> active
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {opt.description}
                </p>
                {opt.warning && isActive && (
                  <div
                    className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-200"
                    data-testid={`sync-conflict-policy-warning-${opt.value}`}
                  >
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{opt.warning}</span>
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </div>

      {/* Save button */}
      <div className="flex items-center justify-between border-t border-border/50 pt-4">
        <div className="text-xs text-muted-foreground">
          {dirty ? 'You have unsaved changes.' : 'No unsaved changes.'}
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saveMutation.isPending || is404}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="sync-conflict-policy-save-btn"
        >
          {saveMutation.isPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          Save policy
        </button>
      </div>
    </m.div>
  );
}
