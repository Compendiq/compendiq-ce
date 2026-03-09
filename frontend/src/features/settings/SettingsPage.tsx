import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SettingsResponse, LlmProviderType } from '@kb-creator/contracts';
import { apiFetch } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { SpacesTab } from './SpacesTab';
import { LabelManager } from './LabelManager';
import { ErrorDashboard } from './ErrorDashboard';
import { ThemeTab } from './ThemeTab';

type TabId = 'confluence' | 'ollama' | 'spaces' | 'theme' | 'account' | 'labels' | 'errors';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const [activeTab, setActiveTab] = useState<TabId>('confluence');

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<SettingsResponse>('/settings'),
  });

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
          {(isLoading || !settings) && activeTab !== 'labels' && activeTab !== 'errors' && activeTab !== 'theme' ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              Loading settings...
            </div>
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
        { method: 'POST', body: JSON.stringify({ url, pat: pat || 'existing' }) },
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
          className="w-full rounded-md border border-border/50 bg-foreground/5 px-3 py-2 text-sm outline-none focus:border-primary"
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
          className="w-full rounded-md border border-border/50 bg-foreground/5 px-3 py-2 text-sm outline-none focus:border-primary"
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
          className="rounded-md border border-border/50 px-4 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          onClick={() => onSave({ confluenceUrl: url, ...(pat ? { confluencePat: pat } : {}) })}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
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
            onClick={() => setProvider('ollama')}
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
            onClick={() => setProvider('openai')}
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
                className="flex-1 rounded-md border border-border/50 bg-foreground/5 px-3 py-2 text-sm outline-none focus:border-primary"
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
              className="w-full rounded-md border border-border/50 bg-foreground/5 px-3 py-2 text-sm outline-none focus:border-primary"
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
            className="flex-1 rounded-md border border-border/50 bg-foreground/5 px-3 py-2 text-sm outline-none focus:border-primary"
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
            className="rounded-md border border-border/50 px-3 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
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
              className="w-full rounded-md border border-border/50 bg-foreground/5 px-3 py-2 text-sm outline-none focus:border-primary"
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

      <button
        onClick={handleSave}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Save
      </button>
    </div>
  );
}

// Keep backward-compatible export name for tests
export { LlmTab as OllamaTab };

function AccountTab() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Account settings coming soon.</p>
    </div>
  );
}
