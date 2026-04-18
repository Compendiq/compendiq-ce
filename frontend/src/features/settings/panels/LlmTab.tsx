import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SettingsResponse, LlmProviderType, AdminSettings, LlmUsecase, UsecaseAssignments, UpdateUsecaseAssignmentsInput } from '@compendiq/contracts';
import { apiFetch } from '../../../shared/lib/api';
import { SkeletonFormFields } from '../../../shared/components/feedback/Skeleton';

interface LlmStatusResponse {
  connected: boolean;
  error?: string;
  provider: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  embeddingModel: string;
}

export function LlmTab({ settings }: { settings: SettingsResponse }) {
  const queryClient = useQueryClient();
  const { data: adminSettings, isLoading: adminSettingsLoading } = useQuery<AdminSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  const [provider, setProvider] = useState<LlmProviderType>('ollama');
  const [ollamaModel, setOllamaModel] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  // Per-use-case LLM overrides (issue #214). `null` means "inherit shared default".
  const [usecaseAssignments, setUsecaseAssignments] = useState<UsecaseAssignments | null>(null);

  useEffect(() => {
    if (!adminSettings) return;
    setProvider(adminSettings.llmProvider ?? 'ollama');
    setOllamaModel(adminSettings.ollamaModel ?? settings.ollamaModel);
    setOpenaiBaseUrl(adminSettings.openaiBaseUrl ?? '');
    setOpenaiModel(adminSettings.openaiModel ?? '');
    setEmbeddingModel(adminSettings.embeddingModel ?? settings.embeddingModel);
    setOpenaiApiKey('');
    setUsecaseAssignments(adminSettings.usecaseAssignments ?? null);
  }, [adminSettings, settings.ollamaModel, settings.embeddingModel]);

  const updateAdminSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['ollama-status'] });
      queryClient.invalidateQueries({ queryKey: ['ollama-models'] });
      toast.success('LLM settings saved for all users');
    },
    onError: (err) => toast.error(err.message),
  });

  const { data: ollamaStatus } = useQuery({
    queryKey: ['ollama-status', 'ollama'],
    queryFn: () => apiFetch<LlmStatusResponse>('/ollama/status?provider=ollama'),
  });

  const { data: openaiStatus } = useQuery({
    queryKey: ['ollama-status', 'openai'],
    queryFn: () => apiFetch<LlmStatusResponse>('/ollama/status?provider=openai'),
    enabled: provider === 'openai',
  });

  const { data: ollamaModels, isFetching: loadingOllamaModels, error: ollamaModelsError, refetch: refetchOllamaModels } = useQuery({
    queryKey: ['ollama-models', 'ollama'],
    queryFn: () => apiFetch<{ name: string }[]>('/ollama/models?provider=ollama'),
    retry: 1,
  });

  // Enable the openai model list whenever the shared provider is openai OR
  // any per-use-case assignment row is set to openai — otherwise the per-row
  // model dropdown in UsecaseAssignmentsSection would be empty in a mixed
  // config (shared=ollama, one row=openai). Issue #214 review finding #3.
  const anyUsecaseUsesOpenai =
    !!usecaseAssignments &&
    Object.values(usecaseAssignments).some((row) => row?.provider === 'openai');
  const { data: openaiModels, isFetching: loadingOpenaiModels, error: openaiModelsError, refetch: refetchOpenaiModels } = useQuery({
    queryKey: ['ollama-models', 'openai'],
    queryFn: () => apiFetch<{ name: string }[]>('/ollama/models?provider=openai'),
    retry: 1,
    enabled: provider === 'openai' || anyUsecaseUsesOpenai,
  });

  const status = provider === 'ollama' ? ollamaStatus : openaiStatus;
  const models = provider === 'ollama' ? ollamaModels : openaiModels;
  const loadingModels = provider === 'ollama' ? loadingOllamaModels : loadingOpenaiModels;
  const modelsError = provider === 'ollama' ? ollamaModelsError : openaiModelsError;
  const refetchModels = provider === 'ollama' ? refetchOllamaModels : refetchOpenaiModels;
  const currentModel = provider === 'ollama' ? ollamaModel : openaiModel;
  const setCurrentModel = provider === 'ollama' ? setOllamaModel : setOpenaiModel;

  if (adminSettingsLoading || !adminSettings) {
    return <SkeletonFormFields />;
  }
  const loadedAdminSettings: AdminSettings = adminSettings;

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiFetch<LlmStatusResponse>(`/ollama/status?provider=${provider}`);
      if (result.connected) {
        setTestResult({ success: true, message: `Connected to ${provider === 'openai' ? 'OpenAI-compatible' : 'Ollama'} server` });
      } else {
        setTestResult({ success: false, message: result.error ?? 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  }

  function handleSave() {
    const updates: Record<string, unknown> = { llmProvider: provider };
    if (provider === 'ollama') {
      updates.ollamaModel = ollamaModel;
    } else {
      updates.openaiModel = openaiModel || null;
      updates.openaiBaseUrl = openaiBaseUrl.trim() || null;
      if (openaiApiKey) updates.openaiApiKey = openaiApiKey;
    }
    if (embeddingModel) updates.embeddingModel = embeddingModel;

    // Diff use-case assignments vs. loaded admin settings so we only send
    // rows that actually changed. `null` means "clear override / inherit".
    if (usecaseAssignments) {
      const diff = diffUsecaseAssignments(
        loadedAdminSettings.usecaseAssignments ?? null,
        usecaseAssignments,
      );
      if (Object.keys(diff).length > 0) {
        updates.usecaseAssignments = diff;
      }
    }

    updateAdminSettings.mutate(updates);
  }

  return (
    <div className="space-y-6">
      <div className="glass-card border-yellow-500/30 p-3 text-sm text-yellow-400">
        These LLM settings are shared across all users. Only admins can change them here.
      </div>

      {/* Provider selector */}
      <div>
        <label className="mb-1.5 block text-sm font-medium">LLM Provider</label>
        <div className="flex gap-2">
          <button
            onClick={() => { setProvider('ollama'); setTestResult(null); }}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              provider === 'ollama'
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'border border-border/50 text-muted-foreground hover:bg-foreground/5'
            }`}
            data-testid="provider-ollama-btn"
          >
            Ollama
          </button>
          <button
            onClick={() => { setProvider('openai'); setTestResult(null); }}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              provider === 'openai'
                ? 'bg-primary/15 text-primary border border-primary/30'
                : 'border border-border/50 text-muted-foreground hover:bg-foreground/5'
            }`}
            data-testid="provider-openai-btn"
          >
            OpenAI Compatible
          </button>
        </div>
      </div>

      {/* Provider-specific settings */}
      {provider === 'ollama' ? (
        <div>
          <label className="mb-1.5 block text-sm font-medium">Ollama Server</label>
          <div className="flex items-center gap-2 rounded-md border border-border/50 bg-foreground/5 px-3 py-2 text-sm text-muted-foreground">
            <span className={`inline-block h-2 w-2 rounded-full ${status?.connected ? 'bg-green-500' : 'bg-red-500'}`} />
            {ollamaStatus?.ollamaBaseUrl ?? 'Loading...'} {status?.connected === false && `(disconnected${status.error ? `: ${status.error}` : ''})`}
          </div>
        </div>
      ) : (
        <>
          <div>
            <label className="mb-1.5 block text-sm font-medium">API Base URL</label>
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={openaiBaseUrl}
                onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                className="glass-input flex-1"
                placeholder="https://api.openai.com/v1"
                data-testid="openai-base-url-input"
              />
              {openaiStatus && (
                <span className={`inline-block h-2 w-2 rounded-full ${openaiStatus.connected ? 'bg-green-500' : 'bg-red-500'}`} />
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Works with OpenAI, Azure OpenAI, LM Studio, vLLM, llama.cpp, LocalAI, etc.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">
              API Key
              {adminSettings.hasOpenaiApiKey && (
                <span className="ml-2 text-xs text-success">Configured</span>
              )}
            </label>
            <input
              type="password"
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              className="glass-input"
              placeholder={adminSettings.hasOpenaiApiKey ? '••••••••••' : 'Enter API key'}
              data-testid="openai-api-key-input"
            />
          </div>
        </>
      )}

      {/* Model selector */}
      <div>
        <label className="mb-1.5 block text-sm font-medium">Chat Model</label>
        <div className="flex gap-2">
          <select
            value={currentModel}
            onChange={(e) => setCurrentModel(e.target.value)}
            className="glass-select flex-1"
            data-testid="ollama-model-select"
          >
            {models && models.length > 0
              ? models.map((m) => (
                  <option key={m.name} value={m.name}>{m.name}</option>
                ))
              : <option value={currentModel}>{currentModel || 'No models available'}</option>}
          </select>
          <button
            onClick={() => refetchModels()}
            disabled={loadingModels}
            className="glass-button-secondary px-3"
            data-testid="ollama-scan-btn"
          >
            {loadingModels ? 'Scanning...' : 'Scan'}
          </button>
        </div>
        {modelsError && (
          <p className="mt-1.5 text-xs text-destructive" data-testid="ollama-scan-error">
            Failed to scan models: {modelsError.message}
          </p>
        )}
        {provider === 'openai' && (!models || models.length === 0) && !loadingModels && !modelsError && (
          <p className="mt-1 text-xs text-muted-foreground">
            You can also type a model name directly (e.g., gpt-4o, gpt-4o-mini).
          </p>
        )}
        {provider === 'openai' && (
          <div className="mt-2">
            <input
              type="text"
              value={openaiModel}
              onChange={(e) => setOpenaiModel(e.target.value)}
              className="glass-input"
              placeholder="Or type a model name..."
              data-testid="openai-model-input"
            />
          </div>
        )}
      </div>

      {/* Embedding model */}
      <div>
        <label className="mb-1.5 block text-sm font-medium">Embedding Model</label>
        {models && models.length > 0 ? (
          <select
            value={embeddingModel}
            onChange={(e) => setEmbeddingModel(e.target.value)}
            className="glass-input"
          >
            {!models.some((m: { name: string }) => m.name === embeddingModel) && embeddingModel && (
              <option value={embeddingModel}>{embeddingModel}</option>
            )}
            {models.map((m: { name: string }) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={embeddingModel}
            onChange={(e) => setEmbeddingModel(e.target.value)}
            className="glass-input"
            placeholder="e.g. nomic-embed-text or text-embedding-nomic-embed-text-v1.5"
          />
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Shared across all users. Changing this requires re-embedding existing pages.
        </p>
      </div>

      {/* Per-use-case LLM assignments (issue #214) */}
      {usecaseAssignments && (
        <UsecaseAssignmentsSection
          assignments={usecaseAssignments}
          onChange={setUsecaseAssignments}
          ollamaModels={ollamaModels ?? []}
          openaiModels={openaiModels ?? []}
        />
      )}

      {testResult && (
        <div className={`rounded-md p-3 text-sm ${testResult.success ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`} data-testid="llm-test-result">
          {testResult.message}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={testConnection}
          disabled={testing}
          className="glass-button-secondary"
          data-testid="llm-test-btn"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          onClick={handleSave}
          disabled={updateAdminSettings.isPending}
          className="glass-button-primary"
        >
          {updateAdminSettings.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-use-case LLM assignments (issue #214)
// ---------------------------------------------------------------------------

const USECASE_LABELS: Record<LlmUsecase, string> = {
  chat: 'Chat',
  summary: 'Summary worker',
  quality: 'Quality worker',
  auto_tag: 'Auto-tag',
};

const USECASES_ORDERED: LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag'];

/**
 * Use cases whose resolver is wired into a production code path today. Rows
 * for use cases not in this set are rendered read-only with a "not yet wired"
 * note — the resolver is ready but the chat routes still read the shared
 * provider (tracked as a follow-up to issue #214). This prevents the UI from
 * implying an admin control that has no runtime effect.
 */
const WIRED_USECASES: ReadonlySet<LlmUsecase> = new Set(['summary', 'quality', 'auto_tag']);

function UsecaseAssignmentsSection({
  assignments,
  onChange,
  ollamaModels,
  openaiModels,
}: {
  assignments: UsecaseAssignments;
  onChange: (next: UsecaseAssignments) => void;
  ollamaModels: Array<{ name: string }>;
  openaiModels: Array<{ name: string }>;
}) {
  function update(usecase: LlmUsecase, patch: Partial<UsecaseAssignments[LlmUsecase]>) {
    onChange({ ...assignments, [usecase]: { ...assignments[usecase], ...patch } });
  }

  return (
    <div className="space-y-3 rounded-md border border-border/50 p-4">
      <div>
        <h3 className="text-sm font-semibold">Use case assignments</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Assign a specific provider + model per background job. Leave a field as &quot;Inherit&quot;
          to fall back to the shared default above. Changes take effect immediately — no restart required.
        </p>
      </div>

      <div className="space-y-2">
        {USECASES_ORDERED.map((usecase) => {
          const row = assignments[usecase];
          const wired = WIRED_USECASES.has(usecase);
          const models = row.provider === 'openai' ? openaiModels : ollamaModels;
          return (
            <div key={usecase} className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_180px_1fr_auto] sm:items-center">
              <div className="text-sm font-medium">{USECASE_LABELS[usecase]}</div>
              <select
                className="glass-select"
                value={row.provider ?? ''}
                onChange={(e) => {
                  const value = e.target.value;
                  update(usecase, {
                    provider: value === '' ? null : (value as LlmProviderType),
                  });
                }}
                data-testid={`usecase-${usecase}-provider`}
                disabled={!wired}
                title={wired ? undefined : 'Chat routing through per-use-case assignments is not yet wired — tracked as a follow-up to #214.'}
              >
                <option value="">Inherit shared default</option>
                <option value="ollama">Ollama</option>
                <option value="openai">OpenAI Compatible</option>
              </select>
              {row.provider === null ? (
                <input
                  className="glass-input"
                  value=""
                  readOnly
                  placeholder={`Inherited: ${row.resolved?.provider ?? '—'} / ${row.resolved?.model ?? '—'}`}
                  data-testid={`usecase-${usecase}-model-inherited`}
                />
              ) : (
                <select
                  className="glass-select"
                  value={row.model ?? ''}
                  onChange={(e) =>
                    update(usecase, { model: e.target.value === '' ? null : e.target.value })
                  }
                  data-testid={`usecase-${usecase}-model`}
                  disabled={!wired}
                  title={wired ? undefined : 'Chat routing through per-use-case assignments is not yet wired — tracked as a follow-up to #214.'}
                >
                  <option value="">Inherit shared model</option>
                  {models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
              <span className="text-xs text-muted-foreground">
                {wired
                  ? row.resolved
                    ? `→ ${row.resolved.provider} / ${row.resolved.model || '(none)'}`
                    : ''
                  : 'Not yet wired — chat still uses the shared provider above.'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Diff the user's edits against the loaded admin settings. Returns only the
 * use cases whose provider or model differs, so the PUT body stays minimal
 * and clearly distinguishes `null` (clear override) from `undefined`
 * (untouched).
 */
function diffUsecaseAssignments(
  original: UsecaseAssignments | null,
  current: UsecaseAssignments,
): UpdateUsecaseAssignmentsInput {
  const diff: UpdateUsecaseAssignmentsInput = {};
  for (const usecase of USECASES_ORDERED) {
    const orig = original?.[usecase];
    const curr = current[usecase];
    const patch: { provider?: LlmProviderType | null; model?: string | null } = {};
    const origProvider = orig?.provider ?? null;
    const currProvider = curr.provider ?? null;
    if (origProvider !== currProvider) patch.provider = currProvider;
    const origModel = orig?.model ?? null;
    const currModel = curr.model ?? null;
    if (origModel !== currModel) patch.model = currModel;
    if (Object.keys(patch).length > 0) diff[usecase] = patch;
  }
  return diff;
}

// Keep backward-compatible export name for tests
export { LlmTab as OllamaTab };
