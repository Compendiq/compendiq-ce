import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import type { ImageAnalysisCapabilityDetail, UsecaseAssignment } from '@compendiq/contracts';
import {
  IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_DEFAULT,
  IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX,
  IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';
import { VisionBadge } from '../../../shared/components/badges/VisionBadge';
import { NumberRow, type NumericField } from './NumberRow';
import { reanalysisDisclosure } from './image-analysis-copy';

/**
 * #1615 (ADR-027) — the `image_analysis` row's detail strip: which provider
 * will receive page images, the vision verdict for the saved pair, the
 * retained identity behind the index, and the output-token ceiling.
 *
 * Modelled on `ImageEmbeddingCapability` (#1115) and `ChatVisionCapability`
 * (#1184), and admin-only for the same reason: `probeError` is the provider's
 * own body and comes from the `requireAdmin` capability route.
 *
 * Four copy decisions are load-bearing.
 *
 *  1. **The egress sentence names the SAVED provider, never the draft.** The
 *     assignment IS the egress control (ADR-027 D3): no page image leaves the
 *     host until an administrator has saved a provider for this purpose, and
 *     the sentence says which one. A dropdown change that has not been saved
 *     has sent nothing anywhere, so it must not read as if it had.
 *  2. **Unconfirmed is not text-only.** `null` covers an unreachable endpoint,
 *     a bad key, a 429 and an open breaker; none of them is evidence about the
 *     model, and the copy under the badge says so rather than letting the
 *     badge's neutral label carry two meanings.
 *  3. **Identity drift is amber, and it is the ONLY amber here.** A provider
 *     `base_url` edit is the one identity dimension no assignment PUT
 *     touches; while it stands the worker skips every image (`identity_drift`),
 *     and Re-check is the documented way out. That needs attention; nothing
 *     else on this strip does.
 *  4. **The ceiling is its own row, below the strip, never inside the
 *     identity line.** It is not part of the identity, changes no stored row
 *     and fires no probe — the copy beside it is the ADR's, verbatim.
 */

export const CAPABILITY_QUERY_KEY = ['llm-usecases', 'image_analysis', 'capability'] as const;

/** What the row is for, and what the model does NOT do. */
export const IMAGE_ANALYSIS_DESCRIPTION =
  'Reads each page image once at ingestion and writes what it shows — description, visible text, tables, chart and diagram structure — into the text index, where ordinary search and a text-only chat model can find it.';

/** The ingestion-versus-chat distinction, stated once. */
export const IMAGE_ANALYSIS_ROLE_NOTE =
  'This is the ingestion model, separate from the Chat model above: it never answers a question, and the chat model never analyzes an image. Never inherits the default provider.';

/** Pause, not purge (ADR-027 D7). */
export const IMAGE_ANALYSIS_PAUSE_NOTE =
  'Unassigning pauses new analysis: images that change stay pending, and descriptions already indexed and still valid remain searchable. Manual model IDs are accepted where discovery is incomplete — the probe on Save is what validates them.';

/** The ADR's copy for the ceiling, verbatim (ADR-027 "Settings and capability semantics"). */
export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_HELP =
  "The most tokens one image analysis may return. Lower it if the vision model's context refuses the default; raise it for scripts that tokenize below one character per token. Changing it never re-analyzes an image: analyses already stored stay valid, and only images that failed because their reply was cut off are tried again under a higher value.";

const MAX_OUTPUT_TOKENS_FIELD: NumericField<'imageAnalysisMaxOutputTokens'> = {
  key: 'imageAnalysisMaxOutputTokens',
  label: 'Max output tokens',
  unit: 'tokens',
  min: IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN,
  max: IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX,
  step: 1,
};

/** Copy for the re-check toast, by verdict. */
const RESULT_MESSAGE: Record<'yes' | 'no' | 'unknown', string> = {
  yes: 'Image support confirmed — this model reads page images.',
  no: 'This model refused the test image. Image analysis stays paused until a vision-capable model is assigned.',
  unknown: "Couldn't establish image support — the provider did not answer. That is not a text-only verdict; see why below.",
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export function ImageAnalysisCard({
  savedAssignment,
  maxOutputTokens,
  onMaxOutputTokensChange,
}: {
  /**
   * The SERVER's `image_analysis` row, never the draft: the egress sentence,
   * the capability query and Re-check all describe what is saved.
   */
  savedAssignment: UsecaseAssignment | undefined;
  /**
   * `admin_settings.image_analysis_max_output_tokens`. Owned by `LlmTab`,
   * saved by the panel's one Save button through `PUT /admin/settings`.
   */
  maxOutputTokens: number;
  onMaxOutputTokensChange: (next: number) => void;
}) {
  const qc = useQueryClient();
  const assigned = savedAssignment?.providerId != null;
  const savedProviderName =
    assigned && savedAssignment.resolved.providerId !== NIL_UUID
      ? savedAssignment.resolved.providerName
      : null;

  // Prefix-matched by LlmTab's post-save `invalidateQueries(['llm-usecases'])`,
  // so saving a new assignment refreshes this alongside the grid. A pure cache
  // read server-side: it never costs a probe.
  const capabilityQuery = useQuery<ImageAnalysisCapabilityDetail>({
    queryKey: CAPABILITY_QUERY_KEY,
    queryFn: () => apiFetch('/admin/llm-usecases/image_analysis/capability'),
    retry: false,
    enabled: assigned,
  });
  const capability = capabilityQuery.data;

  const recheck = useMutation<ImageAnalysisCapabilityDetail>({
    mutationFn: () => apiFetch('/admin/llm-usecases/image_analysis/recheck', { method: 'POST' }),
    onSuccess: (result) => {
      // The verdict and, on a true re-check of a drifted identity, the
      // retained identity both changed: seed the strip with what the click
      // produced and re-read the assignments document behind it.
      qc.setQueryData(CAPABILITY_QUERY_KEY, result);
      qc.invalidateQueries({ queryKey: ['llm-usecases'] });
      if (result.vision === true) {
        toast.success(RESULT_MESSAGE.yes);
        if (result.reanalyzeRows !== undefined && result.reanalyzeRows > 0) {
          toast.warning(reanalysisDisclosure(result.reanalyzeRows));
        }
        return;
      }
      toast.error(RESULT_MESSAGE[result.vision === false ? 'no' : 'unknown']);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const probeError = capability?.probeError ?? null;

  return (
    // Indented to the assignment grid's second column from `sm` up, so the
    // strip reads as detail belonging to the row above rather than a tenth
    // use case. Below `sm` the spacer collapses and the strip takes the full
    // width: a 140 px column inside a ~324 px card left the description, the
    // identity line and the ceiling input clipped (review r1, AC-6).
    <div className="grid gap-2 sm:grid-cols-[140px_1fr]" data-testid="image-analysis-card">
      <span aria-hidden="true" className="hidden sm:block" />
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs">{IMAGE_ANALYSIS_DESCRIPTION}</p>
        {/*
          Which provider receives page images — the egress disclosure the ADR
          requires beside the selector. Named from the SAVED assignment; the
          unassigned sentence is the strongest claim on this strip and it is
          true only of what is saved.
        */}
        <p className="text-xs" data-testid="image-analysis-egress">
          {assigned ? (
            <>
              Page images are sent to{' '}
              <span className="text-foreground font-medium">{savedProviderName ?? 'the assigned provider'}</span>
              {' '}for analysis.
            </>
          ) : (
            <span className="text-muted-foreground">
              No provider is assigned, so no page image leaves this host and nothing is analyzed.
            </span>
          )}
        </p>
        <p className="text-muted-foreground text-xs">{IMAGE_ANALYSIS_ROLE_NOTE}</p>
        <p className="text-muted-foreground text-xs" data-testid="image-analysis-pause-note">
          {IMAGE_ANALYSIS_PAUSE_NOTE}
        </p>

        {assigned && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="text-muted-foreground">Image support</span>
            {/*
              Nothing here claims a verdict before the capability query has
              answered: a badge rendered from an absent document would say
              "Unconfirmed" about a pair the server may hold as `true`.
            */}
            {capability ? (
              <>
                <VisionBadge vision={capability.vision} />
                <span
                  data-testid="image-analysis-probed-at"
                  className="text-muted-foreground"
                  title={capability.probedAt ? new Date(capability.probedAt).toLocaleString() : undefined}
                >
                  {capability.probedAt ? `Checked ${formatRelativeTime(capability.probedAt)}` : 'Never checked'}
                </span>
              </>
            ) : capabilityQuery.isError ? (
              <span className="text-muted-foreground" data-testid="image-analysis-capability-error">
                Image support could not be read.
              </span>
            ) : (
              <span className="text-muted-foreground" data-testid="image-analysis-capability-loading">
                Reading…
              </span>
            )}
            <button
              type="button"
              data-testid="image-analysis-recheck"
              // Blocking on the server: a chat completion with a test image
              // through the queue and the per-provider breaker, bounded at the
              // probe's 60 s budget. The control says what it is doing rather
              // than appearing inert, and keeps focus while it does — as
              // `aria-disabled` plus a REFUSING handler, never native
              // `disabled`: the HTML focus fixup blurs a focused control the
              // moment it stops being focusable, so `disabled` dropped the
              // keyboard to `<body>` for the whole probe (review r1; the
              // `ImageIndexCard` / `RetrievalTab` recipe, #1532).
              className="nm-button-ghost px-2.5 py-1 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-90 aria-disabled:hover:bg-transparent aria-disabled:active:bg-transparent"
              onClick={() => {
                // `aria-disabled` blocks no events: a second press mid-probe
                // would be a second 60 s probe against the same pair.
                if (recheck.isPending) return;
                recheck.mutate();
              }}
              aria-disabled={recheck.isPending || undefined}
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
          The copy under a `null` verdict. Two states share the badge's
          "Unconfirmed" and must not share a sentence: a probe that RAN and
          got no answer, and a pair that has not been probed at all. The
          second is the D7 drift flow — a provider edit discards the stored
          verdict (`invalidateProviderCapabilities`), the PUT probes before
          every write, so "assigned and never checked" only ever means "the
          provider changed under a saved assignment" — and it must not be
          described as a probe outcome that never happened (review r1).
        */}
        {assigned && capability?.vision === null && capability.probedAt === null && (
          <p className="text-muted-foreground text-xs" data-testid="image-analysis-unchecked-note">
            This pair has not been checked since the provider was edited, so the earlier verdict no
            longer applies. No image is analyzed until a re-check confirms it reads images.
          </p>
        )}
        {assigned && capability?.vision === null && capability.probedAt !== null && (
          <p className="text-muted-foreground text-xs" data-testid="image-analysis-unconfirmed-note">
            The provider did not answer the probe — unreachable, an authentication or rate-limit error,
            or an open breaker. That is not evidence the model is text-only. No image is analyzed
            until a re-check confirms it.
          </p>
        )}
        {assigned && capability?.vision === false && (
          <p className="text-muted-foreground text-xs" data-testid="image-analysis-text-only-note">
            This model refused the test image. Image analysis is paused until a vision-capable model is
            assigned; descriptions already indexed stay searchable.
          </p>
        )}

        {/*
          The retained identity (ADR-027 D7): the model identity the index was
          built under, which survives an unassign. Provider · model · endpoint
          · short hash — the ceiling is deliberately NOT in this row.
        */}
        {assigned && capability?.identity && (
          <p className="text-muted-foreground text-xs" data-testid="image-analysis-identity">
            <span>Index identity</span>{' '}
            <span className="text-foreground font-mono">{capability.identity.model}</span>
            {' · '}
            <span className="font-mono">{capability.identity.baseUrl}</span>
            {' · '}
            <span className="font-mono" title={capability.identity.identityHash}>
              {capability.identity.identityHash.slice(0, 12)}
            </span>
            {' · '}
            <span title={new Date(capability.identity.assignedAt).toLocaleString()}>
              adopted {formatRelativeTime(capability.identity.assignedAt)}
            </span>
          </p>
        )}
        {assigned && capability?.identityDrift && (
          <p
            className="text-status-syncing flex items-start gap-1.5 text-xs"
            role="status"
            data-testid="image-analysis-identity-drift"
          >
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              The provider&rsquo;s endpoint has moved since this identity was adopted, so analysis is
              paused and every stored description stays as it is. Re-check re-probes the new endpoint
              and, if it reads images, adopts it — which re-analyzes every image. Reverting the
              endpoint resumes without a call.
            </span>
          </p>
        )}

        {/*
          The probe error is third-party text from the provider — rendered as
          plain JSX so React escapes it, never through `dangerouslySetInnerHTML`
          or a Markdown renderer. Length-bounded server-side; the scroll cap is
          so a 600-character body cannot push the rest of the panel off-screen.
        */}
        {assigned && probeError && (
          <details className="group" data-testid="image-analysis-probe-error">
            <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs transition-colors marker:content-none focus-visible:ring-2 focus-visible:outline-none">
              <ChevronRight
                size={12}
                className="shrink-0 transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              Why this verdict?
            </summary>
            <p
              data-testid="image-analysis-probe-error-text"
              className="border-border bg-background/50 text-muted-foreground mt-1.5 max-h-32 overflow-y-auto rounded-md border px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
            >
              {probeError}
            </p>
          </details>
        )}

        {/*
          The output-token ceiling (ADR-027 D8). Its own row below the selector
          and the chip, assigned or not: it bounds a request, so it can be set
          before the model that will receive it is chosen. Prose only inside
          the described region.
        */}
        <div className="border-border mt-1 border-t pt-2">
          <NumberRow
            field={MAX_OUTPUT_TOKENS_FIELD}
            value={maxOutputTokens}
            onChange={onMaxOutputTokensChange}
            defaultValue={IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_DEFAULT}
            testIdPrefix="image-analysis"
          >
            <p>{IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_HELP}</p>
          </NumberRow>
        </div>
      </div>
    </div>
  );
}
