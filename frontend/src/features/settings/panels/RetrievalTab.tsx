import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type { FtsLanguage, UsecaseAssignments } from '@compendiq/contracts';
import { FTS_LANGUAGES } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { ErrorState } from '../../../shared/components/feedback/ErrorState';
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
 * operator configured. (The one exception is `fts_language`, which migration
 * 049 seeds with `simple` on every instance — the whole reason the removed
 * `FTS_LANGUAGE` env var was unreachable.)
 *
 * **A failed settings fetch is a failure, not a defaults document** (review
 * r3). `useQuery` is consumed with `isError`, because every field on this
 * panel falls back to `DEFAULTS` when `data` is undefined — and react-query
 * settles a failed query with `data === undefined` and `isLoading === false`.
 * Rendering that reports `simple` on a German instance and offers the "pick
 * the language most of your content is written in" hint underneath it, which
 * invites an admin to re-save a language that was already set and pay for a
 * corpus-wide rebuild that was never needed. Same failure CLAUDE.md pins for
 * `usePageTree`, reached on a settings surface.
 */

/** Mirrors the reader defaults in `backend/src/core/services/admin-settings-service.ts`. */
interface RetrievalValues {
  /**
   * #1114 — `admin_settings.fts_language`, read by
   * `core/services/fts-language.ts`. It sits with the retrieval knobs because
   * it configures one of the two retrieval legs, but it is not one of the
   * nine: saving it rebuilds every page's tsvector inside the request, and
   * `FTS_LANGUAGES` is a closed allow-list rather than a range.
   */
  ftsLanguage: FtsLanguage;
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
  ftsLanguage: 'simple',
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

/**
 * Display names for the PostgreSQL text-search configurations. Only `simple`
 * needs one: it is the odd entry in a list of languages, and an operator
 * scanning the dropdown should be able to see that before selecting it rather
 * than after. Everything else is its own regconfig name, capitalised, so the
 * value in `admin_settings` stays recognisable from the UI.
 */
const FTS_LANGUAGE_LABELS: Partial<Record<FtsLanguage, string>> = {
  simple: 'Simple (no stemming)',
};

function ftsLanguageLabel(language: FtsLanguage): string {
  return FTS_LANGUAGE_LABELS[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * Render order for the select. `FTS_LANGUAGES` is the canonical VALIDATION
 * list — the reader, the route and this control all read it — and its order
 * is the historical one it was written in, neither alphabetical nor
 * PostgreSQL's. Rendering that verbatim put "Romanian" seventeenth, so
 * seventeen entries had to be read to find one. Order is presentation:
 * `simple` leads (it is the default and the one entry that is not a
 * language), the rest sort by the label the eye actually scans.
 */
const FTS_LANGUAGE_OPTIONS: readonly FtsLanguage[] = [
  'simple',
  ...FTS_LANGUAGES.filter((language) => language !== 'simple').sort((a, b) =>
    ftsLanguageLabel(a).localeCompare(ftsLanguageLabel(b)),
  ),
];

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

  const {
    data: settings,
    isLoading,
    isFetching: settingsFetching,
    isError: settingsError,
    error: settingsErrorObj,
    refetch: refetchSettings,
  } = useQuery<Partial<RetrievalValues>>({
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
    onSuccess: async (_data, variables) => {
      setHydrated(false);
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      // #1114 — "within a minute" describes the nine cached knobs. The
      // keyword index was rebuilt inside the request that just returned, so
      // reporting a delay for it would be the same false generalisation the
      // panel's intro used to make.
      toast.success(
        'ftsLanguage' in variables
          ? 'Retrieval settings updated (keyword index rebuilt)'
          : 'Retrieval settings updated (takes effect within a minute)',
      );
    },
    onError: async (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update retrieval settings');
      // #1114 — a failed PUT does not mean nothing landed. The knobs are
      // written before the keyword-index transaction runs, so a rebuild
      // failure leaves them saved; and the rebuild is deliberately unbounded
      // server-side while the edge caps `/api/` at 300s, so a corpus that
      // outruns that budget answers 504 here and COMMITS there. Re-reading
      // the server is what stops the panel showing a value the database does
      // not have. `hydrated` is left alone on purpose: `saved` recomputes
      // from the fresh payload — which is what Save's enabled state is
      // derived from — while the admin's unsent edits survive a transient
      // failure.
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
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

  // #1114, review r3 — the failure this control was designed around has to be
  // legible where the control is, not only in the admin guide. In the
  // documented 504 case the toast says "Gateway Time-out" while the panel
  // re-reads `german` and Save goes dead: on screen that is "it failed" beside
  // "there is nothing left to save", a contradiction the guide needed a
  // paragraph to resolve. So the panel resolves it itself, and it can say
  // which of the two happened because the refetched value is the evidence:
  // the server reporting the language the admin picked means the transaction
  // committed, and reporting the old one means it rolled back.
  //
  // Amber, not muted, and not the panel's own no-amber rule: that rule is
  // about *permanent* notices (the disabled optional stages), and ADR-010's
  // `usePageTree` precedent puts exactly this state — the request failed, the
  // data is intact but suspect — in an amber `role="status"` strip. Red is
  // failure; amber is degraded. It clears on the next successful save.
  // Withheld while the refetch is in flight, or it would announce the
  // rollback wording for a frame and then contradict itself.
  const failedSaveTouchedLanguage =
    mutation.isError &&
    mutation.variables !== undefined &&
    'ftsLanguage' in mutation.variables &&
    !settingsFetching;
  const languageSurvivedFailedSave = saved.ftsLanguage === values.ftsLanguage;

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

  // Before the form, never beside it (review r3). Every control here reads
  // `DEFAULTS` when the document is missing, so a failed GET renders a
  // complete, plausible, wrong settings page — `simple` on an instance whose
  // row says `german`, under a hint telling the admin to go set a language
  // that is already set. There is no honest partial render, so there is no
  // partial render.
  if (settingsError) {
    return (
      <ErrorState
        title="Couldn't load retrieval settings"
        description={
          settingsErrorObj instanceof Error
            ? `${settingsErrorObj.message} — nothing below is the deployment's configuration until this loads.`
            : "Nothing below is the deployment's configuration until this loads."
        }
        onRetry={() => refetchSettings()}
        testId="retrieval-tab-error"
        retryTestId="retrieval-tab-retry"
      />
    );
  }

  return (
    <div className="space-y-6" data-testid="retrieval-tab">
      {/*
        #1114 — the timing sentence is scoped. It described the nine cached
        knobs, and it is read directly above the keyword index section, whose
        value is read uncached and whose save re-indexes the corpus inside the
        request. A generalisation that is false for the first control under it
        is worse than no generalisation.
      */}
      <p className="text-sm text-muted-foreground">
        How the AI assistant gathers knowledge-base context for a question: the language the
        keyword index is built with, how many candidates each stage considers, how much of a page
        it carries, and which optional stages run. The numeric and on/off settings apply within a
        minute of saving — immediately on the server that handled the save, and on every other
        server once its 60-second read cache expires. The keyword index language is the
        exception: it applies as soon as its rebuild finishes.
      </p>

      {/* ── Keyword index ───────────────────────────────────────────────── */}
      {/*
        #1114. Unlike the nine knobs below, this one is not a pool size or a
        threshold: it decides how the keyword leg's tsvector is BUILT, so
        saving it re-indexes the corpus inside the request rather than taking
        effect on the next read. The copy carries that cost; the control is
        deliberately in this panel and nowhere else, because the environment
        variable that used to claim to set it never did.
      */}
      <Section
        title="Keyword index"
        description="The PostgreSQL text-search configuration the keyword leg of hybrid search is built and queried with."
      >
        <div className="space-y-1.5" data-testid="retrieval-fts-language">
          <div className="flex items-start justify-between gap-4">
            <label htmlFor="ftsLanguage" className="pt-1.5 text-sm font-medium">
              Keyword index language
            </label>
            {/*
              The cost sentence is wired to the control, not merely printed
              near it (ADR-010's `DeepSearchToggle` precedent): this is the one
              control on the panel whose save re-indexes the corpus, and a
              caveat a screen-reader user never hears is the same caveat living
              in a `title`. The `simple` hint joins the description only while
              it is on screen.
            */}
            <select
              id="ftsLanguage"
              className="nm-select-md shrink-0"
              value={values.ftsLanguage}
              onChange={(event) => set('ftsLanguage', event.target.value as FtsLanguage)}
              aria-describedby={
                values.ftsLanguage === 'simple'
                  ? 'ftsLanguage-help ftsLanguage-simple-hint'
                  : 'ftsLanguage-help'
              }
              data-testid="retrieval-ftsLanguage"
            >
              {FTS_LANGUAGE_OPTIONS.map((language) => (
                <option key={language} value={language}>
                  {ftsLanguageLabel(language)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <p id="ftsLanguage-help">
              Stemming and stop words for the keyword leg of search. Saving rebuilds the keyword
              index for every page.
            </p>
            {values.ftsLanguage === 'simple' && (
              // Muted, never amber: on a default install this is permanent,
              // and ADR-010 spends amber on states that clear.
              <p
                id="ftsLanguage-simple-hint"
                className="text-xs text-muted-foreground"
                data-testid="retrieval-fts-simple-hint"
              >
                <code className="font-mono">simple</code> does no stemming — pick the language most
                of your content is written in.
              </p>
            )}
          </div>
          {failedSaveTouchedLanguage && (
            <p
              role="status"
              className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
              data-testid="retrieval-fts-save-failed"
            >
              {languageSurvivedFailedSave ? (
                <>
                  The save reported an error, but the server now reports{' '}
                  <strong className="font-medium">{ftsLanguageLabel(saved.ftsLanguage)}</strong>. A
                  rebuild that outruns your reverse proxy&apos;s read timeout answers a gateway
                  timeout while the database goes on to commit — believe the value shown here, not
                  the error.
                </>
              ) : (
                <>
                  The save reported an error and the server still reports{' '}
                  <strong className="font-medium">{ftsLanguageLabel(saved.ftsLanguage)}</strong> —
                  the language was not changed. Save again to retry.
                </>
              )}
            </p>
          )}
        </div>
      </Section>

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

      <div className="space-y-2 border-t border-border pt-4">
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={changed.length === 0 || mutation.isPending}
            className="nm-button-primary"
            data-testid="retrieval-save-btn"
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
          <button
            // #1114 — the keyword-index language is deliberately NOT reset
            // here. Every other control on this panel is a number or a
            // checkbox: resetting one costs nothing and is undone by
            // resetting it back. This one's default is `simple`, and saving
            // it re-indexes every page — so a German deployment was one click
            // among nine cheap resets away from putting its keyword leg back
            // on no stemming, which is the failure this panel shipped to fix.
            onClick={() => setValues((prev) => ({ ...DEFAULTS, ftsLanguage: prev.ftsLanguage }))}
            disabled={mutation.isPending}
            className="text-sm text-muted-foreground hover:text-foreground"
            data-testid="retrieval-reset-all-btn"
          >
            Reset all to defaults
          </button>
        </div>
        {/*
          A button labelled "all" that skips a field has to say so where the
          click happens — a `title` is unreachable by touch and keyboard.
        */}
        <p className="text-xs text-muted-foreground" data-testid="retrieval-reset-all-scope">
          Leaves the keyword index language alone — changing it re-indexes every page, so it is
          set only from its own control above.
        </p>
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
