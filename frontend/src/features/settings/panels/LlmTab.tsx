import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AdminSettings,
  LlmProvider,
  LlmUsecase,
  UsecaseAssignments,
  UpdateUsecaseAssignmentsInput,
} from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { ProviderListSection } from './ProviderListSection';
import { UsecaseAssignmentsSection } from './UsecaseAssignmentsSection';
import { EmbeddingReembedBanner } from './EmbeddingReembedBanner';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';
import { ErrorState } from '../../../shared/components/feedback/ErrorState';

const USECASES_ORDERED: LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag', 'embedding'];

/** Default when the server response omits `llmMaxConcurrentStreamsPerUser`. */
const DEFAULT_CONCURRENT_STREAMS_CAP = 3;
const MIN_CONCURRENT_STREAMS_CAP = 1;
const MAX_CONCURRENT_STREAMS_CAP = 20;

export function LlmTab() {
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery<LlmProvider[]>({
    queryKey: ['llm-providers'],
    queryFn: () => apiFetch('/admin/llm-providers'),
  });
  const {
    data: rawAssignments,
    isLoading: assignmentsLoading,
    isError: assignmentsError,
    error: assignmentsErrorObj,
    refetch: refetchAssignments,
  } = useQuery<UsecaseAssignments>({
    queryKey: ['llm-usecases'],
    queryFn: () => apiFetch('/admin/llm-usecases'),
  });
  // Shared admin-settings document (same ['admin-settings'] cache entry as
  // EmbeddingTab). Read-only source for `embeddingDimensions` (current vector
  // width shown in the re-embed banner) and `llmMaxConcurrentStreamsPerUser`.
  // Other fields (rate limits, AI safety) are managed elsewhere and are left
  // untouched when we PUT.
  const { data: adminSettings } = useQuery<AdminSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  const [assignments, setAssignments] = useState<UsecaseAssignments | null>(null);
  // Per-user concurrent SSE-stream cap (#268). Separate local state so edits
  // to the number input don't round-trip through TanStack Query on every
  // keystroke. Default to 3 when the server omits the field.
  const [concurrentStreamsCap, setConcurrentStreamsCap] = useState<number>(
    DEFAULT_CONCURRENT_STREAMS_CAP,
  );
  // One-shot hydration guards (#949). A background refetch (window focus, or a
  // concurrent admin save) returns a new object whenever its payload differs
  // from cache, and re-seeding on every reference change would silently revert
  // the admin's unsaved edits. Seed each form once, then leave it under the
  // admin's control until they Save (which invalidates + re-mounts the data).
  const [assignmentsInitialized, setAssignmentsInitialized] = useState(false);
  const [capInitialized, setCapInitialized] = useState(false);

  // Mirror the server-provided assignments once per load. Using useEffect
  // keeps the setState out of render (avoids an infinite update loop).
  useEffect(() => {
    if (rawAssignments && !assignmentsInitialized) {
      setAssignments(rawAssignments);
      setAssignmentsInitialized(true);
    }
  }, [rawAssignments, assignmentsInitialized]);

  // Mirror the server-provided concurrent-streams cap. Falls back to 3 when
  // the field is absent (legacy backend that has not yet been migrated).
  useEffect(() => {
    if (adminSettings && !capInitialized) {
      setConcurrentStreamsCap(
        adminSettings.llmMaxConcurrentStreamsPerUser ?? DEFAULT_CONCURRENT_STREAMS_CAP,
      );
      setCapInitialized(true);
    }
  }, [adminSettings, capInitialized]);

  const embeddingPending = useMemo(() => {
    if (!rawAssignments || !assignments) return null;
    const origE = rawAssignments.embedding;
    const nowE = assignments.embedding;
    if (origE.providerId === nowE.providerId && origE.model === nowE.model) return null;
    const providerId = nowE.providerId ?? nowE.resolved.providerId;
    const model = nowE.model ?? nowE.resolved.model;
    if (!providerId || !model) return null;
    return { providerId, model };
  }, [rawAssignments, assignments]);

  const save = useMutation({
    mutationFn: (diff: UpdateUsecaseAssignmentsInput) =>
      apiFetch('/admin/llm-usecases', { method: 'PUT', body: JSON.stringify(diff) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['llm-usecases'] });
      // #355 (Finding 1, AC-3): cascade the change to consumers of the
      // resolved per-use-case default (notably the AI chat input pane in
      // AiContext.tsx) and the use-case-scoped models list. Prefix-match on
      // ['llm', 'usecase-default'] and ['llm', 'models'] invalidates every
      // use-case-keyed entry so dropdowns refresh without a hard reload.
      qc.invalidateQueries({ queryKey: ['llm', 'usecase-default'] });
      qc.invalidateQueries({ queryKey: ['llm', 'models'] });
      toast.success('Use-case assignments saved');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Runtime-limits mutation is deliberately separate from the use-case save
  // so admins can update concurrency without implicitly re-applying other
  // in-flight edits.
  const saveRuntimeLimits = useMutation({
    mutationFn: (body: { llmMaxConcurrentStreamsPerUser: number }) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Runtime limits updated (takes effect within 60 seconds)');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const currentCapOnServer =
    adminSettings?.llmMaxConcurrentStreamsPerUser ?? DEFAULT_CONCURRENT_STREAMS_CAP;
  const runtimeLimitsDirty = concurrentStreamsCap !== currentCapOnServer;

  // A failed assignments query must surface a distinct, retryable error —
  // otherwise a 500/network failure falls through to the skeleton guard
  // below and renders an infinite loading state with no message.
  if (assignmentsError) {
    return (
      <ErrorState
        title="Couldn't load use-case assignments"
        description={
          assignmentsErrorObj instanceof Error
            ? assignmentsErrorObj.message
            : undefined
        }
        onRetry={() => refetchAssignments()}
        testId="llm-tab-error"
        retryTestId="llm-tab-retry"
      />
    );
  }

  if (assignmentsLoading || !assignments || !rawAssignments) {
    return <SkeletonFormFields />;
  }

  function handleSave() {
    if (!assignments || !rawAssignments) return;
    const diff = diffUsecaseAssignments(rawAssignments, assignments);
    if (Object.keys(diff).length === 0) {
      toast.message('No changes');
      return;
    }
    save.mutate(diff);
  }

  function handleSaveRuntimeLimits() {
    // Clamp before sending so browsers that ignore min/max don't trip Zod 400s.
    const clamped = Math.max(
      MIN_CONCURRENT_STREAMS_CAP,
      Math.min(MAX_CONCURRENT_STREAMS_CAP, concurrentStreamsCap),
    );
    saveRuntimeLimits.mutate({ llmMaxConcurrentStreamsPerUser: clamped });
  }

  return (
    <div className="space-y-6">
      <div className="nm-card border-yellow-500/30 p-3 text-sm text-yellow-400">
        LLM provider + per-use-case assignments are shared across all users. Only admins can change them here.
      </div>
      <ProviderListSection />
      <EmbeddingReembedBanner
        // Legacy 1024-dim default while settings load or on older backends
        // whose payload predates the field.
        currentDimensions={adminSettings?.embeddingDimensions ?? 1024}
        pending={embeddingPending}
      />
      <UsecaseAssignmentsSection
        assignments={assignments}
        providers={providers}
        onChange={setAssignments}
      />
      <div className="flex gap-3">
        <button
          className="nm-button-primary"
          disabled={save.isPending}
          onClick={handleSave}
        >
          {save.isPending ? 'Saving…' : 'Save use-case assignments'}
        </button>
      </div>

      {/* Runtime limits — per-user concurrent-SSE-stream cap (#268) */}
      <div className="nm-card space-y-4 p-4">
        <div>
          <h3 className="text-base font-semibold">Runtime limits</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Bounds on how AI streams are served. Changes take effect within 60 seconds.
          </p>
        </div>
        <div className="rounded-lg border border-border/30 bg-background/50 p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <label
                htmlFor="llm-max-concurrent-streams-per-user"
                className="text-sm font-medium"
              >
                Max concurrent AI streams per user
              </label>
              <p className="text-xs text-muted-foreground">
                Rejects additional streams with HTTP 429 once a user has this many open. Lowering
                the cap takes effect for newly opened streams; in-flight streams continue to
                completion.
              </p>
            </div>
            <input
              id="llm-max-concurrent-streams-per-user"
              data-testid="llm-max-concurrent-streams-per-user"
              type="number"
              min={MIN_CONCURRENT_STREAMS_CAP}
              max={MAX_CONCURRENT_STREAMS_CAP}
              value={concurrentStreamsCap}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (Number.isFinite(v)) {
                  setConcurrentStreamsCap(
                    Math.max(
                      MIN_CONCURRENT_STREAMS_CAP,
                      Math.min(MAX_CONCURRENT_STREAMS_CAP, v),
                    ),
                  );
                }
              }}
              className="w-24 rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-right text-sm outline-none focus:ring-1 focus:ring-primary/30"
            />
          </div>
        </div>
        <div className="flex gap-3">
          <button
            data-testid="llm-runtime-limits-save"
            className="nm-button-primary"
            disabled={!runtimeLimitsDirty || saveRuntimeLimits.isPending}
            onClick={handleSaveRuntimeLimits}
          >
            {saveRuntimeLimits.isPending ? 'Saving…' : 'Save runtime limits'}
          </button>
        </div>
      </div>
    </div>
  );
}

function diffUsecaseAssignments(
  original: UsecaseAssignments,
  current: UsecaseAssignments,
): UpdateUsecaseAssignmentsInput {
  const diff: UpdateUsecaseAssignmentsInput = {};
  for (const u of USECASES_ORDERED) {
    const orig = original[u];
    const curr = current[u];
    const patch: { providerId?: string | null; model?: string | null } = {};
    const origProvider = orig.providerId ?? null;
    const currProvider = curr.providerId ?? null;
    if (origProvider !== currProvider) patch.providerId = currProvider;
    const origModel = orig.model ?? null;
    const currModel = curr.model ?? null;
    if (origModel !== currModel) patch.model = currModel;
    if (Object.keys(patch).length > 0) diff[u] = patch;
  }
  return diff;
}
