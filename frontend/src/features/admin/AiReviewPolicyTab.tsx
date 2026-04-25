/**
 * AiReviewPolicyTab — admin UI for the AI output review policy
 * (Compendiq/compendiq-ee#120).
 *
 * Lets admins configure:
 *   - whether the review workflow is enabled at all
 *   - the default review mode
 *   - per-action overrides (improve / summary / generate / auto-tag /
 *     apply_improvement)
 *   - how long pending reviews live before they're auto-expired
 *
 * Backend contract (EE overlay PR #122):
 *   GET  /api/admin/ai-review/policy → { policy }
 *   PUT  /api/admin/ai-review/policy   body: { enabled, default_mode,
 *                                              per_action_overrides,
 *                                              expire_after_days }
 *
 * In CE-only deployments both routes 404; we surface a non-fatal "EE
 * only" notice rather than crashing — same pattern as the IP allowlist
 * and webhooks tabs.
 *
 * The brief asked for four modes (off / flag-only / redact-and-publish /
 * block-publication), a multi-select for reviewer roles, and a
 * notify-on-submit toggle. The actual EE routes shipped earlier
 * (overlay/backend/src/routes/foundation/ai-reviews.ts) only support
 * three modes (auto-publish / review-required /
 * review-required-with-blocking-pii) and don't expose
 * reviewer-role/notify fields. The UI mirrors the routes exactly to
 * avoid a contract mismatch — see the PR body for details.
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
  ShieldCheck,
  Info,
} from 'lucide-react';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { cn } from '../../shared/lib/cn';
import {
  AI_REVIEW_ACTION_TYPES,
  AI_REVIEW_ACTION_LABELS,
  AI_REVIEW_MODES,
  AI_REVIEW_MODE_LABELS,
  type AiReviewAction,
  type AiReviewMode,
  type AiReviewPolicy,
  type AiReviewPolicyResponse,
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

const DEFAULT_POLICY: AiReviewPolicy = {
  enabled: false,
  default_mode: 'auto-publish',
  per_action_overrides: {},
  expire_after_days: 30,
};

const MODE_DESCRIPTIONS: Readonly<Record<AiReviewMode, string>> = Object.freeze({
  'auto-publish':
    'AI output is applied to the page without human review. Fastest path; no audit gate.',
  'review-required':
    'AI output is queued in a reviewer detail page. A reviewer must approve, reject, or edit-and-approve before the content reaches the page.',
  'review-required-with-blocking-pii':
    'Same as Review required, plus: if the PII detector finds personally identifiable data in the proposed content, the row is blocked from approval until the findings are cleared. Falls back to plain Review required when PII detection is unavailable.',
});

export function AiReviewPolicyTab() {
  const { isEnterprise, hasFeature } = useEnterprise();

  if (!isEnterprise || !hasFeature('ai_output_review')) {
    return (
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
        role="alert"
        data-testid="ai-review-policy-not-licensed"
      >
        AI output review is an Enterprise feature. Upgrade your license to
        configure the review policy.
      </div>
    );
  }

  return <AiReviewPolicyTabInner />;
}

function AiReviewPolicyTabInner() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<AiReviewPolicyResponse, FetchError>({
    queryKey: ['admin', 'ai-review-policy'],
    queryFn: () =>
      fetchJson<AiReviewPolicyResponse>('/admin/ai-review/policy'),
    staleTime: 30_000,
    retry: false,
  });

  const [policy, setPolicy] = useState<AiReviewPolicy>(DEFAULT_POLICY);
  const [initialised, setInitialised] = useState(false);

  // Hydrate the form from the loaded value once.
  useEffect(() => {
    if (!data || initialised) return;
    setPolicy(data.policy);
    setInitialised(true);
  }, [data, initialised]);

  const dirty =
    initialised &&
    data &&
    JSON.stringify(data.policy) !== JSON.stringify(policy);

  const saveMutation = useMutation({
    mutationFn: (body: AiReviewPolicy) =>
      fetchJson<AiReviewPolicyResponse>('/admin/ai-review/policy', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'ai-review-policy'],
      });
      toast.success('AI review policy saved');
    },
    onError: (err: FetchError) => {
      toast.error(`Failed to save: ${err.message}`);
    },
  });

  const handleSave = useCallback(() => {
    if (!dirty) return;
    saveMutation.mutate(policy);
  }, [dirty, policy, saveMutation]);

  const setOverride = useCallback(
    (action: AiReviewAction, mode: AiReviewMode | null) => {
      setPolicy((prev) => {
        const next = { ...prev.per_action_overrides };
        if (mode === null) {
          delete next[action];
        } else {
          next[action] = mode;
        }
        return { ...prev, per_action_overrides: next };
      });
    },
    [],
  );

  const is404 = error?.status === 404;

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="ai-review-policy-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-lg bg-foreground/5"
          />
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
      data-testid="ai-review-policy-tab"
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck size={20} className="text-muted-foreground" />
          AI review policy
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose whether AI-generated output is auto-published or queued for
          human review. Per-action overrides let you trust low-risk
          generators (auto-tag, summary) while gating the rest.
        </p>
      </div>

      {is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
          data-testid="ai-review-policy-overlay-missing"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-sm">
            The AI review policy API isn&apos;t registered on this
            deployment. The Enterprise overlay that exposes{' '}
            <code>GET</code> / <code>PUT /api/admin/ai-review/policy</code>{' '}
            ships in the EE backend image; until it&apos;s deployed, AI
            output is auto-published with no review gate.
          </div>
        </div>
      )}

      {error && !is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive"
          data-testid="ai-review-policy-error"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="text-sm">
            Failed to load policy: {error.message}
          </div>
        </div>
      )}

      {/* Master enabled toggle */}
      <label
        className="glass-card flex cursor-pointer items-start gap-3 p-4"
        data-testid="ai-review-policy-enabled-card"
      >
        <input
          type="checkbox"
          checked={policy.enabled}
          onChange={(e) =>
            setPolicy((p) => ({ ...p, enabled: e.target.checked }))
          }
          className="mt-1 h-4 w-4 cursor-pointer accent-primary"
          data-testid="ai-review-policy-enabled-toggle"
        />
        <div className="flex-1">
          <div className="text-sm font-medium">Enable review workflow</div>
          <p className="mt-1 text-xs text-muted-foreground">
            When off, AI output bypasses review entirely regardless of the
            settings below. Equivalent to Auto-publish for every action.
          </p>
        </div>
      </label>

      {/* Default mode */}
      <div
        className="space-y-3"
        role="radiogroup"
        aria-label="Default review mode"
        data-testid="ai-review-policy-default-mode-group"
      >
        <h2 className="text-sm font-semibold">Default mode</h2>
        <p className="text-xs text-muted-foreground">
          Applies to every AI action that doesn&apos;t have an explicit
          override below.
        </p>
        {AI_REVIEW_MODES.map((mode) => {
          const active = policy.default_mode === mode;
          return (
            <label
              key={mode}
              className={cn(
                'glass-card flex cursor-pointer items-start gap-3 p-4 transition-all',
                !policy.enabled && 'opacity-60',
                active ? 'ring-1 ring-primary' : 'hover:bg-foreground/[0.03]',
              )}
              data-testid={`ai-review-policy-default-mode-option-${mode}`}
            >
              <input
                type="radio"
                name="default-mode"
                value={mode}
                checked={active}
                disabled={!policy.enabled}
                onChange={() =>
                  setPolicy((p) => ({ ...p, default_mode: mode }))
                }
                className="mt-1 h-4 w-4 cursor-pointer accent-primary"
                data-testid={`ai-review-policy-default-mode-radio-${mode}`}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {AI_REVIEW_MODE_LABELS[mode]}
                  </span>
                  {data?.policy.default_mode === mode && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                      <CheckCircle2 size={10} /> active
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {MODE_DESCRIPTIONS[mode]}
                </p>
              </div>
            </label>
          );
        })}
      </div>

      {/* Per-action overrides */}
      <div className="space-y-3" data-testid="ai-review-policy-overrides">
        <h2 className="text-sm font-semibold">Per-action overrides</h2>
        <p className="text-xs text-muted-foreground">
          Leave any action set to <strong>Inherit default</strong> to use
          the default mode above. Override an action to give it a
          different policy — e.g. trust auto-tag with auto-publish while
          keeping generate gated.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border/40">
          <table className="w-full text-sm">
            <thead className="bg-foreground/[0.03] text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Action</th>
                <th className="px-3 py-2 text-left font-medium">Mode</th>
              </tr>
            </thead>
            <tbody>
              {AI_REVIEW_ACTION_TYPES.map((action) => {
                const override = policy.per_action_overrides[action];
                return (
                  <tr
                    key={action}
                    className="border-t border-border/40"
                    data-testid={`ai-review-policy-override-row-${action}`}
                  >
                    <td className="px-3 py-2 align-middle font-medium">
                      {AI_REVIEW_ACTION_LABELS[action]}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={override ?? ''}
                        disabled={!policy.enabled}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === '') setOverride(action, null);
                          else setOverride(action, v as AiReviewMode);
                        }}
                        className="rounded-md border border-border/50 bg-background px-2 py-1 text-sm disabled:opacity-50"
                        data-testid={`ai-review-policy-override-select-${action}`}
                      >
                        <option value="">Inherit default</option>
                        {AI_REVIEW_MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {AI_REVIEW_MODE_LABELS[mode]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Expiry */}
      <div className="space-y-2" data-testid="ai-review-policy-expiry-group">
        <h2 className="text-sm font-semibold">Pending-review expiry</h2>
        <p className="text-xs text-muted-foreground">
          A pending review that nobody acts on is auto-expired after this
          many days. The author is notified and the proposed content is
          discarded — no auto-approval. Range: 1–365 days.
        </p>
        <label className="flex items-center gap-3" htmlFor="expire-days">
          <input
            id="expire-days"
            type="number"
            min={1}
            max={365}
            disabled={!policy.enabled}
            value={policy.expire_after_days}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n)) {
                setPolicy((p) => ({
                  ...p,
                  expire_after_days: Math.max(1, Math.min(365, n)),
                }));
              }
            }}
            className="w-24 rounded-md border border-border/50 bg-background px-2 py-1 text-sm disabled:opacity-50"
            data-testid="ai-review-policy-expire-days-input"
          />
          <span className="text-xs text-muted-foreground">days</span>
        </label>
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
          data-testid="ai-review-policy-save-btn"
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
