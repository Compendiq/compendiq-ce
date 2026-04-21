import { useState } from 'react';
import { toast } from 'sonner';
import type { LlmProvider, LlmProviderInput } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';

interface Props {
  mode: 'create' | 'edit';
  initial?: LlmProvider;
  open: boolean;
  onClose: () => void;
  onSaved: (p: LlmProvider) => void;
}

export function ProviderEditModal({ mode, initial, open, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [authType, setAuthType] = useState<'bearer' | 'none'>(initial?.authType ?? 'bearer');
  const [verifySsl, setVerifySsl] = useState(initial?.verifySsl ?? true);
  const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? '');
  const [saving, setSaving] = useState(false);
  const canSave = name.trim().length > 0 && /^https?:\/\//.test(baseUrl);

  if (!open) return null;

  async function save() {
    setSaving(true);
    try {
      const body: LlmProviderInput = {
        name,
        baseUrl,
        authType,
        verifySsl,
        defaultModel: defaultModel || null,
        ...(apiKey ? { apiKey } : {}),
      };
      const saved =
        mode === 'create'
          ? await apiFetch<LlmProvider>('/admin/llm-providers', {
              method: 'POST',
              body: JSON.stringify(body),
            })
          : await apiFetch<LlmProvider>(`/admin/llm-providers/${initial!.id}`, {
              method: 'PATCH',
              body: JSON.stringify(body),
            });
      toast.success('Saved');
      onSaved(saved);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div role="dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="glass-card w-[480px] space-y-3 p-6">
        <h2 className="text-lg font-semibold">{mode === 'create' ? 'Add provider' : 'Edit provider'}</h2>
        <label className="block text-sm">
          Name
          <input className="glass-input w-full" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-sm">
          Base URL
          <input
            className="glass-input w-full"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>
        <label className="block text-sm">
          API Key{' '}
          {initial?.hasApiKey && (
            <span className="text-success ml-2 text-xs">Configured {initial.keyPreview}</span>
          )}
          <input
            type="password"
            className="glass-input w-full"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial?.hasApiKey ? 'Replace key…' : ''}
          />
        </label>
        <div className="flex gap-4 text-sm">
          <label>
            <input
              type="radio"
              checked={authType === 'bearer'}
              onChange={() => setAuthType('bearer')}
            />{' '}
            Bearer
          </label>
          <label>
            <input
              type="radio"
              checked={authType === 'none'}
              onChange={() => setAuthType('none')}
            />{' '}
            None
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={verifySsl}
            onChange={(e) => setVerifySsl(e.target.checked)}
          />{' '}
          Verify TLS
        </label>
        <label className="block text-sm">
          Default model
          <input
            className="glass-input w-full"
            value={defaultModel ?? ''}
            onChange={(e) => setDefaultModel(e.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <button className="glass-button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="glass-button-primary"
            disabled={!canSave || saving}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
