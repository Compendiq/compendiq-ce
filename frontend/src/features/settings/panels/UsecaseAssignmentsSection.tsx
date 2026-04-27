import { useQuery } from '@tanstack/react-query';
import type { LlmProvider, LlmUsecase, UsecaseAssignments } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

const USECASE_LABELS: Record<LlmUsecase, string> = {
  chat: 'Chat',
  summary: 'Summary worker',
  quality: 'Quality worker',
  auto_tag: 'Auto-tag',
  embedding: 'Embedding',
};
const USECASES_ORDERED: LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag', 'embedding'];

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface Props {
  assignments: UsecaseAssignments;
  providers: LlmProvider[];
  onChange: (next: UsecaseAssignments) => void;
}

export function UsecaseAssignmentsSection({ assignments, providers, onChange }: Props) {
  function update(u: LlmUsecase, patch: Partial<UsecaseAssignments[LlmUsecase]>) {
    onChange({ ...assignments, [u]: { ...assignments[u], ...patch } });
  }
  return (
    <div className="border-border/50 space-y-2 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Use case assignments</h3>
      {USECASES_ORDERED.map((u) => {
        const row = assignments[u];
        const effectiveProviderId = row.providerId ?? row.resolved.providerId;
        return (
          <div key={u} className="grid grid-cols-[140px_180px_1fr_auto] items-center gap-2">
            <span className="flex items-center gap-1 text-sm font-medium">
              {USECASE_LABELS[u]}
              {u === 'embedding' && (
                <span title="Changing requires re-embedding all pages" aria-label="embedding-warning">
                  ⚠
                </span>
              )}
            </span>
            <select
              className="nm-input"
              value={row.providerId ?? ''}
              onChange={(e) => update(u, { providerId: e.target.value || null })}
              data-testid={`usecase-${u}-provider`}
            >
              <option value="">Inherit default</option>
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
            <span className="text-muted-foreground text-xs">
              → {row.resolved.providerName} / {row.resolved.model || '(none)'}
            </span>
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
      className="nm-input"
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
