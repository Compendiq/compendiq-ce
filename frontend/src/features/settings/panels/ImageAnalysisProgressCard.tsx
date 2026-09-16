import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Play, RefreshCw, RotateCcw } from 'lucide-react';
import type { ImageAnalysisActionResult, ImageAnalysisStatus } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { reanalyzeAllDisclosure } from './image-analysis-copy';
import { useNoticeRetry } from './use-notice-retry';
import { COVERAGE_SENTENCE, imageAnalysisCoverage } from './image-analysis-coverage';

/**
 * #1618 (ADR-027 Stage 1) — Settings → AI Models → Embeddings: *is the image
 * analysis running?*
 *
 * The other half of the job lives on **LLM providers**, where #1615 put the
 * selector, the capability chip, Re-check and the Max output tokens row
 * (ADR-027 `:4843-4860` forbids moving that ceiling here). Two surfaces, one
 * question each: *can it run?* there, *is it running?* here. Every sentence
 * that sends an operator to the other one names the FULL panel chain, because
 * a bare tab name is unfollowable from a panel that has no such tab and
 * `settings-wayfinding.test.ts` can only police the spelled-out rail.
 *
 * **Three fetch states, never one.** The legacy leg shipped this card's
 * ancestor reading `{ data }` alone, which collapsed the pre-fetch paint and
 * a 500 into "not assigned": an admin whose analysis was running fine was
 * told to go and assign it, and the three remedies were withheld on the one
 * surface that reports them. So pending renders em-dashes rather than a
 * claim; a failed read says the status could not be READ, states that the
 * assignment and the stored analyses are untouched, offers a retry that keeps
 * its own focus, and LEAVES THE ACTIONS LIVE.
 *
 * **Unassigned is a pause, not a purge** (ADR-027 D7). Descriptions already
 * stored and still valid stay searchable, images that changed stay pending,
 * and authored text RAG never depended on this at all. The card says so at
 * rest, not in a tooltip, and renders it neutral: a paused instance is a
 * configuration, not an incident.
 *
 * **Two facts that look like one and are not** (epic AC 4): a corpus that is
 * PARTIALLY analyzed still owes vision calls, while one that is analyzed with
 * pages `embedding_dirty` owes only a text re-embed and resolves itself with
 * no vision call at all. They are reported on separate lines with separate
 * words.
 *
 * **Colour follows ADR-010.** Every count is a MEASUREMENT and renders
 * neutral. Four exceptions, each of them work an operator has to do: failed
 * images, a run whose pages could not be written, an identity that does not
 * match the assignment (D13's third gate — the only other symptom is a
 * backlog that never drains), and a provider-side stop. A failed status READ
 * is none of those: it is a failure, so it takes the destructive treatment
 * rather than amber.
 */

const STATUS_QUERY_KEY = ['admin', 'image-analysis'] as const;

/**
 * The panel chain every remedy on this card points at, spelled out once.
 *
 * One constant rather than three inline copies, and on ONE source line,
 * because `settings-wayfinding.test.ts` scans line by line: a chain broken
 * over a JSX line wrap loses every hop past the break, and the fragment left
 * behind names no live panel. The Image analysis ROW is named in prose beside
 * the chain, never as a third hop — the settings IA is two levels deep
 * (panel, then sub-tab) and that guard enforces it.
 */
const LLM_PROVIDERS_CHAIN = 'Settings → AI Models → LLM providers';

/**
 * How often the card re-reads while a batch holds the worker lease.
 *
 * 5s matches `ImageIndexCard`, `EmbeddingShadowMigrationCard` and
 * `ActiveEmbeddingLocksBanner`, and stays under the default 20/min per-route
 * admin rate limit — 3s sits exactly at it, before the mount fetch and before
 * the invalidate each press fires, and with `retry: false` a 429 leaves the
 * last payload cached with `running: true`, which freezes the card on stale
 * counters with every action held and nothing shown.
 */
const POLL_MS = 5_000;

/**
 * How long the card keeps polling after a kick, whatever the payload says.
 *
 * `running` is read server-side from the worker LOCK, and the POST answers
 * before the detached batch has taken it. A single post-kick refetch served
 * inside that window caches `running: false`, the interval never arms, and
 * nothing re-arms it — leaving the counters frozen while the batch is in fact
 * working. The window self-cancels the moment a payload reports the lock, so
 * this is a floor on polling rather than a second timer.
 */
const KICK_WARMUP_MS = 20_000;

/**
 * Skip reasons, spelled for a human and typed on the contract's own key set,
 * so a seventh reason added server-side fails the build here rather than
 * rendering as its camelCase field name on the surface that exists to explain
 * the number.
 */
const SKIP_LABEL: Record<keyof ImageAnalysisStatus['skipReasons'], string> = {
  missing: 'missing from the store',
  unsupported: 'unsupported format',
  oversized: 'above the pixel bound',
  tooLarge: 'too large',
  external: 'external URL',
  capped: 'past the per-page cap',
};

/**
 * What a stop MEANS, one sentence per reason, and whether it is the
 * operator's to act on.
 *
 * `unassigned` is the pause (D7) and stays neutral. `lease_lost` is another
 * replica taking the lease over — transient, self-healing, and never actually
 * recorded (the new holder owns the last-run row), so it is neutral too. The
 * other four are amber: each names something outside this card that has to
 * change before the next batch does any work.
 */
const STOP_REASON: Record<
  NonNullable<NonNullable<ImageAnalysisStatus['lastRun']>['reason']>,
  { attention: boolean; sentence: (httpStatus?: number) => string }
> = {
  unassigned: {
    attention: false,
    sentence: () =>
      'Paused: no vision model is assigned, so nothing new was analyzed. The sweep and the reconcile still ran.',
  },
  capability: {
    attention: true,
    sentence: () =>
      `Stopped: the assigned model did not confirm image input. Press Re-check on the Image analysis row under ${LLM_PROVIDERS_CHAIN}.`,
  },
  identity_drift: {
    attention: true,
    sentence: () =>
      `Stopped: the assigned model or endpoint is not the one the stored analyses were written for. Save the assignment or press Re-check under ${LLM_PROVIDERS_CHAIN} to adopt it.`,
  },
  provider_status: {
    attention: true,
    sentence: (httpStatus) =>
      `Stopped: the vision endpoint answered ${httpStatus ?? 'an error status'}. Nothing is lost — the batch resumes on the next run.`,
  },
  uniform_rejection: {
    attention: true,
    sentence: (httpStatus) =>
      `Stopped: the first images of the batch were all rejected with ${httpStatus ?? 'the same status'}, so the rest were not attempted.`,
  },
  lease_lost: {
    attention: false,
    sentence: () => 'Stopped: another worker took over the analysis lease. The remaining work stays queued.',
  },
};

export function ImageAnalysisProgressCard() {
  const qc = useQueryClient();
  const [kickedAt, setKickedAt] = useState<number | null>(null);
  const [confirmReanalyzeOpen, setConfirmReanalyzeOpen] = useState(false);
  /** Where focus goes when a successful retry removes the notice under it. */
  const stateLineRef = useRef<HTMLParagraphElement | null>(null);

  const { data, isPending, isError, refetch } = useQuery<ImageAnalysisStatus>({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => apiFetch<ImageAnalysisStatus>('/admin/embedding/image-analysis'),
    retry: false,
    // Polls while a batch holds the lease, and for a warm-up window after a
    // kick — the lease is taken after the POST has answered, so the payload
    // alone cannot arm the interval. Deliberately not gated on `dirtyPages`,
    // which stays non-zero for as long as anything is queued, including on an
    // unassigned instance where nothing will ever work through it.
    refetchInterval: (q) => {
      if (q.state.data?.running) return POLL_MS;
      if (kickedAt !== null && Date.now() - kickedAt < KICK_WARMUP_MS) return POLL_MS;
      return false;
    },
  });

  const statusRetry = useNoticeRetry(
    async () => ({ isError: (await refetch()).isError }),
    isError,
    stateLineRef,
  );

  const act = useMutation({
    mutationFn: (action: 'process' | 'retry-failed' | 'reanalyze-all') =>
      apiFetch<ImageAnalysisActionResult>(`/admin/embedding/image-analysis/${action}`, { method: 'POST' }),
    onSuccess: (result, action) => {
      const images = (n: number) => `${n} image${n === 1 ? '' : 's'}`;
      if (action === 'process') {
        // Neither a success nor a failure: the press was a no-op against a
        // batch that already holds the lease (`ActiveEmbeddingLocksBanner`'s
        // neutral precedent). The batch is detached, so the honest report for
        // the other branch is that it STARTED; its counters arrive by poll.
        if (result.alreadyRunning) toast.message('An analysis batch is already running.');
        else toast.success('Image analysis batch started.');
      } else if (action === 'retry-failed') {
        const rows = result.rows ?? 0;
        if (rows === 0) toast.message('No failed analyses to retry.');
        else toast.success(`${images(rows)} queued for another attempt.`);
      } else {
        const rows = result.rows ?? 0;
        toast.success(`${images(rows)} queued for re-analysis.`);
      }
      setKickedAt(Date.now());
      void qc.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const assigned = data?.assigned ?? false;
  /**
   * The batch the SERVER last confirmed, not the one a stale record
   * remembers. TanStack retains `data` through a failed REFETCH, so an outage
   * beginning mid-batch would otherwise leave this reading `running: true`
   * off a payload the card can no longer observe — simultaneously asserting a
   * batch as fact and refusing the three actions its own error copy names as
   * the remedy. A record read through a failed GET claims nothing.
   */
  const serverRunning = !isError && (data?.running ?? false);
  const busy = act.isPending || serverRunning;
  /**
   * Held only while something is genuinely unknown or in flight — never
   * because the status read failed, where the actions ARE the recovery.
   *
   * #1532/#1615: rendered as `aria-disabled` plus a refusing handler, never
   * as a native `disabled`. A batch takes minutes on a real corpus, and per
   * the HTML focus fixup rule a control that stops being focusable is blurred
   * and dropped from the tab order — so the operator who pressed Process now
   * was dumped at `<body>` at the top of a ~30-stop settings panel for the
   * whole run. `aria-disabled="true"` maps to the disabled state and is
   * announced by NVDA, JAWS and VoiceOver, so nothing is lost there; the
   * `opacity-90` (rather than the `:disabled` rule's 45) is the measured
   * value that keeps both the 13px label and the 1px operable border above
   * their contrast floors, carried over from `ImageIndexCard` and
   * `AttachmentStorageCard` so every busy button in this group looks alike.
   */
  const actionsDisabled = busy || isPending;
  /** A number the server has not sent yet is `—`, never a claimed zero. */
  const num = (n: number | undefined): string => (isPending || isError ? '—' : String(n ?? 0));

  const coverage = data && !isError ? imageAnalysisCoverage(data) : null;
  /** Rows Re-analyze all would re-pend: every analyzed, stale, failed and terminal row. */
  const reanalyzeScope = data
    ? data.rows.analyzed + data.rows.stale + data.rows.failed + data.rows.terminal
    : 0;

  /**
   * Analysed fraction of the work window, for the determinate bar. Rendered
   * only while the server says a batch is RUNNING: idle, this ratio does not
   * move, and a permanent bar reads as live work on a card that is usually at
   * rest — the counters are the resting readout.
   */
  const workWindow = data
    ? data.rows.analyzed + data.rows.stale + data.rows.pending + data.rows.failed + data.rows.terminal
    : 0;
  const analyzedPercent =
    !isPending && !isError && workWindow > 0
      ? Math.max(0, Math.min(100, Math.round(((data?.rows.analyzed ?? 0) / workWindow) * 100)))
      : null;

  const skipEntries = data
    ? (Object.entries(data.skipReasons) as Array<[keyof typeof SKIP_LABEL, number]>).filter(([, n]) => n > 0)
    : [];
  const stop = data?.lastRun?.reason ? STOP_REASON[data.lastRun.reason] : null;

  return (
    <div
      className="nm-card space-y-3 p-3 text-sm"
      data-testid="image-analysis-card"
      // The same card-root busy signal the sibling cards carry, off the same
      // fact the "Analyzing…" chip reports: the counters and the last-run
      // block change underneath the operator as each poll lands, which is
      // exactly what ARIA 1.2 scopes `aria-busy` to. Deliberately NOT on the
      // buttons, where it reaches no assistive tech and would withhold their
      // own label updates.
      aria-busy={serverRunning}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Image analysis</h3>
        {serverRunning && (
          <span
            data-testid="image-analysis-running"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            Analyzing…
          </span>
        )}
      </div>

      {/*
        The state line, and the focus target a successful retry rehomes to.
        `tabIndex={-1}` makes it programmatically focusable without adding a
        tab stop — the `EmbeddingShadowCompareSection` recipe.
        `min-w-0` because the model name is one unbreakable token on a
        390px-wide panel and would otherwise stretch the flex row it sits in.
      */}
      <p
        ref={stateLineRef}
        tabIndex={-1}
        className={`min-w-0 text-xs ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
        data-testid="image-analysis-status"
      >
        {isError ? (
          'The analysis status could not be read. The assignment and the stored analyses are unaffected — retry, or check the server logs.'
        ) : isPending ? (
          'Reading analysis status…'
        ) : assigned && data?.retainedIdentity ? (
          <>
            <span className="font-mono break-all">{data.retainedIdentity.model}</span> ·{' '}
            {coverage ? COVERAGE_SENTENCE[coverage] : null}
          </>
        ) : (
          <>
            Not assigned — new analysis is paused, not purged: descriptions already indexed and still
            valid stay searchable, images that change stay pending, and authored page text is
            unaffected. Assign a vision model on the Image analysis (vision) row under{' '}
            {LLM_PROVIDERS_CHAIN}.
          </>
        )}
      </p>

      {/*
        The retry belongs INSIDE the notice it can remove, which is why it
        carries `useNoticeRetry`: react-query drops an errored query with
        nothing cached back to `pending` on refetch, so a plain `isError` gate
        unmounts this strip — and the pressed button — under the admin's
        focus. Gated on `isError || retryInFlight` so the strip outlives the
        read it starts.
      */}
      {(isError || statusRetry.retryInFlight) && (
        <p role="status" className="text-xs" data-testid="image-analysis-status-retry">
          <button
            type="button"
            className="nm-button-ghost px-2.5 py-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-90 aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent"
            aria-disabled={statusRetry.retryInFlight || undefined}
            onClick={statusRetry.onRetry}
          >
            <RefreshCw size={12} aria-hidden="true" />
            {statusRetry.retryInFlight ? 'Retrying…' : 'Retry status read'}
          </button>
        </p>
      )}

      {/*
        D13's third gate, on screen. The worker refuses to analyze anything
        while the retained identity differs from the assignment, and without
        this strip the only symptom is a backlog that never drains.
      */}
      {data?.identityMatchesAssignment === false && (
        <p
          className="text-warning inline-flex items-start gap-1.5 text-xs"
          data-testid="image-analysis-identity-mismatch"
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            The stored analyses were written for a different model or endpoint than the one assigned
            now, so no new image is being analyzed. Press Re-check on the Image analysis row under{' '}
            {LLM_PROVIDERS_CHAIN} to adopt the assigned model.
          </span>
        </p>
      )}

      <dl
        className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs"
        data-testid="image-analysis-counters"
      >
        <div className="flex min-w-0 gap-1.5">
          <dt>Analyzed</dt>
          <dd className="text-foreground font-mono">{num(data?.rows.analyzed)}</dd>
        </div>
        <div className="flex min-w-0 gap-1.5">
          <dt>Pending</dt>
          <dd className="text-foreground font-mono">{num(data?.rows.pending)}</dd>
        </div>
        {/*
          Analyzed on disk, invalid to every reader, awaiting the sweep that
          re-pends it. Folded into `Analyzed` it would report coverage the
          index does not have.
        */}
        <div className="flex min-w-0 gap-1.5">
          <dt>Stale</dt>
          <dd className="text-foreground font-mono">{num(data?.rows.stale)}</dd>
        </div>
        <div className="flex min-w-0 gap-1.5">
          <dt>Failed</dt>
          <dd className="text-foreground font-mono">{num(data?.rows.failed)}</dd>
        </div>
        <div className="flex min-w-0 gap-1.5">
          <dt>Given up</dt>
          <dd className="text-foreground font-mono">{num(data?.rows.terminal)}</dd>
        </div>
        <div className="flex min-w-0 gap-1.5">
          <dt>Skipped</dt>
          <dd className="text-foreground font-mono">{num(data?.rows.skipped)}</dd>
        </div>
      </dl>

      {/*
        `aria-hidden`, with no `role="progressbar"`: the "Analyzing…" chip and
        `aria-busy` already carry the run on the assistive channel, and the
        numbers this bar draws are the `dl` immediately above it. A labelled
        progressbar would announce the same pair again on every poll.
      */}
      {serverRunning && analyzedPercent !== null && (
        <div
          className="bg-foreground/10 h-1.5 overflow-hidden rounded-full"
          data-testid="image-analysis-progress"
          aria-hidden="true"
        >
          <div
            className="bg-action h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${analyzedPercent}%` }}
          />
        </div>
      )}

      {/*
        The two page-level facts, each on its own line and in its own words.
        `pagesAwaitingEmbed` is NOT partial analysis: the vision work for
        those pages is done and the remaining step costs no call.
      */}
      {!isPending && !isError && (data?.pagesAwaitingEmbed ?? 0) > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="image-analysis-awaiting-embed">
          <span className="text-foreground font-mono">{data?.pagesAwaitingEmbed}</span> page
          {data?.pagesAwaitingEmbed === 1 ? '' : 's'} analyzed, text embedding still pending — no
          vision call is needed for those.
        </p>
      )}
      {!isPending && !isError && (data?.dirtyPages ?? 0) > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="image-analysis-dirty-pages">
          <span className="text-foreground font-mono">{data?.dirtyPages}</span> page
          {data?.dirtyPages === 1 ? '' : 's'} queued for an image re-read.
        </p>
      )}

      {/*
        Skip reasons by NAME, and only the ones that fired: a row of six
        zeroes is noise on the surface whose job is to explain a number that
        looks wrong. `missing` is called out separately because it is the one
        reason that is a GAP rather than a decision — a broken sync, not a
        policy — and it is what makes an otherwise complete corpus `partial`.
      */}
      {skipEntries.length > 0 && (
        <p className="text-muted-foreground text-xs" data-testid="image-analysis-skip-reasons">
          Skipped: {skipEntries.map(([reason, n]) => `${n} ${SKIP_LABEL[reason]}`).join(', ')}
          {(data?.skipReasons.missing ?? 0) > 0
            ? '. Images missing from the store are a gap, not a policy decision — the page references evidence the index does not hold.'
            : ''}
        </p>
      )}

      {data?.lastRun && !isError && (
        <div className="text-muted-foreground space-y-1 text-xs" data-testid="image-analysis-last-run">
          <p>
            Last run {formatRelativeTime(data.lastRun.at)} ·{' '}
            <span className="text-foreground font-mono">{data.lastRun.processed}</span> analyzed ·{' '}
            <span className="font-mono">{data.lastRun.reused}</span> reused ·{' '}
            <span className="font-mono">{data.lastRun.skipped}</span> skipped
          </p>
          {/*
            The sweep's and the reconcile's own counters. Rendered only when
            they did something: on a settled corpus every one of them is zero
            and the line would be a permanent row of noughts.
          */}
          {data.lastRun.repended + data.lastRun.returned + data.lastRun.reopened > 0 && (
            <p data-testid="image-analysis-last-run-sweep">
              Sweep: <span className="font-mono">{data.lastRun.repended}</span> re-queued ·{' '}
              <span className="font-mono">{data.lastRun.returned}</span> failures reset ·{' '}
              <span className="font-mono">{data.lastRun.reopened}</span> re-opened by a raised ceiling
            </p>
          )}
          {data.lastRun.reconciledPages + data.lastRun.removed > 0 && (
            <p data-testid="image-analysis-last-run-reconcile">
              Reconcile: <span className="font-mono">{data.lastRun.reconciledPages}</span> page
              {data.lastRun.reconciledPages === 1 ? '' : 's'} ·{' '}
              <span className="font-mono">{data.lastRun.removed}</span> row
              {data.lastRun.removed === 1 ? '' : 's'} removed
            </p>
          )}
          {/*
            The amber pair, for the same reason the legacy card kept them
            apart. A failed IMAGE is the endpoint refusing or answering
            unusably, and the row is retried. A page that could not be WRITTEN
            is a different outage — its pass did not complete, it stays dirty,
            and `unreadableRefs` is the finer count that says whether one
            image or twenty is stuck.
          */}
          {data.lastRun.failed > 0 && (
            <p
              className="text-warning inline-flex items-start gap-1.5"
              data-testid="image-analysis-last-run-failed"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                {data.lastRun.failed} image{data.lastRun.failed === 1 ? '' : 's'} failed to analyze —
                those rows stay queued and are retried with a growing backoff.
              </span>
            </p>
          )}
          {data.lastRun.pagesFailed > 0 && (
            <p
              className="text-warning inline-flex items-start gap-1.5"
              data-testid="image-analysis-last-run-pages-failed"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                {data.lastRun.pagesFailed} page{data.lastRun.pagesFailed === 1 ? '' : 's'} could not
                be reconciled and stay queued
                {data.lastRun.unreadableRefs > 0
                  ? ` (${data.lastRun.unreadableRefs} image${data.lastRun.unreadableRefs === 1 ? '' : 's'} present but unreadable)`
                  : ''}
                {' '}— see the server logs.
              </span>
            </p>
          )}
          {/*
            ADR-027 Stage 1 `:5262` names the stop's reason and HTTP status as
            part of this card. A bare "0 analyzed" cannot distinguish a
            settled corpus from an endpoint that refused every call.
          */}
          {stop && (
            <p
              className={
                stop.attention
                  ? 'text-warning inline-flex items-start gap-1.5'
                  : 'inline-flex items-start gap-1.5'
              }
              data-testid="image-analysis-last-run-stop"
            >
              {stop.attention && (
                <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0">{stop.sentence(data.lastRun.httpStatus)}</span>
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="image-analysis-process"
          className="nm-button-ghost px-2.5 py-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-90 aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent"
          aria-disabled={actionsDisabled || undefined}
          onClick={() => {
            // The refusal `aria-disabled` cannot perform — it blocks no
            // events. A second press during a batch is a wasted POST against
            // a held lease.
            if (actionsDisabled) return;
            act.mutate('process');
          }}
        >
          <Play size={12} aria-hidden="true" />
          Process now
        </button>
        <button
          type="button"
          data-testid="image-analysis-retry-failed"
          className="nm-button-ghost px-2.5 py-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-90 aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent"
          aria-disabled={actionsDisabled || undefined}
          onClick={() => {
            if (actionsDisabled) return;
            act.mutate('retry-failed');
          }}
          aria-describedby="image-analysis-retry-note"
        >
          <RotateCcw size={12} aria-hidden="true" />
          Retry failed
        </button>
        <button
          type="button"
          data-testid="image-analysis-reanalyze-all"
          className="nm-button-ghost px-2.5 py-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-90 aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent"
          aria-disabled={actionsDisabled || undefined}
          onClick={() => {
            if (actionsDisabled) return;
            // Disclosure BEFORE execution (ADR-027 D7, epic requirement): the
            // dialog quotes the scope this press would spend, and the POST is
            // fired only from its confirm handler.
            setConfirmReanalyzeOpen(true);
          }}
        >
          <RefreshCw size={12} aria-hidden="true" />
          Re-analyze all
        </button>
      </div>

      <p id="image-analysis-retry-note" className="text-muted-foreground text-xs" data-testid="image-analysis-retry-note">
        Retry failed gives every failed and given-up image a fresh attempt budget, due at once.
        Re-analyze all discards the stored descriptions first and spends one vision call per image.
      </p>

      <ConfirmDialog
        open={confirmReanalyzeOpen}
        title="Re-analyze every page image?"
        description={reanalyzeAllDisclosure(reanalyzeScope)}
        confirmLabel="Re-analyze all"
        onConfirm={() => {
          setConfirmReanalyzeOpen(false);
          act.mutate('reanalyze-all');
        }}
        onCancel={() => setConfirmReanalyzeOpen(false)}
      />
    </div>
  );
}
