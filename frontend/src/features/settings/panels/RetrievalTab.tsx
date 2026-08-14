import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { UsecaseAssignments } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { SETTINGS_PANELS } from '../settings-nav';

/**
 * #1118 — Settings → AI Models → Retrieval.
 *
 * The write surface for the nine `admin_settings` rows epic #1100 shipped.
 * Every one of them was DB-only until now: each reader's JSDoc named this
 * panel, and the admin guide told operators to write raw SQL.
 *
 * Three things about this panel are load-bearing.
 *
 * **It owns knobs, not stages.** The rerank *stage* is on iff a `rerank`
 * use-case assignment exists (ADR-021 — rerank never inherits the default
 * provider), so the pool size lives here and the on/off switch stays in LLM
 * providers. Duplicating the assignment control here would give an operator
 * two places to turn one thing on.
 *
 * **The disabled stages are visible and explained, not hidden.** MMR and the
 * ranking prior ship off because they were *measured* and the measurement did
 * not justify defaulting them on. Behind a disclosure they read as unfinished;
 * with the measurement beside them they read as a decision. They also carry no
 * amber — ADR-010 reserves it for attention, and a permanent amber panel on a
 * settings page is how users learn to ignore amber.
 *
 * **Nothing is seeded.** Only fields the admin actually changed are sent, so
 * an untouched knob keeps no row at all. Absent and explicitly-default read
 * alike today, but `rag_context_chars_per_page`'s last-good fallback is
 * written assuming no phantom row, and a row nobody set misrepresents what the
 * operator configured.
 */

/** Mirrors the reader defaults in `backend/src/core/services/admin-settings-service.ts`. */
interface RetrievalValues {
  ragFetchWidth: number;
  ragRerankCandidates: number;
  ragConfidenceThreshold: number;
  ragConfidenceThresholdRerank: number;
  ragContextCharsPerPage: number;
  ragPinIdentifiers: boolean;
  ragMmrEnabled: boolean;
  ragMmrLambda: number;
  ragRankingPriorWeight: number;
}

interface BenchmarkVariantSummary {
  averageLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  emptyResultQueries: number;
  labeledQueryCount: number;
  recallAtK: Record<string, number> | null;
  mrr: number | null;
}

interface BenchmarkReport {
  queryCount: number;
  topK: number;
  baseline: BenchmarkVariantSummary;
  deepSearch: BenchmarkVariantSummary & {
    expansionParticipatingQueries: number;
    expansionSkippedQueries: number;
    expansionUnavailableQueries: number;
  };
  paired: {
    top1ChangedQueries: number;
    topKChangedQueries: number;
    averageTopKOverlap: number;
    deepOnlyPagesAtK: number;
    baselineOnlyPagesAtK: number;
  };
}

interface BenchmarkRun {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progressDone: number;
  progressTotal: number;
  result: BenchmarkReport | null;
  error: string | null;
}

const DEFAULTS: RetrievalValues = {
  ragFetchWidth: 10,
  ragRerankCandidates: 30,
  ragConfidenceThreshold: 0,
  ragConfidenceThresholdRerank: 0,
  ragContextCharsPerPage: 6000,
  ragPinIdentifiers: true,
  ragMmrEnabled: false,
  ragMmrLambda: 0.7,
  ragRankingPriorWeight: 0,
};

/**
 * The measured value for the ranking prior — offered, never pre-filled.
 * Pre-filling it would make enabling the stage a matter of ticking a box that
 * already carried a number; the whole point of the default 0 is that turning
 * this on is a choice someone makes deliberately.
 */
const RANKING_PRIOR_TUNED = 0.003;

/**
 * Confidence thresholds are half-open in the reader ([0, 1)): `'1'` is
 * rejected outright, so the input's own ceiling has to stop short of it.
 */
const CONFIDENCE_MAX = 0.99;

type NumericKey = {
  [K in keyof RetrievalValues]: RetrievalValues[K] extends number ? K : never;
}[keyof RetrievalValues];

interface NumericField {
  key: NumericKey;
  label: string;
  /** Unit shown after the input. Empty for a bare ratio. */
  unit?: string;
  min: number;
  max: number;
  step: number;
  /** Decimal places used when resetting / formatting the default. */
  decimals?: number;
}

const FIELDS: Record<NumericKey, NumericField> = {
  ragFetchWidth: { key: 'ragFetchWidth', label: 'Fetch width', unit: 'rows / leg', min: 10, max: 200, step: 1 },
  ragRerankCandidates: {
    key: 'ragRerankCandidates',
    label: 'Rerank candidate pool',
    unit: 'candidates',
    min: 10,
    max: 100,
    step: 1,
  },
  ragConfidenceThreshold: {
    key: 'ragConfidenceThreshold',
    label: 'Similarity basis',
    min: 0,
    max: CONFIDENCE_MAX,
    step: 0.01,
    decimals: 2,
  },
  ragConfidenceThresholdRerank: {
    key: 'ragConfidenceThresholdRerank',
    label: 'Rerank basis',
    min: 0,
    max: CONFIDENCE_MAX,
    step: 0.01,
    decimals: 2,
  },
  ragContextCharsPerPage: {
    key: 'ragContextCharsPerPage',
    label: 'Assembly budget',
    unit: 'chars / page',
    min: 0,
    max: 24_000,
    step: 500,
  },
  ragMmrLambda: { key: 'ragMmrLambda', label: 'λ (relevance vs diversity)', min: 0, max: 1, step: 0.05, decimals: 2 },
  ragRankingPriorWeight: {
    key: 'ragRankingPriorWeight',
    label: 'Prior weight',
    min: 0,
    max: 0.05,
    step: 0.001,
    decimals: 3,
  },
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const LLM_PROVIDERS_PATH = `${SETTINGS_PANELS.models.path}?sub=llm`;

/** Strips floating-point noise from a stepped input without changing the value. */
function round(value: number, decimals: number | undefined): number {
  if (decimals === undefined) return value;
  return Number(value.toFixed(decimals));
}

export function RetrievalTab() {
  const queryClient = useQueryClient();
  const [benchmarkRunId, setBenchmarkRunId] = useState<string | null>(null);
  const [benchmarkDays, setBenchmarkDays] = useState(30);
  const [benchmarkLimit, setBenchmarkLimit] = useState(25);

  const { data: settings, isLoading } = useQuery<Partial<RetrievalValues>>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  // Shares LlmTab's cache entry — this panel only READS the assignment, to say
  // whether the rerank stage is live. The control itself stays in LLM providers.
  const { data: assignments } = useQuery<UsecaseAssignments>({
    queryKey: ['llm-usecases'],
    queryFn: () => apiFetch('/admin/llm-usecases'),
  });

  const saved: RetrievalValues = useMemo(() => {
    const out = { ...DEFAULTS };
    if (settings) {
      for (const key of Object.keys(DEFAULTS) as (keyof RetrievalValues)[]) {
        const v = settings[key];
        if (v !== undefined && v !== null) (out as Record<string, unknown>)[key] = v;
      }
    }
    return out;
  }, [settings]);

  const [values, setValues] = useState<RetrievalValues>(DEFAULTS);
  // One-shot hydration (#949): a background refetch returns a new object
  // whenever the payload differs, and re-seeding on every reference change
  // silently reverts the admin's unsaved edits. Seeded once, then released
  // again by the save handler so the form re-reads the fresh server state.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (settings && !hydrated) {
      setValues(saved);
      setHydrated(true);
    }
  }, [settings, saved, hydrated]);

  const mutation = useMutation({
    mutationFn: (body: Partial<RetrievalValues>) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: async () => {
      setHydrated(false);
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Retrieval settings updated (takes effect within a minute)');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update retrieval settings');
    },
  });

  const changed = (Object.keys(DEFAULTS) as (keyof RetrievalValues)[]).filter(
    (key) => values[key] !== saved[key],
  );

  function handleSave() {
    const body: Record<string, unknown> = {};
    for (const key of changed) body[key] = values[key];
    mutation.mutate(body as Partial<RetrievalValues>);
  }

  function set<K extends keyof RetrievalValues>(key: K, value: RetrievalValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  // The rerank STAGE, per ADR-021: on iff an assignment exists AND the server
  // could resolve a model for it. `resolveRerankUsecase` returning the nil
  // sentinel means assigned-but-unresolvable, which is still a disabled stage.
  const rerankRow = assignments?.rerank;
  const rerankActive =
    !!rerankRow && rerankRow.providerId !== null && rerankRow.resolved.providerId !== NIL_UUID;

  const { data: benchmark } = useQuery<BenchmarkRun>({
    queryKey: ['retrieval-benchmark', benchmarkRunId],
    queryFn: () => apiFetch(`/admin/retrieval-benchmark/${benchmarkRunId}`),
    enabled: benchmarkRunId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 2_000 : false;
    },
  });

  const benchmarkMutation = useMutation({
    mutationFn: () => apiFetch<{ runId: string }>('/admin/retrieval-benchmark', {
      method: 'POST',
      body: JSON.stringify({
        source: 'recent-queries',
        days: benchmarkDays,
        limit: benchmarkLimit,
        topK: 5,
      }),
    }),
    onSuccess: (data) => {
      setBenchmarkRunId(data.runId);
      toast.success('Production retrieval benchmark started');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not start benchmark'),
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="space-y-6" data-testid="retrieval-tab">
      <p className="text-sm text-muted-foreground">
        How the AI assistant gathers knowledge-base context for a question: how many candidates
        each stage considers, how much of a page it carries, and which optional stages run. Saved
        values apply within a minute — immediately on the server that handled the save, and on
        every other server once its 60-second read cache expires.
      </p>

      {/* ── Candidate pools ─────────────────────────────────────────────── */}
      <Section
        title="Candidate pools"
        description="How wide retrieval runs before anything is ranked or trimmed."
      >
        <NumberRow
          field={FIELDS.ragFetchWidth}
          value={values.ragFetchWidth}
          onChange={(v) => set('ragFetchWidth', v)}
          defaultValue={DEFAULTS.ragFetchWidth}
        >
          <p>
            Rows each retrieval leg (vector and full-text) pulls before fusion, independent of how
            many results come back.
          </p>
          <p>
            More candidates is not more recall on its own: measured on the retrieval fixture, width
            30 under plain fusion scored Recall@5 0.72 against the width-10 baseline&apos;s 0.88.
            The cross-encoder is the stage that turns a wide pool into better answers, so raise
            this together with a rerank provider.
          </p>
        </NumberRow>

        <NumberRow
          field={FIELDS.ragRerankCandidates}
          value={values.ragRerankCandidates}
          onChange={(v) => set('ragRerankCandidates', v)}
          defaultValue={DEFAULTS.ragRerankCandidates}
        >
          <p>
            Fused candidates the cross-encoder re-scores. Every candidate is a document shipped to
            the rerank provider, so this bounds the stage&apos;s cost as well as its reach.
          </p>
          <p data-testid="retrieval-rerank-stage-status">
            {rerankActive ? (
              <>
                Rerank stage: <span className="text-foreground">{rerankRow.resolved.providerName}</span>
                {rerankRow.resolved.model ? ` / ${rerankRow.resolved.model}` : ''}.
              </>
            ) : (
              <>
                Rerank stage: <span className="text-foreground">Disabled (no reranking)</span> — this
                pool applies only once a rerank provider is assigned in{' '}
                <Link className="underline underline-offset-2 hover:text-foreground" to={LLM_PROVIDERS_PATH}>
                  {SETTINGS_PANELS.models.label} → LLM providers
                </Link>
                . Setting the pool first is fine; it just has nothing to size yet.
              </>
            )}
          </p>
        </NumberRow>
      </Section>

      {/* ── Confidence gate ─────────────────────────────────────────────── */}
      <Section
        title="Confidence refuse gate"
        description="Below its threshold the assistant answers “not enough grounded context” with the closest sources, instead of a low-grounded answer. Each basis is 0 by default, which leaves its confidence diagnostic-only in logs and traces."
      >
        <NumberRow
          field={FIELDS.ragConfidenceThreshold}
          value={values.ragConfidenceThreshold}
          onChange={(v) => set('ragConfidenceThreshold', v)}
          defaultValue={DEFAULTS.ragConfidenceThreshold}
        >
          <p>
            Basis: max cosine similarity of the best chunk, 0–1. The embedding model moves this
            scale, so there is no universal value — read your own logged{' '}
            <code className="font-mono">rag.confidence</code> values before picking one. 0 turns the
            gate off.
          </p>
        </NumberRow>

        <NumberRow
          field={FIELDS.ragConfidenceThresholdRerank}
          value={values.ragConfidenceThresholdRerank}
          onChange={(v) => set('ragConfidenceThresholdRerank', v)}
          defaultValue={DEFAULTS.ragConfidenceThresholdRerank}
        >
          <p>
            Basis: max reranker relevance, 0–1, used only when the rerank stage scored every
            returned row. The provider and its normalisation move this scale, and a raw-logit
            reranker (llama.cpp, for one) is sigmoid-normalised per request — its scores are only
            loosely comparable between requests, so tune this one conservatively or prefer a
            calibrated reranker. No universal value exists here either.
          </p>
          <p>
            The two bases are separate knobs because the basis flips per request: a rerank bypass
            measures that request on the cosine scale. Raise both for full coverage.
          </p>
        </NumberRow>
      </Section>

      {/* ── Context assembly ────────────────────────────────────────────── */}
      <Section
        title="Context assembly"
        description="How much of each source page reaches the model."
      >
        <NumberRow
          field={FIELDS.ragContextCharsPerPage}
          value={values.ragContextCharsPerPage}
          onChange={(v) => set('ragContextCharsPerPage', v)}
          defaultValue={DEFAULTS.ragContextCharsPerPage}
        >
          <p>
            Characters of a page&apos;s sibling chunks the window may carry, anchored at the
            matching chunk, so the model sees contiguous prose instead of one arbitrary section. 0
            disables assembly entirely — the kill switch for small local models where a larger
            prompt costs more than the added context buys.
          </p>
          <p>
            At the default the per-page ceiling is unchanged, because chunks were already capped at
            6000 characters. The chat path carries five source pages, and there is no input-side
            context-window guard, so raising this is a capacity decision.
          </p>
        </NumberRow>
      </Section>

      {/* ── Identifier pinning ──────────────────────────────────────────── */}
      <Section title="Exact-identifier pin" description="">
        <ToggleRow
          id="rag-pin-identifiers"
          label="Pin exact identifier matches"
          checked={values.ragPinIdentifiers}
          onChange={(v) => set('ragPinIdentifiers', v)}
          defaultChecked={DEFAULTS.ragPinIdentifiers}
        >
          <p>
            A literal identifier — a numeric page id, an INC-2203-style key, a quoted or “page
            called …” title — gets averaged away by the vector leg and diluted by fusion. When on,
            an exact match is pinned to the top of the results. On by default; turn it off to make
            every result come from ranking alone.
          </p>
        </ToggleRow>
      </Section>

      {/* ── Optional stages ─────────────────────────────────────────────── */}
      {/*
        Always visible, never behind a disclosure, and carrying no accent, no
        badge and no amber. These stages are off because they were measured —
        the measurement sits beside each one so "off" reads as a decision
        somebody made rather than a feature somebody left unfinished.
      */}
      <Section
        title="Optional stages"
        description="Both ship off. Each is a real mechanism that was measured on the retrieval rig, and neither measurement justified turning it on for every deployment — so they are opt-in rather than defaults."
      >
        <div className="space-y-4" data-testid="retrieval-optional-stages">
          <div className="space-y-3">
            <ToggleRow
              id="rag-mmr-enabled"
              label="MMR diversity narrow"
              badge={values.ragMmrEnabled ? undefined : 'Off'}
              checked={values.ragMmrEnabled}
              onChange={(v) => set('ragMmrEnabled', v)}
              defaultChecked={DEFAULTS.ragMmrEnabled}
            >
              <p data-testid="retrieval-mmr-measurement">
                No Recall@1 gain measured; removes redundant context (53% of returned slots were
                near-duplicates on duplicate-heavy queries). It is a context-budget optimisation,
                not a recall one — worth having where a space is full of per-team copies of the
                same runbook.
              </p>
            </ToggleRow>

            <div className="pl-6">
              <NumberRow
                field={FIELDS.ragMmrLambda}
                value={values.ragMmrLambda}
                onChange={(v) => set('ragMmrLambda', v)}
                defaultValue={DEFAULTS.ragMmrLambda}
                disabled={!values.ragMmrEnabled}
              >
                <p>
                  1.0 is pure relevance, 0 pure diversity. Measured live on 158 queries: 0.7 cost no
                  recall at all and still removed a third of the redundant slots; 0.5 nearly
                  eliminated redundancy but lost a query and more MRR. The narrow reorders within
                  the returned set, so more diversity always costs some MRR.
                </p>
              </NumberRow>
            </div>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Quality / recency ranking prior</span>
              {values.ragRankingPriorWeight === 0 && <OffChip />}
            </div>
            <p className="text-xs text-muted-foreground" data-testid="retrieval-prior-measurement">
              Measured zero effect when a rerank provider is assigned; without rerank it moved 2 of
              164 queries, one gain and one regression. The regression is inherent rather than a
              tuning miss: a scored page in a near-tie gains, which demotes an unscored neighbour
              relatively, and an unscored page is usually a recently synced one.
            </p>
            <NumberRow
              field={FIELDS.ragRankingPriorWeight}
              value={values.ragRankingPriorWeight}
              onChange={(v) => set('ragRankingPriorWeight', v)}
              defaultValue={DEFAULTS.ragRankingPriorWeight}
            >
              {/*
                Never a bare RRF-scale number: 0.003 means nothing without the
                scale it moves against, and the gap between "one leg found it"
                and "both did" is what bounds the whole stage.
              */}
              <p>
                Weighed against fused ranking scores, where adjacent ranks differ by about 0.00026
                at k=60. So 0.003 spans roughly 14 positions inside one leg-agreement tier, while
                still being far too small to lift a single-leg hit over a page both legs found. At
                0.05 the prior exceeds that tier gap entirely and starts outranking retrieval
                itself. 0 disables the stage and skips its signal query.
              </p>
              {values.ragRankingPriorWeight !== RANKING_PRIOR_TUNED && (
                <button
                  type="button"
                  onClick={() => set('ragRankingPriorWeight', RANKING_PRIOR_TUNED)}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  data-testid="retrieval-prior-use-measured"
                >
                  Use measured value ({RANKING_PRIOR_TUNED})
                </button>
              )}
              {rerankActive && values.ragRankingPriorWeight > 0 && (
                <p data-testid="retrieval-prior-discarded-note">
                  A rerank provider is assigned on this deployment, and the rerank pool is wider
                  than the fused candidate set — so the cross-encoder re-scores every candidate and
                  discards this ordering wholesale. The prior will have no effect here.
                </p>
              )}
            </NumberRow>
          </div>
        </div>
      </Section>

      <Section
        title="Production benchmark"
        description="Replay real questions recorded by this deployment against its current pages and embeddings. The same questions run once with ordinary retrieval and once with deep search."
      >
        <p className="text-xs text-muted-foreground">
          This is a read-only paired measurement. It does not seed content, change retrieval settings,
          or add replayed questions to search analytics. Because production questions do not carry
          ground-truth labels, this reports result movement and latency rather than Recall or MRR.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="block">Look back (days)</span>
            <input
              type="number"
              min={1}
              max={90}
              value={benchmarkDays}
              onChange={(event) => setBenchmarkDays(Math.max(1, Math.min(90, Number(event.target.value) || 1)))}
              className="w-20 rounded-md border border-border-interactive bg-background/50 px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
              data-testid="retrieval-benchmark-days"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span className="block">Questions</span>
            <input
              type="number"
              min={1}
              max={100}
              value={benchmarkLimit}
              onChange={(event) => setBenchmarkLimit(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
              className="w-20 rounded-md border border-border-interactive bg-background/50 px-2 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
              data-testid="retrieval-benchmark-limit"
            />
          </label>
          <button
            type="button"
            onClick={() => benchmarkMutation.mutate()}
            disabled={benchmarkMutation.isPending || benchmark?.status === 'queued' || benchmark?.status === 'running'}
            className="nm-button-primary"
            data-testid="retrieval-benchmark-start"
          >
            {benchmarkMutation.isPending ? 'Starting...' : 'Run on production queries'}
          </button>
        </div>

        {benchmark && (benchmark.status === 'queued' || benchmark.status === 'running') && (
          <p className="text-xs text-muted-foreground" data-testid="retrieval-benchmark-progress">
            Benchmark {benchmark.status} · {benchmark.progressDone}/{benchmark.progressTotal || '?'} questions
          </p>
        )}
        {benchmark?.status === 'failed' && (
          <p className="text-xs text-destructive" data-testid="retrieval-benchmark-error">
            {benchmark.error ?? 'The benchmark failed.'}
          </p>
        )}
        {benchmark?.status === 'completed' && benchmark.result && (
          <BenchmarkSummary report={benchmark.result} />
        )}
      </Section>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <button
          onClick={handleSave}
          disabled={changed.length === 0 || mutation.isPending}
          className="nm-button-primary"
          data-testid="retrieval-save-btn"
        >
          {mutation.isPending ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={() => setValues(DEFAULTS)}
          disabled={mutation.isPending}
          className="text-sm text-muted-foreground hover:text-foreground"
          data-testid="retrieval-reset-all-btn"
        >
          Reset all to defaults
        </button>
      </div>
    </div>
  );
}

function BenchmarkSummary({ report }: { report: BenchmarkReport }) {
  return (
    <div className="space-y-2 text-xs text-muted-foreground" data-testid="retrieval-benchmark-summary">
      <p className="font-medium text-foreground">{report.queryCount} production questions compared</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Metric label="Ordinary p50 / p95" value={`${report.baseline.p50LatencyMs} / ${report.baseline.p95LatencyMs} ms`} />
        <Metric label="Deep search p50 / p95" value={`${report.deepSearch.p50LatencyMs} / ${report.deepSearch.p95LatencyMs} ms`} />
        <Metric label={`Top-${report.topK} overlap`} value={`${Math.round(report.paired.averageTopKOverlap * 100)}%`} />
        <Metric label="Top-1 changed" value={`${report.paired.top1ChangedQueries} questions`} />
        <Metric label="Deep expansion ran" value={`${report.deepSearch.expansionParticipatingQueries}/${report.queryCount}`} />
        <Metric label="Deep expansion skipped/unavailable" value={`${report.deepSearch.expansionSkippedQueries}/${report.deepSearch.expansionUnavailableQueries}`} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-background/40 px-3 py-2">
      <span>{label}: </span><span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-border bg-background/50 p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * The neutral "off" marker. Deliberately slate rather than amber or teal: this
 * is a resting state, not a warning and not an action.
 */
function OffChip() {
  return (
    <span className="rounded-sm border border-status-inactive/30 bg-status-inactive/10 px-1.5 py-0.5 text-[12px] font-medium text-status-inactive">
      Off
    </span>
  );
}

/**
 * A number input that clamps on COMMIT, not on keystroke.
 *
 * Clamping in `onChange` — which is what the sibling rate-limits panel does —
 * makes several of these fields untypeable: fetch width has a minimum of 10,
 * so typing "40" snaps to 10 after the first digit and the next keystroke
 * lands on "100". The keystroke belongs to the draft; the range belongs to the
 * committed value, which is also what Save diffs against, so a half-typed
 * number can never enable Save or reach the PUT.
 */
function NumberRow({
  field,
  value,
  onChange,
  defaultValue,
  disabled,
  children,
}: {
  field: NumericField;
  value: number;
  onChange: (value: number) => void;
  defaultValue: number;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Any committed change — Save's re-hydration, "reset to default", "use
  // measured value" — retires the draft so the field shows the real value.
  useEffect(() => setDraft(null), [value]);

  function commit() {
    if (draft === null) return;
    const raw = Number(draft);
    // An emptied field is not a value: fall back to what is committed rather
    // than inventing a 0 (which several of these knobs read as a kill switch).
    if (draft.trim() === '' || !Number.isFinite(raw)) {
      setDraft(null);
      return;
    }
    const clamped = round(Math.max(field.min, Math.min(field.max, raw)), field.decimals);
    setDraft(null);
    if (clamped !== value) onChange(clamped);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-4">
        <label htmlFor={field.key} className="pt-1.5 text-sm font-medium">
          {field.label}
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <input
            id={field.key}
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            value={draft ?? String(value)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
            }}
            className="w-24 rounded-md border border-border-interactive bg-background/50 px-3 py-1.5 text-right text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-45"
            data-testid={`retrieval-${field.key}`}
          />
          {field.unit && <span className="w-24 text-xs text-muted-foreground">{field.unit}</span>}
        </div>
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground">{children}</div>
      {value !== defaultValue && (
        <button
          type="button"
          onClick={() => onChange(defaultValue)}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          data-testid={`retrieval-${field.key}-reset`}
        >
          Reset to default ({defaultValue})
        </button>
      )}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  badge,
  checked,
  onChange,
  defaultChecked,
  children,
}: {
  id: string;
  label: string;
  badge?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  defaultChecked: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-border accent-primary"
          data-testid={id}
        />
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {badge === 'Off' && <OffChip />}
      </div>
      <div className="space-y-1.5 pl-6 text-xs text-muted-foreground">{children}</div>
      {checked !== defaultChecked && (
        <button
          type="button"
          onClick={() => onChange(defaultChecked)}
          className="ml-6 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          data-testid={`${id}-reset`}
        >
          Reset to default ({defaultChecked ? 'on' : 'off'})
        </button>
      )}
    </div>
  );
}
