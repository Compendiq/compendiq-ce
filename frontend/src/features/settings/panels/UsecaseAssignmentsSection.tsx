import { useQuery } from '@tanstack/react-query';
import type { LlmProvider, LlmUsecase, UsecaseAssignments, UsecaseDefault } from '@compendiq/contracts';
import { LlmUsecaseSchema } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { ChatVisionCapability } from './ChatVisionCapability';
import { ImageEmbeddingCapability } from './ImageEmbeddingCapability';

const USECASE_LABELS: Record<LlmUsecase, string> = {
  chat: 'Chat',
  summary: 'Summary worker',
  quality: 'Quality worker',
  auto_tag: 'Auto-tag',
  embedding: 'Embedding',
  rerank: 'Rerank',
  image_embedding: 'Image embedding',
};
const USECASES_ORDERED: LlmUsecase[] = [...LlmUsecaseSchema.options];

/**
 * The use cases that never inherit the default provider (#1104, #1115). Their
 * "unset" option says **Disabled**, because there is no fallback behind it —
 * offering "Inherit default" would name a resolution that does not happen.
 */
const NON_INHERITING: Record<string, string> = {
  rerank: 'Disabled (no reranking)',
  image_embedding: 'Disabled (no image search)',
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface Props {
  assignments: UsecaseAssignments;
  /**
   * The SERVER's document, not the edited copy. #1115's probe strip describes a
   * live, saved leg and its Re-check posts to a route that resolves the saved
   * assignment — reading the draft made picking a provider in the dropdown fire
   * an admin probe and render a Re-check button that 404s, and clearing it hid a
   * strip still describing a working leg (review round 1). Same rule
   * `RetrievalTab`'s calibration notices already follow.
   */
  savedAssignments: UsecaseAssignments;
  providers: LlmProvider[];
  onChange: (next: UsecaseAssignments) => void;
  /**
   * #1115 — the image leg's MRL truncation width
   * (`admin_settings.image_embedding_target_dimensions`). It is not a use-case
   * assignment, so it rides through this section rather than living in it: the
   * control belongs beside the row it changes, and the value belongs with the
   * panel's Save, which writes it before re-probing the assignment.
   */
  imageTargetDimensions: number | null;
  onImageTargetDimensionsChange: (next: number | null) => void;
}

export function UsecaseAssignmentsSection({
  assignments,
  savedAssignments,
  providers,
  onChange,
  imageTargetDimensions,
  onImageTargetDimensionsChange,
}: Props) {
  function update(u: LlmUsecase, patch: Partial<UsecaseAssignments[LlmUsecase]>) {
    onChange({ ...assignments, [u]: { ...assignments[u], ...patch } });
  }
  // #1154: reads the already-resolved chat verdict rather than probing —
  // same queryKey AiContext.tsx uses for the chat input pane, so this shares
  // that cache entry (no extra request) and LlmTab's save handler already
  // invalidates the ['llm', 'usecase-default'] prefix on assignment changes.
  // Deliberately scoped to `chat` only: badging every ModelPicker option
  // would fire one vision probe per model on mount.
  //
  // `staleTime` matches AiContext's observer on the same key. Two observers of
  // one key do not each get their own stale time — the cache entry takes the
  // configuration of whichever observer is active — so leaving it at the
  // default here would mean the badge's options silently decide refetch
  // scheduling for the chat pane whenever AiContext's instance unmounts first.
  const { data: chatDefault } = useQuery<UsecaseDefault>({
    queryKey: ['llm', 'usecase-default', 'chat'],
    queryFn: () => apiFetch('/llm/usecase-default?usecase=chat'),
    retry: false,
    staleTime: 30_000,
  });
  return (
    <div className="border-border space-y-2 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Use case assignments</h3>
      {USECASES_ORDERED.map((u) => {
        const row = assignments[u];
        // A frontend bundle newer than the backend (rolling deploy, cached
        // SPA) can receive a document without a newly added use case; an
        // unguarded row.providerId would throw during render and take the
        // whole route's error boundary with it (#1267 verification, 9).
        if (!row) return null;
        const effectiveProviderId = row.providerId ?? row.resolved.providerId;
        // #1104: assigned-but-unresolvable — a provider is chosen but the
        // server could not resolve a model for the stage (rerank with no
        // model anywhere). Without this, the row looks configured while the
        // stage is silently disabled. #1115's image leg has the same state,
        // for the same reason: neither inherits, so neither has a fallback to
        // fall back to.
        const assignedButUnresolvable =
          u in NON_INHERITING && row.providerId !== null && row.resolved.providerId === NIL_UUID;
        return (
          <div key={u} data-testid={`usecase-row-${u}`} className="space-y-1.5">
            <div className="grid grid-cols-[140px_180px_1fr_auto] items-center gap-2">
              <span className="flex items-center gap-1 text-sm font-medium">
                {USECASE_LABELS[u]}
                {u === 'embedding' && (
                  <span title="Changing requires re-embedding all pages" aria-label="embedding-warning">
                    ⚠
                  </span>
                )}
                {u === 'rerank' && (
                  <span
                    title="Needs a Cohere/Jina-style /v1/rerank endpoint (llama.cpp's llama-server --rerank serves it; TEI's bare /rerank shape is NOT compatible). Leaving it unassigned disables the rerank stage — it never falls back to the default provider."
                    aria-label="rerank-info"
                    className="text-muted-foreground"
                  >
                    ⓘ
                  </span>
                )}
              </span>
              <select
                className="nm-select-md"
                value={row.providerId ?? ''}
                onChange={(e) => update(u, { providerId: e.target.value || null })}
                data-testid={`usecase-${u}-provider`}
              >
                <option value="">{NON_INHERITING[u] ?? 'Inherit default'}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ModelPicker
                providerId={effectiveProviderId}
                value={row.model}
                onChange={(m) => update(u, { model: m })}
                testId={`usecase-${u}-model`}
                inheritLabel="Inherit provider's model"
              />
              <span className="flex items-center gap-2 text-muted-foreground text-xs">
                {assignedButUnresolvable
                  ? '→ not resolvable'
                  : `→ ${row.resolved.providerName} / ${row.resolved.model || '(none)'}`}
              </span>
            </div>
            {assignedButUnresolvable && (
              <p className="text-status-syncing text-xs" data-testid={`usecase-${u}-unresolvable`}>
                Assigned, but no model resolves — {USECASE_LABELS[u].toLowerCase()} is disabled.
                Pick a model, or set a default model on the provider.
              </p>
            )}
            {/*
              #1184: the capability affordances sit on their own line under the
              chat row. The badge alone fitted in the resolved column; the badge
              plus a timestamp, a re-check button and a disclosure does not, and
              cramming them there would have squeezed the four columns the other
              use cases share.
            */}
            {u === 'chat' && chatDefault && <ChatVisionCapability vision={chatDefault.vision} />}
            {/*
              #1115: the image leg's strip is always rendered, not only when
              assigned — its two sentences are what tell an operator whether
              this row is even usable on their stack, and the probe status
              inside it is gated on the assignment instead.

              On the SAVED assignment, never `row` (the draft): the probe route
              and Re-check both resolve what the server has, so a dropdown
              change that has not been saved must not fire either.
            */}
            {u === 'image_embedding' && (
              <ImageEmbeddingCapability
                assigned={savedAssignments[u]?.providerId != null}
                targetDimensions={imageTargetDimensions}
                onTargetDimensionsChange={onImageTargetDimensionsChange}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ModelPicker({
  providerId,
  value,
  onChange,
  testId,
  inheritLabel,
}: {
  providerId: string;
  value: string | null;
  onChange: (m: string | null) => void;
  testId: string;
  inheritLabel: string;
}) {
  const { data: models = [] } = useQuery<{ name: string }[]>({
    queryKey: ['provider-models', providerId],
    queryFn: () => apiFetch(`/admin/llm-providers/${providerId}/models`),
    enabled: !!providerId && providerId !== NIL_UUID,
  });
  return (
    <select
      className="nm-select-md"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      data-testid={testId}
    >
      <option value="">{inheritLabel}</option>
      {models.map((m) => (
        <option key={m.name} value={m.name}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
