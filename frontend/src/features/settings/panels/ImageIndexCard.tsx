import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Play, RefreshCw } from 'lucide-react';
import type { ImageIndexStatus } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';

/**
 * #1115 P2 — Settings → AI Models → Embeddings: the image index.
 *
 * Four pieces of copy carry the things an operator would otherwise have to
 * discover:
 *
 *  - **Where the index is READ** — until P3 this sentence said image search
 *    was not live yet, because the index really was a thing that filled up and
 *    was read by nothing, while the LLM providers row promised image search
 *    and its probe said "confirmed". P3 landed the retrieval leg, so that
 *    sentence became false and is now a pointer at the switch that turns the
 *    leg on. The rule it satisfies is unchanged (#1119: on screen, at rest,
 *    not in a tooltip) — what changed is which fact is true. It names the FULL
 *    panel chain (review r2), not a bare "under Retrieval": that is the
 *    spelling `settings-wayfinding.test.ts` can police, and a naked tab name
 *    is unfollowable from a panel that has no such tab.
 *  - **Re-scan's consequence** — it marks every page. That sounds expensive,
 *    and the half that makes it cheap (content-hash reuse) is invisible unless
 *    stated.
 *  - **The model-change consequence** — changing the image model TRUNCATEs
 *    this index (ADR-025 D7). The sentence also says what it does *not* touch,
 *    because "rebuilds the index" reads as "re-embeds everything" to anyone who
 *    remembers the text side's re-embed.
 *  - **Skip reasons, by name** — the row count is lower than the picture count
 *    on essentially every real corpus, and `unsupported` (a draw.io `.png` that
 *    is really XML) is working as designed while `missing` is a broken sync.
 *
 * **A failed FETCH is a failure, not an unassigned leg** (review r1, and
 * CLAUDE.md's `usePageTree` rule). Reading `{ data }` alone collapsed both the
 * pre-fetch paint and a 500 into the not-assigned state: an admin whose leg is
 * assigned and working was told to go and assign it, and both remedies —
 * Process now and Re-scan all — were disabled on the one surface that reports
 * the index. So three states, not one. Pending renders em-dashes rather than a
 * claim; an error says the status could not be READ, states that the
 * assignment and the index are untouched, and leaves the actions live, because
 * a status read failing is no reason to withhold the buttons that fix things.
 *
 * **Colour follows ADR-010 exactly.** Everything here is a MEASUREMENT and
 * renders neutral — the `QualityScoreBadge` argument. Three exceptions, each
 * genuinely attention-worthy and each requiring the operator to act: a last run
 * with FAILED images, a run with pages that could not be WRITTEN, and an index
 * built for a model other than the one assigned now (the guarded-DDL branch,
 * whose only other symptom is a backlog that never drains). A failed status
 * READ is none of them — it is a failure, so it takes the destructive treatment
 * rather than amber.
 */

const STATUS_QUERY_KEY = ['admin', 'image-index'] as const;

/**
 * How often the card re-reads while a scan is running.
 *
 * 5s matches `EmbeddingShadowMigrationCard` and `ActiveEmbeddingLocksBanner`,
 * and stays under the default 20/min per-route admin rate limit. 3s sits
 * EXACTLY at it, before the mount fetch and before the invalidate each button
 * press fires — and with `retry: false` a 429 leaves the last payload in
 * cache, so `running` stays true, the interval keeps firing and the card
 * freezes on stale counters with both buttons disabled and no error shown.
 */
const POLL_MS = 5_000;

/**
 * How long the card keeps polling after a kick, whatever the payload says.
 *
 * `running` is read server-side from the worker LOCK, and the POST answers
 * before the detached scan has taken it: `processDirtyPageImages` awaits the
 * resolver and then `acquireWorkerLock`. If the one post-kick refetch is served
 * inside that window it caches `running: false`, the interval never arms and
 * nothing re-arms it — on Re-scan all that leaves `Pages pending` frozen at the
 * whole corpus, indefinitely, while the scan is in fact running (review r2).
 *
 * A warm-up window costs at most four extra reads of a route the card already
 * polls at this cadence, and it self-cancels the moment a payload reports the
 * lock — which is why this is a floor on polling rather than a second timer.
 */
const KICK_WARMUP_MS = 20_000;

const TIER_LABEL: Record<NonNullable<NonNullable<ImageIndexStatus['identity']>['tier']>, string> = {
  vector: 'vector HNSW',
  halfvec: 'halfvec HNSW',
  unindexed: 'no index (sequential scan)',
};

/**
 * Skip reasons, spelled for a human.
 *
 * Typed on the contract's own key set, so a seventh reason added server-side
 * fails the build here rather than rendering as its camelCase field name on
 * the one surface that exists to explain the number.
 */
const SKIP_LABEL: Record<keyof NonNullable<ImageIndexStatus['lastRun']>['skipped'], string> = {
  missing: 'missing',
  unsupported: 'unsupported',
  oversized: 'oversized',
  tooLarge: 'too large',
  capped: 'capped',
  external: 'external',
};

export function ImageIndexCard() {
  const qc = useQueryClient();
  const [kickedAt, setKickedAt] = useState<number | null>(null);

  const { data, isPending, isError } = useQuery<ImageIndexStatus>({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => apiFetch<ImageIndexStatus>('/admin/embedding/image-index'),
    retry: false,
    // Polls while a scan holds the worker lock, and for a warm-up window after
    // a kick — the lock is taken after the POST has answered, so the payload
    // alone cannot arm the interval. Not gated on `pagesDirty`, which is
    // non-zero for as long as anything is queued — including on an instance
    // where the leg is unassigned and nothing will ever work through it, which
    // would poll for the life of the page.
    refetchInterval: (q) => {
      if (q.state.data?.running) return POLL_MS;
      if (kickedAt !== null && Date.now() - kickedAt < KICK_WARMUP_MS) return POLL_MS;
      return false;
    },
  });

  const kick = useMutation({
    mutationFn: (action: 'process' | 'rescan') =>
      apiFetch<{ marked?: number; started: boolean; alreadyRunning?: boolean }>(
        `/admin/embedding/image-index/${action}`,
        { method: 'POST' },
      ),
    onSuccess: (result, action) => {
      const pages = (n: number) => `${n} page${n === 1 ? '' : 's'}`;
      if (result.alreadyRunning) {
        // Neither a success nor a failure: the press was a no-op against a scan
        // that already holds the lock (`ActiveEmbeddingLocksBanner`'s neutral
        // precedent). Re-scan's half that DID happen is named, together with
        // the reason the second press is needed — the running scan walks a
        // LIMIT/OFFSET window over a result set the marking just grew, so pages
        // inserted ahead of its offset are not visited by it.
        toast.message(
          action === 'rescan'
            ? `Marked ${pages(result.marked ?? 0)}. A scan is already running and may not reach them — press Process now once it finishes.`
            : 'A scan is already running.',
        );
      } else {
        // The scan runs detached from the request, so the honest report is that
        // it STARTED. The counters arrive through the poll above.
        toast.success(
          action === 'rescan'
            ? `Re-scan started for ${pages(result.marked ?? 0)}.`
            : 'Image index scan started.',
        );
      }
      setKickedAt(Date.now());
      void qc.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const assigned = data?.assigned ?? false;
  /**
   * The scan the SERVER last confirmed, not the one a stale record remembers
   * (review r2) — the guard `AttachmentStorageCard.tsx` carries on its own
   * `running`, so the two cards' busy states are identical in the outage
   * branch too, per #1532's per-group rule.
   *
   * TanStack retains `data` through a failed REFETCH, so an outage that begins
   * while a scan is in flight left this reading `running: true` off a payload
   * the card could no longer observe. It feeds `aria-busy`, the "Scanning…"
   * chip and (through `busy`) `actionsDisabled`, so the card simultaneously
   * asserted a scan as fact and refused Process now and Re-scan all — the
   * remedy its own error copy names four paragraphs below, and the affordance
   * the comment beneath this one promises stays live. A record read through a
   * failed GET claims nothing.
   *
   * Polling is unaffected: `refetchInterval` reads the query's own retained
   * data, so the card keeps asking and heals itself the moment the route
   * answers again.
   */
  const serverRunning = !isError && (data?.running ?? false);
  const busy = kick.isPending || serverRunning;
  // Live whenever the leg is known to be assigned, and ALSO when the status
  // could not be read: the buttons are the remedy, and a card that hides them
  // because its own GET 500'd removes the recovery from the surface that
  // exists to provide it. Only the pending paint holds them, where nothing
  // is known yet and a press would be a guess.
  //
  // #1532: rendered as `aria-disabled` plus a REFUSING handler, never as a
  // native `disabled`. A scan takes minutes on a real corpus, and per the HTML
  // focus fixup rule a control that stops being focusable is blurred and
  // removed from the tab order, so the operator who pressed Process now was
  // dropped to `<body>` at the top of a ~30-stop settings panel for the whole
  // run — CLAUDE.md's Retrieval-panel ruling, whose recipe this is. The WHOLE
  // flag converts, busy half and inert half alike: the fixup fires wherever
  // native `disabled` lands on a focused control, and "both actions are inert
  // without an assignment" is carried by the refusal instead of the attribute.
  // `aria-disabled="true"` is mapped to the disabled state and announced by
  // NVDA, JAWS and VoiceOver, so nothing is lost on that channel.
  const actionsDisabled = busy || isPending || (!isError && !assigned);
  /** A number the server has not sent yet is `—`, never a claimed zero. */
  const num = (n: number | undefined): string => (isPending || isError ? '—' : String(n ?? 0));

  return (
    <div
      className="nm-card border-status-embedding/30 space-y-3 p-3 text-sm"
      data-testid="image-index-card"
      // #1532: the same card-root busy signal `AttachmentStorageCard` carries,
      // off the same fact — the run the "Scanning…" chip reports. The counters
      // and the last-run block below change underneath the operator as the
      // poll lands, which is exactly what ARIA 1.2 scopes `aria-busy` to; it
      // is deliberately NOT on the buttons, where it reaches no assistive
      // tech and would withhold their own label updates.
      aria-busy={serverRunning}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Image index</h3>
        {serverRunning && (
          <span
            data-testid="image-index-running"
            className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
          >
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            Scanning…
          </span>
        )}
      </div>

      <p
        className={isError ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
        data-testid="image-index-status"
      >
        {isError ? (
          'The index status could not be read. The assignment and the stored index are unaffected — retry, or check the server logs.'
        ) : isPending ? (
          'Reading index status…'
        ) : assigned && data?.identity ? (
          <>
            <span className="font-mono">
              {data.identity.dimensions ?? '—'}-dim ·{' '}
              {data.identity.tier ? TIER_LABEL[data.identity.tier] : 'width not recorded'}
            </span>{' '}
            · {data.identity.model}
          </>
        ) : (
          'Not assigned — assign Image embedding under Settings → AI Models → LLM providers.'
        )}
      </p>

      {/*
        The one state where the line above names a model and a width that
        belong to different things. The DDL behind an assignment is guarded, so
        an `ALTER` that failed leaves the new pair live against the old column
        — amber, because nothing else on screen says so and the backlog simply
        stops draining.

        The remedy names WHERE the row is (review r4): Re-check lives on a
        different panel from this card, and the not-assigned line above already
        spells the same chain. `settings-wayfinding.test.ts` holds both to the
        live rail, so a renamed panel fails here rather than sending an admin
        to a page that does not exist.
      */}
      {data?.identityMatchesAssignment === false && (
        <p
          className="text-warning inline-flex items-center gap-1.5 text-xs"
          data-testid="image-index-identity-mismatch"
        >
          <AlertTriangle size={12} aria-hidden="true" />
          The index was built for a different model or endpoint than the one assigned now. Press
          Re-check on the Image embedding row under Settings → AI Models → LLM providers to rebuild
          it.
        </p>
      )}

      <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="image-index-counters">
        <div className="flex gap-1.5">
          <dt>Images embedded</dt>
          <dd className="text-foreground font-mono">{num(data?.rows)}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt>Pages pending</dt>
          <dd className="text-foreground font-mono">
            {num(data?.pagesDirty)}/{num(data?.pagesTotal)}
          </dd>
        </div>
      </dl>

      {data?.lastRun && (
        <div className="text-muted-foreground space-y-1 text-xs" data-testid="image-index-last-run">
          <p>
            Last run {formatRelativeTime(data.lastRun.at)} · {data.lastRun.pages} page
            {data.lastRun.pages === 1 ? '' : 's'} ·{' '}
            <span className="text-foreground font-mono">{data.lastRun.embedded}</span> embedded ·{' '}
            <span className="font-mono">{data.lastRun.reused}</span> reused ·{' '}
            <span className="font-mono">{data.lastRun.removed}</span> removed
          </p>
          {/*
            Skip reasons by NAME, and only the ones that fired. A row of six
            zeroes is noise on the surface whose job is to explain a number
            that looks wrong.
          */}
          {Object.entries(data.lastRun.skipped).some(([, n]) => n > 0) && (
            <p data-testid="image-index-last-run-skipped">
              Skipped:{' '}
              {(
                Object.entries(data.lastRun.skipped) as Array<
                  [keyof typeof SKIP_LABEL, number]
                >
              )
                .filter(([, n]) => n > 0)
                .map(([reason, n]) => `${n} ${SKIP_LABEL[reason]}`)
                .join(', ')}
            </p>
          )}
          {/*
            The amber pair. A failed IMAGE means the endpoint refused, never
            answered, or answered at a width the column is not typed for (the
            guarded-DDL case the strip above names Re-check for) — the pages
            stayed queued, and somebody has to look, which is exactly what
            ADR-010 reserves amber for. A page that THREW is reported
            separately because it is a different outage: that is a DATABASE
            error, the page's whole transaction rolled back, and "the model
            refused" would send the operator to the wrong place.
          */}
          {data.lastRun.failed > 0 && (
            <p className="text-warning inline-flex items-center gap-1.5" data-testid="image-index-last-run-failed">
              <AlertTriangle size={12} aria-hidden="true" />
              {data.lastRun.failed} image{data.lastRun.failed === 1 ? '' : 's'} failed to embed — those
              pages stay queued and will be retried.
            </p>
          )}
          {data.lastRun.pagesFailed > 0 && (
            <p
              className="text-warning inline-flex items-center gap-1.5"
              data-testid="image-index-last-run-pages-failed"
            >
              <AlertTriangle size={12} aria-hidden="true" />
              {data.lastRun.pagesFailed} page{data.lastRun.pagesFailed === 1 ? '' : 's'} could not be
              written to the index and stay queued — see the server logs.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="image-index-process"
          // `opacity-70`, not the `:disabled` rule's 45 — at 45% this 12px
          // label falls under the 4.5:1 floor in both themes, and WCAG's
          // inactive-component exemption does not cover a control that keeps
          // its focus and refuses in its HANDLER (the `RetrievalTab` recipe).
          className="nm-button-ghost px-2.5 py-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-70 aria-disabled:hover:bg-transparent"
          aria-disabled={actionsDisabled || undefined}
          onClick={() => {
            // The refusal `aria-disabled` cannot perform — it blocks no
            // events. Both actions are inert without an assignment (the
            // worker's own fast path answers "unassigned" and clears
            // nothing, so a live press would report success for work that
            // never starts), and a second press during a scan is a wasted
            // POST against a held lock.
            if (actionsDisabled) return;
            kick.mutate('process');
          }}
        >
          <Play size={12} aria-hidden="true" />
          Process now
        </button>
        <button
          type="button"
          data-testid="image-index-rescan"
          className="nm-button-ghost px-2.5 py-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-70 aria-disabled:hover:bg-transparent"
          aria-disabled={actionsDisabled || undefined}
          onClick={() => {
            if (actionsDisabled) return;
            kick.mutate('rescan');
          }}
          aria-describedby="image-index-rescan-note"
        >
          <RefreshCw size={12} aria-hidden="true" />
          Re-scan all
        </button>
      </div>

      <p id="image-index-rescan-note" className="text-muted-foreground text-xs" data-testid="image-index-rescan-note">
        Re-scan marks every page and re-reads its images; images already embedded are reused by
        content hash.
      </p>

      <p className="text-muted-foreground text-xs" data-testid="image-index-model-change-note">
        Changing the image model empties and rebuilds this index; text search is unaffected.
      </p>

      <p className="text-muted-foreground text-xs" data-testid="image-index-retrieval-note">
        Image search runs as a third retrieval leg when enabled under Settings → AI Models → Retrieval.
      </p>
    </div>
  );
}
