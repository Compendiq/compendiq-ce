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
import { LlmUsecaseSchema } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { ProviderListSection } from './ProviderListSection';
import { UsecaseAssignmentsSection } from './UsecaseAssignmentsSection';
import { clampImageEmbeddingTargetDimensions } from './image-embedding-target-dimensions';
import { EmbeddingReembedBanner } from './EmbeddingReembedBanner';
import { EmbeddingShadowMigrationCard } from './EmbeddingShadowMigrationCard';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';
import { ErrorState } from '../../../shared/components/feedback/ErrorState';

// Derived from the contracts enum, NOT hand-copied: a private copy here
// omitted 'rerank' while the section component's copy had it, so the rerank
// row rendered and edited but diffUsecaseAssignments silently dropped it
// from every save (#1267 review B1). The schema is the single source.
const USECASES_ORDERED: LlmUsecase[] = [...LlmUsecaseSchema.options];

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
  // admin's control until they Save — whose onSuccess drops the guard again
  // (same reset IpAllowlistTab does) so the form re-hydrates from the fresh
  // server state.
  const [assignmentsInitialized, setAssignmentsInitialized] = useState(false);
  const [shadowMigrationActive, setShadowMigrationActive] = useState(false);
  const [capInitialized, setCapInitialized] = useState(false);
  // #1115 — the image leg's MRL truncation width. Same one-shot hydration
  // guard as the two above, and dropped by the same post-save reset so the
  // field re-seeds from the value the server actually stored.
  const [imageTargetDims, setImageTargetDims] = useState<number | null>(null);
  const [imageTargetInitialized, setImageTargetInitialized] = useState(false);

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

  // #1115 — mirror the stored truncation width once. `?? null` covers both an
  // instance that never set one and a backend older than the field.
  useEffect(() => {
    if (adminSettings && !imageTargetInitialized) {
      setImageTargetDims(adminSettings.imageEmbeddingTargetDimensions ?? null);
      setImageTargetInitialized(true);
    }
  }, [adminSettings, imageTargetInitialized]);

  const savedImageTargetDims = adminSettings?.imageEmbeddingTargetDimensions ?? null;

  const embeddingPending = useMemo(() => {
    if (!rawAssignments || !assignments) return null;
    const origE = rawAssignments.embedding;
    const nowE = assignments.embedding;
    if (origE.providerId === nowE.providerId && origE.model === nowE.model) return null;
    const draft = embeddingDraftIdentity(nowE, providers);
    if (!draft) return null;
    if (
      draft.providerId === origE.resolved.providerId &&
      draft.model === origE.resolved.model
    ) {
      return null;
    }
    return draft;
  }, [rawAssignments, assignments, providers]);

  const embeddingLive = useMemo(() => {
    const resolved = rawAssignments?.embedding.resolved;
    if (!resolved?.providerId || !resolved.model) return null;
    return { providerId: resolved.providerId, model: resolved.model };
  }, [rawAssignments]);

  const otherAssignmentsDirty = useMemo(() => {
    if (!rawAssignments || !assignments) return false;
    const diff = diffUsecaseAssignments(rawAssignments, assignments);
    delete diff.embedding;
    const nextImageTargetDims = clampImageEmbeddingTargetDimensions(imageTargetDims);
    const imageTargetChanged =
      imageTargetInitialized && nextImageTargetDims !== savedImageTargetDims;
    return Object.keys(diff).length > 0 || imageTargetChanged;
  }, [
    rawAssignments,
    assignments,
    imageTargetDims,
    imageTargetInitialized,
    savedImageTargetDims,
  ]);

  const save = useMutation<
    { ok: boolean; imageIndexWarning?: string },
    Error,
    {
      diff: UpdateUsecaseAssignmentsInput;
      imageTargetDimensions?: number | null;
      keepEmbeddingDraft?: boolean;
    }
  >({
    // #1115 — two requests, in this order and never the other. The truncation
    // width is what the probe SENDS, so it has to be stored before the
    // assignment PUT re-probes; a probe run against the old width would type
    // the column for a request the leg no longer makes.
    mutationFn: async ({ diff, imageTargetDimensions }) => {
      if (imageTargetDimensions !== undefined) {
        await apiFetch('/admin/settings', {
          method: 'PUT',
          body: JSON.stringify({ imageEmbeddingTargetDimensions: imageTargetDimensions }),
        });
      }
      if (Object.keys(diff).length === 0) return { ok: true };
      return apiFetch('/admin/llm-usecases', { method: 'PUT', body: JSON.stringify(diff) });
    },
    // #1115 review round 3 — the settings document is re-read on EVERY
    // outcome, not only success, because the two requests above are not
    // atomic: a 422 from the assignment PUT (the designed answer when the
    // probe refuses the pair) leaves the width already persisted by the
    // request before it. Invalidating only on success left
    // `savedImageTargetDims` naming the pre-save value while the server held
    // the new one, so the runbook's own remedy — "clear the field, and save
    // again" — compared the cleared field against a stale baseline, read as
    // unchanged, and reported "No changes" over a width the server still had.
    //
    // Both halves live here rather than in `onSuccess` because React Query
    // runs `onSettled` LAST: dropping the hydration guard before the refetch
    // lands re-seeds the field from the stale cache entry and then locks it
    // there. And the guard is dropped on success ONLY — after a refusal the
    // admin's typed value must survive so they can correct it in place.
    onSettled: async (_result, error) => {
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
      if (!error) setImageTargetInitialized(false);
    },
    onSuccess: async (result, variables) => {
      // Refetch the canonical assignments, then drop the one-shot hydration
      // guard so the form re-seeds from the fresh server state (#949) — the
      // same post-save reset IpAllowlistTab does. Awaiting the invalidation
      // first ensures the re-seed reads the refetched document rather than
      // the stale cache entry.
      await qc.invalidateQueries({ queryKey: ['llm-usecases'] });
      if (variables.keepEmbeddingDraft) {
        const fresh = qc.getQueryData<UsecaseAssignments>(['llm-usecases']);
        if (fresh) {
          setAssignments((prev) =>
            prev ? { ...fresh, embedding: prev.embedding } : fresh,
          );
        }
      } else {
        setAssignmentsInitialized(false);
      }
      // #355 (Finding 1, AC-3): cascade the change to consumers of the
      // resolved per-use-case default (notably the AI chat input pane in
      // AiContext.tsx) and the use-case-scoped models list. Prefix-match on
      // ['llm', 'usecase-default'] and ['llm', 'models'] invalidates every
      // use-case-keyed entry so dropdowns refresh without a hard reload.
      qc.invalidateQueries({ queryKey: ['llm', 'usecase-default'] });
      qc.invalidateQueries({ queryKey: ['llm', 'models'] });
      // #1115: the row saved but the image column's DDL did not. Amber, not
      // green — the assignment landed and the leg is misconfigured behind it,
      // and the server's sentence names the remedy (Re-check on that row).
      if (result?.imageIndexWarning) {
        toast.warning(result.imageIndexWarning);
        return;
      }
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
    onSuccess: async () => {
      // Same post-save guard reset as the assignments mutation above (#949):
      // re-hydrate the cap from the refetched settings document.
      await qc.invalidateQueries({ queryKey: ['admin-settings'] });
      setCapInitialized(false);
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
    // An unsaved embedding assignment is started from the row's re-embed
    // control, never from this Save. Writing it here would switch the live
    // model immediately, hide the re-embed card, and (on a width change)
    // fail every page against the current column.
    if (embeddingPending) delete diff.embedding;
    // Clamped BEFORE the comparison, not only before the request: a typed 32
    // against a stored 64 is not a change once the clamp has run, and diffing
    // the raw value would re-send the assignment and re-probe for a width the
    // server already holds. The field clamps on blur too — this is the backstop
    // for a save reached without one, and the clamp is idempotent.
    const nextImageTargetDims = clampImageEmbeddingTargetDimensions(imageTargetDims);
    const imageTargetChanged =
      imageTargetInitialized && nextImageTargetDims !== savedImageTargetDims;
    if (Object.keys(diff).length === 0 && !imageTargetChanged) {
      toast.message('No changes');
      return;
    }
    // #1115 — a changed truncation width IS a change to the image leg, so it
    // re-sends the saved assignment when the admin did not touch the
    // dropdowns. Without this the width lands in `admin_settings` and nothing
    // re-probes: the column keeps its old type while every later call asks for
    // the new one, and the operator has to discover that Re-check is the
    // second half of a save they thought they had finished.
    const savedImageProvider = rawAssignments.image_embedding?.providerId ?? null;
    if (imageTargetChanged && !diff.image_embedding && savedImageProvider) {
      diff.image_embedding = { providerId: savedImageProvider };
    }
    save.mutate({
      diff,
      keepEmbeddingDraft: embeddingPending !== null,
      ...(imageTargetChanged ? { imageTargetDimensions: nextImageTargetDims } : {}),
    });
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
      {/* Muted, not amber: this is a permanent scope note with nothing to act
          on, and amber is reserved for warnings that genuinely need attention
          — a banner that is always amber teaches users to ignore amber. */}
      <div className="nm-card p-3 text-sm text-muted-foreground">
        LLM provider + per-use-case assignments are shared across all users. Only admins can change them here.
      </div>
      <ProviderListSection />
      <UsecaseAssignmentsSection
        assignments={assignments}
        savedAssignments={rawAssignments}
        providers={providers}
        onChange={setAssignments}
        imageTargetDimensions={imageTargetDims}
        onImageTargetDimensionsChange={setImageTargetDims}
        embeddingAction={
          <div className="space-y-2">
            <EmbeddingShadowMigrationCard
              pending={embeddingPending}
              // A swap writes an EXPLICIT (provider, model) pair server-side, and
              // without re-seeding, the local copy stays frozen on the admin's
              // pre-start edit — an inherit-shaped one then reads as a fresh "model
              // changed" the moment the swap succeeds, re-raising the destructive
              // re-embed banner over a completed migration (review r7).
              //
              // Only the EMBEDDING row is re-seeded, not the whole document
              // (review r8): dropping the #949 hydration guard wholesale would
              // silently revert unsaved edits to the other four use cases, which is
              // the exact invariant that guard exists to protect. The embedding row
              // has no unsaved edits worth keeping — it is pinned server-side for
              // the duration, so a PUT touching it is refused with a 409.
              onActiveChange={setShadowMigrationActive}
              onLifecycleChange={() => {
                const fresh = qc.getQueryData<UsecaseAssignments>(['llm-usecases']);
                if (fresh) {
                  setAssignments((prev) => (prev ? { ...prev, embedding: fresh.embedding } : prev));
                }
              }}
            />
            {/* Suppressed while a shadow migration exists (review r9): `pending`
                stays non-null for the whole migration — the assignment PUT is
                deliberately 409'd, so the admin's edit is never saved — and the
                destructive path would otherwise sit under the shadow card
                offering the same intent the card is mid-way through serving. */}
            {!shadowMigrationActive && (
              <EmbeddingReembedBanner
                currentDimensions={adminSettings?.embeddingDimensions ?? 1024}
                pending={embeddingPending}
                live={embeddingLive}
              />
            )}
          </div>
        }
      />
      <div className="space-y-2">
        {embeddingPending && (
          <p
            id="usecase-save-embedding-hint"
            data-testid="usecase-save-embedding-hint"
            className="text-xs text-muted-foreground"
          >
            Start the re-embed from the Embedding row. Saving would switch the live model
            before the index is ready.
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            className={
              embeddingPending && otherAssignmentsDirty ? 'nm-button-ghost' : 'nm-button-primary'
            }
            disabled={save.isPending || (embeddingPending !== null && !otherAssignmentsDirty)}
            onClick={handleSave}
            {...(embeddingPending
              ? { 'aria-describedby': 'usecase-save-embedding-hint' }
              : {})}
          >
            {save.isPending
              ? 'Saving…'
              : embeddingPending && otherAssignmentsDirty
                ? 'Save other use-case assignments'
                : 'Save use-case assignments'}
          </button>
        </div>
      </div>

      {/* Runtime limits — per-user concurrent-SSE-stream cap (#268) */}
      <div className="nm-card space-y-4 p-4">
        <div>
          <h3 className="text-base font-semibold">Runtime limits</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Bounds on how AI streams are served. Changes take effect within 60 seconds.
          </p>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
          <div className="max-w-xl">
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
            className="w-24 rounded-[var(--radius-md)] border border-border bg-background px-3 py-1.5 text-right text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
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

function embeddingDraftIdentity(
  now: UsecaseAssignments['embedding'],
  providers: LlmProvider[],
): { providerId: string; model: string } | null {
  if (now.providerId) {
    const selectedDefault = providers.find((p) => p.id === now.providerId)?.defaultModel ?? null;
    const model = now.model ?? selectedDefault;
    if (!model) return null;
    return { providerId: now.providerId, model };
  }
  const fallback = providers.find((p) => p.isDefault);
  if (!fallback?.id || !fallback.defaultModel) return null;
  return { providerId: fallback.id, model: fallback.defaultModel };
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
