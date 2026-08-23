import { useState, useEffect, useMemo, useRef, type Ref } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import type {
  ConfidenceCalibration,
  ConfidenceDistribution,
  ConfidenceDistributionBucket,
  FtsLanguage,
  RagConfidenceCalibration,
  UpdateAdminSettingsResult,
  UsecaseAssignments,
} from '@compendiq/contracts';
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
 * `usePageTree`, reached on a settings surface — including its THREE states
 * (review r4): failed-with-nothing-cached is the destructive `ErrorState`,
 * failed-with-cache is an amber `role="status"` strip over an intact form, and
 * loaded is the form. `isError` alone conflated the first two and tore down a
 * known-good document the panel had really read.
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
  /**
   * #1115 — image retrieval. Three knobs across two halves of one feature:
   * `ragImageLegEnabled` is the QUERY side (P3), the other two are the INTAKE
   * side (P2) and their controls live here because this is where an operator
   * reasons about what retrieval sees.
   */
  ragImageLegEnabled: boolean;
  ragImagesPerPageMax: number;
  ragImageIndexExternal: boolean;
  /**
   * #1115 P4 — the ANSWER side: how many of the matched pictures the chat
   * model is actually shown. A third half of the same feature, and it sits in
   * the same group because an operator reasoning about "does the assistant
   * see our diagrams?" needs the intake, the leg and this in one place.
   */
  ragAnswerMaxImages: number;
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
  ragImageLegEnabled: true,
  ragImagesPerPageMax: 20,
  ragImageIndexExternal: true,
  ragAnswerMaxImages: 2,
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
  ragImagesPerPageMax: {
    key: 'ragImagesPerPageMax',
    label: 'Images per page',
    unit: 'images',
    // 0 is deliberately not reachable: the leg is switched off by unassigning
    // the use case, and a zero cap would reconcile every row away on the next
    // scan — an indexing bug's symptoms from a settings change.
    min: 1,
    max: 200,
    step: 1,
  },
  ragAnswerMaxImages: {
    key: 'ragAnswerMaxImages',
    label: 'Images shown to the model',
    unit: 'images',
    // 0 IS reachable here, unlike the intake cap above. A zero intake cap
    // reconciles the index away; a zero answer cap subtracts nothing durable
    // — the index still fills, the leg still ranks, the sources still carry
    // their thumbnails — so it is the honest off switch for the one cost this
    // number bounds.
    min: 0,
    max: 8,
    step: 1,
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

/**
 * #1114 — the wording each confidence basis needs.
 *
 * `basisNoun` is the use case whose model sets the scale, `scaleNoun` the
 * thing that moves when it changes. They are not interchangeable: the
 * embedder decides a SIMILARITY distribution, the reranker a RELEVANCE one,
 * and that distinction is the entire reason #1105 shipped two knobs instead
 * of one. A single generic "the model changed" would leave the operator
 * unable to judge whether their number is now too strict or too loose.
 */
const CONFIDENCE_BASIS_COPY = {
  ragConfidenceThreshold: { basis: 'similarity', basisNoun: 'embedding', scaleNoun: 'similarity' },
  ragConfidenceThresholdRerank: { basis: 'rerank', basisNoun: 'rerank', scaleNoun: 'relevance' },
} as const;

type CalibrationFieldKey = keyof typeof CONFIDENCE_BASIS_COPY;

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
  } = useQuery<Partial<RetrievalValues> & { ragConfidenceCalibration?: RagConfidenceCalibration }>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  // Shares LlmTab's cache entry — this panel only READS the assignment, to say
  // whether the rerank stage is live. The control itself stays in LLM providers.
  const { data: assignments } = useQuery<UsecaseAssignments>({
    queryKey: ['llm-usecases'],
    queryFn: () => apiFetch('/admin/llm-usecases'),
  });

  /**
   * #1284 — the observed `rag.confidence` distribution, per basis. Its own
   * endpoint rather than a field on `/admin/settings`: that route is a
   * settings document, and this is a measurement of what the deployment has
   * been doing.
   *
   * Consumed with `isPending`/`isError` (review-proofing the `usePageTree`
   * rule): a failed read renders as a failure sentence under each threshold,
   * never as "nothing was measured" — which would tell an operator their
   * assistant has had no questions when in fact the panel could not look.
   */
  const {
    data: distribution,
    isPending: distributionPending,
    isError: distributionError,
    refetch: refetchDistribution,
  } = useQuery<ConfidenceDistribution>({
    queryKey: ['confidence-distribution'],
    queryFn: () => apiFetch('/analytics/confidence-distribution'),
  });

  /**
   * THREE states, not two (review r1) — the same `usePageTree` rule the
   * settings query above already implements, applied to this one.
   *
   * react-query settles a failed REFETCH as `status: 'error'` while KEEPING
   * `data`, and this panel's client sets `staleTime: 30_000` with the default
   * `refetchOnWindowFocus`, so "alt-tab away, come back during a backend
   * blip" is an ordinary path rather than a corner. Branching the readout on
   * `isError` alone threw away a real 2,184-question measurement the panel
   * was still holding and replaced it with "there is nothing measured to
   * check this threshold against" — a sentence that is FALSE in exactly that
   * state, since something was measured and only the re-read failed.
   *
   * So: `distributionLost` is the destructive case where the error IS the
   * content, and `distributionStale` keeps the figures and marks them as the
   * last ones the panel could get. Both notices stay muted — the missing
   * thing is an auxiliary measurement, not a knob.
   */
  const distributionLost = distributionError && distribution === undefined;
  const distributionStale = distributionError && distribution !== undefined;

  /**
   * A retry this section's own control started (review r2). It exists for ONE
   * reason: to keep the strip — and with it the button the user just pressed —
   * mounted for the duration of that request.
   *
   * react-query's `fetchState` spreads `...data === undefined && { error:
   * null, status: 'pending' }`, so refetching an errored query with NOTHING
   * cached drops back to `pending`. `isError` goes false, the
   * `{distributionError && (…)}` strip unmounts, and the control the user
   * activated disappears out from under their focus — which then falls to
   * `<body>` in a panel with ~30 tab stops and is never restored, because the
   * strip that returns on a repeated failure is a fresh element. It also made
   * the `Retrying…`/`disabled` state unreachable in exactly the branch where
   * a failed read is most likely: a first load against a backend that has not
   * run migration 098. The `distributionStale` branch keeps `data`, so it
   * keeps `status: 'error'` and never had the problem — which is why the
   * first cut's own test only ever exercised the half that worked.
   *
   * The window is not one tick: `query-client.ts` retries a non-4xx failure
   * twice more with exponential backoff, so this is seconds of the section
   * standing empty.
   */
  const [retryInFlight, setRetryInFlight] = useState(false);

  /**
   * The busy state is `retryInFlight` ALONE, never `isFetching` (review r3).
   *
   * This client leaves `refetchOnWindowFocus` at its v5 default with
   * `staleTime: 30_000`, so alt-tabbing back into the stale strip starts a
   * read nobody pressed anything for. Folding `isFetching` in relabelled the
   * button `Retrying…` and stood it down for that read — a system event
   * reported as the user's own action, inside a `role="status"` region that
   * then announces it as one. Everything the button says is about the request
   * this control started; a background re-read is the strip's own business
   * and changes no control.
   */

  /**
   * Where focus goes when the strip the user pressed disappears BENEATH it
   * (review r3). The r2 fix kept the button mounted through its own request
   * and stopped there, which left the ORDINARY outcome — the retry succeeds,
   * the strip's condition resolves, the button is removed — dropping focus to
   * `<body>` in the ~30-stop panel the r2 comment calls unacceptable one
   * branch over. Success is the more common instance of that case, not a
   * rarer one.
   *
   * So a successful retry hands focus to the measurement it produced: the
   * similarity readout, the first thing on screen that changed. It is a `<p>`
   * with `tabIndex={-1}`, so it is programmatically focusable without adding a
   * tab stop, and it stays prose — the description sweep bans operable
   * elements from these regions, and a paragraph is not one.
   *
   * Two guards keep it from being a focus THEFT. The effect only runs for a
   * retry this control started, and only when the unmount really dropped
   * focus: if `activeElement` is anything but `<body>`, the user moved on
   * during the request (it can be seconds — `query-client.ts` retries a
   * non-4xx twice with backoff) and their caret is left where they put it.
   */
  const [restoreFocusAfterRetry, setRestoreFocusAfterRetry] = useState(false);
  const distributionReadoutRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!restoreFocusAfterRetry) return;
    // The strip is still up (the retry failed, or is still out) — the button
    // the user pressed is still under their focus, which is where it belongs.
    if (distributionError || retryInFlight) return;
    setRestoreFocusAfterRetry(false);
    const active = document.activeElement;
    if (active && active !== document.body) return;
    distributionReadoutRef.current?.focus();
  }, [restoreFocusAfterRetry, distributionError, retryInFlight]);

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

  /**
   * #1114 — "keep this number, and record it against the live model" is its
   * own control, not a mode of Save (review r1). Both calibration notices
   * reach it: the amber one as `Keep <value>`, the muted "no record" one as
   * `Record <value>` (review r2 — that branch shipped with a remedy no
   * control could perform).
   *
   * The remedy the amber strip offers changes no VALUE: the number is right,
   * the record beside it is out of date. The first cut reached that by pushing
   * the stale key into `changed`, which armed Save — and put the untouched
   * threshold into EVERY subsequent PUT. An operator who edited the fetch
   * width at the other end of the panel then certified the refuse gate against
   * a model they had never measured it on, and the strip — the only standing
   * surface saying the gate needs re-tuning once the swap's log line has
   * scrolled away — silently vanished. `admin.ts` deliberately re-records only
   * a threshold the request carried, for exactly that reason; handing it one
   * unasked defeated the rule from a layer up.
   *
   * So Save is a value diff and nothing else, and keeping a threshold is a
   * button inside the strip that PUTs that one key. It is aimed, it is
   * labelled with the number it is about, and no unrelated save can fire it.
   *
   * It is a SEPARATE mutation from Save, and that is not tidiness. Save's
   * `onSuccess` releases the one-shot hydration so the form re-reads the
   * server — right for a request that submitted the form, and wrong for this
   * one, which submits a row the operator did not edit: re-seeding would
   * silently revert whatever else they had typed and not yet saved, the exact
   * failure #949's `hydrated` flag exists to prevent. Keep changes no value,
   * so there is nothing to re-seed; it invalidates the query (which is what
   * refreshes the calibration and clears the strip) and leaves the draft
   * alone.
   */
  const keepMutation = useMutation({
    // `saved`, never `values`: the record must describe the number the SERVER
    // is holding, which is the same reason the strip itself reads `saved`. A
    // half-typed draft in the field must not be what gets certified.
    mutationFn: async (key: CalibrationFieldKey) => {
      const result = await apiFetch<UpdateAdminSettingsResult>('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ [key]: saved[key] }),
      });
      return { key, result };
    },
    onSuccess: async ({ key, result }) => {
      await queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      // Review r3 — the toast reports what the SERVER did, not that the
      // request returned 200. The route writes the threshold row and answers
      // 200 whether or not the calibration beside it landed: it abstains when
      // the live model cannot be resolved, and the record write is
      // best-effort. Asserting success there was the same dead end review r2
      // removed one layer up — the operator presses the button the notice
      // told them to press, is told it worked, and the notice comes straight
      // back with nothing on screen explaining why. And `unresolved` is not
      // reliably transient: an undecryptable provider key after a rotation,
      // or an EE policy naming a deleted provider, throws on every attempt.
      const { basis, basisNoun } = CONFIDENCE_BASIS_COPY[key];
      const write = result?.ragConfidenceCalibrationWrite?.[basis] ?? null;
      if (!write) {
        // A server that reported nothing has told us nothing — claim only
        // what the status code supports. (Unreachable from the notices
        // themselves, which need `ragConfidenceCalibration` to render at all.)
        toast.success('Threshold saved');
        return;
      }
      if (write.outcome === 'unresolved') {
        toast.error(
          `Could not resolve the live ${basisNoun} model — the calibration was left as it was.`,
        );
        return;
      }
      if (write.outcome !== 'recorded') {
        toast.error('The calibration could not be recorded — it was left as it was.');
        return;
      }
      // Deliberately not "settings updated": no setting changed. What changed
      // is the record of which model the number was measured against — and it
      // is named, because "the live model" is exactly what the operator
      // cannot see from here.
      toast.success(
        write.model
          ? `Threshold recorded against ${write.model}`
          : `Threshold recorded — no ${basisNoun} model is assigned`,
      );
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to record the calibration');
    },
  });

  function handleKeepCalibration(key: CalibrationFieldKey) {
    keepMutation.mutate(key);
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
  //
  // The evidence is what was SENT (`mutation.variables`), never the live
  // select (review r4). `values` is a draft the admin can still edit while
  // `isError` is true, so comparing the refetched value against it let them
  // flip the verdict by abandoning their own change: picking `german`,
  // getting the 503 rollback, then putting the select back to `simple` made
  // the two sides match and the panel announced a commit — "believe the value
  // shown here, not the error" — for a transaction that rolled back and a
  // proxy timeout that never happened. The question the strip answers is "did
  // the server end up with what we asked for?", which only the request can ask.
  //
  // And withheld when the re-read ITSELF failed, for the same reason: on a
  // backend that is down the PUT fails and the `onError` refetch fails with
  // it, leaving a cached value from before the save. Reading a verdict off
  // that would state "the language was not changed" from evidence nobody
  // collected. The degraded strip at the top of the panel says what is
  // actually known — the settings could not be re-read.
  const submittedLanguage = (mutation.variables as Partial<RetrievalValues> | undefined)?.ftsLanguage;
  const failedSaveTouchedLanguage =
    mutation.isError && submittedLanguage !== undefined && !settingsFetching && !settingsError;
  const languageSurvivedFailedSave = saved.ftsLanguage === submittedLanguage;

  // The rerank STAGE, per ADR-021: on iff an assignment exists AND the server
  // could resolve a model for it. `resolveRerankUsecase` returning the nil
  // sentinel means assigned-but-unresolvable, which is still a disabled stage.
  const rerankRow = assignments?.rerank;
  const rerankActive =
    !!rerankRow && rerankRow.providerId !== null && rerankRow.resolved.providerId !== NIL_UUID;

  // #1115 P3 — the same non-inheriting rule as `rerank`: `resolved` reports
  // what WOULD serve if assigned, so the leg is live only on an explicit
  // `providerId`. Rendered as a NOTICE, never as a disabled control.
  //
  // `assignments === undefined` (the query has not answered, or failed) shows
  // NOTHING rather than the notice: telling an operator their leg is off on
  // evidence the panel has not collected is the mistake `usePageTree`'s
  // three-state rule is about, one surface over.
  const imageEmbeddingRow = assignments?.image_embedding;
  const imageEmbeddingUnassigned = !!assignments && !imageEmbeddingRow?.providerId;

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
  //
  // Three states, not two (review r4): `settingsError && !settings` is the
  // destructive one — nothing was ever read, so the error IS the content.
  // react-query settles a failed REFETCH with `status: 'error'` while keeping
  // `data`, and `isError` alone tore down a known-good settings document plus
  // the admin's unsent edit. That is reachable from this panel's own
  // `onError`, which invalidates `['admin-settings']`: when the backend is
  // down the follow-on GET fails too, and the failed-save strip below — the
  // whole point of that re-read — never rendered. Failed-with-cache is
  // DEGRADED, and takes the amber strip above an intact form instead.
  if (settingsError && !settings) {
    return (
      <ErrorState
        title="Couldn't load retrieval settings"
        description={
          settingsErrorObj instanceof Error
            ? `${settingsErrorObj.message} — the panel is hidden rather than showing defaults that are not this deployment's configuration.`
            : "The panel is hidden rather than showing defaults that are not this deployment's configuration."
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
        Failed-with-cache. Amber and `role="status"`, not red and not a
        teardown: the form below is the last document this panel really read,
        so it is degraded rather than wrong, and the admin's unsent edits are
        still on it.
      */}
      {settingsError && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
          data-testid="retrieval-settings-stale"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            The retrieval settings could not be re-read, so the values below may be stale.{' '}
            <button
              type="button"
              onClick={() => refetchSettings()}
              className="font-medium underline underline-offset-2"
              data-testid="retrieval-settings-stale-retry"
            >
              Try again
            </button>
          </span>
        </div>
      )}

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
              //
              // The copy names what `simple` does and stops short of promising
              // what a language would buy. It used to end "pick the language
              // most of your content is written in", which reads as a
              // recommendation with an upside behind it — and the upside was
              // then measured (#1114, 2026-08-16): on a 275-page technical
              // German corpus, `german` against `simple` moved a handful of
              // queries either way, Recall@10 came back identical query for
              // query on both embedding models, and the only nominally
              // significant cell was a small regression that dies under
              // multiplicity correction. So this control costs a corpus-wide
              // rebuild and, on the one corpus anyone has measured, buys no
              // detectable ranking. Saying otherwise here sends operators to
              // spend a maintenance window on a number that will not move.
              //
              // That corpus is named as TRANSLATED, and the word is doing work:
              // it is the #1102 fixture's vendored English OSS docs run through
              // a translation pass, which is what held content constant across
              // the two language arms. A translation holds less of the
              // compounding and inflection a Snowball German stemmer exists to
              // fold than pages a German speaker wrote, so the measurement
              // bounds the upside an admin may ASSUME rather than proving the
              // stemmer inert on their own content — and this hint is read as
              // advice about their own content. It also strengthens the
              // post-hoc reading in the runbook, since translated technical
              // prose is identifier-dense and `simple` already matches those
              // exactly. Full argument: *On the stemmer null result* in
              // docs/runbooks/shadow-reembed.md.
              <p
                id="ftsLanguage-simple-hint"
                className="text-xs text-muted-foreground"
                data-testid="retrieval-fts-simple-hint"
              >
                <code className="font-mono">simple</code> does no stemming or stop-word removal. On a
                275-page corpus of technical German translated from English OSS docs,{' '}
                <code className="font-mono">german</code> against <code className="font-mono">simple</code>{' '}
                measured within noise — choose by the language your content is written in, and expect
                the keyword-index rebuild rather than a jump in result quality.
              </p>
            )}
          </div>
          {failedSaveTouchedLanguage && (
            // The 16px AlertTriangle is part of this class recipe everywhere
            // else in the app (ADR-010): colour is the weaker channel under
            // `forced-colors` and for a colour-blind admin, and this strip is
            // the only thing on screen resolving "it failed" against a Save
            // button that just went dead.
            <div
              role="status"
              className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
              data-testid="retrieval-fts-save-failed"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
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
              </span>
            </div>
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
        // #1284 — the description ORIENTS and points at the readout, and
        // stops there (review r1). Every other section description on this
        // panel is one line (11–40 words); this one had grown to 111, a
        // four-sentence block of 12px muted prose above the first control,
        // restating the same fact the similarity row's help and the readout
        // beneath it state within about 200px of each other. How to read a
        // percentile now lives beside the first distribution, where the
        // numbers it qualifies are; the logs and traces stay here, one rung
        // down, because they are still where a single request's verdict is
        // inspected.
        description="Below its threshold the assistant answers “not enough grounded context” with the closest sources, instead of a low-grounded answer. Each basis is 0 by default, which leaves its confidence diagnostic-only in logs and traces. Under each knob is the distribution this deployment has actually measured."
      >
        {/*
          #1284 review r2 — the recovery for a failed read is a control, and a
          control can never live inside a threshold row's readout: that
          paragraph is the input's `aria-describedby` region and must stay
          prose (a description flattens to one string, so a button in it is
          announced with no way to reach it, then repeated on the next tab
          stop). One query serves both bases, so one Retry serves both rows, and it
          sits at the top of the section where each row's failure sentence
          points. It replaces "Reload this page to try again", which was an
          instruction to discard every unsaved knob edit on this panel — the
          exact loss #949's one-shot hydration and the separate Keep mutation
          both exist to prevent — with the cost unnamed. Muted, not amber: the
          missing thing is an auxiliary measurement, the panel's own knobs are
          intact, and #1284 keeps this whole readout off the status palette.
        */}
        {/*
          `role="status"` (review r1) — the panel's two other failure strips
          both carry it, and without it this one told a screen-reader user
          nothing at all: it appears silently, and a Retry that fails AGAIN
          changes no other pixel on the page. The `Retry` → `Retrying…` swap
          is the second half of that: it is a text change INSIDE the live
          region, so the press is announced, and the swap BACK on a repeated
          failure announces the outcome.

          It carries NO `aria-busy` (review r2), and that is the whole point.
          The r1 cut set `aria-busy={distributionFetching}` on this same
          element, which per ARIA 1.2 tells assistive technology to WITHHOLD
          updates to the region until busy clears — so the "Retrying…" text
          change was emitted precisely while announcements were suppressed,
          and by the time busy cleared the content had returned to the string
          that was already announced. The two mechanisms cancelled: the
          property silenced the content change it was paired with, while the
          comment above it claimed both were announced. One region, one
          mechanism — the content IS the announcement. The button's own label
          carries the busy state where a busy state belongs.
        */}
        {(distributionError || retryInFlight) && (
          <div
            role="status"
            className="flex flex-col items-start gap-2 text-xs text-muted-foreground"
            data-testid="retrieval-distribution-error"
          >
            <span id={DISTRIBUTION_ERROR_SENTENCE_ID}>
              {distributionStale
                ? 'The measured confidence distribution could not be re-read, so the figures below are'
                  + ' the last ones this panel could get. Your unsaved edits on this page are untouched.'
                : 'The measured confidence distribution could not be read, so neither threshold below'
                  + ' has a measurement beside it. Your unsaved edits on this page are untouched.'}
            </span>
            {/*
              `aria-disabled`, NEVER `disabled` (review r3) — the whole point
              of the r2 machinery above is that this control keeps the focus
              of the user who pressed it, and a genuinely disabled element
              cannot: per the HTML focus fixup rule a control that stops being
              focusable is blurred, so every browser drops focus to `<body>`
              here, and `nm-button-ghost`'s `:disabled` rule adds
              `pointer-events: none` on top. jsdom implements none of that —
              it leaves `activeElement` on a disabled button — so the test
              beside this one asserted focus retention and `toBeDisabled()` in
              the same block, a pair that cannot both hold in a browser. The
              handler is the refusal instead, since `aria-disabled` blocks no
              events (the `AuthPanel` SSO-retry precedent, same shape).

              And no `aria-busy` on it either: this button sits INSIDE the
              `role="status"` region, and busy on an element withholds updates
              from its subtree — which is r2's silenced-announcement defect
              moved down one node. The label change IS the announcement.
            */}
            <button
              type="button"
              onClick={() => {
                // The refusal `aria-disabled` cannot perform. Belt-and-braces
                // over react-query's own in-flight dedupe rather than a
                // second mechanism: the point is that the contract lives here
                // and not in whether `refetch` happens to coalesce.
                if (retryInFlight) return;
                setRetryInFlight(true);
                setRestoreFocusAfterRetry(true);
                void refetchDistribution()
                  .then(
                    // A retry that fails again leaves the strip up with the
                    // button still under the user's focus; only a success
                    // takes it away, and only then does focus need rehoming.
                    (result) => setRestoreFocusAfterRetry(!result.isError),
                    () => setRestoreFocusAfterRetry(false),
                  )
                  .finally(() => setRetryInFlight(false));
              }}
              aria-disabled={retryInFlight || undefined}
              aria-describedby={DISTRIBUTION_ERROR_SENTENCE_ID}
              /*
                `opacity-70`, not 45 (review r1) — and the value is the whole
                argument above, cashed out. The design deliberately refuses
                `aria-busy` on both this button and its region, so this LABEL
                is the only channel the busy state has; at 45% it composites
                to 3.93:1 in Graphite and 2.88:1 in Paper against
                `--color-foreground` on `--color-background`, under the 4.5:1
                floor its 12px text is held to, while 70% clears it at 8.00 /
                6.36. WCAG's inactive-component exemption does not cover it:
                this control is deliberately NOT inactive — it keeps focus,
                and the handler is what refuses. Matches the shape it was
                modelled on, `AuthPanel`'s SSO re-check.
              */
              className="nm-button-ghost shrink-0 text-xs aria-disabled:cursor-default aria-disabled:opacity-70"
              data-testid="retrieval-distribution-retry"
            >
              {retryInFlight ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}
        {/*
          #1114 — above the control, and keyed off `saved`, not `values`: the
          calibration describes the number the SERVER is holding, so reading a
          draft the admin is still typing would let the strip disappear before
          anything was saved.
        */}
        <CalibrationNotice
          fieldKey="ragConfidenceThreshold"
          label={FIELDS.ragConfidenceThreshold.label}
          value={saved.ragConfidenceThreshold}
          supported={settings?.ragConfidenceCalibration !== undefined}
          calibration={settings?.ragConfidenceCalibration?.similarity ?? null}
          onKeep={() => handleKeepCalibration('ragConfidenceThreshold')}
          keepDisabled={keepMutation.isPending || mutation.isPending}
        />
        <NumberRow
          field={FIELDS.ragConfidenceThreshold}
          value={values.ragConfidenceThreshold}
          onChange={(v) => set('ragConfidenceThreshold', v)}
          defaultValue={DEFAULTS.ragConfidenceThreshold}
          // The measured distribution is the reason to reach for this knob at
          // all, so it is what the input's description carries.
          describedBy={distributionDescriptionId('ragConfidenceThreshold')}
        >
          <p>
            Basis: max cosine similarity of the best chunk, 0–1. The embedding model moves this
            scale, so there is no universal value — pick one against the measured distribution
            below, not a number from another deployment. The same value is logged and traced per
            request as <code className="font-mono">rag.confidence</code>. 0 turns the gate off.
          </p>
          {/*
            #1284 review r1 — how to READ the distribution, stated once, beside
            the first one rather than in the section description above. It was
            four sentences of 12px muted prose at the top of the section, three
            times the length of every other section description on this panel
            and restating what this row and the readout below already say.
            Stated here it sits with the numbers it qualifies, and it is
            written for both rows ("that basis", not "this one"): duplicating
            it under the rerank threshold would put a paragraph the reader has
            just read back into a second input's accessible description, which
            is the length problem one layer down.

            The rule itself is unchanged and both halves are load-bearing. The
            gate refuses on `score < threshold` (llm-ask.ts), so a threshold AT
            a percentile puts about that share of the sample below the bar — at
            p50 half, at p90 nine in ten; the first cut said "above p50 refuses
            about half", off by a whole percentile in the direction that
            flatters the feature. And below the bar is not refused: `llm-ask.ts`
            computes `otherGrounding` and short-circuits `refusalReason` to null
            BEFORE the comparison, so a turn carrying a sub-page tree, an
            attached document, web results or a substantive prior turn is
            answered at any threshold while its analytics row — written during
            retrieval — is in the sample regardless. `hasSubstantiveHistory`
            makes that every follow-up in a conversation.
          */}
          <p>
            Where a threshold sits in the distribution below is a ceiling on how often the gate
            refuses: one set at p50 puts about half the questions measured on that basis below the
            bar, one set at p90 about nine in ten. Fewer are refused than that — a question
            grounded some other way, by a sub-page tree, an attached document or an earlier answer
            in the same conversation, is answered without the gate being consulted.
          </p>
          <ConfidenceDistributionLine
            fieldKey="ragConfidenceThreshold"
            // Where a successful Retry puts focus — see `restoreFocusAfterRetry`.
            readoutRef={distributionReadoutRef}
            bucket={distribution?.similarity}
            windowDays={distribution?.windowDays ?? CONFIDENCE_WINDOW_DAYS_FALLBACK}
            isPending={distributionPending}
            isError={distributionLost}
            staleRead={distributionStale}
            basisChanged={settings?.ragConfidenceCalibration?.similarity?.stale === true}
          />
        </NumberRow>

        <CalibrationNotice
          fieldKey="ragConfidenceThresholdRerank"
          label={FIELDS.ragConfidenceThresholdRerank.label}
          value={saved.ragConfidenceThresholdRerank}
          supported={settings?.ragConfidenceCalibration !== undefined}
          calibration={settings?.ragConfidenceCalibration?.rerank ?? null}
          onKeep={() => handleKeepCalibration('ragConfidenceThresholdRerank')}
          keepDisabled={keepMutation.isPending || mutation.isPending}
        />
        <NumberRow
          field={FIELDS.ragConfidenceThresholdRerank}
          value={values.ragConfidenceThresholdRerank}
          onChange={(v) => set('ragConfidenceThresholdRerank', v)}
          defaultValue={DEFAULTS.ragConfidenceThresholdRerank}
          // Prose only — the `emptyNote` below deliberately carries no link
          // for exactly this reason.
          describedBy={distributionDescriptionId('ragConfidenceThresholdRerank')}
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
          <ConfidenceDistributionLine
            fieldKey="ragConfidenceThresholdRerank"
            bucket={distribution?.rerank}
            windowDays={distribution?.windowDays ?? CONFIDENCE_WINDOW_DAYS_FALLBACK}
            isPending={distributionPending}
            isError={distributionLost}
            staleRead={distributionStale}
            basisChanged={settings?.ragConfidenceCalibration?.rerank?.stale === true}
            // The empty rerank sample is the ORDINARY state under ADR-021 —
            // unassigned means the stage never runs — so name the cause
            // rather than leave a permanent blank reading as a defect. Only
            // when the panel really knows: `assignments === undefined` is a
            // query that has not answered, and `rerankActive` is false for it
            // too (the `usePageTree` three-state rule, one surface over).
            //
            // The second sentence is not padding (review, external round). "so
            // every question is measured on the similarity basis above" is
            // false: with the stage off, `computeRetrievalConfidence` reaches
            // the similarity basis only for a VECTOR-LED set, and answers
            // basis `none` for a keyword-led set, an image-only set, a pinned
            // exact-identifier head and an empty one — rows the readout
            // excludes by basis, so they appear in NEITHER count. Left
            // unqualified, an operator with a few thousand assistant questions
            // reads a similarity count materially below that and has nothing
            // in the panel accounting for the gap.
            //
            // The criterion is stated as "belongs to neither basis" rather
            // than as a list of three (review, external round). The formula
            // has FOUR `none` outcomes and the omitted one — an empty result
            // set, which scores 0 on basis `none` when retrieval was healthy
            // and null under a caveat — is the LARGEST residue on a thin
            // corpus, i.e. exactly the deployment reading this note. A closed
            // list that reads as exhaustive and is not accounts for less of
            // the gap than it appears to.
            emptyNote={
              assignments && !rerankActive
                ? 'The rerank stage is disabled on this deployment, so every question that can be'
                  + ' scored at all is scored on the similarity basis above. Questions that belong'
                  + ' to neither basis — keyword-led, image-only or pinned exact-identifier'
                  + ' results, and questions the knowledge base had nothing for — appear in'
                  + ' neither readout, so the two counts do not add up to the number of questions'
                  + ' asked.'
                : undefined
            }
          />
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

      {/* ── Image retrieval (#1115) ─────────────────────────────────────── */}
      <Section
        title="Image retrieval"
        description="Pictures in your pages are embedded into their own index and searched as a third retrieval leg beside the semantic and keyword ones."
      >
        {/*
          The unassigned notice is MUTED, not amber (ADR-010): on an instance
          with no vision-language model this is the permanent, correct state —
          not a warning — and amber that is always on is amber that stops
          meaning anything. The controls stay ENABLED beside it: they are
          settings, not actions, and an operator configuring the leg before
          assigning the model is a reasonable order to work in.
        */}
        {imageEmbeddingUnassigned && (
          <p className="text-xs text-muted-foreground" data-testid="retrieval-image-unassigned">
            Image embedding is not assigned; the image leg does not run. Assign a
            vision-language model under{' '}
            <Link className="underline underline-offset-2 hover:text-foreground" to={LLM_PROVIDERS_PATH}>
              {SETTINGS_PANELS.models.label} → LLM providers
            </Link>
            .
          </p>
        )}

        <ToggleRow
          id="rag-image-leg-enabled"
          label="Image leg"
          checked={values.ragImageLegEnabled}
          onChange={(v) => set('ragImageLegEnabled', v)}
          defaultChecked={DEFAULTS.ragImageLegEnabled}
        >
          <p>
            Fuses the image index into page ranking, so a page whose diagram answers the question
            is found even when its text does not mention it. On by default.
          </p>
          <p>
            It costs one extra embedding call per question — the question is embedded a second
            time, by the vision-language model, alongside the ordinary retrieval. Turn it off to
            stop paying that while leaving the index being built.
          </p>
        </ToggleRow>

        <NumberRow
          field={FIELDS.ragImagesPerPageMax}
          value={values.ragImagesPerPageMax}
          onChange={(v) => set('ragImagesPerPageMax', v)}
          defaultValue={DEFAULTS.ragImagesPerPageMax}
        >
          <p>
            How many of a page&apos;s images are indexed. A cost bound, not a quality one: each
            image past it is one request, so a page with ninety screenshots would spend ninety of
            them while the rest of the corpus waits. Images past the cap are skipped and counted
            on the Embeddings tab.
          </p>
        </NumberRow>

        <NumberRow
          field={FIELDS.ragAnswerMaxImages}
          value={values.ragAnswerMaxImages}
          onChange={(v) => set('ragAnswerMaxImages', v)}
          defaultValue={DEFAULTS.ragAnswerMaxImages}
        >
          {/*
            The second sentence is the only place this fact is ever stated.
            ADR-025 D8 makes a text-only answer UNQUALIFIED — nothing on the
            answer, in the sources or in the announcement says a picture was
            withheld — so an operator whose chat model cannot see images has
            no other way to find out that this control does nothing for them.

            Which is exactly why the third sentence has to point somewhere
            (review r2): stating a dependency with no way to check it leaves
            the reader stuck at "can mine?". The verdict — and #1184's
            Re-check, which is how a wrong one is corrected — is the chat
            row's `VisionBadge`, on the same route the unassigned notice at
            the top of this Section already links to.
          */}
          <p>
            Up to this many retrieved images are attached to the question when the chat model can
            see images; 0 turns this off. Text-only chat models never receive images. Whether
            yours can is shown on the chat row under{' '}
            <Link className="underline underline-offset-2 hover:text-foreground" to={LLM_PROVIDERS_PATH}>
              {SETTINGS_PANELS.models.label} → LLM providers
            </Link>
            .
          </p>
        </NumberRow>

        <ToggleRow
          id="rag-image-index-external"
          label="Index external images"
          checked={values.ragImageIndexExternal}
          onChange={(v) => set('ragImageIndexExternal', v)}
          defaultChecked={DEFAULTS.ragImageIndexExternal}
        >
          <p>
            Confluence pages can embed pictures from an external URL; those are cached here and
            are page content like any other, so they are indexed by default. Turn this off to
            keep third-party imagery out of the index.
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
 * Below this many measured questions the two percentiles are noise, and the
 * readout says so rather than letting an operator tune against them. A round
 * number, not a derived one: the honest statement is "this sample is small",
 * and dressing it as a confidence interval would imply a rigour the figure
 * does not have.
 */
const CONFIDENCE_SAMPLE_FLOOR = 30;

/**
 * The window the readout names while the request is still in flight or has
 * failed. The server owns the real number and sends it on every answer; this
 * only exists so the sentence is never "the last undefined days".
 */
const CONFIDENCE_WINDOW_DAYS_FALLBACK = 7;

/**
 * Names the section-level failure notice for its own Retry button — the
 * `Record <value>` recipe, so two ghost buttons on one panel stay
 * distinguishable without an `aria-label` overriding a visible one
 * (WCAG 2.5.3).
 */
const DISTRIBUTION_ERROR_SENTENCE_ID = 'retrieval-distribution-error-sentence';

/**
 * The id a threshold input's `aria-describedby` points at: the READOUT
 * paragraph, not the whole help block (review r1).
 *
 * A description flattens to one unskippable string that is re-read on every
 * focus of the control, so its length is a cost paid per interaction. Pointed
 * at the help block, the rerank threshold's description measured 159 words /
 * 975 characters — the two scale-caveat paragraphs, the readout and its empty
 * note concatenated — of which the #1284 measurement is about thirty. The
 * caveats are the row's visible prose and are read in ordinary reading order
 * either way; the measurement is the part that is ABOUT this control's number
 * and changes per deployment, so it is the part the description carries.
 */
function distributionDescriptionId(fieldKey: CalibrationFieldKey): string {
  return `${fieldKey}-distribution`;
}

/**
 * #1284 — the confidence distribution this deployment has actually produced,
 * under the threshold it is used to set.
 *
 * The panel's own copy says there is no universal value here, because the
 * embedding model moves the cosine scale and the reranker's normalisation
 * moves the relevance one. Until now its only advice was to go and read
 * logged `rag.confidence` values — a question the product already had the
 * data for, asked of an operator with a grep.
 *
 * Four things about this line are deliberate.
 *
 * **It is a MEASUREMENT, so it is neutral** (ADR-010): muted body text, no
 * status hue, no chip. Amber is attention and Steel is action, and this is
 * neither — it is the same de-colouring argument `QualityScoreBadge` and
 * `ConfidenceBadge` settled, reached on a settings surface.
 *
 * **The count is never optional.** A p90 over eleven questions is not a p90,
 * and a readout without a sample size invites exactly the tuning it should
 * prevent. Below {@link CONFIDENCE_SAMPLE_FLOOR} it says so in words.
 *
 * **A failed read is a failure, not an empty distribution** — and a failed
 * RE-read is neither (review r1). `isError` here means the panel has nothing
 * cached, and gets its own sentence, because "nothing was measured" and "we
 * could not look" send an operator in opposite directions; that is the
 * `usePageTree` defect ADR-010 pins. `staleRead` is the rule's third state:
 * the figures survived, so they are still shown, with one clause saying they
 * are the last ones the panel could get.
 *
 * **It IS the row's description** — the input's `aria-describedby` points at
 * this region by id ({@link distributionDescriptionId}), so the measurement
 * reaches touch, keyboard and screen readers rather than the eye alone. It
 * renders inside the row's help block, which is what keeps the #1114
 * calibration strip the immediately-preceding sibling of the control it is
 * about. It stays prose only: a description flattens to one string, so a
 * control in here would be announced with no way to act on it — which is why
 * the failed read's Retry sits at the section top instead.
 */
function ConfidenceDistributionLine({
  fieldKey,
  readoutRef,
  bucket,
  windowDays,
  isPending,
  isError,
  staleRead,
  basisChanged,
  emptyNote,
}: {
  fieldKey: CalibrationFieldKey;
  /**
   * Review r3 — the focus target for a successful Retry, on the ONE row that
   * takes it. Passing it is what makes the readout region `tabIndex={-1}`: a
   * row nobody focuses stays out of the tab order entirely, and the focusable
   * one holds nothing but paragraphs, so the panel's description sweep (which
   * bans `button`/`a`/`input`/`select`/`textarea` from these regions) is
   * unaffected and the tab order gains nothing.
   */
  readoutRef?: Ref<HTMLDivElement>;
  bucket: ConfidenceDistributionBucket | undefined;
  windowDays: number;
  isPending: boolean;
  /** The read failed and there is NOTHING cached — the error is the content. */
  isError: boolean;
  /**
   * The read failed but a previous one succeeded, so the figures below are
   * real and merely not current (review r1). Kept separate from `isError`
   * because the failure sentence claims "there is nothing measured to check
   * this threshold against", which is false the moment a measurement is
   * cached — and this is the state an ordinary focus-refetch during a backend
   * blip lands in.
   */
  staleRead: boolean;
  /**
   * #1114's verdict for this basis, review r2. `search_analytics` records no
   * provider or model beside the score (migration 098 adds `confidence`,
   * `confidence_basis` and `surface` and nothing else), so the window cannot
   * be filtered to one model — and the model behind a basis is exactly what
   * sets its scale. When the calibration strip directly above says the model
   * has moved, its remedy is "re-tune it below", and "below" is this line:
   * without this sentence the panel sends an operator to re-tune against a
   * window that may still be mostly the previous model's numbers.
   *
   * It states what it KNOWS and hedges what it does not (the r3 rule the
   * muted calibration line already follows): the panel has no swap timestamp,
   * so it cannot say how much of the window predates the change — only that
   * the window can span both scales. `stale` outlives the swap, so a
   * deployment that changed a model a year ago and never re-tuned carries
   * this sentence permanently; that is the safe direction, and it is muted
   * prose rather than a second amber, which is what keeps the strip above the
   * one attention-grade thing on the row.
   */
  basisChanged: boolean;
  /**
   * Why this basis has no sample, when the panel already knows. The reachable
   * case is the ordinary one: with no rerank assignment the stage never runs,
   * so the rerank basis is empty forever and "nothing to tune against yet"
   * reads as a defect rather than as a consequence of the deployment. Prose
   * only, and no link — the wayfinding to LLM providers already sits on the
   * rerank pool row, and this string lands inside an `aria-describedby`
   * region that flattens to one line.
   */
  emptyNote?: string;
}) {
  const testId = `retrieval-${fieldKey}-distribution`;
  // One set of props for all four branches, so the focus target survives
  // whichever one is on screen when the retry settles — and so the input's
  // description resolves to a region that always exists, whichever branch is
  // on screen.
  //
  // It is a REGION, not a single paragraph (review, external round). Every
  // caveat used to be appended to the measurement's own sentence, so a stale
  // read on an eleven-question sample with #1114's verdict stale rendered as
  // one undifferentiated ~290-character run of 12px muted text with the two
  // numbers the operator came for buried at its head. Siblings are still
  // prose and a description flattens across children identically, so the
  // accessibility contract is unchanged and only the scanning is fixed.
  //
  // `nm-focus-ring` is index.css's standalone `:focus-visible` mechanic for a
  // surface that wants the Steel ring without a button recipe, and this is
  // the one thing #1284 makes focusable: measured in Chromium, the readout
  // that a successful Retry lands focus on painted the UA default 1px
  // `rgb(0, 95, 204)` outline across its full ~865px width at 1440. The
  // resting rule is a transparent outline, so it costs the unfocusable row
  // nothing.
  const readoutProps = {
    id: distributionDescriptionId(fieldKey),
    'data-testid': testId,
    ref: readoutRef,
    tabIndex: readoutRef ? -1 : undefined,
    className: 'space-y-1.5 nm-focus-ring',
  };
  if (isError) {
    return (
      <div {...readoutProps}>
        <p>
          The measured distribution could not be read, so there is nothing measured to check this
          threshold against. Use <strong className="font-medium">Retry</strong> at the top of this
          section.
        </p>
      </div>
    );
  }
  if (isPending || !bucket) {
    return (
      <div {...readoutProps}>
        <p>Reading the measured distribution…</p>
      </div>
    );
  }
  // One clause, shared by both data branches: what is on screen is real, and
  // is the last thing the panel could read. The Retry that would refresh it
  // sits at the section top, where a control is legal.
  const staleClause = staleRead ? (
    <p>The latest read failed, so this is the last measurement this panel could get.</p>
  ) : null;
  if (bucket.count === 0 || bucket.p50 === null || bucket.p90 === null) {
    return (
      <div {...readoutProps}>
        <p>
          No assistant questions measured on this basis in the last {windowDays} days, so there is
          nothing to tune against yet.
        </p>
        {emptyNote ? <p>{emptyNote}</p> : null}
        {staleClause}
      </div>
    );
  }
  return (
    <div {...readoutProps}>
      <p>
        Measured over the last {windowDays} days: p50{' '}
        <span className="font-mono">{bucket.p50.toFixed(2)}</span>, p90{' '}
        <span className="font-mono">{bucket.p90.toFixed(2)}</span> across{' '}
        {bucket.count.toLocaleString()} assistant question{bucket.count === 1 ? '' : 's'}.
      </p>
      {staleClause}
      {bucket.count < CONFIDENCE_SAMPLE_FLOOR ? (
        <p>Too few to tune against — treat both figures as provisional.</p>
      ) : null}
      {basisChanged ? (
        <p>
          No model is recorded beside a measured question, so this window can span both scales — it
          is comparable again once {windowDays} days have passed since the change.
        </p>
      ) : null}
    </div>
  );
}

/**
 * #1114 — what a confidence threshold was tuned against, when that no longer
 * matches what is running.
 *
 * Three states, and getting the third one wrong is the trap:
 *
 *  - **value 0 → nothing.** The gate does not run, so its calibration cannot
 *    be wrong about anything. Warning here would put amber on the panel of
 *    every instance that ever tried a threshold and turned it back off.
 *  - **stale → amber `role="status"`**, the same recipe (and the same 16px
 *    `AlertTriangle`) as the failed-save strip above. It matches ADR-010's
 *    `usePageTree` precedent exactly: red is failure, amber is degraded, and
 *    the value below is intact but no longer means what it meant. It clears
 *    the moment the threshold is saved again — the server re-records the pair
 *    on every write of it, including a re-save of the same number.
 *  - **no record → a MUTED line, never amber.** Every threshold set before
 *    this shipped lands here, so an amber strip would appear on upgrade for a
 *    model change that may never have happened. Absence of evidence is not
 *    evidence of a change, and a permanent amber banner is how the panel's
 *    own no-amber-at-rest rule gets hollowed out.
 *
 * "Recorded while nothing was assigned" is NOT the third state (review r1).
 * A rerank threshold saved with the stage disabled is an ordinary ADR-021
 * situation and the server records it as a present record with a null pair —
 * so it goes stale the moment a model appears, with copy that says which way
 * round it happened.
 *
 * **Both notices carry the same aimed button, and the muted one needs it
 * most** (review r2). Its remedy used to read "save to record it against the
 * live model" while Save is a pure value diff and this branch rendered no
 * control — so the one thing the operator wants (record THIS number against
 * the live model) was reachable only by changing the gate to a different
 * number, saving, changing it back and saving again. Every instance upgraded
 * with a non-zero threshold lands in exactly this state, which made the note
 * permanent and its instruction false; it is the same "remedy is a no-op"
 * defect review r1 fixed for the amber branch, left standing in its sibling.
 * The copy also stopped asserting a cause it cannot know: a record write that
 * failed is indistinguishable from one that never happened, so the note says
 * what is missing rather than why. It stopped promising an OUTCOME it cannot
 * know either (review r3): "record it against the live model" is a sentence
 * with no live pair behind it — this branch has no calibration object to read
 * one from — and the reachable case is ordinary, a rerank threshold set
 * before #1114 on an instance whose rerank stage is unassigned, where
 * pressing the button records "tuned against nothing". It names the action,
 * not the result; the result is the toast's job, and the toast reads the
 * server's own report of what it wrote.
 *
 * The stale copy names the OLD model, the LIVE one and the scale between
 * them, because "stale" alone leaves an operator no way to judge whether
 * their number is now too strict or too loose — and it names both remedies,
 * since keeping the number is a legitimate choice that simply needs
 * recording. See `handleKeepCalibration` for why that is its own mutation.
 *
 * **The no-live-model case is TWO cases, and `liveResolved` tells them apart**
 * (review r3). "No {basisNoun} model is assigned now" is a claim about
 * `llm_usecase_assignments`, and it is false — persistently — when the row is
 * present and merely unreadable: an `api_key` left undecryptable by a
 * `PAT_ENCRYPTION_KEY` rotation, or an EE org policy naming a provider that
 * has been deleted. Both throw on every read, so the panel would keep naming
 * the wrong cause and point the operator at the assignment grid instead of
 * the provider row. The verdict is deliberately the same in both — erring
 * toward "this still needs attention" is the safe direction — only the
 * sentence differs.
 *
 * `supported` is the fourth cell and it renders NOTHING: a server that has
 * not shipped `ragConfidenceCalibration` has told us nothing at all, and
 * "calibration unknown" beside a button that cannot clear it would be the
 * same dead end one deployment skew away.
 */
function CalibrationNotice({
  fieldKey,
  label,
  value,
  supported,
  calibration,
  onKeep,
  keepDisabled,
}: {
  fieldKey: keyof typeof CONFIDENCE_BASIS_COPY;
  label: string;
  value: number;
  supported: boolean;
  calibration: ConfidenceCalibration | null;
  onKeep: () => void;
  keepDisabled: boolean;
}) {
  if (value <= 0 || !supported) return null;

  if (!calibration) {
    const unknownSentenceId = `retrieval-${fieldKey}-calibration-unknown-sentence`;
    return (
      <div
        className="flex flex-col items-start gap-2 text-xs text-muted-foreground"
        data-testid={`retrieval-${fieldKey}-calibration-unknown`}
      >
        <span id={unknownSentenceId}>
          Calibration unknown — no model is recorded for {label} {value}, so a model change behind it
          would pass unnoticed. Record the model behind it now, or re-tune it below.
        </span>
        <button
          type="button"
          onClick={onKeep}
          disabled={keepDisabled}
          aria-describedby={unknownSentenceId}
          className="nm-button-ghost shrink-0 text-xs"
          data-testid={`retrieval-${fieldKey}-calibration-record`}
        >
          Record {value}
        </button>
      </div>
    );
  }

  if (!calibration.stale) return null;

  const { basisNoun, scaleNoun } = CONFIDENCE_BASIS_COPY[fieldKey];
  const sentenceId = `retrieval-${fieldKey}-calibration-sentence`;
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
      data-testid={`retrieval-${fieldKey}-calibration-stale`}
    >
      <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <span id={sentenceId}>
          {label} {value} was set while{' '}
          {calibration.model ? (
            <>
              <strong className="font-medium">{calibration.model}</strong> was the {basisNoun} model.
            </>
          ) : (
            // The mirror case: the number was tuned with the stage disabled,
            // and something has since been assigned behind it.
            <>no {basisNoun} model was assigned.</>
          )}{' '}
          {calibration.liveModel ? (
            <>
              The live model is <strong className="font-medium">{calibration.liveModel}</strong>,
              whose {scaleNoun} scale differs — re-tune it below, or keep it and record it against
              the live model.
            </>
          ) : calibration.liveResolved ? (
            // ADR-021: an unassigned rerank means the stage is disabled, so the
            // threshold is measured against nothing. "The live model is null"
            // would be worse than saying so.
            <>
              No {basisNoun} model is assigned now, so the threshold gates nothing it was tuned on —
              re-tune it below, or keep it and record the current state.
            </>
          ) : (
            // Review r3 — the sentence above is a claim about the ASSIGNMENT,
            // and it is false when the row is present and merely unreadable:
            // an `api_key` left undecryptable by a `PAT_ENCRYPTION_KEY`
            // rotation, or an EE policy naming a deleted provider. Both throw
            // on every read, so the panel would keep naming the wrong cause
            // and send the operator to the assignment grid instead of the
            // provider row.
            <>
              The live {basisNoun} model could not be resolved, so the threshold is not gating
              against anything it was tuned on — check its provider in{' '}
              <Link className="underline underline-offset-2" to={LLM_PROVIDERS_PATH}>
                {SETTINGS_PANELS.models.label} → LLM providers
              </Link>
              , then re-tune it below or keep it and record it once the model resolves.
            </>
          )}
        </span>
        {/*
          WCAG 2.5.3: the accessible name is the visible label, so no
          `aria-label` overrides it. Two strips can both read "Keep 0.2"; what
          tells them apart is `aria-describedby` pointing at the sentence
          above, the same wiring ADR-010 pins for the deep-search toggle.
        */}
        <button
          type="button"
          onClick={onKeep}
          disabled={keepDisabled}
          aria-describedby={sentenceId}
          className="nm-button-ghost shrink-0 text-xs"
          data-testid={`retrieval-${fieldKey}-calibration-keep`}
        >
          Keep {value}
        </button>
      </div>
    </div>
  );
}

/**
 * The neutral "off" marker. Deliberately slate rather than amber or Steel: this
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
  describedBy,
  children,
}: {
  field: NumericField;
  value: number;
  onChange: (value: number) => void;
  defaultValue: number;
  disabled?: boolean;
  /**
   * #1284 — the id of the paragraph that becomes this input's accessible
   * description. Today: the row's measured-distribution readout
   * ({@link distributionDescriptionId}).
   *
   * **Opt-in, never panel-wide** (review r1). A description flattens to one
   * string, so the region it names must be PROSE ONLY: three of this panel's
   * rows carry an operable child inside their help — the two wayfinding
   * `<Link>`s to LLM providers and `Use measured value` — and wiring those
   * announces a link and a button as description text with no way to act on
   * them, then repeats them on the next tab stop. The blanket form of this
   * prop shipped in the first cut of #1284 and did exactly that.
   *
   * **And it names ONE paragraph, not the help block** (review r1): the block
   * form made the rerank threshold's description 975 characters, re-read on
   * every focus, with the measurement it exists to carry at the far end of it.
   * `RetrievalTab.test.tsx` sweeps every `[aria-describedby]` the panel
   * renders and fails on any region holding something operable, so the
   * prose-only rule is enforced for all rows rather than spot-checked on one.
   */
  describedBy?: string;
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
            // #1284 — the readout under a knob carries the part of the
            // decision the number cannot: what this deployment has actually
            // measured. Printed beside the input it was reachable by eye
            // only; wired here it reaches touch, keyboard and screen readers
            // too (ADR-010's `DeepSearchToggle` precedent). Per-row and one
            // paragraph, never panel-wide and never the whole help block —
            // see `describedBy`.
            aria-describedby={describedBy}
            className="w-24 rounded-md border border-border-interactive bg-background/50 px-3 py-1.5 text-right text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-45"
            data-testid={`retrieval-${field.key}`}
          />
          {field.unit && <span className="w-24 text-xs text-muted-foreground">{field.unit}</span>}
        </div>
      </div>
      <div id={`${field.key}-help`} className="space-y-1.5 text-xs text-muted-foreground">
        {children}
      </div>
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
