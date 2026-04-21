import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
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

const USECASES_ORDERED: LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag', 'embedding'];

export function LlmTab() {
  const qc = useQueryClient();
  const { data: providers = [] } = useQuery<LlmProvider[]>({
    queryKey: ['llm-providers'],
    queryFn: () => apiFetch('/admin/llm-providers'),
  });
  const { data: rawAssignments, isLoading: assignmentsLoading } = useQuery<UsecaseAssignments>({
    queryKey: ['llm-usecases'],
    queryFn: () => apiFetch('/admin/llm-usecases'),
  });
  const { data: dims } = useQuery<{ dimensions: number }>({
    queryKey: ['embedding-dimensions'],
    queryFn: () => apiFetch('/admin/embedding/dimensions'),
    // This endpoint may not exist in every deployment; on 404 fall back to
    // the legacy 1024-dim default rather than blocking the tab.
    retry: false,
  });

  const [assignments, setAssignments] = useState<UsecaseAssignments | null>(null);

  // Mirror the server-provided assignments once per load. Using useEffect
  // keeps the setState out of render (avoids an infinite update loop).
  useEffect(() => {
    if (rawAssignments) setAssignments(rawAssignments);
  }, [rawAssignments]);

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
      toast.success('Use-case assignments saved');
    },
    onError: (e: Error) => toast.error(e.message),
  });

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

  return (
    <div className="space-y-6">
      <div className="glass-card border-yellow-500/30 p-3 text-sm text-yellow-400">
        LLM provider + per-use-case assignments are shared across all users. Only admins can change them here.
      </div>
      <ProviderListSection />
      <EmbeddingReembedBanner
        currentDimensions={dims?.dimensions ?? 1024}
        pending={embeddingPending}
      />
      <UsecaseAssignmentsSection
        assignments={assignments}
        providers={providers}
        onChange={setAssignments}
      />
      <div className="flex gap-3">
        <button
          className="glass-button-primary"
          disabled={save.isPending}
          onClick={handleSave}
        >
          {save.isPending ? 'Saving…' : 'Save use-case assignments'}
        </button>
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

export { LlmTab as OllamaTab };
