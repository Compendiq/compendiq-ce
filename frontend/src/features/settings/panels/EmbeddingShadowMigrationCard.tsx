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
/**
 * What to do about it, and it is TWO sentences because the recovery is not
 * available everywhere the ending is announced (#1533).
 *
 * `EmbeddingShadowCompareSection` — the only surface with a Run control — is
 * mounted by the `ready` branch alone, while the ending arm below fires on a
 * window that is GONE — `swapped` and `aborting` included: the strip is by
 * construction shown where that control is gone. A single fixed "Start a new
 * comparison…" therefore named a control the card does not offer in four of
 * its five branches, on the PRIMARY path every time (swap while a comparison
 * runs) — an instruction the admin cannot follow is worse than no
 * instruction, because they go looking.
 *
 * The unreachable wording names the EVENT rather than a control, in the card's
 * own vocabulary, so it composes with whatever the branch's own prose already
 * says to do next: finish the abort, wait for the backfill, clean up or roll
 * back, start a re-embed. It is also what the toast carries, because every
 * path that fires the toast has ended the migration window server-side —
 * including the one case no strip can cover, a rollback that takes the whole
 * card away.
 *
 * The event, and NOT the compare route's gate restated as conditions (review
 * r2). Every branch this sentence reaches has closed the window: `swapped`,
 * `aborting`, a card with no active migration left, and the hold below —
 * whereas a sentence about what comparing NEEDS names conditions the card on
 * screen keeps asserting. `stragglerPages === 0 && indexReady` with no swap
 * behind it (`shadow-migration-service`: `phase: stragglerPages === 0 &&
 * indexReady ? 'ready' : 'backfilling'`) is true of an `aborting` migration
 * being torn down, and every clause of it is printed one line above the strip
 * in the hold's own window — under an enabled Swap button, next to "Backfill
 * complete … and the new index is built". The admin cannot infer that a
 * phrase like "still waiting at the swap" excludes what they are looking at;
 * the closed window is a fact they can act on, and it is the fact the 409
 * actually turns on. That is exactly where #1533 asks it to be true.
 */
const COMPARISON_RESTARTABLE = 'Start a new comparison from the current migration.';
const COMPARISON_UNAVAILABLE =
  'Comparing on real queries is refused until a migration is waiting at the swap again — the window this comparison ran in has closed on the server.';

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
  /**
   * The ending is reported one status round trip BEFORE `status` can show it:
   * `post()` warns the moment the lifecycle POST returns 200, and `refresh()`
   * below swallows a failing GET and keeps the last known state — so
   * `migration.phase` can still read `ready` while the swap has already closed
   * the migration window server-side and the compare route answers 409
   * (`llm-embedding-shadow.ts`: `status.phase !== 'ready'`). Deriving the
   * strip's second sentence from that stale phase alone made it prescribe a
   * comparison the server refuses, in the same instant as a toast saying
   * comparing is unavailable — the two surfaces contradicting each other on the
   * primary path (review r1 of #1533).
   *
   * Every path that reports an ending has closed the window server-side, so the
   * fact is already known here: hold it until a status observation NEWER than
   * the ending arrives, and word the strip from the fact rather than from a
   * phase that has not caught up. Cleared in `refresh()`, so a later migration
   * that genuinely reaches `ready` gets the prescription back.
   */
  const [endedWindowUnconfirmed, setEndedWindowUnconfirmed] = useState(false);
  const onCompareRunInFlightChange = useCallback((runId: string | null) => {
    compareRunInFlight.current = runId;
    // A run already reported ended is not "running" for either surface, even
    // though the section keeps reporting it up until the server catches up.
    const live = runId !== null && runId !== warnedFor.current;
    setCompareRunning(live);
    if (live) setEndedNotice(false);
  }, []);
  /**
   * Status requests are numbered, and a body OLDER than the last one applied
   * is dropped (review r1 of r2's fix). Declared ABOVE the takes below,
   * because a take stamps its hold with the number in flight.
   *
   * Keyed on what was APPLIED, not on the newest request in flight: an older
   * response is still the freshest thing this card knows until a newer one
   * lands, and dropping it then would trade staleness for blindness.
   */
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  /**
   * The request number in flight when the migration window was last observed
   * CLOSED. Every status request at or below it was issued while this card
   * still believed the window open, so its answer can describe only the
   * migration BEFORE the close: it is dropped, and — the point of the
   * watermark — it cannot release the hold either.
   *
   * ONE number for both sides, because the take and the release have to turn
   * on the same condition (review r3). They did not: the hold is taken by any
   * window-closing POST, whether or not anything was comparing, while the
   * release was denied only to an answer bracketed by a COMPARISON ending
   * (`warnedFor`, which moves on exactly that event and nothing else). So a
   * swap that ended no run left the in-flight pre-swap poll free to answer
   * FIRST — nothing newer had been applied, so the sequence check passed it —
   * releasing the hold and handing `ready` back to the wording under a strip
   * that outlived its own migration: #1533 verbatim, "Start a new comparison
   * from the current migration." over a server whose compare route already
   * answers 409, for as long as the confirming GET kept failing.
   *
   * It SUBSUMES the `warnedFor` snapshot it replaces rather than sitting
   * beside it: every ending takes the hold, and a take can only raise the
   * watermark to at least the number of every request already in flight, so
   * every answer that snapshot dropped is at or below the watermark too.
   */
  const windowClosedAtSeq = useRef(0);
  /**
   * The one take, so the release predicate above has exactly one event to
   * compare against and the two cannot drift apart again.
   */
  const holdEndedWindow = useCallback(() => {
    setEndedWindowUnconfirmed(true);
    windowClosedAtSeq.current = requestSeq.current;
  }, []);
  /** The one ending both arms report — the local action and the remote one.
   *  Written once so the two paths cannot drift apart. */
  const warnComparisonEnded = useCallback(
    (runId: string) => {
      if (warnedFor.current === runId) return;
      warnedFor.current = runId;
      compareRunInFlight.current = null;
      setCompareRunning(false);
      setEndedNotice(true);
      holdEndedWindow();
      toast.warning(`${COMPARISON_ENDED} ${COMPARISON_UNAVAILABLE}`);
    },
    [holdEndedWindow],
  );
  // Through a ref so an inline arrow prop cannot re-fire the effect each render.
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;

  const refresh = useCallback(async () => {
    // Numbered BEFORE the request, so the number IS the issue order. The 5s
    // poll is in flight across a lifecycle POST often enough to matter — the
    // comment on `endsMigrationWindow` below says why — and whichever order
    // the two responses land in, taking a pre-close body for "the last known
    // state" puts the whole pre-swap branch (compare section, enabled Swap)
    // back over a server that has already swapped and answers 409, with the
    // prescription on it. So such an answer is DROPPED, not merely denied the
    // confirmation (review r2/r3 of #1533).
    const seq = ++requestSeq.current;
    try {
      const s = await apiFetch<ShadowStatus>('/admin/embedding/shadow-migration');
      if (seq <= windowClosedAtSeq.current) return;
      if (seq < appliedSeq.current) return;
      appliedSeq.current = seq;
      setStatus(s);
      setEndedWindowUnconfirmed(false);
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
    // Read BEFORE the request: the ending arms NULL this ref, and the 5s poll
    // can observe the same ending inside this POST's own window. (The compare
    // section does NOT clear it on unmount — deliberately, because the unmount
    // IS the event: `EmbeddingShadowCompareSection`, "Clearing on unmount
    // would erase the very fact the card needs".)
    const endedComparison = opts.endsMigrationWindow ? compareRunInFlight.current : null;
    try {
      await apiFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      toast.success(okMessage);
      // The window is closed server-side the moment this returns 200, whether
      // or not anything was comparing — so the hold the strip's wording reads
      // is taken HERE, not inside the ending arm below (review r2 of r2).
      // Taken on the ending alone, a swap with nothing running left an
      // undismissed strip from an EARLIER migration prescribing a comparison
      // over a server whose compare route already answers 409, for as long as
      // the confirming status GET kept failing — #1533 on the sibling path,
      // against the r1 standard that the wording may not depend on that
      // request ever landing. Through the same `holdEndedWindow` the ending
      // arm uses, so this take carries the watermark that releases it: a hold
      // taken by a POST no comparison bracketed was otherwise released by the
      // very pre-swap answer it exists to outlive (review r3).
      if (opts.endsMigrationWindow) holdEndedWindow();
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
   * remedy the compare route's own 409 refuses. The open window is exactly
   * `migration !== null` and a phase that is neither `swapped` nor `aborting`;
   * `backfilling` KEEPS the id, so the section re-adopts the run when `ready`
   * returns.
   *
   * Keyed on the open window's IDENTITY, not on a boolean "is it open" (review
   * r2 of r2). A boolean makes this a transition observer that has to SEE the
   * closing answer, and `refresh()` above legitimately drops one: a status GET
   * stalled across swap → cleanup → new re-embed answers last, so the only
   * observation in which this card's window is closed is the one that is
   * dropped for staleness, and the card walks from the run's window straight
   * into the NEXT one having seen no close at all. The run's N x 2 embedding
   * calls were then lost with no notice on any surface. A window is identified
   * exactly as the re-attachment cache is (`compareCacheKey`), because that is
   * the identity the server's own fingerprint moves on: a DIFFERENT open
   * window is proof the run's window is gone, and it arrives on the body that
   * is applied rather than on the one that is dropped — so the arm no longer
   * depends on response ordering. Rescuing the dropped body instead would fire
   * this on the mirror sequence too, where the in-flight run belongs to the
   * NEWER window and a stale closed body says nothing about it.
   *
   * Both arms latch on the run id, so the local POST and this poll cannot
   * report one ending twice.
   */
  const openWindowKey =
    migration !== null && migration.phase !== 'swapped' && migration.phase !== 'aborting'
      ? `${migration.model}@${migration.startedAt}`
      : null;
  const wasOpen = useRef(false);
  useEffect(() => {
    // The dep array is the change detector: `openWindowKey` is a primitive and
    // `warnComparisonEnded` is stable, so this body runs only when the window
    // IDENTITY moved — which is why it no longer has to see a closed one.
    const inFlight = compareRunInFlight.current;
    const hadOpenWindow = wasOpen.current;
    wasOpen.current = openWindowKey !== null;
    // Only a window this card WATCHED open can have been the run's: a remount
    // in `backfilling` adopts a running run from the re-attachment cache in the
    // same commit that first learns the window (the lookup effect above is
    // declared earlier), and that is a run still going, not one that ended.
    if (!hadOpenWindow || inFlight === null) return;
    warnComparisonEnded(inFlight);
  }, [openWindowKey, warnComparisonEnded]);

  if (!migration && !pending) return null;
  if (status === null) return null; // first poll not resolved yet

  // Derived from the same `migration.phase` the branches below switch on, so
  // the second sentence cannot disagree with what is actually on screen: the
  // `ready` branch is the only one that mounts `EmbeddingShadowCompareSection`
  // and therefore the only one where a new comparison can be started (#1533).
  // `endedWindowUnconfirmed` covers the one case that phase cannot answer for
  // itself — the round trip (or the run of failing GETs) in which it is the
  // PRE-ending phase, where the section is still mounted but the route behind
  // its Run button already refuses (r1).
  const compareControlMounted = migration?.phase === 'ready' && !endedWindowUnconfirmed;
  // …and the third arm on that same phase: `backfilling` already owns the
  // availability fact, in the muted `shadow-compare-locked` note printed one
  // line above the strip ("unlocks when the backfill completes"). Repeating it
  // here said the same thing twice in a row, the second time escalated to the
  // hue ADR-010 reserves for a real consequence — so in that branch the strip
  // carries the ending alone and lets the note say what comparing is waiting
  // for (review r1). Only in the note's OTHER arm, though (review r2): when
  // the card's own server lookup finds a run holding the one-active slot, the
  // note reports THAT instead of stating availability, and the strip was then
  // the ending with no availability sentence left anywhere on the card. Same
  // flag the note itself reads, so the two cannot drift.
  const availabilityStatedByBranch = migration?.phase === 'backfilling' && !compareRunning;
  const endedRecovery = compareControlMounted
    ? COMPARISON_RESTARTABLE
    : availabilityStatedByBranch
      ? null
      : COMPARISON_UNAVAILABLE;

  // Rendered by EVERY branch below, because the branch is exactly what changes
  // underneath a comparison. Amber, not destructive: the lifecycle action the
  // admin asked for succeeded and the migration is fine — the comparison is the
  // collateral, which is what ADR-010 reserves amber for. It is dismissible so
  // it cannot stand at rest on a card the admin still has to finish using.
  // The polite region's text is derived per render, so it MUTATES in place when
  // the branch changes under an undismissed notice — a second announcement, and
  // deliberately so (review r2): what it then says is true of the branch now on
  // screen, whereas latching the sentence at warn time would keep prescribing a
  // comparison after the window closed, which is the whole of #1533.
  const endedStrip = endedNotice ? (
    <div
      role="status"
      className="mt-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs"
      data-testid="shadow-compare-ended"
    >
      <p className="flex-1">{endedRecovery ? `${COMPARISON_ENDED} ${endedRecovery}` : COMPARISON_ENDED}</p>
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
