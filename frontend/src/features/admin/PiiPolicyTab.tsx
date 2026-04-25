/**
 * PiiPolicyTab — admin UI for PII detection policy (EE #119, Phase I).
 *
 * Lets admins configure:
 *   - whether the PII scanner runs at all (master toggle)
 *   - the NER confidence threshold (filters out low-confidence spans)
 *   - the async LLM-as-judge mode (off / on findings / always) and
 *     which LlmUsecase the judge bills its calls through
 *   - per-use-case actions (off / flag-only / redact-and-publish /
 *     block-publication) for each of chat / improve / summary / generate
 *     / auto_tag
 *   - which PII categories to flag (subset of the closed category union)
 *
 * Backend contract (EE overlay — added in this PR's EE half):
 *   GET  /api/admin/pii-policy → { policy }
 *   PUT  /api/admin/pii-policy   body: { policy } → { policy }
 *
 * In CE-only deployments and EE deployments without the overlay loaded,
 * both routes 404. We surface a non-fatal "API not registered yet"
 * notice rather than crashing — same pattern as the AI review policy
 * tab (CE #341) and the IP allowlist / webhooks tabs.
 *
 * Feature gate: `useEnterprise().hasFeature('pii_detection')`. Items
 * outside this gate render an upgrade-prompt fallback.
 *
 * Visual idiom: glassmorphic cards (`glass-card`), Framer Motion entrance,
 * `data-testid` attributes for component-level tests. Mirrors
 * AiReviewPolicyTab so the two enterprise admin surfaces feel consistent.
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
  DEFAULT_PII_POLICY,
  PII_USE_CASES,
  PII_USE_CASE_LABELS,
  PII_ACTION_MODES,
  PII_ACTION_MODE_LABELS,
  PII_CATEGORIES,
  PII_CATEGORY_LABELS,
  PII_LLM_JUDGE_MODES,
  PII_LLM_JUDGE_MODE_LABELS,
  PII_LLM_JUDGE_USECASES,
  PII_LLM_JUDGE_USECASE_LABELS,
  type PiiActionMode,
  type PiiCategory,
  type PiiLlmJudgeMode,
  type PiiLlmJudgeUsecase,
  type PiiPolicy,
  type PiiPolicyResponse,
  type PiiUseCase,
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

const ACTION_DESCRIPTIONS: Readonly<Record<PiiActionMode, string>> =
  Object.freeze({
    off: 'Skip the PII scanner entirely for this use-case. Output passes through unchanged with no findings recorded.',
    'flag-only':
      'Run the scanner and record findings, but pass content through unmodified. Findings appear in the LLM Audit page so admins can review patterns over time.',
    'redact-and-publish':
      'Splice detected spans out of the output and replace each with `[REDACTED:CATEGORY]`. The end user sees the redacted version; findings persist for audit.',
    'block-publication':
      'Reject the inference response with a 409 when findings are present. Integrates with the AI review queue (#120) — blocked outputs surface there for human review before reaching the page.',
  });

export function PiiPolicyTab() {
  const { isEnterprise, hasFeature } = useEnterprise();

  if (!isEnterprise || !hasFeature('pii_detection')) {
    return (
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100"
        role="alert"
        data-testid="pii-policy-not-licensed"
      >
        PII detection is an Enterprise feature. Upgrade your license to
        configure the detection policy.
      </div>
    );
  }

  return <PiiPolicyTabInner />;
}

function PiiPolicyTabInner() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<PiiPolicyResponse, FetchError>({
    queryKey: ['admin', 'pii-policy'],
    queryFn: () => fetchJson<PiiPolicyResponse>('/admin/pii-policy'),
    staleTime: 30_000,
    retry: false,
  });

  const [policy, setPolicy] = useState<PiiPolicy>(DEFAULT_PII_POLICY);
  const [initialised, setInitialised] = useState(false);

  // Hydrate the form from the loaded value once. The overlay always
  // returns a fully-populated policy (it merges DB → defaults), so we
  // can take the response verbatim.
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
    mutationFn: (body: PiiPolicy) =>
      fetchJson<PiiPolicyResponse>('/admin/pii-policy', {
        method: 'PUT',
        body: JSON.stringify({ policy: body }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['admin', 'pii-policy'],
      });
      toast.success('PII policy saved');
    },
    onError: (err: FetchError) => {
      toast.error(`Failed to save: ${err.message}`);
    },
  });

  const handleSave = useCallback(() => {
    if (!dirty) return;
    saveMutation.mutate(policy);
  }, [dirty, policy, saveMutation]);

  const setUseCaseAction = useCallback(
    (useCase: PiiUseCase, mode: PiiActionMode) => {
      setPolicy((prev) => ({
        ...prev,
        actions: { ...prev.actions, [useCase]: mode },
      }));
    },
    [],
  );

  const toggleCategory = useCallback((category: PiiCategory) => {
    setPolicy((prev) => {
      const has = prev.categoriesToFlag.includes(category);
      const next = has
        ? prev.categoriesToFlag.filter((c) => c !== category)
        : [...prev.categoriesToFlag, category];
      return { ...prev, categoriesToFlag: next };
    });
  }, []);

  const is404 = error?.status === 404;

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="pii-policy-loading">
        {Array.from({ length: 6 }).map((_, i) => (
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
      data-testid="pii-policy-tab"
    >
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck size={20} className="text-muted-foreground" />
          PII detection policy
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure how the AI output scanner detects and reacts to
          personally identifiable information. Three layers run on every
          inference response: regex (German + generic), Transformers.js NER
          (CPU, multilingual), and an optional asynchronous LLM judge for
          ambiguous spans.
        </p>
      </div>

      {is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100"
          data-testid="pii-policy-overlay-missing"
        >
          <Info size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-sm">
            The PII policy API isn&apos;t registered on this deployment.
            The Enterprise overlay that exposes <code>GET</code> /{' '}
            <code>PUT /api/admin/pii-policy</code> ships in the EE backend
            image; until it&apos;s deployed, AI output runs without PII
            scanning regardless of the form below.
          </div>
        </div>
      )}

      {error && !is404 && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-destructive"
          data-testid="pii-policy-error"
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
        data-testid="pii-policy-enabled-card"
      >
        <input
          type="checkbox"
          checked={policy.enabled}
          onChange={(e) =>
            setPolicy((p) => ({ ...p, enabled: e.target.checked }))
          }
          className="mt-1 h-4 w-4 cursor-pointer accent-primary"
          data-testid="pii-policy-enabled-toggle"
        />
        <div className="flex-1">
          <div className="text-sm font-medium">Enable PII scanner</div>
          <p className="mt-1 text-xs text-muted-foreground">
            When off, AI output passes through with no scanning regardless
            of the settings below. Equivalent to setting every use-case to
            Off.
          </p>
        </div>
      </label>

      {/* Confidence threshold */}
      <div
        className="space-y-2 glass-card p-4"
        data-testid="pii-policy-threshold-card"
      >
        <h2 className="text-sm font-semibold">Confidence threshold</h2>
        <p className="text-xs text-muted-foreground">
          NER findings below this confidence are dropped before policy
          actions apply. Higher = fewer false positives, more false
          negatives. Regex findings always emit confidence 1.0 and are
          unaffected. Range: 0–1.
        </p>
        <label
          className="flex items-center gap-3"
          htmlFor="pii-confidence-threshold"
        >
          <input
            id="pii-confidence-threshold"
            type="range"
            min={0}
            max={1}
            step={0.05}
            disabled={!policy.enabled}
            value={policy.confidenceThreshold}
            onChange={(e) => {
              const n = Number.parseFloat(e.target.value);
              if (Number.isFinite(n)) {
                setPolicy((p) => ({
                  ...p,
                  confidenceThreshold: Math.max(0, Math.min(1, n)),
                }));
              }
            }}
            className="flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="pii-policy-threshold-slider"
          />
          <output
            className="w-16 text-right font-mono text-sm tabular-nums"
            data-testid="pii-policy-threshold-value"
          >
            {policy.confidenceThreshold.toFixed(2)}
          </output>
        </label>
      </div>

      {/* LLM-as-judge */}
      <div
        className="space-y-3"
        data-testid="pii-policy-llm-judge-group"
      >
        <h2 className="text-sm font-semibold">Async LLM-as-judge</h2>
        <p className="text-xs text-muted-foreground">
          Optional second pass via the configured LLM. Runs asynchronously
          on a low-priority queue — never blocks the user&apos;s request.
          Findings are merged into the audit entry on completion.
        </p>
        <div
          role="radiogroup"
          aria-label="LLM judge mode"
          className="space-y-3"
        >
          {PII_LLM_JUDGE_MODES.map((mode) => {
            const active = policy.llmJudgeMode === mode;
            return (
              <label
                key={mode}
                className={cn(
                  'glass-card flex cursor-pointer items-start gap-3 p-4 transition-all',
                  !policy.enabled && 'opacity-60',
                  active
                    ? 'ring-1 ring-primary'
                    : 'hover:bg-foreground/[0.03]',
                )}
                data-testid={`pii-policy-llm-judge-option-${mode}`}
              >
                <input
                  type="radio"
                  name="pii-llm-judge-mode"
                  value={mode}
                  checked={active}
                  disabled={!policy.enabled}
                  onChange={() =>
                    setPolicy((p) => ({
                      ...p,
                      llmJudgeMode: mode as PiiLlmJudgeMode,
                    }))
                  }
                  className="mt-1 h-4 w-4 cursor-pointer accent-primary"
                  data-testid={`pii-policy-llm-judge-radio-${mode}`}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {PII_LLM_JUDGE_MODE_LABELS[mode]}
                    </span>
                    {data?.policy.llmJudgeMode === mode && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
                        <CheckCircle2 size={10} /> active
                      </span>
                    )}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <label
          className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground"
          htmlFor="pii-llm-judge-usecase"
        >
          <span>
            Bill judge calls to use-case (matches an{' '}
            <code>LlmUsecase</code> in your provider config):
          </span>
          <select
            id="pii-llm-judge-usecase"
            value={policy.llmJudgeUsecase}
            disabled={!policy.enabled || policy.llmJudgeMode === 'off'}
            onChange={(e) =>
              setPolicy((p) => ({
                ...p,
                llmJudgeUsecase: e.target.value as PiiLlmJudgeUsecase,
              }))
            }
            className="w-48 rounded-md border border-border/50 bg-background px-2 py-1 text-sm text-foreground disabled:opacity-50"
            data-testid="pii-policy-llm-judge-usecase-select"
          >
            {PII_LLM_JUDGE_USECASES.map((u) => (
              <option key={u} value={u}>
                {PII_LLM_JUDGE_USECASE_LABELS[u]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Per-use-case actions */}
      <div className="space-y-3" data-testid="pii-policy-actions">
        <h2 className="text-sm font-semibold">Per-use-case actions</h2>
        <p className="text-xs text-muted-foreground">
          Pick a mode for each AI surface. Off = no scan; Flag only =
          record + pass through; Redact &amp; publish = splice spans;
          Block publication = 409 the response (integrates with the AI
          review queue).
        </p>
        <div className="overflow-x-auto rounded-lg border border-border/40">
          <table className="w-full text-sm">
            <thead className="bg-foreground/[0.03] text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">
                  Use-case
                </th>
                {PII_ACTION_MODES.map((mode) => (
                  <th
                    key={mode}
                    className="px-3 py-2 text-left font-medium"
                    title={ACTION_DESCRIPTIONS[mode]}
                  >
                    {PII_ACTION_MODE_LABELS[mode]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PII_USE_CASES.map((useCase) => {
                const current = policy.actions[useCase] ?? 'flag-only';
                return (
                  <tr
                    key={useCase}
                    className="border-t border-border/40"
                    data-testid={`pii-policy-action-row-${useCase}`}
                  >
                    <td className="px-3 py-2 align-middle font-medium">
                      {PII_USE_CASE_LABELS[useCase]}
                    </td>
                    {PII_ACTION_MODES.map((mode) => (
                      <td key={mode} className="px-3 py-2">
                        <input
                          type="radio"
                          name={`pii-action-${useCase}`}
                          value={mode}
                          checked={current === mode}
                          disabled={!policy.enabled}
                          onChange={() => setUseCaseAction(useCase, mode)}
                          className="h-4 w-4 cursor-pointer accent-primary"
                          aria-label={`${PII_USE_CASE_LABELS[useCase]} → ${PII_ACTION_MODE_LABELS[mode]}`}
                          data-testid={`pii-policy-action-${useCase}-${mode}`}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Categories to flag */}
      <div className="space-y-3" data-testid="pii-policy-categories">
        <h2 className="text-sm font-semibold">Categories to flag</h2>
        <p className="text-xs text-muted-foreground">
          Uncheck categories you don&apos;t want the scanner to react to.
          A finding for an unchecked category is dropped before any
          action runs (regex still matches; the result is just discarded).
          The scanner can detect more than this list; categories not in
          the union below are reserved for future German rule expansions.
        </p>
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
          role="group"
          aria-label="PII categories to flag"
        >
          {PII_CATEGORIES.map((category) => {
            const checked = policy.categoriesToFlag.includes(category);
            return (
              <label
                key={category}
                className={cn(
                  'glass-card flex cursor-pointer items-center gap-3 p-3 transition-all',
                  !policy.enabled && 'opacity-60',
                  checked
                    ? 'ring-1 ring-primary'
                    : 'hover:bg-foreground/[0.03]',
                )}
                data-testid={`pii-policy-category-${category}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!policy.enabled}
                  onChange={() => toggleCategory(category)}
                  className="h-4 w-4 cursor-pointer accent-primary"
                  data-testid={`pii-policy-category-checkbox-${category}`}
                />
                <span className="text-sm">
                  {PII_CATEGORY_LABELS[category]}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center justify-between border-t border-border/50 pt-4">
        <div className="text-xs text-muted-foreground">
          {dirty ? 'You have unsaved changes.' : 'No unsaved changes.'}
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || saveMutation.isPending || is404}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="pii-policy-save-btn"
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
