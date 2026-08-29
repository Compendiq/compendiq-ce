import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Search, Trash2 } from 'lucide-react';
import type {
  AttachmentStorageStats,
  AttachmentStoreSweepStats,
  AttachmentSweepRun,
  AttachmentSweepStatus,
  AttachmentSweepTriggerResponse,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';

/**
 * #1349 — Settings → Spaces & Sync: attachment storage + the dry-run-first
 * orphan sweep. ImageIndexCard is the pattern of record.
 *
 * Three rules carried over from that card and from ADR-010:
 *
 *  - **A failed stats fetch is a failure, not zero bytes.** Reading `{ data }`
 *    alone would collapse a 500 into "0 B stored", which on THIS surface
 *    reads as "nothing to sweep" — the exact opposite of what an unreadable
 *    store means. Three states: pending (em-dashes), error (the destructive
 *    treatment, actions kept live — a status read failing is no reason to
 *    withhold the Dry run that would explain it), and data. The two GETs are
 *    separate requests with separate rate-limit counters and `retry: false`,
 *    so EACH one's failure stands alone (review r1: `&&`-ing them collapsed
 *    a one-sided failure into the empty state, or silently dropped a refused
 *    last run): a failed stats GET fails the figures block while a healthy
 *    last-run line stays, and vice versa. Every consumer of the figures reads
 *    ONE derived `figures` value (review r2) — guarding the counters and
 *    leaving the four walk-verdict lines on `stores &&` put four stale numbers
 *    directly under "The storage figures could not be read", because TanStack
 *    retains `data` through a failed refetch. And the ladder has FIVE states,
 *    not four: a first run that refused, failed or stood a store down leaves
 *    no stats record beside a real last run, which used to render nothing at
 *    all.
 *  - **"Candidate" is a claim about pending work**, so the last-run line and
 *    the disclosure say it only for a DRY run. After a live run the same list
 *    is what the walk FOUND — most of it destroyed, some of it (a store stood
 *    down for the mis-mount anomaly) deliberately left alone — and labelling
 *    it "candidates" under post-delete figures reporting zero orphans had the
 *    card contradicting itself on one screen (review r2).
 *  - **Everything at rest is neutral.** Storage figures, orphan candidates,
 *    the candidate list, the three walk-verdict counters (unreadable, nested,
 *    grace-deferred) and the missing-rows count are MEASUREMENTS (the
 *    QualityScoreBadge argument). Amber appears only where an operator has to
 *    look: a last run that did not complete — `failed`, or `refused` (a
 *    mis-pointed ATTACHMENTS_DIR the sweep declined to delete against) — and,
 *    since review r1, a run that COMPLETED having stood one store down for
 *    that same anomaly, which is the same fact at half the scope.
 *  - **Destroying files is the point of the live button**, so it is the
 *    filled destructive variant inside a confirm dialog that names what will
 *    be deleted and what never is — never a bare button.
 *
 * The GETs answer a persisted record and never walk the tree, so the figures
 * are as fresh as the last COMPLETED walk — a refused or failed run leaves
 * them standing (r1), which is why they carry their own `computedAt` date:
 * after a refusal the amber strip below is NEWER than the counters above it,
 * and figures with no date would borrow the strip's age. Dry run is the
 * refresh. Both actions are
 * fire-and-forget 202s and the card polls `running` (read server-side from
 * the worker lock) at 5s — at, not under, the admin rate limit's comfort
 * zone — with ImageIndexCard's warm-up window, because the lock is taken
 * after the POST answers and one early refetch would otherwise cache
 * `running: false` and never re-arm the interval.
 */

const STATS_QUERY_KEY = ['admin', 'attachment-storage-stats'] as const;
const SWEEP_QUERY_KEY = ['admin', 'attachment-sweep'] as const;

/**
 * ≥5s — the admin rate limit is 20/min per route and two routes poll.
 *
 * Exported for the test to assert the floor itself (#1523): the value is a
 * rate-limit constraint, not a preference, and a private copy of the number
 * in the test could not see it shrink.
 */
export const POLL_MS = 5_000;
/**
 * Poll floor after a kick, until the payload reports the lock.
 *
 * The trigger takes the lock inside the request now, so the ordinary case is
 * covered by the POST's own answer — but the window is not gone: with Redis
 * unreachable `isWorkerLocked` cannot report a lock at all, so `running` never
 * flips and the interval would never arm. Twenty seconds of polling is what
 * still fetches the finished record on that path.
 */
const KICK_WARMUP_MS = 20_000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** `1 file in 1 directory` / `3 files in 2 directories`. */
function countPhrase(files: number, directories: number): string {
  return `${files} file${files === 1 ? '' : 's'} in ${directories} director${directories === 1 ? 'y' : 'ies'}`;
}

function orphanSummary(stats: AttachmentStoreSweepStats): string | null {
  const parts: string[] = [];
  if (stats.orphanDirectories > 0) {
    parts.push(`${stats.orphanDirectories} orphan director${stats.orphanDirectories === 1 ? 'y' : 'ies'}`);
  }
  if (stats.orphanFiles > 0) {
    parts.push(`${stats.orphanFiles} orphan file${stats.orphanFiles === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) return null;
  const bytes = stats.orphanDirectoryBytes + stats.orphanFileBytes;
  return `${parts.join(', ')} (${formatBytes(bytes)})`;
}

/**
 * What a run that did NOT complete destroyed before it stopped — the one fact
 * a failed LIVE run carries that the verdict alone does not.
 *
 * Shared by the visible amber strip and the polite announcer (review r1) so
 * the two surfaces cannot drift: the announcer used to stop at "The sweep
 * failed: <note>." while the strip beside it said three files were already
 * gone and how to refresh the figures, i.e. the one branch where files were
 * destroyed was also the one branch the screen-reader user was told least
 * about. A live run that failed with the totals still at zero cannot be
 * vouched for either way — a recursive `rm` can unlink and then throw before
 * any total is incremented — so it claims only that nothing was RECORDED.
 */
function partialDeletionClause(run: AttachmentSweepRun): string {
  if (run.deleted && run.deleted.files + run.deleted.directories > 0) {
    const { files, directories, bytes } = run.deleted;
    return `The run stopped partway: ${files} file${files === 1 ? '' : 's'} and ${directories} director${directories === 1 ? 'y' : 'ies'} (${formatBytes(bytes)}) had already been removed — press Dry run to refresh the figures.`;
  }
  return run.deleted ? 'No deletions were recorded.' : 'No files were deleted.';
}

/**
 * One sentence for the polite announcer — see `runAnnouncement` below.
 *
 * Deliberately not the visible line's markup: what a screen-reader user needs
 * is the VERDICT of the run they just watched, not the same spans re-read.
 */
function announceRun(run: AttachmentSweepRun): string {
  const subject = run.dryRun ? 'dry run' : 'sweep';
  if (run.status !== 'completed') {
    const verb = run.status === 'refused' ? 'refused to proceed' : 'failed';
    return `The ${subject} ${verb}${run.note ? `: ${run.note}` : ''}. ${partialDeletionClause(run)}`;
  }
  const stoodDown = run.note ? ` One store was left alone: ${run.note}.` : '';
  if (run.dryRun) {
    return `Dry run finished — ${run.candidatesTotal} candidate${run.candidatesTotal === 1 ? '' : 's'}.${stoodDown}`;
  }
  if (!run.deleted) return `Sweep finished — nothing was deleted.${stoodDown}`;
  const { files, directories, bytes } = run.deleted;
  return `Sweep finished — deleted ${files} file${files === 1 ? '' : 's'} and ${directories} director${directories === 1 ? 'y' : 'ies'} (${formatBytes(bytes)}).${stoodDown}`;
}

export function AttachmentStorageCard() {
  const qc = useQueryClient();
  const [kickedAt, setKickedAt] = useState<number | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const pollWhile = (running: boolean | undefined) => {
    if (running) return POLL_MS;
    if (kickedAt !== null && Date.now() - kickedAt < KICK_WARMUP_MS) return POLL_MS;
    return false;
  };

  const stats = useQuery<AttachmentStorageStats>({
    queryKey: STATS_QUERY_KEY,
    queryFn: () => apiFetch<AttachmentStorageStats>('/admin/attachments/stats'),
    retry: false,
    refetchInterval: (q) => pollWhile(q.state.data?.running),
  });

  const sweep = useQuery<AttachmentSweepStatus>({
    queryKey: SWEEP_QUERY_KEY,
    queryFn: () => apiFetch<AttachmentSweepStatus>('/admin/attachments/sweep'),
    retry: false,
    refetchInterval: (q) => pollWhile(q.state.data?.running),
  });

  /**
   * The card's ONE polite announcer (review r2).
   *
   * It is rendered unconditionally and starts EMPTY, because a live region
   * that is INSERTED into the DOM carrying text is announced on insertion:
   * with `role="status"` on the conditionally-rendered last-run line, opening
   * Settings → Spaces & Sync read out "Last dry run 3 days ago · 3 candidates"
   * for a run the user did not start and nothing that had just happened — on
   * every visit, and on the two amber strips too.
   *
   * `watchedFrom` is what makes it a report on THIS session's run rather than
   * on the record: `undefined` means nothing is being watched, and it is armed
   * only when the operator kicks a run or a payload reports one already in
   * flight. It holds the `at` of the run on screen when the watch began, so
   * the refetch that lands the SAME record announces nothing and only a new
   * run's verdict is read. Nothing is lost by the narrowing: the queries do
   * not poll at all unless kicked or a lock is reported, so a run this card
   * did not watch is one it could not have announced anyway.
   *
   * It is published in TWO commits (fixer r1). An `aria-live` region whose
   * text does not CHANGE is not re-announced, and React bails out of a
   * `useState` write that is `Object.is`-equal to the current value — so an
   * operator who pressed Dry run twice and got the same verdict ("Dry run
   * finished — 3 candidates.") heard it once: the second run, on the one
   * surface built for the user this announcer exists for, completed in
   * silence. `pendingAnnouncement` is a fresh OBJECT per run, so no write on
   * this path can bail; the effect below empties the region and refills it on
   * the next tick, which is a real mutation whatever the sentence says.
   */
  const [runAnnouncement, setRunAnnouncement] = useState('');
  const [pendingAnnouncement, setPendingAnnouncement] = useState<{ at: string; text: string } | null>(
    null,
  );
  const watchedFrom = useRef<string | null | undefined>(undefined);

  const trigger = useMutation({
    mutationFn: (dryRun: boolean) =>
      apiFetch<AttachmentSweepTriggerResponse>('/admin/attachments/sweep', {
        method: 'POST',
        body: JSON.stringify({ dryRun }),
      }),
    onSuccess: (result, dryRun) => {
      if (result.alreadyRunning) {
        // Neither success nor failure: the press was a no-op against a sweep
        // that already holds the lock (ImageIndexCard's neutral precedent).
        //
        // The copy names the REMEDY, not an outcome (fixer r1). The lock is
        // taken `failClosed`, so the server answers `alreadyRunning` for two
        // different facts — a sweep really is running, and Redis could not be
        // reached to find out — and on the second no run exists, nothing will
        // "appear here when it finishes", and the card's warm-up poll expires
        // after 20 s leaving a promise the server never made. One sentence
        // true on both branches, and the same remedy applies to both.
        toast.message('A sweep already holds the lock — its results appear here, or press again if nothing does.');
      } else {
        toast.success(
          dryRun
            ? 'Dry run started — figures update here when the walk finishes.'
            : 'Deleting orphans — the run re-checks every candidate before removing it.',
        );
      }
      // Arm the announcer for the run this press started (or joined), from the
      // record on screen right now — see `watchedFrom`. A kick with Redis
      // unreachable never reports `running`, so waiting for the flag would
      // leave that path silent. Read from the cache rather than the render's
      // `lastRun`, which is derived further down.
      if (watchedFrom.current === undefined) {
        watchedFrom.current = qc.getQueryData<AttachmentSweepStatus>(SWEEP_QUERY_KEY)?.lastRun?.at ?? null;
      }
      setKickedAt(Date.now());
      void qc.invalidateQueries({ queryKey: STATS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: SWEEP_QUERY_KEY });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const isPending = stats.isPending || sweep.isPending;
  // Each GET's failure stands alone — see the header comment (review r1).
  const statsError = stats.isError;
  const sweepError = sweep.isError;
  // …but when BOTH are down, two paragraphs both saying "could not be read"
  // is one fact told twice (fixer, external round). The admin routes share a
  // backend, so the pair failing together is the ORDINARY outage shape, not an
  // edge case. One sentence, on the stats paragraph, and the sweep one stands
  // down — it exists to say a refused run would not show, which is already
  // implied when nothing at all could be read.
  const bothQueriesFailed = statsError && sweepError;
  /**
   * …and the same guard for the RUNNING flag (fixer r1) — the third consumer
   * of the same half-fix pattern `figures` and `lastRun` already closed.
   *
   * TanStack retains `data` through a failed REFETCH, so an outage that begins
   * while a sweep is in flight — the ordinary shape, since both admin GETs
   * share a backend — left this reading `running: true` off two payloads the
   * card could no longer observe. It feeds `aria-busy`, the "Sweeping…" chip
   * and `actionsDisabled`, so the card simultaneously asserted a sweep as fact
   * and DISABLED Dry run, the remedy its own error copy names one line above:
   * no reachable affordance at all until the backend came back.
   *
   * A record read through a failed GET claims nothing. Polling is unaffected —
   * `pollWhile` reads the query's own retained data, so the card keeps asking
   * and heals itself the moment either route answers again.
   */
  const running =
    (!statsError && (stats.data?.running ?? false)) || (!sweepError && (sweep.data?.running ?? false));
  /**
   * The RAW last-run record — the announcer's input, and nothing else's.
   *
   * The watch below compares `at` against the run it started watching, so it
   * must see the record TanStack is actually holding: blanking it on a failed
   * read would rearm `watchedFrom` from `null` and then announce the
   * unchanged, days-old run as this session's verdict the moment the GET
   * recovered. Nothing is lost by keeping it raw — a retained record cannot
   * change while its GET is failing, so this path announces nothing until the
   * poll succeeds again.
   */
  const lastRunRecord = sweep.data?.lastRun ?? null;
  const stores = stats.data?.stores ?? null;
  /**
   * ONE derived value that every figure consumer reads (review r2).
   *
   * The counters block honoured `!statsError` because it sits inside the
   * ladder below, and the missing-rows line spelled the guard out — but the
   * four walk-verdict lines were gated on `stores &&` alone. TanStack retains
   * `data` through a failed REFETCH, which is the ordinary poll-failure shape
   * on a card that polls two admin routes every 5s while a sweep runs, so
   * "The storage figures could not be read" rendered directly above four
   * figures derived from that same record — one of them reading "…the figures
   * above cover only what the walk could see" with no figures above it.
   * Guarding five of six consumers is the half-fix pattern this card's own
   * comments keep naming.
   */
  const figures = !isPending && !statsError ? stores : null;
  /**
   * …and the same guard for the OTHER record (external round 2).
   *
   * `figures` was derived because five of six consumers honoured `!statsError`
   * and one did not; `lastRun` was the same half-fix one field over — it fed
   * four surfaces (the last-run line, the candidate disclosure, the stood-down
   * note, the did-not-complete strip) on `sweep.data` alone. With both admin
   * GETs failing — the ORDINARY outage shape, since they share a backend — the
   * card printed "The storage record could not be read" and, directly beneath
   * it, "Last dry run 6m ago · 3 candidates" with a working disclosure naming
   * the files. Every last-run consumer now reads this one value.
   */
  const lastRun = !sweepError ? lastRunRecord : null;
  // "No run yet" is a claim BOTH records support — a failed read of either
  // one must never be reported as an empty history.
  const noRunYet = !isPending && !statsError && !sweepError && stores === null && lastRun === null;

  // The watch itself — see `runAnnouncement` above for what it is for.
  useEffect(() => {
    if (running) {
      if (watchedFrom.current === undefined) watchedFrom.current = lastRunRecord?.at ?? null;
      return;
    }
    if (watchedFrom.current === undefined) return;
    if (!lastRunRecord || lastRunRecord.at === watchedFrom.current) return;
    watchedFrom.current = undefined;
    setPendingAnnouncement({ at: lastRunRecord.at, text: announceRun(lastRunRecord) });
  }, [running, lastRunRecord]);

  // Publish it: empty the region in this commit, refill it in the next tick —
  // see `pendingAnnouncement`. Writing the sentence straight in is a no-op
  // whenever two consecutive runs read the same, which is the ordinary shape
  // of pressing Dry run twice on a store that did not change.
  useEffect(() => {
    if (!pendingAnnouncement) return;
    setRunAnnouncement('');
    const id = setTimeout(() => setRunAnnouncement(pendingAnnouncement.text), 0);
    return () => clearTimeout(id);
  }, [pendingAnnouncement]);
  // The actions stay live on a failed READ — Dry run is the remedy that
  // refreshes the very record the failed GET could not deliver. Only the
  // pending paint (nothing known yet) and a running sweep disable them.
  const actionsDisabled = isPending || running || trigger.isPending;

  return (
    <div
      className="nm-card space-y-3 p-3 text-sm"
      data-testid="attachment-storage-card"
      // A destructive run's OUTCOME lands here silently (review r2): the kick
      // toast promises "figures update here when the walk finishes" and the
      // poll then swaps the running chip for the verdict. `aria-busy` marks
      // the region as changing; the last-run line carries the polite
      // announcement.
      aria-busy={running}
    >
      {/*
        No heading of its own (fixer, external round): the section this card
        sits in already carries `Attachment Storage` as its h2, and an h3
        restating it one line below is the same label twice at two casings.
        The running chip keeps the row.
      */}
      {/*
        Always in the DOM, empty until this card has WATCHED a run finish —
        see `runAnnouncement`. A live region inserted with its text already in
        it is announced on insertion, which is how the conditionally-rendered
        strips below read out a days-old run on every visit to this tab.
      */}
      <p className="sr-only" role="status" data-testid="attachment-sweep-announcement">
        {runAnnouncement}
      </p>

      {running && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            data-testid="attachment-sweep-running"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            Sweeping…
          </span>
        </div>
      )}

      {statsError ? (
        <p className="text-destructive text-xs" data-testid="attachment-storage-error">
          {bothQueriesFailed
            ? 'The storage record could not be read. The files on disk are unaffected — retry, or run a dry run to rebuild it.'
            : 'The storage figures could not be read. The files on disk are unaffected — retry, or run a dry run to rebuild the record.'}
        </p>
      ) : isPending ? (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-pending">
          Reading storage record…
        </p>
      ) : noRunYet ? (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-empty">
          No sweep has run yet — press Dry run to measure both stores and list orphan candidates
          without touching any files.
        </p>
      ) : figures ? (
        <>
        <dl
          className="text-muted-foreground grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2"
          data-testid="attachment-storage-counters"
        >
          <div className="space-y-0.5">
            <dt className="text-foreground font-medium">Confluence cache</dt>
            <dd data-testid="attachment-storage-confluence-bytes">
              <span className="text-foreground font-mono">{formatBytes(figures.confluence.bytes)}</span>{' '}
              · {countPhrase(figures.confluence.files, figures.confluence.directories)}
            </dd>
            {orphanSummary(figures.confluence) && (
              <dd data-testid="attachment-storage-confluence-orphans">
                Candidates: {orphanSummary(figures.confluence)}
              </dd>
            )}
          </div>
          <div className="space-y-0.5">
            <dt className="text-foreground font-medium">Local store</dt>
            <dd data-testid="attachment-storage-local-bytes">
              <span className="text-foreground font-mono">{formatBytes(figures.local.bytes)}</span>{' '}
              · {countPhrase(figures.local.files, figures.local.directories)}
            </dd>
            {orphanSummary(figures.local) && (
              <dd data-testid="attachment-storage-local-orphans">
                Candidates: {orphanSummary(figures.local)}
              </dd>
            )}
          </div>
        </dl>
        {/*
          The figures' own age (review r1): the backend keeps the last
          COMPLETED walk's record through a refused/failed run, so after one
          these counters can be days older than the amber strip below them —
          `computedAt` is shipped for exactly this. Muted, not amber: a date
          on a measurement, not a state.
        */}
        {stats.data?.computedAt && (
          <p className="text-muted-foreground text-xs" data-testid="attachment-storage-measured-at">
            Measured {formatRelativeTime(stats.data.computedAt)} — the figures update when a run
            completes.
          </p>
        )}
        </>
      ) : (
        /*
          The ladder's FIFTH state (review r2), which used to render `null`.
          `attachment_storage_stats` is written only by a CLEAN completed walk,
          while the last-run record is written by every run — so a first sweep
          that refuses (the mis-pointed ATTACHMENTS_DIR this feature's refusal
          exists for), fails, or stands one store down leaves `stores: null`
          beside a non-null `lastRun`, `noRunYet` false (it needs both records
          empty) and therefore NO figure state at all: no counters, no pending,
          no error, no empty line. The storage block went silently blank on
          exactly the operator path the card was written for.

          It states the absence rather than falling back to `lastRun.stores`:
          the backend withholds those figures from the reference record on
          purpose — they are the zeroed walk of a store it had just declined to
          trust — and rendering them here would defeat that decision one layer
          up. The remedy is the same one the empty state offers, minus its
          "no sweep has run" claim, which would be false here.

          And it drops its OWN claim when the last-run GET is the thing that
          failed (fixer, verification round). The two GETs fail independently
          by decision (review r1), so `sweepError` beside a readable stats
          record reporting `stores: null` is a reachable state — and there this
          line's "the last run produced no figures" sat directly above
          `attachment-sweep-status-error`'s "The last-run record could not be
          read", one paragraph asserting as fact what the next says is unknown.
          That is the card's own "a failure is reported, never inferred" rule
          turned on its head. The MISSING measurement is certain either way;
          what produced it is not, so only the certain half is stated.
        */
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-unmeasured">
          {sweepError
            ? 'No completed measurement is on record. Press Dry run to measure both stores.'
            : 'No completed measurement yet — the last run produced no figures. Press Dry run to measure both stores.'}
        </p>
      )}

      {/*
        Review r2: an unjudged directory is REPORTED instead of judged
        (decision (e)) — without this line a partial walk shows the same
        clean figures as a complete one. Muted, not amber: a fact about the
        last run that qualifies the figures above, not a state.
      */}
      {figures &&
        figures.confluence.unreadableDirectories + figures.local.unreadableDirectories > 0 && (
          <p className="text-muted-foreground text-xs" data-testid="attachment-storage-unreadable">
            {figures.confluence.unreadableDirectories + figures.local.unreadableDirectories === 1
              ? '1 directory could not be read and was not judged'
              : `${figures.confluence.unreadableDirectories + figures.local.unreadableDirectories} directories could not be read and were not judged`}{' '}
            — the figures above cover only what the walk could see.
          </p>
        )}

      {/*
        Review r1: the third walk verdict. An attachment key directory is flat
        by construction, so one holding anything but plain files is something
        else wearing a key-shaped name and is never judged — the walk counts
        plain files only, which would make the safety checks vacuous and the
        whole thing a 0 B recursive delete. Muted, like its two siblings: a
        fact about the walk, and the conservative verdict is the correct one.

        The copy says "sub-folders or links", not "sub-folders" (verification
        round): the backend counter now also covers symlinks and other
        non-file entries, which are unmeasured for exactly the same reason,
        and a line naming only sub-folders would send an operator looking for
        a directory that is not there.
      */}
      {figures && figures.confluence.nestedDirectories + figures.local.nestedDirectories > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-nested">
          {figures.confluence.nestedDirectories + figures.local.nestedDirectories === 1
            ? '1 pageless directory holds sub-folders or links and was not judged'
            : `${figures.confluence.nestedDirectories + figures.local.nestedDirectories} pageless directories hold sub-folders or links and were not judged`}{' '}
          — attachment directories are flat, so the sweep never removes contents it cannot measure.
        </p>
      )}

      {/*
        Review r1: the THIRD counter the walk records and the only one no
        surface rendered. A store whose entire orphan population is inside the
        24-hour grace window reported "0 candidates" — indistinguishable from a
        store with nothing to clean, and that is exactly the state an admin
        lands in right after the bulk page delete that sends them here.
        Rendering two of three verdicts and dropping the third is the half-fix
        pattern; muted, and suppressed at 0, like its siblings.
      */}
      {figures && figures.confluence.graceSkipped + figures.local.graceSkipped > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-grace">
          {figures.confluence.graceSkipped + figures.local.graceSkipped === 1
            ? '1 file or directory is orphaned but younger than 24 hours'
            : `${figures.confluence.graceSkipped + figures.local.graceSkipped} files or directories are orphaned but younger than 24 hours`}{' '}
          — they become candidates once they age out.
        </p>
      )}

      {/*
        Fixer, external round: `keepProtectedDirectories` was counted, shipped
        on the wire and promised by the service comment, but no surface
        rendered it — so a pageless directory pinned forever by one colliding
        common filename (`image.png` in a template) looked like a directory the
        sweep simply had not got to, and pressing Delete orphans again changed
        nothing. Muted, not amber: it is a fact about the last walk, and the
        conservative verdict is the correct one.
      */}
      {figures &&
        figures.confluence.keepProtectedDirectories + figures.local.keepProtectedDirectories > 0 && (
          <p className="text-muted-foreground text-xs" data-testid="attachment-storage-keep-protected">
            {figures.confluence.keepProtectedDirectories + figures.local.keepProtectedDirectories === 1
              ? '1 pageless directory was left standing because a file inside it is still referenced'
              : `${figures.confluence.keepProtectedDirectories + figures.local.keepProtectedDirectories} pageless directories were left standing because a file inside each is still referenced`}{' '}
            — a referenced filename is kept everywhere, so the directory around it is never removed.
          </p>
        )}

      {/*
        Fixer r1: the FOURTH declined verdict. A store-root directory whose
        name is not a usable attachment key (`tmp.12345/`, `12345 (copy)/`) is
        dropped before the walk opens it, so its bytes reach none of the
        figures above and none of the three lines above this one — a silently
        declined class on a card whose contract is that a partial walk cannot
        show the same clean figures as a complete one. Muted, like its
        siblings: skipping is the correct verdict, and this only says so.
      */}
      {figures && figures.confluence.unkeyedDirectories + figures.local.unkeyedDirectories > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-unkeyed">
          {figures.confluence.unkeyedDirectories + figures.local.unkeyedDirectories === 1
            ? '1 directory does not look like an attachment key and was not measured'
            : `${figures.confluence.unkeyedDirectories + figures.local.unkeyedDirectories} directories do not look like attachment keys and were not measured`}{' '}
          — the sweep never opens or removes them, and their bytes are not in the figures above.
        </p>
      )}

      {figures !== null && (stats.data?.missingLocalFiles ?? 0) > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="attachment-storage-missing-rows">
          {stats.data!.missingLocalFiles} local attachment record
          {stats.data!.missingLocalFiles === 1 ? ' points' : 's point'} at a file that is not on
          disk — counted, never deleted, in case the attachments directory is mis-mounted.
        </p>
      )}

      {/*
        A destructive run's OUTCOME reaches assistive tech through the card's
        one polite announcer at the top, NOT from a `role="status"` here
        (review r2, revising r2's own first cut): this line is conditionally
        rendered, so marking it live announced the historical record the
        instant the GET resolved — a screen-reader user opening this tab was
        read "Last dry run 3 days ago" for a run they did not start.

        "candidate" is a claim about PENDING work, so it is made only for a dry
        run. After a live run these are what the walk FOUND — most of them
        destroyed, and (when a store stood down for the mis-mount anomaly)
        some deliberately left alone. Calling them candidates under
        post-delete figures reporting zero orphans is one card contradicting
        itself, and the operator's reading is "it did nothing, press Delete
        again" — the exact failure the post-delete figures were added to stop.
      */}
      {lastRun && lastRun.status === 'completed' && (
        <p className="text-muted-foreground text-xs" data-testid="attachment-sweep-last-run">
          Last {lastRun.dryRun ? 'dry run' : 'sweep'} {formatRelativeTime(lastRun.at)} ·{' '}
          <span className="text-foreground font-mono">{lastRun.candidatesTotal}</span>{' '}
          {lastRun.dryRun ? `candidate${lastRun.candidatesTotal === 1 ? '' : 's'}` : 'found'}
          {lastRun.deleted && (
            <>
              {' '}
              · deleted <span className="text-foreground font-mono">{lastRun.deleted.files}</span>{' '}
              file{lastRun.deleted.files === 1 ? '' : 's'} and{' '}
              <span className="text-foreground font-mono">{lastRun.deleted.directories}</span>{' '}
              director{lastRun.deleted.directories === 1 ? 'y' : 'ies'} (
              {formatBytes(lastRun.deleted.bytes)})
              {lastRun.deleted.imageEmbeddingRows > 0 &&
                `, pruned ${lastRun.deleted.imageEmbeddingRows} image-index row${lastRun.deleted.imageEmbeddingRows === 1 ? '' : 's'}`}
            </>
          )}
        </p>
      )}

      {/*
        Review r1: dry-run-first is the safety premise of this whole feature
        and the thing the confirm dialog instructs the operator to do — but
        the candidate LIST was populated, persisted, served and rendered
        nowhere, so "review the dry run" meant a number, and the only way to
        see WHICH files a destructive run would remove was to curl an
        authenticated admin route.

        A disclosure rather than an always-open list: on a healthy instance it
        is empty and this is a card in a settings panel, not a file browser.
        The scroller is load-bearing — a 100-row sample would otherwise push
        Dry run and Delete orphans off screen. Neutral throughout: this is a
        measurement, and the destructive act has its own confirm.
      */}
      {lastRun && lastRun.candidateSample.length > 0 && (
        <details className="text-xs" data-testid="attachment-sweep-candidates">
          {/*
            `index.css` has no universal `:focus-visible` rule outside
            `.prose`, so without an explicit recipe the card's only
            keyboard-reachable disclosure — the one that opens the destructive
            review list — falls back to the UA outline.

            `nm-focus-ring`, not the sibling settings-disclosures'
            `focus-visible:ring-2` (external round 2, measured). A Tailwind
            ring compiles to a BOX-SHADOW (`--tw-ring-shadow` → `box-shadow`,
            confirmed against this repo's own compiled output) and
            `focus-visible:outline-none` suppresses the UA fallback beside it —
            so under `forced-colors: active`, which discards box-shadow,
            these two controls had NO focus indicator at all while the two
            buttons below kept theirs. `nm-focus-ring` is index.css's
            hand-authored standalone mechanic and a real `outline`, which
            forced-colors recolours rather than strips (the `transparent`
            resting value is preserved, the same trick `nm-button-ghost`
            below relies on).
          */}
          <summary className="nm-focus-ring text-muted-foreground hover:text-foreground cursor-pointer rounded select-none">
            {lastRun.dryRun ? (
              <>
                Show the {lastRun.candidateSample.length} candidate
                {lastRun.candidateSample.length === 1 ? '' : 's'}
                {lastRun.candidatesTotal > lastRun.candidateSample.length &&
                  ` of ${lastRun.candidatesTotal}`}
              </>
            ) : (
              <>
                Show what the sweep found ({lastRun.candidateSample.length}
                {lastRun.candidatesTotal > lastRun.candidateSample.length &&
                  ` of ${lastRun.candidatesTotal}`}
                )
              </>
            )}
          </summary>
          {/*
            The scroller is a TAB STOP with a name (review r1, WCAG 2.1.1 /
            axe `scrollable-region-focusable`). `max-h-56` shows about ten of
            up to `CANDIDATE_SAMPLE_MAX` = 100 rows, every descendant is a
            `<span>`, and Chromium and WebKit do not make a scroll container
            focusable on their own — so a keyboard user reached the
            `<summary>`, opened the list, and had no way to scroll it: arrow
            keys moved the page instead. That is the one in-product path to
            WHICH files a live run destroys, which the confirm dialog tells
            the operator to read first. The implicit `list` role is kept (a
            screen reader announcing "list, 100 items" is the useful part) and
            named, because a focusable region with no name announces nothing.
            The focus indicator is the `<summary>`'s recipe two lines up —
            `nm-focus-ring`, a real outline, for the forced-colors reason
            spelled out there.

            Its NAME follows the same dry-run rule as the summary above it
            (fixer r1). The r2 ruling — "candidate" is a claim about pending
            work, so say it only for a dry run — was applied to the visible
            copy and not to the accessible name, so after a live run a screen
            reader still announced the region as "Orphan candidates": exactly
            the wording this card decided was a lie, surviving where the
            pinned test could not see it (`textContent` never contains an
            attribute value).
          */}
          <ul
            tabIndex={0}
            aria-label={lastRun.dryRun ? 'Orphan candidates' : 'What the sweep found'}
            className="nm-focus-ring border-border mt-2 max-h-56 space-y-1 overflow-y-auto rounded-md border p-2"
            data-testid="attachment-sweep-candidate-list"
          >
            {lastRun.candidateSample.map((c) => (
              <li
                key={`${c.store}:${c.key}:${c.filename ?? ''}`}
                className="text-muted-foreground flex flex-wrap items-baseline gap-x-2"
              >
                <span className="text-foreground font-mono break-all">
                  {c.store === 'local' ? 'local/' : ''}
                  {c.key}
                  {c.filename === null ? '/' : `/${c.filename}`}
                </span>
                <span>
                  {c.reason === 'orphan_directory' ? 'whole directory' : 'single file'} ·{' '}
                  {formatBytes(c.bytes)}
                </span>
              </li>
            ))}
          </ul>
          {lastRun.candidatesTotal > lastRun.candidateSample.length && (
            <p className="text-muted-foreground mt-1">
              Showing the first {lastRun.candidateSample.length} of {lastRun.candidatesTotal}.
            </p>
          )}
        </details>
      )}

      {/*
        A completed run can still carry a note (review r1): when exactly ONE
        store is empty on disk while the database references it, that store
        stands down and the sound one is swept — the run completed, but a
        store was skipped for a reason that usually means a mis-mounted
        ATTACHMENTS_DIR. Amber, because it needs an operator to look; the
        sibling strip below covers runs that did not complete at all.
      */}
      {lastRun && lastRun.status === 'completed' && lastRun.note && (
        <p
          className="text-warning inline-flex items-start gap-1.5 text-xs"
          data-testid="attachment-sweep-partial-note"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            One store was left alone: {lastRun.note}. The other store was swept normally.
          </span>
        </p>
      )}

      {/*
        Amber is spent on the strips around this one: a run that did not
        complete needs an operator to look — an unreadable root, or a store
        empty while the database references it (the mis-mount refusal). None of
        them is a live region of its own, because all three are conditionally
        rendered and a live region inserted WITH its text is announced on
        insertion: the verdict of a run this card watched is announced once,
        politely, by the announcer at the top, and a days-old failure is not
        re-read on every visit to the tab (review r2). This paragraph itself is
        the failed-READ case, and stays the destructive treatment.
      */}
      {!isPending && sweepError && !bothQueriesFailed && (
        <p className="text-destructive text-xs" data-testid="attachment-sweep-status-error">
          The last-run record could not be read — a refused or failed sweep would not show here.
          Retry, or run a dry run to rewrite it.
        </p>
      )}

      {/*
        "No files were deleted." is a claim, so it is made only where it is
        true by construction: a refusal runs before the delete phase, a dry
        run never deletes, and `deleted: null` means the delete phase never
        started (the invariant runAttachmentSweep keeps). A failed live run
        that DID record deletions says so with the counts (review r1). A
        failed live run whose delete phase STARTED but recorded zero is the
        one case the record cannot vouch for — a recursive rm can unlink
        files and then throw, before any total is incremented — so it claims
        only "no deletions were recorded" (review r2). The clause itself lives
        in `partialDeletionClause`, shared with the announcer (review r1).
      */}
      {lastRun && lastRun.status !== 'completed' && (
        <p
          className="text-warning inline-flex items-start gap-1.5 text-xs"
          data-testid="attachment-sweep-last-run-problem"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            The last {lastRun.dryRun ? 'dry run' : 'sweep'} {formatRelativeTime(lastRun.at)}{' '}
            {lastRun.status === 'refused' ? 'refused to proceed' : 'failed'}
            {lastRun.note ? `: ${lastRun.note}` : ''}.{' '}
            {partialDeletionClause(lastRun)}
          </span>
        </p>
      )}

      {/*
        Both controls take their box from a `nm-button-*` recipe, so the row
        cannot drift apart (review r2). The hand-rolled version measured 14px/400
        beside Dry run's 13px/500 and — because `@utility nm-action-destructive`
        declares colour, hover and focus only — carried an explicitly
        TRANSPARENT border beside Dry run's `--color-border-interactive` one.
        `transparent` is not forced, so under `forced-colors: active` both the
        colour and the hover fill are overridden and the destructive control
        reads as body text while its neutral sibling keeps its outline: the
        failure ADR-010's "every operable surface keeps a 1px solid border"
        rule exists to prevent.

        `nm-button-destructive` is the filled variant for a surface where
        deleting is the point — the lane brief specified it and the confirm
        dialog is the second step. `nm-action-destructive` stays correct for a
        destructive row INSIDE a bordered container (its three pinned
        callsites); this is a peer button beside a bordered one.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="attachment-sweep-dry-run"
          className="nm-button-ghost"
          disabled={actionsDisabled}
          onClick={() => trigger.mutate(true)}
          aria-describedby="attachment-sweep-note"
        >
          <Search size={14} aria-hidden="true" />
          Dry run
        </button>
        <button
          type="button"
          data-testid="attachment-sweep-delete"
          className="nm-button-destructive"
          disabled={actionsDisabled}
          onClick={() => setConfirmDeleteOpen(true)}
          aria-describedby="attachment-sweep-note"
        >
          <Trash2 size={14} aria-hidden="true" />
          Delete orphans
        </button>
      </div>

      {/*
        The one sentence that names what Delete orphans does and what it costs,
        wired to both controls with `aria-describedby` (the DeepSearchToggle
        rule: a caveat lives on screen at rest, not in a `title`). Its second
        half is the one an operator would otherwise get wrong: "no page
        references it" reads as "nothing on a live page", and the sweep really
        does remove a cached image sitting under a live Confluence page that no
        body embeds (review r1). Pinned by `AttachmentStorageCard.test.tsx`, or
        deleting the paragraph outright left every cell green while both
        buttons kept pointing `aria-describedby` at a dead id.
      */}
      <p id="attachment-sweep-note" className="text-muted-foreground text-xs" data-testid="attachment-sweep-note">
        Dry run walks both stores and lists candidates without touching disk. Delete orphans removes
        only files no page, draft, version, template, comment or saved AI answer references, older
        than 24 hours, re-checked at delete time; matching image-index rows are pruned with them. A
        cached Confluence image that no page body embeds counts as unreferenced and is removed —
        Confluence re-serves it the next time it is viewed.
      </p>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title="Delete orphaned attachment files?"
        description="This permanently removes files that no page, draft, retained version, pending sync version, template, comment or saved AI answer references and that are older than 24 hours. Every candidate is re-checked at delete time, matching image-index rows are pruned, and affected pages are re-queued for image indexing. Files referenced anywhere are never touched. Cached Confluence images that no page body embeds are removed too — they are re-fetched from Confluence the next time they are viewed. Uploaded page icons are a separate store and are never swept. This cannot be undone — run a dry run first if you have not."
        confirmLabel="Delete orphans"
        destructive
        onConfirm={() => {
          setConfirmDeleteOpen(false);
          trigger.mutate(false);
        }}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
