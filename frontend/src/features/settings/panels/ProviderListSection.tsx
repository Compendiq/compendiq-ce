import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { LlmProvider } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { ProviderEditModal } from './ProviderEditModal';

/** Quiet inline action in a settings row — ordinary, reversible. */
const ROW_ACTION =
  'rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45';

/** The same row, but destructive. See `nm-action-destructive` in index.css. */
const DESTRUCTIVE_ROW_ACTION = 'nm-action-destructive rounded-md px-2 py-1';

export function ProviderListSection() {
  const qc = useQueryClient();
  const { data: providers = [], isLoading } = useQuery<LlmProvider[]>({
    queryKey: ['llm-providers'],
    queryFn: () => apiFetch('/admin/llm-providers'),
  });
  const [editing, setEditing] = useState<LlmProvider | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
    onSettled: () => setConfirmDeleteId(null),
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
        <button className="nm-button-primary" onClick={() => setAdding(true)}>
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
                  <span className="ml-2 rounded bg-muted px-1.5 text-xs text-muted-foreground">
                    default
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-xs">{p.baseUrl}</div>
            </div>
            {/* These four were bare, unstyled <button>s, so `Delete` carried
                exactly the weight of `Edit` beside it — the least guarded
                destructive control in the app. The ordinary actions are quiet
                ghost text; Delete takes the shared destructive treatment. */}
            <div className="flex items-center gap-1 text-xs">
              <button className={ROW_ACTION} onClick={() => setEditing(p)}>Edit</button>
              <button
                className={ROW_ACTION}
                onClick={() => setDefault.mutate(p.id)}
                disabled={p.isDefault || (setDefault.isPending && setDefault.variables === p.id)}
              >
                {setDefault.isPending && setDefault.variables === p.id ? 'Setting…' : 'Set default'}
              </button>
              <button
                className={ROW_ACTION}
                onClick={() => test.mutate(p.id)}
                disabled={test.isPending && test.variables === p.id}
              >
                {test.isPending && test.variables === p.id ? 'Testing…' : 'Test'}
              </button>
              {confirmDeleteId === p.id ? (
                <>
                  <button
                    // Was `text-error`, which is not a class this project
                    // defines — the one moment the UI meant to turn red, it
                    // rendered as plain text.
                    className={DESTRUCTIVE_ROW_ACTION}
                    onClick={() => del.mutate(p.id)}
                    disabled={del.isPending && del.variables === p.id}
                  >
                    {del.isPending && del.variables === p.id ? 'Deleting…' : 'Confirm delete'}
                  </button>
                  <button className={ROW_ACTION} onClick={() => setConfirmDeleteId(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  className={DESTRUCTIVE_ROW_ACTION}
                  onClick={() => setConfirmDeleteId(p.id)}
                  disabled={p.isDefault}
                >
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {adding && (
        <ProviderEditModal
          mode="create"
          open
          onClose={() => setAdding(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['llm-providers'] })}
        />
      )}
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
