import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { LlmProvider } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { ProviderEditModal } from './ProviderEditModal';

export function ProviderListSection() {
  const qc = useQueryClient();
  const { data: providers = [], isLoading } = useQuery<LlmProvider[]>({
    queryKey: ['llm-providers'],
    queryFn: () => apiFetch('/admin/llm-providers'),
  });
  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [adding, setAdding] = useState(false);

  const setDefault = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/llm-providers/${id}/set-default`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['llm-providers'] });
      toast.success('Default updated');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/llm-providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['llm-providers'] });
      toast.success('Provider deleted');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ connected: boolean; error?: string; sampleModelsCount: number }>(
        `/admin/llm-providers/${id}/test`,
        { method: 'POST' },
      ),
    onSuccess: (r) =>
      toast[r.connected ? 'success' : 'error'](
        r.connected ? `Connected (${r.sampleModelsCount} models)` : (r.error ?? 'Connection failed'),
      ),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Providers</h3>
        <button className="glass-button-primary" onClick={() => setAdding(true)}>
          + Add
        </button>
      </div>
      {isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> : null}
      <ul className="divide-border/40 divide-y">
        {providers.map((p) => (
          <li key={p.id} className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm font-medium">
                {p.name}{' '}
                {p.isDefault && (
                  <span className="bg-primary/15 text-primary ml-2 rounded px-1.5 text-xs">
                    default
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-xs">{p.baseUrl}</div>
            </div>
            <div className="flex gap-2 text-xs">
              <button onClick={() => setEditing(p)}>Edit</button>
              <button onClick={() => setDefault.mutate(p.id)} disabled={p.isDefault}>
                Set default
              </button>
              <button onClick={() => test.mutate(p.id)}>Test</button>
              <button onClick={() => del.mutate(p.id)} disabled={p.isDefault}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <ProviderEditModal
        mode="create"
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={() => qc.invalidateQueries({ queryKey: ['llm-providers'] })}
      />
      {editing && (
        <ProviderEditModal
          mode="edit"
          initial={editing}
          open
          onClose={() => setEditing(null)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['llm-providers'] })}
        />
      )}
    </div>
  );
}
