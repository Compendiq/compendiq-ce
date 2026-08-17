import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import type { ImageEmbeddingProbe } from '@compendiq/contracts';
import {
  IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN,
  IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';
import { clampImageEmbeddingTargetDimensions } from './image-embedding-target-dimensions';

/**
 * #1115 — the `image_embedding` row's detail strip: what the leg is for, what
 * it needs, and what the last probe found.
 *
 * Modelled on `ChatVisionCapability` (#1184), and admin-only for the same
 * reason: `error` is the provider's own response body, which can echo request
 * fragments and internal topology, so it comes from the `requireAdmin` probe
 * route and never from `GET /llm/usecase-default`.
 *
 * Three copy decisions are load-bearing.
 *
 *  1. **The non-support list is visible text, not a `title`.** It is the
 *     difference between "this endpoint will work" and "this endpoint silently
 *     indexes vectors from the wrong formatting", and a caveat that lives only
 *     in a tooltip is unreachable by touch, keyboard and screen readers
 *     (#1119's rule, learned on the Deep Search toggle).
 *  2. **Nothing here is amber.** ADR-010 reserves amber for attention; an
 *     unindexed width is a standing property of the chosen model, and a note
 *     that is permanently amber teaches operators to ignore amber. The
 *     *words* carry the warning.
 *  3. **The tier is stated as a measurement, not a status.** `2048-dim ·
 *     halfvec HNSW` is a fact about the column, in the same neutral treatment
 *     `QualityScoreBadge` and `FreshnessBadge` settled on. It is labelled
 *     **Last probe**, not "Image index" (review round 2): it is sourced from
 *     `GET …/probe`, which answers what the MODEL returned. The two diverge on
 *     the branch this feature deliberately has — a saved assignment whose
 *     column DDL failed answers 200 with a warning and leaves the column at its
 *     previous width — and a chip claiming to describe the index would then
 *     state a width the column does not have.
 *  4. **P1 indexes nothing, and says so.** Assigning the leg types the column,
 *     builds the index and dirties every page — and then nothing happens, until
 *     P2's worker exists. That sentence lived only in the PR body, ADR-025 and
 *     the runbook; the panel an admin actually reads carries it too. Delete it
 *     in P2/P3.
 */

const PROBE_QUERY_KEY = ['llm-usecases', 'image_embedding', 'probe'] as const;

/** What the row is for, and the one rule an operator must not be surprised by. */
export const IMAGE_EMBEDDING_DESCRIPTION =
  'Embeds page images with a vision-language model for image search. Never inherits the default provider; unassigned means image search is off.';

/**
 * The non-support list, in one sentence. Spelled out rather than hedged: these
 * three are what a CE deployment is most likely to already be running, and all
 * three refuse the request shape this leg needs.
 */
export const IMAGE_EMBEDDING_SUPPORT_NOTE =
  "Needs an endpoint that accepts vLLM's chat-template embeddings shape — Ollama, LM Studio and TEI do not.";

/**
 * What assigning the leg does *today*, in one sentence (review round 2).
 *
 * The description above reads "…for image search", and a successful Re-check
 * says "confirmed at N dimensions" — both of which promise a working feature.
 * In this release the assignment types the column, builds its index and marks
 * every page for a re-scan that no worker consumes yet. #1119's rule: the
 * caveat belongs on screen, at rest, not in a `title` and not only in a
 * runbook.
 */
export const IMAGE_EMBEDDING_INERT_NOTE =
  'Page images are not indexed yet in this release — assigning prepares the index and proves the endpoint; indexing and image search arrive in a later release.';

const TIER_LABEL: Record<NonNullable<ImageEmbeddingProbe['tier']>, string> = {
  vector: 'vector HNSW',
  halfvec: 'halfvec HNSW',
  unindexed: 'no index (sequential scan)',
};

/**
 * What a re-check answers with.
 *
 * Two things the first cut got wrong (review round 1). A probe that did not
 * complete — an unreachable endpoint, an open breaker — was reported in the
 * SUCCESS treatment; ADR-010 reserves green for connected/succeeded, so a
 * refusal or an outage takes `toast.error`. And "Re-check" reads as purely
 * diagnostic while a width or endpoint change makes it destructive: it empties
 * `page_image_embeddings` and queues every non-folder page for a re-scan. The
 * control cannot stay silent about that, so the server reports the rebuild and
 * the toast names it.
 */
const RESULT_MESSAGE = {
  ok: (dims: number) => `Image embedding confirmed at ${dims} dimensions.`,
  rebuilt: (dims: number, pages: number) =>
    `Image embedding confirmed at ${dims} dimensions. The image index was emptied and ${pages} ${
      pages === 1 ? 'page was' : 'pages were'
    } queued for a re-scan.`,
  failed: 'The endpoint refused the probe. See why this verdict below.',
};

export function ImageEmbeddingCapability({
  assigned,
  targetDimensions,
  onTargetDimensionsChange,
}: {
  assigned: boolean;
  /**
   * `admin_settings.image_embedding_target_dimensions`, the MRL truncation
   * width every image-side call requests — null for the model's native width.
   *
   * Owned by `LlmTab` rather than by this strip, because it is saved by the
   * panel's one Save button: the width has to land BEFORE the assignment PUT
   * re-probes, or the probe measures a request the leg will no longer make.
   */
  targetDimensions: number | null;
  onTargetDimensionsChange: (next: number | null) => void;
}) {
  const qc = useQueryClient();

  // Prefix-matched by LlmTab's post-save `invalidateQueries(['llm-usecases'])`,
  // so saving a new assignment refreshes this alongside the grid. A pure cache
  // read server-side: it never costs a probe.
  const { data: probe } = useQuery<ImageEmbeddingProbe>({
    queryKey: PROBE_QUERY_KEY,
    queryFn: () => apiFetch('/admin/llm-usecases/image_embedding/probe'),
    retry: false,
    enabled: assigned,
  });

  const recheck = useMutation<ImageEmbeddingProbe>({
    mutationFn: () => apiFetch('/admin/llm-usecases/image_embedding/reprobe', { method: 'POST' }),
    onSuccess: (result) => {
      // The server may have retyped the column and re-dirtied the corpus, so
      // the whole use-case document is stale, not only this strip.
      qc.setQueryData(PROBE_QUERY_KEY, result);
      qc.invalidateQueries({ queryKey: ['llm-usecases'] });
      qc.invalidateQueries({ queryKey: ['llm', 'usecase-default'] });
      if (result.dimensions === null) {
        toast.error(RESULT_MESSAGE.failed);
        return;
      }
      toast.success(
        result.rebuilt
          ? RESULT_MESSAGE.rebuilt(result.dimensions, result.dirtiedPages ?? 0)
          : RESULT_MESSAGE.ok(result.dimensions),
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    // Indented to the assignment grid's second column, so the strip reads as
    // detail belonging to the row above rather than an eighth use case.
    <div className="grid grid-cols-[140px_1fr] gap-2">
      <span aria-hidden="true" />
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs">{IMAGE_EMBEDDING_DESCRIPTION}</p>
        <p className="text-muted-foreground text-xs" data-testid="image-embedding-support-note">
          {IMAGE_EMBEDDING_SUPPORT_NOTE}
        </p>
        <p className="text-muted-foreground text-xs" data-testid="image-embedding-inert-note">
          {IMAGE_EMBEDDING_INERT_NOTE}
        </p>

        {/*
          The MRL truncation width. Always rendered, assigned or not: an 8B is
          only assignable at all once this is set, so it cannot sit behind the
          assignment it gates. Muted helper text, wired with `aria-describedby`
          — the same rule as the Deep Search caveat (#1119), because "leave
          empty to use the native width" is the whole contract of the field.
        */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
          <label htmlFor="image-embedding-target-dimensions" className="text-xs">
            Truncate to N dimensions (MRL)
          </label>
          <input
            id="image-embedding-target-dimensions"
            data-testid="image-embedding-target-dimensions"
            type="number"
            inputMode="numeric"
            // The schema's own bounds, not a hand-copied pair — and they
            // constrain nothing on their own: `e.target.value` is read
            // regardless, so `clampImageEmbeddingTargetDimensions` is what
            // keeps an out-of-range entry from coming back as a raw Zod issue
            // path. It runs on blur here and again in `LlmTab` before the PUT.
            min={IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN}
            max={IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX}
            placeholder="native"
            className="nm-input w-28 font-mono text-xs"
            aria-describedby="image-embedding-target-dimensions-help"
            value={targetDimensions ?? ''}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === '') {
                onTargetDimensionsChange(null);
                return;
              }
              const parsed = Number(raw);
              onTargetDimensionsChange(Number.isFinite(parsed) ? Math.trunc(parsed) : null);
            }}
            // Settle on the value that will actually be sent, once the admin
            // has finished typing. Clamping per keystroke would rewrite `4` to
            // `64` and make `4000` — the largest indexable width, and the one
            // the unindexed note tells them to enter — unreachable.
            onBlur={() =>
              onTargetDimensionsChange(clampImageEmbeddingTargetDimensions(targetDimensions))
            }
          />
          <p
            id="image-embedding-target-dimensions-help"
            className="text-muted-foreground basis-full text-xs"
          >
            Sent as the <code>dimensions</code> parameter on every image-embedding request. Leave
            empty to use the model&rsquo;s native width; the 8B needs 4000 or fewer to stay indexed.
            The server must accept it (vLLM: <code>--hf-overrides</code>{' '}
            <code>{'{"is_matryoshka": true}'}</code>), and changing it re-probes and rebuilds the
            index on the next save.
          </p>
        </div>

        {assigned && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            {/*
              "Last probe", not "Image index": this is what the MODEL answered,
              not what `page_image_embeddings.embedding` is typed to. They
              diverge on the guarded-DDL branch — a save whose ALTER failed
              answers 200 with a warning and leaves the column at its previous
              width — and the honest label is the one that names its source.
            */}
            <span className="text-muted-foreground">Last probe</span>
            <span
              data-testid="image-embedding-probe-status"
              className="border-border text-foreground rounded border px-1.5 py-0.5 font-mono"
            >
              {probe?.dimensions != null && probe.tier
                ? `${probe.dimensions}-dim · ${TIER_LABEL[probe.tier]}`
                : 'Not established'}
            </span>
            {probe && (
              <span
                data-testid="image-embedding-probed-at"
                className="text-muted-foreground"
                title={probe.probedAt ? new Date(probe.probedAt).toLocaleString() : undefined}
              >
                {probe.probedAt ? `Checked ${formatRelativeTime(probe.probedAt)}` : 'Never checked'}
              </span>
            )}
            <button
              type="button"
              data-testid="image-embedding-recheck"
              // Blocking on the server: it embeds an image and a text through
              // the queue and the per-provider breaker, and an image prompt is
              // 10–25x a short text one. The control says what it is doing
              // rather than appearing inert.
              className="nm-button-ghost px-2.5 py-1 text-xs"
              onClick={() => recheck.mutate()}
              disabled={recheck.isPending}
              aria-busy={recheck.isPending}
            >
              {recheck.isPending ? (
                <>
                  <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                  Checking…
                </>
              ) : (
                <>
                  <RefreshCw size={12} aria-hidden="true" />
                  Re-check
                </>
              )}
            </button>
          </div>
        )}

        {/*
          Muted, not amber. This is a standing consequence of the model the
          operator chose, not an incident — and it names the remedy, because
          "unindexed" alone leaves nobody able to act on it.
        */}
        {probe?.tier === 'unindexed' && (
          <p className="text-muted-foreground text-xs" data-testid="image-embedding-unindexed-note">
            Above 4000 dimensions pgvector cannot build an HNSW index, so image search reads the
            whole table. Set the truncation width above to 4000 or fewer, then save, to keep the
            index — or pick a checkpoint whose native width is already there (the 2B at 2048).
          </p>
        )}

        {/*
          The probe error is third-party text from the provider — rendered as
          plain JSX so React escapes it, never through `dangerouslySetInnerHTML`
          or a Markdown renderer. It is already length-bounded server-side; the
          scroll cap here is so a 600-character body cannot push the rest of the
          panel off-screen.
        */}
        {probe?.error && (
          <details className="group" data-testid="image-embedding-probe-error">
            <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs transition-colors marker:content-none focus-visible:ring-2 focus-visible:outline-none">
              <ChevronRight
                size={12}
                className="shrink-0 transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              Why this verdict?
            </summary>
            <p
              data-testid="image-embedding-probe-error-text"
              className="border-border bg-background/50 text-muted-foreground mt-1.5 max-h-32 overflow-y-auto rounded-md border px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
            >
              {probe.error}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
