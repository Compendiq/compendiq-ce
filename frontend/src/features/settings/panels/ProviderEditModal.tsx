import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { LlmProvider, LlmProviderInput } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { Button } from '../../../shared/components/Button';
import {
  PROVIDER_PRESETS,
  type ProviderPreset,
  type ProviderPresetId,
  presetById,
  presetWouldOverwrite,
} from './provider-presets';

type ProviderProbeResult = {
  connected: boolean;
  error?: string;
  models?: string[];
  sampleModelsCount?: number;
};

function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
}

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
  const [presetId, setPresetId] = useState<ProviderPresetId>('custom');
  const [pendingPresetId, setPendingPresetId] = useState<ProviderPresetId | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<ProviderProbeResult | null>(null);
  const canSave = name.trim().length > 0 && /^https?:\/\//.test(baseUrl);
  const canTest =
    /^https?:\/\//.test(baseUrl) &&
    (authType === 'none' || apiKey.trim().length > 0 || Boolean(initial?.hasApiKey));
  const listedModels = probe?.connected ? (probe.models ?? []) : [];
  const nameRef = useRef<HTMLInputElement>(null);
  const presetSelectRef = useRef<HTMLSelectElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const probeGen = useRef(0);
  // Empty until applyPreset — a stored edit-mode URL is operator-owned, not a fill.
  const lastFilled = useRef({ baseUrl: '', defaultModel: '' });
  const appliedPresetId = useRef<ProviderPresetId>('custom');
  const activePreset = presetById(presetId) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!;

  function restorePresetFocusFromConfirm() {
    const active = document.activeElement;
    if (active === document.body || (active instanceof Node && confirmRef.current?.contains(active))) {
      presetSelectRef.current?.focus();
    }
  }

  function applyPreset(preset: ProviderPreset) {
    restorePresetFocusFromConfirm();
    setPresetId(preset.id);
    setPendingPresetId(null);
    setBaseUrl(preset.baseUrl);
    setDefaultModel(preset.suggestedModel);
    setAuthType(preset.authType);
    if (!name.trim() && preset.id !== 'custom') setName(preset.label);
    lastFilled.current = { baseUrl: preset.baseUrl, defaultModel: preset.suggestedModel };
    appliedPresetId.current = preset.id;
  }

  function onPresetChange(nextId: ProviderPresetId) {
    const next = presetById(nextId);
    if (!next) return;
    if (
      presetWouldOverwrite(next, { baseUrl, defaultModel }, lastFilled.current)
    ) {
      setPresetId(next.id);
      setPendingPresetId(next.id);
      return;
    }
    applyPreset(next);
  }

  function keepCurrentFields() {
    restorePresetFocusFromConfirm();
    setPendingPresetId(null);
    setPresetId(appliedPresetId.current);
  }

  useEffect(() => {
    if (!open) return;
    nameRef.current?.focus();
  }, [open]);

  useEffect(() => {
    probeGen.current += 1;
    setTesting(false);
    setProbe(null);
  }, [baseUrl, apiKey, authType, verifySsl]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pendingPresetId) {
        const active = document.activeElement;
        if (active === document.body || (active instanceof Node && confirmRef.current?.contains(active))) {
          presetSelectRef.current?.focus();
        }
        setPendingPresetId(null);
        setPresetId(appliedPresetId.current);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, pendingPresetId]);

  if (!open) return null;

  async function testConnection() {
    const gen = ++probeGen.current;
    setTesting(true);
    setProbe(null);
    try {
      const result = await apiFetch<ProviderProbeResult>('/admin/llm-providers/test', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl,
          authType,
          verifySsl,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(mode === 'edit' && initial?.id && !apiKey.trim() ? { providerId: initial.id } : {}),
        }),
      });
      if (gen !== probeGen.current) return;
      setProbe({
        ...result,
        error: result.error ? redactSecrets(result.error) : result.error,
        models: result.models ?? [],
      });
    } catch (e) {
      if (gen !== probeGen.current) return;
      setProbe({
        connected: false,
        error: redactSecrets(e instanceof Error ? e.message : 'Connection failed'),
        models: [],
      });
    } finally {
      if (gen === probeGen.current) setTesting(false);
    }
  }

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
    <div
      data-testid="provider-modal-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-modal-title"
        className="nm-card flex w-[480px] max-h-[min(90vh,40rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-6">
        <h2 id="provider-modal-title" className="text-lg font-semibold">
          {mode === 'create' ? 'Add provider' : 'Edit provider'}
        </h2>
        <div>
          <label htmlFor="provider-preset" className="block text-sm">
            Preset
          </label>
          <select
            ref={presetSelectRef}
            id="provider-preset"
            className="nm-select-md mt-1 w-full"
            value={presetId}
            disabled={testing}
            onChange={(e) => onPresetChange(e.target.value as ProviderPresetId)}
          >
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {pendingPresetId ? (
          <div
            ref={confirmRef}
            data-testid="preset-overwrite-confirm"
            role="group"
            aria-labelledby="preset-overwrite-heading"
            className="space-y-2 rounded-md border border-border-interactive bg-muted/40 p-3 text-sm"
          >
            <h3 id="preset-overwrite-heading" className="font-medium text-foreground">
              Replace the URL or model you typed with this preset?
            </h3>
            <p className="text-muted-foreground">The API key is left as-is.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={keepCurrentFields}>
                Keep current
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const next = presetById(pendingPresetId);
                  if (next) applyPreset(next);
                }}
              >
                Use preset
              </Button>
            </div>
          </div>
        ) : null}
        <label className="block text-sm">
          Name
          <input ref={nameRef} className="nm-input w-full" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div>
          <label htmlFor="provider-base-url" className="block text-sm">
            Base URL
            <input
              id="provider-base-url"
              className="nm-input w-full"
              value={baseUrl}
              disabled={testing}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={activePreset.urlPlaceholder}
              aria-describedby="provider-url-help"
            />
          </label>
          <p id="provider-url-help" className="mt-1 text-[11px] text-muted-foreground">
            {activePreset.id === 'custom' ? (
              <>
                For local servers (LM Studio, vLLM) in Docker, use{' '}
                <code className="text-foreground">http://host.docker.internal:1234/v1</code>. For a hosted
                API, pick a preset above.
              </>
            ) : activePreset.id === 'azure-openai' ? (
              <>
                Paste the resource endpoint, e.g.{' '}
                <code className="text-foreground">https://{'{resource}'}.openai.azure.com/openai/v1</code>.
              </>
            ) : (
              activePreset.urlHelper
            )}
          </p>
        </div>
        <label className="block text-sm">
          API Key{' '}
          {initial?.hasApiKey && (
            <span className="text-success ml-2 text-xs">Configured {initial.keyPreview}</span>
          )}
          <input
            type="password"
            className="nm-input w-full"
            value={apiKey}
            disabled={testing}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial?.hasApiKey ? 'Replace key…' : ''}
          />
        </label>
        <div className="flex gap-4 text-sm">
          <label>
            <input
              type="radio"
              name="provider-auth"
              checked={authType === 'bearer'}
              disabled={testing}
              onChange={() => setAuthType('bearer')}
            />{' '}
            Bearer
          </label>
          <label>
            <input
              type="radio"
              name="provider-auth"
              checked={authType === 'none'}
              disabled={testing}
              onChange={() => setAuthType('none')}
            />{' '}
            None
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={verifySsl}
            disabled={testing}
            onChange={(e) => setVerifySsl(e.target.checked)}
          />{' '}
          Verify TLS
        </label>
        <label className="block text-sm">
          Default model
          <input
            className="nm-input w-full"
            value={defaultModel ?? ''}
            onChange={(e) => setDefaultModel(e.target.value)}
          />
        </label>
        {listedModels.length > 0 ? (
          <div>
            <label htmlFor="provider-listed-models" className="block text-sm">
              Listed models
            </label>
            <select
              id="provider-listed-models"
              className="nm-select-md mt-1 w-full"
              value={listedModels.includes(defaultModel) ? defaultModel : ''}
              onChange={(e) => setDefaultModel(e.target.value)}
              aria-describedby="provider-listed-models-help"
            >
              <option value="">Select a model</option>
              {listedModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <p id="provider-listed-models-help" className="mt-1 text-[11px] text-muted-foreground">
              Choosing one writes the default model. You can still type an id above if the host did
              not list it.
            </p>
          </div>
        ) : null}
        {presetId !== 'custom' ? (
          <p className="text-[11px] text-muted-foreground">
            Saving does not assign use cases. Assign Chat after saving — do not assign a chat-only
            host to Embedding, Rerank, or Image embedding.
          </p>
        ) : null}
        </div>
        <div className="shrink-0 space-y-2 border-t border-border p-3">
        <div
          data-testid="provider-test-result"
          data-state={probe ? (probe.connected ? 'success' : 'error') : 'idle'}
          role="status"
          className={
            !probe
              ? 'sr-only'
              : probe.connected
                ? 'rounded-md border border-status-connected/30 bg-status-connected/10 p-3 text-sm text-status-connected'
                : 'rounded-md border border-status-disconnected/30 bg-status-disconnected/10 p-3 text-sm text-status-disconnected'
          }
        >
          {probe?.connected
            ? listedModels.length > 0
              ? `Connected. ${listedModels.length} models listed.`
              : 'Connected'
            : (probe?.error ?? '')}
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={testConnection}
            disabled={!canTest || testing || saving}
            isLoading={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canSave || saving}
              isLoading={saving}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
