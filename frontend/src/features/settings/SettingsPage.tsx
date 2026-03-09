import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SettingsResponse } from '@kb-creator/contracts';
import { apiFetch } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { SpacesTab } from './SpacesTab';
import { LabelManager } from './LabelManager';
import { ErrorDashboard } from './ErrorDashboard';

type TabId = 'confluence' | 'ollama' | 'spaces' | 'account' | 'labels' | 'errors';

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
    { id: 'ollama', label: 'Ollama' },
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
        <div className="flex border-b border-white/10 overflow-x-auto">
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
          {(isLoading || !settings) && activeTab !== 'labels' && activeTab !== 'errors' ? (
            <div className="flex h-32 items-center justify-center text-muted-foreground">
              Loading settings...
            </div>
          ) : activeTab === 'confluence' ? (
            <ConfluenceTab settings={settings!} onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'spaces' ? (
            <SpacesTab
              selectedSpaces={settings?.selectedSpaces ?? []}
              onSave={(v) => updateSettings.mutate(v)}
            />
          ) : activeTab === 'ollama' ? (
            <OllamaTab settings={settings!} onSave={(v) => updateSettings.mutate(v)} />
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
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary"
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
          className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary"
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
          className="rounded-md border border-white/10 px-4 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
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

function OllamaTab({ settings, onSave }: { settings: SettingsResponse; onSave: (v: Record<string, unknown>) => void }) {
  const [model, setModel] = useState(settings.ollamaModel);

  const { data: status } = useQuery({
    queryKey: ['ollama-status'],
    queryFn: () => apiFetch<{ connected: boolean; ollamaBaseUrl: string; embeddingModel: string }>('/ollama/status'),
  });

  const { data: models, isFetching: loadingModels, error: modelsError, refetch } = useQuery({
    queryKey: ['ollama-models'],
    queryFn: () => apiFetch<{ name: string }[]>('/ollama/models'),
    retry: 1,
  });

  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1.5 block text-sm font-medium">Ollama Server</label>
        <div className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-muted-foreground">
          <span className={`inline-block h-2 w-2 rounded-full ${status?.connected ? 'bg-green-500' : 'bg-red-500'}`} />
          {status?.ollamaBaseUrl ?? 'Loading...'} {status?.connected === false && '(disconnected)'}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium">Chat Model</label>
        <div className="flex gap-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="flex-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-primary"
            data-testid="ollama-model-select"
          >
            {models && models.length > 0
              ? models.map((m) => (
                  <option key={m.name} value={m.name}>{m.name}</option>
                ))
              : <option value={model}>{model}</option>}
          </select>
          <button
            onClick={() => refetch()}
            disabled={loadingModels}
            className="rounded-md border border-white/10 px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-50"
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
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium">Embedding Model</label>
        <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-muted-foreground">
          {settings.embeddingModel} (server-wide, read-only)
        </div>
      </div>

      <button
        onClick={() => onSave({ ollamaModel: model })}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Save
      </button>
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
