import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../../shared/lib/api';
import { EmbeddingShadowCompareSection } from './EmbeddingShadowCompareSection';

interface Pending {
  providerId: string;
  model: string;
}

interface Props {
  /** The unsaved embedding provider/model change, when one exists (same value the destructive banner receives). */
  pending: Pending | null;
  /**
   * Called after any lifecycle action that repoints the embedding assignment
   * server-side. Invalidating the query is not enough — the parent holds a
   * local working copy behind a one-shot hydration guard, and only it can
   * drop that guard so the form re-seeds (review r7).
   */
  onLifecycleChange?: () => void;
  /**
   * Reports whether a migration exists, so the parent can stop offering the
   * destructive path this card replaces while one is under way (review r9).
   */
  onActiveChange?: (active: boolean) => void;
}

/** Only the two fields the card needs; the section owns the full shape. */
interface CompareRunSummary {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
}

interface ShadowStatus {
  active: boolean;
  migration: null | {
    phase: 'backfilling' | 'ready' | 'swapped' | 'aborting';
    model: string;
    dimensions: number;
    totalPages: number;
    backfilledPages: number;
    stragglerPages: number;
    indexed: boolean;
    indexReady: boolean;
    startedAt: string;
  };
}

/**
 * #1116 — the zero-downtime re-embed lifecycle. Search serves the live
 * vectors throughout: start probes the pair server-side and backfills a
 * shadow column in the background, swap is one bounded-lock rename, rollback
 * stays available until cleanup deletes the old vectors. Sits beside the
 * destructive wipe (live-index rebuild) as the recommended path for model
 * changes.
 */
/**
 * First sample of a backfill this card has seen. Reset when the counter moves
 * backwards — a new migration, or an abort — so a stale baseline can never
 * outlive the run it measured.
 */
let etaBaseline: { at: number; done: number; startedAt: string } | null = null;

function etaFromObservedRate(m: { backfilledPages: number; totalPages: number; startedAt: string }): string | null {
  const now = Date.now();
  if (!etaBaseline || etaBaseline.startedAt !== m.startedAt || m.backfilledPages < etaBaseline.done) {
    etaBaseline = { at: now, done: m.backfilledPages, startedAt: m.startedAt };
    return null;
  }
  const observed = m.backfilledPages - etaBaseline.done;
  const elapsed = now - etaBaseline.at;
  const remaining = m.totalPages - m.backfilledPages;
  // 5 pages of watched progress: below that the sample says nothing.
  if (observed < 5 || elapsed <= 0 || remaining <= 0) return null;
  return formatEta((elapsed / observed) * remaining);
}

/** Coarse on purpose: an ETA to the minute would imply precision this has none of. */
function formatEta(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = ms / 3_600_000;
  return hours < 10 ? `${hours.toFixed(1)} h` : `${Math.round(hours)} h`;
}

/**
 * The ending itself — true in every branch the strip renders in and in the
 * toast, because the branch is exactly what changed underneath the run.
 */
const COMPARISON_ENDED = 'The comparison in progress ended — the migration changed underneath it.';
/** The recovery, in the one branch that offers it: `ready`, and only `ready`. */
const COMPARISON_RESTARTABLE = 'Start a new comparison from the current migration.';
/**
 * …and where it does not. `EmbeddingShadowCompareSection` — the only surface
 * carrying a Run control — is mounted by the `ready` branch alone, while the
 * ending arm below fires on a migration WINDOW that closed: `swapped`,
 * `aborting`, or the migration gone from the card entirely. So the strip is by
 * construction shown where that control is not, and one fixed "Start a new
 * comparison…" named a control the card does not offer in four of its five
 * branches — on the PRIMARY path every time (swap while a comparison runs).
 * An instruction the admin cannot follow is worse than none, because they go
 * looking for it (#1533).
 *
 * It names what comparing NEEDS rather than a control, in the phase vocabulary
 * the card already speaks, so it composes with whatever the branch's own prose
 * says to do next: finish the abort, wait for the backfill, clean up or roll
 * back, start a re-embed. What it names is exactly what the compare route
 * gates on — `llm-embedding-shadow.ts` 409s on `status.phase !== 'ready'`, the
 * phase alone — and its second clause is checkable from the card on screen:
 * every branch that renders this sentence renders no Swap control either.
 */
const COMPARISON_UNAVAILABLE =
  'Comparing on real queries needs a migration waiting at the swap, and this card is not showing one.';
/**
 * What the TOAST carries instead. It is announced once, at an instant where
 * this card can vanish entirely (a rollback with no pending change leaves no
 * branch to word a sentence from), and it cannot re-word itself afterwards the
 * way the derived strip does — so it states the fact every path that fires it
 * has just established server-side rather than pointing at a card that may be
 * gone or at a control that may not exist.
 */
const COMPARISON_WINDOW_CLOSED = 'The window this comparison ran in has closed on the server.';

export function EmbeddingShadowMigrationCard({ pending, onLifecycleChange, onActiveChange }: Props) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ShadowStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCleanup, setConfirmingCleanup] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelCleanupRef = useRef<HTMLButtonElement | null>(null);
  /**
   * The phase paragraph of whichever branch is rendered — exactly one is, so
   * one ref is enough. It is the landing spot when the ending notice's Dismiss
   * removes itself from under the admin's focus, the "nearest surviving prose"
   * rule the compare section's notices already follow.
   */
  const phaseProseRef = useRef<HTMLParagraphElement | null>(null);
  /** Set by that Dismiss alone, so no other removal can move the caret. */
  const rehomeAfterDismiss = useRef(false);
  /**
   * The id of a #1260 comparison this admin started that is still running, as
   * reported up by the compare section (r3). It lives HERE, not there, because
   * every lifecycle action below ends such a run server-side AND unmounts the
   * section that would have said so: swap and rollback move the card out of
   * the `ready` branch, and rollback can take the card away entirely. The card
   * is the last surface standing at that moment, so it is the one that speaks.
   */
  const compareRunInFlight = useRef<string | null>(null);
  /**
   * Latched by RUN ID, not by a boolean (review r2). The two arms below do not
   * coordinate: `post()` snapshots the in-flight id BEFORE its request, and the
   * 5s status poll can observe the same ending inside that window — which a
   * real abort (table lock, column drops) makes the ordinary case rather than
   * the exotic one. Keyed on the id, one ending produces one notice from
   * whichever arm gets there first, and the mirror case (the poll wins and the
   * POST's snapshot is stale) closes with it.
   */
  const warnedFor = useRef<string | null>(null);
  /** Mirrors the ref for RENDER — the backfilling branch has to say something
   *  true while a comparison it cannot show is still running behind it. */
  const [compareRunning, setCompareRunning] = useState(false);
  /**
   * The ending, as a surface that OUTLIVES the branch it was raised in
   * (browser verification F3). The toast below announces it at the app root
   * and covers the one case this strip cannot — a rollback with no pending
   * change takes the whole card away — but it is gone in seconds, while the
   * thing it reports is that a run's N x 2 embedding calls were spent for
   * nothing and the admin has to start another comparison. So the fact stays
   * on screen, in whatever branch the lifecycle action moved the card into,
   * until it is dismissed or a new comparison replaces it.
   */
  const [endedNotice, setEndedNotice] = useState(false);
  const onCompareRunInFlightChange = useCallback((runId: string | null) => {
    compareRunInFlight.current = runId;
    // A run already reported ended is not "running" for either surface, even
    // though the section keeps reporting it up until the server catches up.
    const live = runId !== null && runId !== warnedFor.current;
    setCompareRunning(live);
    if (live) setEndedNotice(false);
  }, []);
  /** The one sentence both endings share — the local action and the remote
   *  one. Written once so the two paths cannot drift apart. */
  const warnComparisonEnded = useCallback((runId: string) => {
    if (warnedFor.current === runId) return;
    warnedFor.current = runId;
    compareRunInFlight.current = null;
    setCompareRunning(false);
    setEndedNotice(true);
    toast.warning(`${COMPARISON_ENDED} ${COMPARISON_WINDOW_CLOSED}`);
  }, []);
  // Through a ref so an inline arrow prop cannot re-fire the effect each render.
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;

  const refresh = useCallback(async () => {
    try {
      const s = await apiFetch<ShadowStatus>('/admin/embedding/shadow-migration');
      setStatus(s);
    } catch {
      // transient — keep the last known state
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 5s matches ActiveEmbeddingLocksBanner's cadence and stays under the
    // default 20/min per-route admin rate limit (3s sat exactly at it).
    pollRef.current = setInterval(() => void refresh(), 5_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  /**
   * `endsMigrationWindow` is explicit, never inferred from the path: swap,
   * rollback and cleanup all move the state row and therefore end any running
   * comparison, while **Re-run backfill does not** — it leaves
   * `status:startedAt:swappedAt:revertedAt` untouched, so the run keeps going.
   * Since the ready → backfilling regression now KEEPS the in-flight id (r2),
   * a path-blind arm would fire on exactly that button.
   */
  async function post(path: string, okMessage: string, opts: { endsMigrationWindow: boolean }, body?: object) {
    setBusy(true);
    // Read BEFORE the request: `refresh()` below re-renders the card into
    // another phase branch, which unmounts the compare section and clears
    // this ref on the way out.
    const endedComparison = opts.endsMigrationWindow ? compareRunInFlight.current : null;
    try {
      await apiFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      toast.success(okMessage);
      if (endedComparison) {
        // The action succeeded; the comparison is the collateral, hence
        // `warning` rather than `error` (#1260 r3). The run re-reads the
        // migration fingerprint per query and fails cleanly on the next one,
        // but the section that renders that failure is inside the `ready`
        // branch and is already gone — an admin who aborted at 7/16 saw the
        // progress line, the section and any strip vanish within one poll,
        // with the run's N x 2 embedding calls silently spent. Said here it
        // outlives every unmount, because a toast renders at the app root.
        warnComparisonEnded(endedComparison);
      }
      await refresh();
      // Swap/rollback/cleanup repoint the embedding assignment and
      // dimensions server-side — the sibling panels (assignments section,
      // destructive banner) read them through these caches and would keep
      // showing pre-migration state until a full reload otherwise.
      // AWAITED, and the callback runs after it: invalidate() only marks the
      // entry stale, so a parent re-seeding synchronously would read the OLD
      // document and re-arm its hydration guard against it — leaving the form
      // on the pre-swap pair and re-raising the destructive banner over a
      // migration that just succeeded (review r8). This is the same ordering
      // LlmTab's own save.onSuccess uses, and for the same reason.
      await queryClient.invalidateQueries({ queryKey: ['llm-usecases'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      void queryClient.invalidateQueries({ queryKey: ['llm', 'usecase-default'] });
      onLifecycleChange?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
      setConfirmingCleanup(false);
    }
  }

  useEffect(() => {
    // Arming unmounts the button that had focus, dropping it to <body>
    // (WCAG 2.4.3). Land on Cancel rather than Confirm: what is armed here
    // deletes the old vectors permanently, and Enter must not finish it by
    // momentum.
    if (confirmingCleanup) cancelCleanupRef.current?.focus();
  }, [confirmingCleanup]);

  useEffect(() => {
    // The ending notice's Dismiss unmounts itself, so the caret it held falls
    // to <body>. Guarded the two ways `useNoticeRetry` guards its own rehome:
    // only for a dismiss THIS control started, and only if focus really was
    // orphaned — an admin who reached for Roll back mid-click keeps it.
    if (endedNotice) return;
    if (!rehomeAfterDismiss.current) return;
    rehomeAfterDismiss.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    phaseProseRef.current?.focus();
  }, [endedNotice]);

  const migration = status?.active ? status.migration : null;

  useEffect(() => {
    onActiveChangeRef.current?.(migration !== null);
  }, [migration]);

  /**
   * The comparison as the SERVER sees it, asked only while the card is the
   * last surface standing — the `backfilling` branch, where the compare
   * section is not mounted (r1 of this round).
   *
   * `compareRunning` was raised and cleared exclusively by the section's own
   * report, and the section only exists in the `ready` branch, so the sentence
   * this branch renders was a claim the card could not check in either
   * direction. A FRESH mount in `backfilling` (a reload, or a Settings sub-tab
   * switch away and back) had never heard of the run at all and told an admin
   * that comparing "unlocks when the backfill completes" while their own
   * comparison was running and holding the one-active slot — the exact case
   * the two-sentence note was written for. And a run that FINISHED behind the
   * note kept "still running" for as long as the stragglers lasted, because
   * nothing on this side could clear the flag; the stale id then also made the
   * next swap or abort warn that a comparison had ended when it had already
   * completed. One lookup answers both.
   *
   * It shares the section's cache key, candidate and all, so the two are one
   * entry rather than two racing ones — and it is scoped to this branch, so
   * the `ready` branch keeps exactly one poller (the section's) and this adds
   * no request there.
   */
  /**
   * The identity both halves key their re-attachment cache on — the model AND
   * the migration window it belongs to, never the bare model name (r1). The
   * server re-attaches on the whole candidate PAIR
   * (`config @> {"candidate":{providerId,model}}`), and `providerId` is not on
   * the status wire, so a name-only key was one dimension short of the
   * predicate it mirrors: the same model re-hosted behind a second provider
   * collided on the client while the server refused, and a remount inside the
   * five-minute gcTime rendered the previous migration's report — and its live
   * judgement radios — under the current migration's heading. `startedAt` is
   * strictly FINER than the pair, which is the safe direction: it can only
   * miss the cache and pay one round trip, never serve the wrong run.
   */
  const compareCacheKey = migration ? `${migration.model}@${migration.startedAt}` : '';
  const compareLookupActive = migration?.phase === 'backfilling';
  const { data: compareLatest } = useQuery<{ run: CompareRunSummary | null }>({
    queryKey: ['shadow-compare-latest', compareCacheKey],
    queryFn: () => apiFetch('/admin/embedding/shadow-migration/compare'),
    enabled: compareLookupActive,
    // The card's own cadence; two admin-rate-limited polls never share a
    // route here, because the section that owns the other one is unmounted.
    refetchInterval: 5_000,
    staleTime: Infinity,
    refetchOnMount: 'always',
  });
  const latestCompare = compareLatest?.run ?? null;
  useEffect(() => {
    if (!compareLookupActive || !latestCompare) return;
    if (latestCompare.status === 'queued' || latestCompare.status === 'running') {
      // An ending already reported for this id is not "running" again just
      // because the server has not caught up yet — the same latch both other
      // arms use.
      if (latestCompare.id === warnedFor.current) return;
      compareRunInFlight.current = latestCompare.id;
      setCompareRunning(true);
      return;
    }
    if (compareRunInFlight.current === latestCompare.id) compareRunInFlight.current = null;
    setCompareRunning(false);
  }, [compareLookupActive, latestCompare]);

  /**
   * The same ending, arrived at without a local POST (r1): a swap, abort or
   * rollback made in ANOTHER TAB or by another admin. `refresh()` flips this
   * card out of the `ready` branch, which unmounts the compare section, its
   * progress line and any strip it would have rendered — and the section's own
   * compensating toast cannot cover it, because the server fails the run only
   * at its next per-query fingerprint check, one or more polls after the
   * migration went inactive. The card's poll usually wins that race outright,
   * so without this the comparison died with no notice on any surface, and the
   * pair-scoped re-attachment cannot recover the run by design.
   *
   * Keyed on the migration WINDOW closing, not on leaving the `ready` PHASE
   * (review r2). The server ends a run on the state row's fingerprint
   * (`status:startedAt:swappedAt:revertedAt`), while `phase` is recomputed from
   * a LIVE `embedding_next IS NULL` count on every poll — so one page whose
   * shadow embed failed mid-window (`embedding-service`: a shadow failure must
   * never fail the live embed) flips ready → backfilling with the state row
   * untouched. Keyed on the phase, that regression announced an ending to a run
   * that was still going, still holding the one-active slot, and prescribed a
   * remedy the compare route's own 409 refuses. The window is exactly
   * `migration === null` (rolled back or cleaned up) or `swapped` / `aborting`;
   * `backfilling` KEEPS the id, so the section re-adopts the run when `ready`
   * returns.
   *
   * Both arms latch on the run id, so the local POST and this poll cannot
   * report one ending twice.
   */
  const migrationWindowOpen =
    migration !== null && migration.phase !== 'swapped' && migration.phase !== 'aborting';
  const wasOpen = useRef(false);
  useEffect(() => {
    const inFlight = compareRunInFlight.current;
    if (wasOpen.current && !migrationWindowOpen && inFlight) warnComparisonEnded(inFlight);
    wasOpen.current = migrationWindowOpen;
  }, [migrationWindowOpen, warnComparisonEnded]);

  if (!migration && !pending) return null;
  if (status === null) return null; // first poll not resolved yet

  /**
   * The strip's second sentence, derived from the SNAPSHOT this render is
   * already drawing the branch from — one expression, no ref, no timer, no
   * counter, no watermark, no memory of an earlier snapshot (review r4). The
   * `ready` branch is the only one that mounts the Run control, so it is the
   * only one where the prescription can be followed; every other branch gets
   * the sentence that is true without it (#1533).
   *
   * Pure by design, not by luck. A status answer that was already stale when it
   * landed therefore yields a strip that AGREES with the branch rendered from
   * that same answer — both are that one answer's view of the migration — and
   * the next poll (≤5s) corrects the two together. Wording the strip from
   * anything other than the answer on screen is what earlier rounds of this fix
   * tried, and it produced #1533 in mirror image: the unavailable sentence
   * standing under a mounted Run control and an enabled Swap.
   */
  const endedRecovery = migration?.phase === 'ready' ? COMPARISON_RESTARTABLE : COMPARISON_UNAVAILABLE;

  // Rendered by EVERY branch below, because the branch is exactly what changes
  // underneath a comparison. Amber, not destructive: the lifecycle action the
  // admin asked for succeeded and the migration is fine — the comparison is the
  // collateral, which is what ADR-010 reserves amber for. It is dismissible so
  // it cannot stand at rest on a card the admin still has to finish using.
  // The polite region's text is derived per render, so it MUTATES in place when
  // the branch changes under an undismissed notice — a second announcement, and
  // deliberately so: what it then says is true of the branch now on screen,
  // whereas latching the sentence at warn time would keep prescribing a
  // comparison after the window closed, which is the whole of #1533.
  const endedStrip = endedNotice ? (
    <div
      role="status"
      className="mt-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs"
      data-testid="shadow-compare-ended"
    >
      <p className="flex-1">{`${COMPARISON_ENDED} ${endedRecovery}`}</p>
      <button
        type="button"
        className="shrink-0 underline"
        onClick={() => {
          // Dismissing unmounts the button that had focus, dropping it to
          // <body> in a ~30-stop settings panel (WCAG 2.4.3) — the same defect
          // `cancelCleanupRef` above and the section's `useNoticeRetry` both
          // exist to prevent, on the fourth self-removing control of this
          // surface. Rehoming happens in the effect below, because the element
          // only leaves the DOM on the commit this `setState` schedules.
          rehomeAfterDismiss.current = true;
          setEndedNotice(false);
        }}
      >
        Dismiss
      </button>
    </div>
  ) : null;

  if (!migration && pending) {
    return (
      // Every phase card wears border-status-embedding/30: this surface IS
      // the embedding pipeline, and Steel is its reserved hue (ADR-010). It
      // used to be the informational indigo, which names no state.
      <div
        className="nm-card border-status-embedding/30 p-3 text-sm"
        data-testid="shadow-migration-card"
      >
        <p ref={phaseProseRef} tabIndex={-1}>
          Start a re-embed to switch to <b>{pending.model}</b>. Search keeps the current index
          until you swap. Do not save the assignment — that would switch the live model
          immediately. If the new width differs, those vectors will not fit the current index.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="nm-button-primary"
            disabled={busy}
            onClick={() => pending && void post('/admin/embedding/shadow-migration', 'Shadow backfill started', { endsMigrationWindow: false }, pending)}
          >
            {busy ? 'Starting…' : 'Start re-embed'}
          </button>
        </div>
        {endedStrip}
      </div>
    );
  }

  if (!migration) return null;

  if (migration.phase === 'aborting') {
    return (
      <div className="nm-card border-status-embedding/30 p-3 text-sm" data-testid="shadow-migration-card">
        <p ref={phaseProseRef} tabIndex={-1}>
          A previous abort did not finish — the shadow columns may still exist.
          Retry to complete it; nothing else can start until it does.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            className="nm-button-primary"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/rollback', 'Abort completed', { endsMigrationWindow: true })}
          >
            Retry abort
          </button>
        </div>
        {endedStrip}
      </div>
    );
  }

  if (migration.phase === 'backfilling') {
    // The issue asks for progress AND an ETA. Rate comes from progress this
    // card has WATCHED, never from `startedAt` ÷ pages done (review r10):
    // `startedAt` is the migration's start, not the backfill's, and
    // `rerunShadowBackfill` deliberately leaves it alone — so after a crashed
    // worker resumed a day later, the idle day was divided into the pages and
    // the card advertised hundreds of hours for a run with minutes left. The
    // cost is that the estimate appears a few polls in rather than at once,
    // which is the honest trade: an ETA that counts idle time as work is
    // worse than no ETA. Suppressed during the index build too, which has no
    // page counter to extrapolate from — the card names that phase instead
    // (review r9).
    const buildingIndex = migration.stragglerPages === 0 && !migration.indexReady;
    const eta = !buildingIndex ? etaFromObservedRate(migration) : null;

    return (
      <div className="nm-card border-status-embedding/30 p-3 text-sm" data-testid="shadow-migration-card">
        <p ref={phaseProseRef} tabIndex={-1}>
          {/*
            "Search is unaffected" was half true, and this is the surface where
            the other half shows up (#1114). Correctness really is untouched —
            the live column serves every query, edited pages dual-write, nothing
            is deleted before the swap. Availability is not: `runShadowBackfillJob`
            embeds through the same process-wide LLM queue as a user's question
            and holds one of `LLM_CONCURRENCY`'s slots for the entire run, which
            on a non-batching provider is hours at Qwen3's ingest cost. At
            `LLM_MAX_QUEUE_DEPTH` a query embed is rejected outright and search
            drops to its keyword leg. Sized as "may be slower" rather than a
            warning because that rejection needs concurrent load on top; the
            runbook's *Search during the backfill* section carries the detail.

            The copy names the QUEUE, not the provider. The queue is one
            module-level `pLimit` in the API process, so the contention holds in
            every configuration. Provider identity does not: this migration
            carries its own `providerId` from the start body, and the SWAP is
            what rewrites `llm_usecase_assignments` — so while the backfill runs,
            live query embeds may still resolve an entirely different provider
            row. Blaming the provider would name a coupling that is absent on
            those instances and leave the one that is always there unsaid.
          */}
          Zero-downtime re-embed to <b>{migration.model}</b> ({migration.dimensions} dims):{' '}
          <b>
            {migration.backfilledPages}/{migration.totalPages}
          </b>{' '}
          pages backfilled{eta ? ` — about ${eta} remaining` : ''}. Results stay complete — the
          current index keeps serving — but query embedding shares the embedding queue with this
          backfill, so answers may be slower until it finishes.
        </p>
        {buildingIndex && (
          <p className="mt-1 text-muted-foreground">
            All pages carry shadow vectors; <b>building the vector index</b>. This is usually the
            longest phase and reports no page-level progress — writes to the embedding table queue
            behind it.
          </p>
        )}
        <div className="mt-2 flex gap-2">
          {/* Always offered while backfilling: it also recovers a worker
              that crashed during the final index build (zero stragglers), and
              the server refuses honestly if the job is still running. */}
          <button
            className="nm-button-primary"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/backfill', 'Backfill re-enqueued', { endsMigrationWindow: false })}
          >
            Re-run backfill
          </button>
          <button
            className="nm-button-ghost"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/rollback', 'Shadow migration aborted', { endsMigrationWindow: true })}
          >
            Abort
          </button>
        </div>
        {/* #1260 — absent, not disabled-with-no-reason: comparing against a
            partially backfilled column measures the backfill, not the model,
            so the control only exists once `ready` does. Muted, never amber —
            waiting is the normal state of a backfill.

            Two sentences, because this branch is reached two ways (r2). The
            usual one is a backfill that has not finished yet. The other is a
            REGRESSION out of `ready` — one page whose shadow embed failed
            raises the straggler count again — and there a comparison can be
            running behind this note, holding the one-active slot: telling that
            admin comparing "unlocks when the backfill completes" describes a
            control they already used, and hides the run their next attempt
            would be 409'd by.

            Which sentence shows is decided by the SERVER lookup above, not by
            what this session happened to watch: a fresh mount here has watched
            nothing, and a run that finished behind this note is no longer
            running. */}
        <p className="mt-2 text-xs text-muted-foreground" data-testid="shadow-compare-locked">
          {compareRunning
            ? 'A comparison on real queries is still running — this card cannot show it while stragglers remain, and it reappears when the backfill catches up.'
            : 'Comparing the two models on real queries unlocks when the backfill completes — a partially filled candidate column would measure the backfill, not the model.'}
        </p>
        {endedStrip}
      </div>
    );
  }

  if (migration.phase === 'ready') {
    return (
      <div className="nm-card border-status-embedding/30 p-3 text-sm" data-testid="shadow-migration-card">
        <p ref={phaseProseRef} tabIndex={-1}>
          Backfill complete — <b>{migration.totalPages}</b> pages carry <b>{migration.model}</b>{' '}
          vectors
          {migration.indexed ? (
            ' and the new index is built'
          ) : (
            <span className="text-warning">
              {' '}
              with <b>no vector index</b> — pgvector cannot index past 4000 dimensions, so search
              will scan sequentially once you swap
            </span>
          )}
          . Swapping is a sub-second rename; the old vectors stay available for rollback until
          cleanup.
        </p>
        <div className="mt-2 flex gap-2">
          <button
            className="nm-button-primary"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/swap', 'Swapped — new model is live', { endsMigrationWindow: true })}
          >
            {busy ? 'Swapping…' : 'Swap to the new model'}
          </button>
          <button
            className="nm-button-ghost"
            disabled={busy}
            onClick={() => void post('/admin/embedding/shadow-migration/rollback', 'Shadow migration aborted', { endsMigrationWindow: true })}
          >
            Abort
          </button>
        </div>
        {/* #1260 — the one window a real-data A/B is possible: both models'
            vectors exist on the same rows, and the backfill is complete. */}
        <EmbeddingShadowCompareSection
          candidateModel={migration.model}
          candidateKey={compareCacheKey}
          onRunInFlightChange={onCompareRunInFlightChange}
        />
        {endedStrip}
      </div>
    );
  }

  // swapped
  return (
    <div className="nm-card border-status-embedding/30 p-3 text-sm" data-testid="shadow-migration-card">
      <p ref={phaseProseRef} tabIndex={-1}>
        <b>{migration.model}</b> is live. Validate search quality, then clean up — or roll back
        to the previous model. Cleanup <b>deletes the old vectors</b> and ends the rollback
        window.
      </p>
      {confirmingCleanup && (
        <p className="mt-2 text-warning" role="alert">
          Cleanup permanently deletes the old vectors — rolling back afterwards requires a full
          re-embed. Continue?
        </p>
      )}
      <div className="mt-2 flex gap-2">
        {confirmingCleanup ? (
          <>
            <button
              ref={cancelCleanupRef}
              className="nm-button-ghost"
              disabled={busy}
              onClick={() => setConfirmingCleanup(false)}
            >
              Cancel
            </button>
            <button
              className="nm-button-primary"
              disabled={busy}
              onClick={() => void post('/admin/embedding/shadow-migration/cleanup', 'Cleaned up — migration complete', { endsMigrationWindow: true })}
            >
              Confirm cleanup
            </button>
          </>
        ) : (
          <>
            <button className="nm-button-primary" disabled={busy} onClick={() => setConfirmingCleanup(true)}>
              Clean up
            </button>
            <button
              className="nm-button-ghost"
              disabled={busy}
              onClick={() => void post('/admin/embedding/shadow-migration/rollback', 'Rolled back — previous model is live', { endsMigrationWindow: true })}
            >
              Roll back
            </button>
          </>
        )}
      </div>
        {endedStrip}
    </div>
  );
}
