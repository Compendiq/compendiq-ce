import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SettingsResponse, LlmProviderType, AdminSettings } from '@kb-creator/contracts';
import { apiFetch } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { useSettings } from '../../shared/hooks/use-settings';
import { SpacesTab } from './SpacesTab';
import { LabelManager } from './LabelManager';
import { ErrorDashboard } from './ErrorDashboard';
import { ThemeTab } from './ThemeTab';
import { SkeletonFormFields } from '../../shared/components/Skeleton';

type TabId = 'confluence' | 'ollama' | 'spaces' | 'theme' | 'account' | 'labels' | 'errors' | 'embedding';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const [activeTab, setActiveTab] = useState<TabId>('confluence');

  const { data: settings, isLoading } = useSettings();

  const updateSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved');
    },
    onError: (err) => toast.error(err.message),
  });

  const tabs: { id: TabId; label: string; adminOnly?: boolean }[] = [
    { id: 'confluence', label: 'Confluence' },
    { id: 'spaces', label: 'Spaces' },
    { id: 'ollama', label: 'LLM' },
    { id: 'theme', label: 'Theme' },
    { id: 'account', label: 'Account' },
    { id: 'labels', label: 'Labels', adminOnly: true },
    { id: 'errors', label: 'Errors', adminOnly: true },
    { id: 'embedding', label: 'Embedding', adminOnly: true },
  ];

  const visibleTabs = tabs.filter((t) => !t.adminOnly || isAdmin);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>

      <div className="glass-card">
        {/* Tab bar */}
        <div className="flex border-b border-border/50 overflow-x-auto">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-6 py-3 text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'border-b-2 border-primary text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {(isLoading || !settings) && activeTab !== 'labels' && activeTab !== 'errors' && activeTab !== 'theme' && activeTab !== 'embedding' ? (
            <SkeletonFormFields />
          ) : activeTab === 'confluence' ? (
            <ConfluenceTab settings={settings!} onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'spaces' ? (
            <SpacesTab
              selectedSpaces={settings?.selectedSpaces ?? []}
              showSpaceHomeContent={settings?.showSpaceHomeContent ?? true}
              onSave={(v) => updateSettings.mutate(v)}
            />
          ) : activeTab === 'ollama' ? (
            <LlmTab settings={settings!} onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'theme' ? (
            <ThemeTab onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'labels' && isAdmin ? (
            <LabelManager />
          ) : activeTab === 'errors' && isAdmin ? (
            <ErrorDashboard />
          ) : activeTab === 'embedding' && isAdmin ? (
            <EmbeddingTab />
          ) : (
            <AccountTab />
          )}
        </div>
      </div>
    </div>
  );
}

function ConfluenceTab({ settings, onSave }: { settings: SettingsResponse; onSave: (v: Record<string, unknown>) => void }) {
  const [url, setUrl] = useState(settings.confluenceUrl ?? '');
  const [pat, setPat] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  async function testConnection() {
    setTesting(true);
    try {
      const result = await apiFetch<{ success: boolean; message: string }>(
        '/settings/test-confluence',
        { method: 'POST', body: JSON.stringify({ url, pat: pat || undefined }) },
      );
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1.5 block text-sm font-medium">Confluence URL</label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="glass-input"
          placeholder="https://confluence.company.com"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium">
          Personal Access Token
          {settings.hasConfluencePat && (
            <span className="ml-2 text-xs text-success">Configured</span>
          )}
        </label>
        <input
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          className="glass-input"
          placeholder={settings.hasConfluencePat ? '••••••••••' : 'Enter PAT'}
        />
      </div>

      {testResult && (
        <div className={`rounded-md p-3 text-sm ${testResult.success ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
          {testResult.message}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={testConnection}
          disabled={testing || !url}
          className="glass-button-secondary"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          onClick={() => onSave({ confluenceUrl: url, ...(pat ? { confluencePat: pat } : {}) })}
          className="glass-button-primary"
        >
          Save
        </button>
      </div>
    </div>
  );
}

interface LlmStatusResponse {
  connected: boolean;
  error?: string;
  provider: string;
  ollamaBaseUrl: string;
  openaiBaseUrl: string;
  embeddingModel: string;
}

function LlmTab({ settings, onSave }: { settings: SettingsResponse; onSave: (v: Record<string, unknown>) => void }) {
  const [provider, setProvider] = useState<LlmProviderType>(settings.llmProvider ?? 'ollama');
  const [ollamaModel, setOllamaModel] = useState(settings.ollamaModel);
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(settings.openaiBaseUrl ?? '');
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState(settings.openaiModel ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

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

  const { data: openaiModels, isFetching: loadingOpenaiModels, error: openaiModelsError, refetch: refetchOpenaiModels } = useQuery({
    queryKey: ['ollama-models', 'openai'],
    queryFn: () => apiFetch<{ name: string }[]>('/ollama/models?provider=openai'),
    retry: 1,
    enabled: provider === 'openai',
  });

  const status = provider === 'ollama' ? ollamaStatus : openaiStatus;
  const models = provider === 'ollama' ? ollamaModels : openaiModels;
  const loadingModels = provider === 'ollama' ? loadingOllamaModels : loadingOpenaiModels;
  const modelsError = provider === 'ollama' ? ollamaModelsError : openaiModelsError;
  const refetchModels = provider === 'ollama' ? refetchOllamaModels : refetchOpenaiModels;
  const currentModel = provider === 'ollama' ? ollamaModel : openaiModel;
  const setCurrentModel = provider === 'ollama' ? setOllamaModel : setOpenaiModel;

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
      updates.openaiModel = openaiModel;
      if (openaiBaseUrl) updates.openaiBaseUrl = openaiBaseUrl;
      if (openaiApiKey) updates.openaiApiKey = openaiApiKey;
    }
    onSave(updates);
  }

  return (
    <div className="space-y-6">
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
              {settings.hasOpenaiApiKey && (
                <span className="ml-2 text-xs text-success">Configured</span>
              )}
            </label>
            <input
              type="password"
              value={openaiApiKey}
              onChange={(e) => setOpenaiApiKey(e.target.value)}
              className="glass-input"
              placeholder={settings.hasOpenaiApiKey ? '••••••••••' : 'Enter API key'}
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
        <div className="rounded-md border border-border/50 bg-foreground/5 px-3 py-2 text-sm text-muted-foreground">
          {settings.embeddingModel} (server-wide, read-only)
        </div>
      </div>

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
          className="glass-button-primary"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// Keep backward-compatible export name for tests
export { LlmTab as OllamaTab };

function EmbeddingTab() {
  const queryClient = useQueryClient();

  const { data: adminSettings, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch<AdminSettings>('/admin/settings'),
  });

  const [chunkSize, setChunkSize] = useState<number | undefined>(undefined);
  const [chunkOverlap, setChunkOverlap] = useState<number | undefined>(undefined);

  // Initialise local state once data loads
  const effectiveChunkSize = chunkSize ?? adminSettings?.embeddingChunkSize ?? 500;
  const effectiveChunkOverlap = chunkOverlap ?? adminSettings?.embeddingChunkOverlap ?? 50;

  const savedChunkSize = adminSettings?.embeddingChunkSize ?? 500;
  const savedChunkOverlap = adminSettings?.embeddingChunkOverlap ?? 50;
  const hasChanges =
    (chunkSize !== undefined && chunkSize !== savedChunkSize) ||
    (chunkOverlap !== undefined && chunkOverlap !== savedChunkOverlap);

  const updateAdminSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      setChunkSize(undefined);
      setChunkOverlap(undefined);
      toast.success('Embedding settings saved. All pages queued for re-embedding.');
    },
    onError: (err) => toast.error(err.message),
  });

  function handleSave() {
    const updates: Record<string, unknown> = {};
    if (chunkSize !== undefined) updates.embeddingChunkSize = chunkSize;
    if (chunkOverlap !== undefined) updates.embeddingChunkOverlap = chunkOverlap;
    if (Object.keys(updates).length > 0) {
      updateAdminSettings.mutate(updates);
    }
  }

  if (isLoading) {
    return <SkeletonFormFields />;
  }

  return (
    <div className="space-y-6">
      <div className="glass-card border-yellow-500/30 p-3 text-sm text-yellow-400">
        These settings are shared across all users. Changing them will trigger re-embedding of all pages, which may take several minutes.
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="admin-chunk-size-input">
          Chunk Size (tokens)
        </label>
        <p className="mb-1.5 text-sm text-muted-foreground">
          Controls how much text is grouped into each searchable unit for AI Q&amp;A.
          Smaller values (128-256) find precise facts but may miss context.
          Larger values (512-1024) capture complete sections. Default: 500.
        </p>
        <input
          id="admin-chunk-size-input"
          type="number"
          min={128}
          max={2048}
          step={64}
          value={effectiveChunkSize}
          onChange={(e) => setChunkSize(Number(e.target.value))}
          className="glass-input w-40"
          data-testid="admin-chunk-size-input"
        />
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="admin-chunk-overlap-input">
          Chunk Overlap (tokens)
        </label>
        <p className="mb-1.5 text-sm text-muted-foreground">
          Tokens shared between adjacent chunks to prevent information loss at boundaries.
          Recommended: 10% of chunk size. Default: 50.
        </p>
        <input
          id="admin-chunk-overlap-input"
          type="number"
          min={0}
          max={512}
          step={10}
          value={effectiveChunkOverlap}
          onChange={(e) => setChunkOverlap(Number(e.target.value))}
          className="glass-input w-40"
          data-testid="admin-chunk-overlap-input"
        />
      </div>

      {hasChanges && (
        <div
          className="glass-card border-yellow-500/30 p-3 text-sm text-yellow-400"
          data-testid="admin-chunk-change-warning"
        >
          Saving will mark all embedded pages dirty and trigger global re-embedding.
          This may take several minutes and temporarily affects AI Q&amp;A for all users.
        </div>
      )}

      <div>
        <button
          onClick={handleSave}
          disabled={!hasChanges || updateAdminSettings.isPending}
          className="glass-button-primary"
          data-testid="admin-chunk-save-btn"
        >
          {updateAdminSettings.isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function AccountTab() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Account settings coming soon.</p>
    </div>
  );
}
