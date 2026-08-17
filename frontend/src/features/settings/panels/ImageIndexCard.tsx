import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Loader2, Play, RefreshCw } from 'lucide-react';
import type { ImageIndexStatus } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';

/**
 * #1115 P2 — Settings → AI Models → Embeddings: the image index.
 *
 * The card exists because the index it describes is, in this release, a thing
 * that fills up and is read by nothing. Four pieces of copy carry that, and
 * each of them is a consequence somebody would otherwise have to discover:
 *
 *  - **"Image search is not live yet"** — the LLM providers row promises image
 *    search and its probe says "confirmed". Without this sentence, an operator
 *    who assigns the leg, watches rows appear and then searches for a picture
 *    concludes the feature is broken. It replaces the inert note that row used
 *    to carry (#1119's rule: on screen, at rest, not in a tooltip).
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
 * renders neutral — the `QualityScoreBadge` argument. Two exceptions, both
 * genuinely attention-worthy and both requiring the operator to act: a last run
 * that FAILED, and an index built for a model other than the one assigned now
 * (the guarded-DDL branch, whose only other symptom is a backlog that never
 * drains). A failed status READ is neither — it is a failure, so it takes the
 * destructive treatment rather than amber.
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

  const { data, isPending, isError } = useQuery<ImageIndexStatus>({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => apiFetch<ImageIndexStatus>('/admin/embedding/image-index'),
    retry: false,
    // Polls only while a scan holds the worker lock. Not gated on
    // `pagesDirty`, which is non-zero for as long as anything is queued —
    // including on an instance where the leg is unassigned and nothing will
    // ever work through it, which would poll for the life of the page.
    refetchInterval: (q) => (q.state.data?.running ? POLL_MS : false),
  });

  const kick = useMutation({
    mutationFn: (action: 'process' | 'rescan') =>
      apiFetch<{ marked?: number; started: boolean }>(
        `/admin/embedding/image-index/${action}`,
        { method: 'POST' },
      ),
    onSuccess: (result, action) => {
      // The scan runs detached from the request, so the honest report is that
      // it STARTED. The counters arrive through the poll below.
      toast.success(
        action === 'rescan'
          ? `Re-scan started for ${result.marked ?? 0} page${result.marked === 1 ? '' : 's'}.`
          : 'Image index scan started.',
      );
      void qc.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const assigned = data?.assigned ?? false;
  const busy = kick.isPending || (data?.running ?? false);
  // Live whenever the leg is known to be assigned, and ALSO when the status
  // could not be read: the buttons are the remedy, and a card that hides them
  // because its own GET 500'd removes the recovery from the surface that
  // exists to provide it. Only the pending paint disables them, where nothing
  // is known yet and a press would be a guess.
  const actionsDisabled = busy || isPending || (!isError && !assigned);
  /** A number the server has not sent yet is `—`, never a claimed zero. */
  const num = (n: number | undefined): string => (isPending || isError ? '—' : String(n ?? 0));

  return (
    <div className="nm-card border-status-embedding/30 space-y-3 p-3 text-sm" data-testid="image-index-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">Image index</h3>
        {data?.running && (
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
      */}
      {data?.identityMatchesAssignment === false && (
        <p
          className="text-warning inline-flex items-center gap-1.5 text-xs"
          data-testid="image-index-identity-mismatch"
        >
          <AlertTriangle size={12} aria-hidden="true" />
          The index was built for a different model or endpoint than the one assigned now. Press
          Re-check on the Image embedding row to rebuild it.
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
            The amber pair. A failed run means the endpoint refused, the pages
            stayed queued, and somebody has to look — which is exactly what
            ADR-010 reserves amber for. A page that THREW is reported
            separately because it is a different outage: the scan never reached
            the provider, so "the model refused" would send the operator to the
            wrong place.
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
          className="nm-button-ghost px-2.5 py-1 text-xs"
          // Both actions are inert without an assignment: the worker's own
          // fast path answers "unassigned" and clears nothing, so a live
          // button would report success for work that never starts.
          disabled={actionsDisabled}
          onClick={() => kick.mutate('process')}
        >
          <Play size={12} aria-hidden="true" />
          Process now
        </button>
        <button
          type="button"
          data-testid="image-index-rescan"
          className="nm-button-ghost px-2.5 py-1 text-xs"
          disabled={actionsDisabled}
          onClick={() => kick.mutate('rescan')}
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

      <p className="text-muted-foreground text-xs" data-testid="image-index-not-live-note">
        Image search is not live yet in this release; the index is being prepared.
      </p>
    </div>
  );
}
