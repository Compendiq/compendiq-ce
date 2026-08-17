import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import type { ImageEmbeddingProbe } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';

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
 *     `QualityScoreBadge` and `FreshnessBadge` settled on.
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

const TIER_LABEL: Record<NonNullable<ImageEmbeddingProbe['tier']>, string> = {
  vector: 'vector HNSW',
  halfvec: 'halfvec HNSW',
  unindexed: 'no index (sequential scan)',
};

const RESULT_MESSAGE = {
  ok: (dims: number) => `Image embedding confirmed at ${dims} dimensions.`,
  failed: 'The endpoint refused the probe. See why this verdict below.',
};

export function ImageEmbeddingCapability({ assigned }: { assigned: boolean }) {
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
      toast.success(
        result.dimensions !== null
          ? RESULT_MESSAGE.ok(result.dimensions)
          : RESULT_MESSAGE.failed,
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

        {assigned && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="text-muted-foreground">Image index</span>
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
            whole table. Serve the model at 4000 dimensions or fewer — its <code>dimensions</code>{' '}
            (MRL) parameter — to keep the index.
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
