import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, Loader2, RefreshCw } from 'lucide-react';
import type { VisionCapabilityDetail } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { formatRelativeTime } from '../../../shared/lib/format-relative-time';
import { VisionBadge } from '../../../shared/components/badges/VisionBadge';

/**
 * #1184: the capability verdict for the `chat` model, with the two things the
 * badge alone could not give an admin — when it was established, and why.
 *
 * Before this, a wrong verdict had exactly two remedies, neither discoverable:
 * re-saving the same use-case assignment (which fires a probe as a side
 * effect), or reading `llm_model_capabilities.probe_error` in psql. A `false`
 * verdict is cached for 30 days, so that window was the only thing bounding a
 * misclassification.
 *
 * The verdict itself comes from the caller, which reads the resolved default
 * shared with the AI chat pane. Only the evidence — `probedAt`, `probeError` —
 * comes from the admin route, because the probe error is the provider's own
 * error body and `GET /llm/usecase-default` is not admin-gated.
 */

const CAPABILITY_QUERY_KEY = ['llm-usecases', 'chat', 'vision-capability'] as const;

/** Copy for the toast, which reports a verdict the badge may not visibly change. */
const RESULT_MESSAGE: Record<'yes' | 'no' | 'unknown', string> = {
  yes: 'Image support confirmed — this model reads images.',
  no: 'This model refused the test image. Image attachments stay disabled.',
  unknown: "Couldn't establish image support. See why this verdict below.",
};

export function ChatVisionCapability({ vision }: { vision: boolean | null }) {
  const qc = useQueryClient();

  // Prefix-matched by LlmTab's post-save `invalidateQueries(['llm-usecases'])`,
  // so saving a new chat assignment refreshes this alongside the assignments
  // document. A pure cache read on the server — it never costs a probe.
  const { data: capability } = useQuery<VisionCapabilityDetail>({
    queryKey: CAPABILITY_QUERY_KEY,
    queryFn: () => apiFetch('/admin/llm-usecases/chat/vision-capability'),
    retry: false,
  });

  const recheck = useMutation<VisionCapabilityDetail>({
    mutationFn: () => apiFetch('/admin/llm-usecases/chat/reprobe-vision', { method: 'POST' }),
    onSuccess: (result) => {
      // Same pair the save handler in LlmTab invalidates: the assignments
      // document (which this component's own query hangs off) and every
      // use-case-keyed resolved default, notably the AI chat pane's.
      qc.invalidateQueries({ queryKey: ['llm-usecases'] });
      qc.invalidateQueries({ queryKey: ['llm', 'usecase-default'] });
      toast.success(
        RESULT_MESSAGE[result.vision === true ? 'yes' : result.vision === false ? 'no' : 'unknown'],
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const probeError = capability?.probeError ?? null;

  return (
    // Indented to the assignment grid's second column, so the strip reads as
    // detail belonging to the row above rather than a sixth use case.
    <div className="grid grid-cols-[140px_1fr] gap-2">
      <span aria-hidden="true" />
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="text-muted-foreground">Image support</span>
          <VisionBadge vision={vision} />

          {/*
            Shown for every verdict, not only the non-`true` ones: a "Vision"
            badge probed four months ago is the case an admin most needs to be
            able to see, and it looks identical to a fresh one otherwise.
          */}
          {capability && (
            <span
              data-testid="vision-probed-at"
              className="text-muted-foreground"
              title={capability.probedAt ? new Date(capability.probedAt).toLocaleString() : undefined}
            >
              {capability.probedAt
                ? `Checked ${formatRelativeTime(capability.probedAt)}`
                : 'Never checked'}
            </span>
          )}

          <button
            type="button"
            data-testid="vision-recheck"
            // Probing is a blocking chat completion through the LLM queue and
            // the per-provider breaker. It is usually quick (`maxTokens: 64`)
            // but a queued request can take many seconds, so the control says
            // what it is doing rather than appearing inert.
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

        {/*
          The probe error is third-party text from the provider — rendered as
          plain JSX so React escapes it, never through `dangerouslySetInnerHTML`
          or a Markdown renderer. It is already length-bounded server-side; the
          scroll cap here is so a 600-character body cannot push the rest of
          the panel off-screen. Behind a disclosure because it is diagnostic
          detail, not something to read on every visit.
        */}
        {probeError && (
          <details className="group" data-testid="vision-probe-error">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs text-muted-foreground transition-colors marker:content-none hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
              <ChevronRight
                size={12}
                className="shrink-0 transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              Why this verdict?
            </summary>
            <p
              data-testid="vision-probe-error-text"
              className="mt-1.5 max-h-32 overflow-y-auto rounded-md border border-border bg-background/50 px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
            >
              {probeError}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
