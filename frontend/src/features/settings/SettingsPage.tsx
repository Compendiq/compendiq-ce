import { useEffect, useState } from 'react';
import { m } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { SettingsResponse, LlmProviderType, AdminSettings, SyncOverviewResponse, SyncOverviewSpace, CustomPrompts } from '@atlasmind/contracts';
import { apiFetch } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { useSettings } from '../../shared/hooks/use-settings';
import { useSync } from '../../shared/hooks/use-spaces';
import { SpacesTab } from './SpacesTab';
import { LabelManager } from './LabelManager';
import { ErrorDashboard } from './ErrorDashboard';
import { ThemeTab } from './ThemeTab';
import { WorkersTab } from './WorkersTab';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';

type TabId = 'confluence' | 'sync' | 'ollama' | 'ai-prompts' | 'spaces' | 'theme' | 'labels' | 'errors' | 'embedding' | 'workers';

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
    { id: 'sync', label: 'Sync' },
    { id: 'spaces', label: 'Spaces' },
    { id: 'ollama', label: 'LLM', adminOnly: true },
    { id: 'ai-prompts', label: 'AI Prompts' },
    { id: 'theme', label: 'Theme' },
    { id: 'labels', label: 'Labels', adminOnly: true },
    { id: 'errors', label: 'Errors', adminOnly: true },
    { id: 'embedding', label: 'Embedding', adminOnly: true },
    { id: 'workers', label: 'Workers', adminOnly: true },
  ];

  const visibleTabs = tabs.filter((t) => !t.adminOnly || isAdmin);

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <h1 className="mb-6 text-2xl font-bold tracking-[-0.01em]">Settings</h1>

      <div className="glass-card">
        {/* Tab bar — Obsidian style: no fill on inactive, inset bottom-border on active */}
        <div className="flex overflow-x-auto border-b border-border/40">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap px-5 py-2.5 text-sm transition-all duration-150 ${
                activeTab === tab.id
                  ? 'text-foreground shadow-[inset_0_-2px_0_0_var(--color-primary)]'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground/80'
              }`}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {(isLoading || !settings) && activeTab !== 'labels' && activeTab !== 'errors' && activeTab !== 'theme' && activeTab !== 'embedding' && activeTab !== 'sync' ? (
            <SkeletonFormFields />
          ) : activeTab === 'confluence' ? (
            <ConfluenceTab settings={settings!} onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'sync' ? (
            <SyncTab />
          ) : activeTab === 'spaces' ? (
            <SpacesTab
              selectedSpaces={settings?.selectedSpaces ?? []}
              showSpaceHomeContent={settings?.showSpaceHomeContent ?? true}
              onSave={(v) => updateSettings.mutateAsync(v)}
            />
          ) : activeTab === 'ollama' ? (
            <LlmTab settings={settings!} />
          ) : activeTab === 'ai-prompts' ? (
            <AiPromptsTab settings={settings!} onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'theme' ? (
            <ThemeTab onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'labels' && isAdmin ? (
            <LabelManager />
          ) : activeTab === 'errors' && isAdmin ? (
            <ErrorDashboard />
          ) : activeTab === 'embedding' && isAdmin ? (
            <EmbeddingTab />
          ) : activeTab === 'workers' && isAdmin ? (
            <WorkersTab />
          ) : (
            null
          )}
        </div>
      </div>
    </m.div>
  );
}

const syncBadgeClasses: Record<'idle' | 'syncing' | 'embedding' | 'error', string> = {
  idle: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  syncing: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  embedding: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-300',
};

const spaceBadgeClasses: Record<SyncOverviewSpace['status'], string> = {
  healthy: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  degraded: 'border-red-500/30 bg-red-500/10 text-red-300',
  syncing: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  not_synced: 'border-slate-500/30 bg-slate-500/10 text-slate-300',
};

function formatTimestamp(value?: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString();
}

function MetricCard({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  testId?: string;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-foreground/[0.03] p-4" data-testid={testId}>
      <div className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{hint}</div>
    </div>
  );
}

function StatusBadge({
  label,
  classes,
  testId,
}: {
  label: string;
  classes: string;
  testId?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium uppercase tracking-[0.14em] ${classes}`}
      data-testid={testId}
    >
      {label}
    </span>
  );
}

const workerBadgeClasses = {
  processing: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  idle: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
};

interface QualityStatusResponse {
  totalPages: number;
  analyzedPages: number;
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  averageScore: number | null;
  isProcessing: boolean;
}

interface SummaryStatusResponse {
  totalPages: number;
  summarizedPages: number;
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  isProcessing: boolean;
}

function SyncTab() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const syncMutation = useSync();
  const { data, isLoading, isFetching, refetch } = useQuery<SyncOverviewResponse>({
    queryKey: ['settings', 'sync-overview'],
    queryFn: () => apiFetch('/settings/sync-overview'),
    refetchInterval: (query) => {
      const status = query.state.data?.sync.status;
      return status === 'syncing' || status === 'embedding' ? 2000 : false;
    },
  });

  const { data: qualityStatus } = useQuery<QualityStatusResponse>({
    queryKey: ['quality-status'],
    queryFn: () => apiFetch('/llm/quality-status'),
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 3000 : false;
    },
  });

  const qualityRescanMutation = useMutation({
    mutationFn: () => apiFetch<{ message: string; pagesReset: number }>('/llm/quality-rescan', { method: 'POST' }),
    onSuccess: (data) => {
      toast.success(data.message);
      queryClient.invalidateQueries({ queryKey: ['quality-status'] });
    },
    onError: (err) => toast.error(err.message),
  });

  const { data: summaryStatus } = useQuery<SummaryStatusResponse>({
    queryKey: ['summary-status'],
    queryFn: () => apiFetch('/llm/summary-status'),
    refetchInterval: (query) => {
      return query.state.data?.isProcessing ? 3000 : false;
    },
  });

  const summaryRescanMutation = useMutation({
    mutationFn: () => apiFetch<{ message: string; resetCount: number }>('/llm/summary-rescan', { method: 'POST' }),
    onSuccess: (data) => {
      toast.success(data.message);
      queryClient.invalidateQueries({ queryKey: ['summary-status'] });
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading || !data) {
    return <SkeletonFormFields />;
  }

  const syncLabel = data.sync.status === 'syncing'
    ? `Syncing${data.sync.progress?.space ? ` ${data.sync.progress.space}` : ''}`
    : data.sync.status === 'embedding'
      ? 'Embedding'
      : data.sync.status === 'error'
        ? 'Error'
        : 'Idle';

  return (
    <div className="space-y-6" data-testid="sync-tab-panel">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={syncLabel}
              classes={syncBadgeClasses[data.sync.status]}
              testId="sync-overview-status"
            />
            {data.sync.progress && data.sync.status === 'syncing' && (
              <span className="text-sm text-muted-foreground">
                {data.sync.progress.current}/{data.sync.progress.total} pages
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Last completed sync: {formatTimestamp(data.sync.lastSynced)}
          </p>
          {data.sync.error && (
            <p className="text-sm text-destructive" data-testid="sync-overview-error">{data.sync.error}</p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="glass-button-secondary"
            data-testid="sync-overview-refresh"
          >
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </button>
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || data.sync.status === 'syncing'}
            className="glass-button-primary"
            data-testid="sync-overview-sync-now"
          >
            {data.sync.status === 'syncing' ? 'Syncing...' : syncMutation.isPending ? 'Starting...' : 'Sync Now'}
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Selected Spaces"
          value={String(data.totals.selectedSpaces)}
          hint={`${data.totals.totalPages} cached pages`}
          testId="sync-metric-spaces"
        />
        <MetricCard
          label="Pages With Assets"
          value={String(data.totals.pagesWithAssets)}
          hint={`${data.totals.healthyPages} healthy, ${data.totals.pagesWithIssues} with gaps`}
          testId="sync-metric-pages"
        />
        <MetricCard
          label="Images"
          value={`${data.totals.images.cached}/${data.totals.images.expected}`}
          hint={data.totals.images.missing > 0 ? `${data.totals.images.missing} missing` : 'All cached'}
          testId="sync-metric-images"
        />
        <MetricCard
          label="Draw.io"
          value={`${data.totals.drawio.cached}/${data.totals.drawio.expected}`}
          hint={data.totals.drawio.missing > 0 ? `${data.totals.drawio.missing} missing` : 'All cached'}
          testId="sync-metric-drawio"
        />
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Spaces</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Health by selected Confluence space, including images and draw.io exports expected from cached pages.
          </p>
        </div>

        <div className="grid gap-3 lg:grid-cols-2">
          {data.spaces.map((space) => (
            <div
              key={space.spaceKey}
              className="rounded-xl border border-border/40 bg-foreground/[0.03] p-4"
              data-testid={`sync-overview-space-${space.spaceKey}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold">{space.spaceName}</div>
                  <div className="text-sm text-muted-foreground">{space.spaceKey}</div>
                </div>
                <StatusBadge label={space.status.replace('_', ' ')} classes={spaceBadgeClasses[space.status]} />
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Pages</div>
                  <div className="mt-1 text-lg font-medium">{space.pageCount}</div>
                  <div className="text-sm text-muted-foreground">{space.pagesWithAssets} with assets</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Last Synced</div>
                  <div className="mt-1 text-sm">{formatTimestamp(space.lastSynced)}</div>
                  <div className="text-sm text-muted-foreground">{space.pagesWithIssues} pages need attention</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Images</div>
                  <div className="mt-1 text-lg font-medium">{space.images.cached}/{space.images.expected}</div>
                  <div className="text-sm text-muted-foreground">{space.images.missing} missing</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Draw.io</div>
                  <div className="mt-1 text-lg font-medium">{space.drawio.cached}/{space.drawio.expected}</div>
                  <div className="text-sm text-muted-foreground">{space.drawio.missing} missing</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Missing Assets</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pages listed here still have missing local files, which is the most likely source of image 404s.
          </p>
        </div>

        {data.issues.length === 0 ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-300" data-testid="sync-overview-empty">
            No missing images or draw.io exports were detected in the selected spaces.
          </div>
        ) : (
          <div className="space-y-3">
            {data.issues.map((issue) => (
              <div
                key={issue.pageId}
                className="rounded-xl border border-red-500/30 bg-red-500/10 p-4"
                data-testid={`sync-overview-issue-${issue.pageId}`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="font-medium">{issue.pageTitle}</div>
                    <div className="text-sm text-muted-foreground">{issue.spaceKey}</div>
                  </div>
                  <div className="text-sm text-red-200">
                    {issue.missingImages} image missing, {issue.missingDrawio} draw.io missing
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {issue.missingFiles.map((filename) => (
                    <span
                      key={filename}
                      className="rounded-full border border-red-400/30 bg-black/10 px-2.5 py-1 text-xs text-red-100"
                    >
                      {filename}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Quality Analysis Worker */}
      <section className="space-y-3" data-testid="quality-worker-section">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Quality Analysis</h2>
              {qualityStatus && (
                <StatusBadge
                  label={qualityStatus.isProcessing ? 'Analyzing' : 'Idle'}
                  classes={qualityStatus.isProcessing ? workerBadgeClasses.processing : workerBadgeClasses.idle}
                  testId="quality-worker-status"
                />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Background worker that scores each article on completeness, clarity, structure, accuracy, and readability.
            </p>
          </div>

          {isAdmin && (
            <button
              onClick={() => qualityRescanMutation.mutate()}
              disabled={qualityRescanMutation.isPending}
              className="glass-button-secondary whitespace-nowrap"
              data-testid="quality-force-rescan"
            >
              {qualityRescanMutation.isPending ? 'Rescanning...' : 'Force Rescan'}
            </button>
          )}
        </div>

        {qualityStatus && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard
              label="Analyzed"
              value={String(qualityStatus.analyzedPages)}
              hint={`of ${qualityStatus.totalPages} total pages`}
              testId="quality-metric-analyzed"
            />
            <MetricCard
              label="Pending"
              value={String(qualityStatus.pendingPages)}
              hint="Waiting for analysis"
              testId="quality-metric-pending"
            />
            <MetricCard
              label="Failed"
              value={String(qualityStatus.failedPages)}
              hint="Analysis encountered errors"
              testId="quality-metric-failed"
            />
            <MetricCard
              label="Skipped"
              value={String(qualityStatus.skippedPages)}
              hint="Content too short"
              testId="quality-metric-skipped"
            />
            <MetricCard
              label="Avg Score"
              value={qualityStatus.averageScore !== null ? String(qualityStatus.averageScore) : '—'}
              hint={qualityStatus.averageScore !== null ? 'Out of 100' : 'No scores yet'}
              testId="quality-metric-avg-score"
            />
          </div>
        )}
      </section>

      {/* Summary Worker */}
      <section className="space-y-3" data-testid="summary-worker-section">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-muted-foreground">Article Summaries</h2>
              {summaryStatus && (
                <StatusBadge
                  label={summaryStatus.isProcessing ? 'Summarizing' : 'Idle'}
                  classes={summaryStatus.isProcessing ? workerBadgeClasses.processing : workerBadgeClasses.idle}
                  testId="summary-worker-status"
                />
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Background worker that generates concise summaries for each article using the LLM.
            </p>
          </div>

          {isAdmin && (
            <button
              onClick={() => summaryRescanMutation.mutate()}
              disabled={summaryRescanMutation.isPending}
              className="glass-button-secondary whitespace-nowrap"
              data-testid="summary-force-rescan"
            >
              {summaryRescanMutation.isPending ? 'Rescanning...' : 'Force Rescan'}
            </button>
          )}
        </div>

        {summaryStatus && (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Summarized"
              value={String(summaryStatus.summarizedPages)}
              hint={`of ${summaryStatus.totalPages} total pages`}
              testId="summary-metric-summarized"
            />
            <MetricCard
              label="Pending"
              value={String(summaryStatus.pendingPages)}
              hint="Waiting for summarization"
              testId="summary-metric-pending"
            />
            <MetricCard
              label="Failed"
              value={String(summaryStatus.failedPages)}
              hint="Summarization encountered errors"
              testId="summary-metric-failed"
            />
            <MetricCard
              label="Skipped"
              value={String(summaryStatus.skippedPages)}
              hint="No content to summarize"
              testId="summary-metric-skipped"
            />
          </div>
        )}
      </section>
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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ confluenceUrl: url, ...(pat ? { confluencePat: pat } : {}) });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
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
          type="button"
          onClick={testConnection}
          disabled={testing || !url}
          className="glass-button-secondary"
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        <button
          type="submit"
          className="glass-button-primary"
        >
          Save
        </button>
      </div>
    </form>
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

function LlmTab({ settings }: { settings: SettingsResponse }) {
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

  useEffect(() => {
    if (!adminSettings) return;
    setProvider(adminSettings.llmProvider ?? 'ollama');
    setOllamaModel(adminSettings.ollamaModel ?? settings.ollamaModel);
    setOpenaiBaseUrl(adminSettings.openaiBaseUrl ?? '');
    setOpenaiModel(adminSettings.openaiModel ?? '');
    setEmbeddingModel(adminSettings.embeddingModel ?? settings.embeddingModel);
    setOpenaiApiKey('');
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

  if (adminSettingsLoading || !adminSettings) {
    return <SkeletonFormFields />;
  }

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
  const [drawioEmbedUrl, setDrawioEmbedUrl] = useState<string | undefined>(undefined);

  // Initialise local state once data loads
  const effectiveChunkSize = chunkSize ?? adminSettings?.embeddingChunkSize ?? 500;
  const effectiveChunkOverlap = chunkOverlap ?? adminSettings?.embeddingChunkOverlap ?? 50;
  const effectiveDrawioUrl = drawioEmbedUrl ?? adminSettings?.drawioEmbedUrl ?? '';

  const savedChunkSize = adminSettings?.embeddingChunkSize ?? 500;
  const savedChunkOverlap = adminSettings?.embeddingChunkOverlap ?? 50;
  const savedDrawioUrl = adminSettings?.drawioEmbedUrl ?? '';

  const hasChunkChanges =
    (chunkSize !== undefined && chunkSize !== savedChunkSize) ||
    (chunkOverlap !== undefined && chunkOverlap !== savedChunkOverlap);
  const hasDrawioChanges =
    drawioEmbedUrl !== undefined && drawioEmbedUrl !== savedDrawioUrl;
  const hasChanges = hasChunkChanges || hasDrawioChanges;

  const updateAdminSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      // Also invalidate the drawio-url query so PageViewPage picks up the new URL
      queryClient.invalidateQueries({ queryKey: ['settings', 'drawio-url'] });
      setChunkSize(undefined);
      setChunkOverlap(undefined);
      setDrawioEmbedUrl(undefined);
      const hasChunk = variables.embeddingChunkSize !== undefined || variables.embeddingChunkOverlap !== undefined;
      if (hasChunk) {
        toast.success('Embedding settings saved. All pages queued for re-embedding.');
      } else {
        toast.success('Draw.io settings saved.');
      }
    },
    onError: (err) => toast.error(err.message),
  });

  function handleSave() {
    const updates: Record<string, unknown> = {};
    if (chunkSize !== undefined) updates.embeddingChunkSize = chunkSize;
    if (chunkOverlap !== undefined) updates.embeddingChunkOverlap = chunkOverlap;
    if (drawioEmbedUrl !== undefined) {
      // Empty string clears the setting (backend will delete the row, falling back to default)
      updates.drawioEmbedUrl = drawioEmbedUrl || undefined;
    }
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
        These settings are shared across all users. Changing chunk settings will trigger re-embedding of all pages, which may take several minutes.
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

      {hasChunkChanges && (
        <div
          className="glass-card border-yellow-500/30 p-3 text-sm text-yellow-400"
          data-testid="admin-chunk-change-warning"
        >
          Saving will mark all embedded pages dirty and trigger global re-embedding.
          This may take several minutes and temporarily affects AI Q&amp;A for all users.
        </div>
      )}

      <hr className="border-border/40" />

      <div>
        <label className="mb-1.5 block text-sm font-medium" htmlFor="admin-drawio-url-input">
          Draw.io Embed URL
        </label>
        <p className="mb-1.5 text-sm text-muted-foreground">
          URL of the draw.io embed server. Change this if{' '}
          <code className="rounded bg-foreground/10 px-1 text-xs">embed.diagrams.net</code> is
          blocked by your firewall. Leave empty to use the default (
          <code className="rounded bg-foreground/10 px-1 text-xs">https://embed.diagrams.net</code>).
        </p>
        <p className="mb-1.5 text-xs text-muted-foreground/70">
          Note: if you use a custom URL, also update the{' '}
          <code className="rounded bg-foreground/10 px-1 text-xs">frame-src</code> directive in{' '}
          <code className="rounded bg-foreground/10 px-1 text-xs">frontend/nginx-security-headers.conf</code>.
        </p>
        <input
          id="admin-drawio-url-input"
          type="url"
          placeholder="https://embed.diagrams.net"
          value={effectiveDrawioUrl}
          onChange={(e) => setDrawioEmbedUrl(e.target.value)}
          className="glass-input w-full max-w-md"
          data-testid="admin-drawio-url-input"
        />
      </div>

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

const PROMPT_TYPES = [
  {
    key: 'improve_grammar' as const,
    label: 'Grammar',
    description: 'Fix spelling, grammar, and punctuation without changing meaning.',
    placeholder: 'You are a technical writing assistant. Improve the grammar, spelling, and punctuation of the following article while preserving its meaning and structure. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
  {
    key: 'improve_structure' as const,
    label: 'Structure',
    description: 'Reorganize headings, paragraph flow, and logical order.',
    placeholder: 'You are a technical writing assistant. Improve the structure and organization of the following article. Add clear headings, improve paragraph flow, and ensure logical order. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
  {
    key: 'improve_clarity' as const,
    label: 'Clarity',
    description: 'Simplify complex sentences and remove unnecessary jargon.',
    placeholder: 'You are a technical writing assistant. Improve the clarity and readability of the following article. Simplify complex sentences, remove jargon where possible, and ensure each point is clear. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
  {
    key: 'improve_technical' as const,
    label: 'Technical',
    description: 'Fix technical errors and add missing technical details.',
    placeholder: 'You are a technical expert reviewer. Review the following article for technical accuracy. Fix any technical errors, update outdated information, and add missing technical details. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
  {
    key: 'improve_completeness' as const,
    label: 'Completeness',
    description: 'Fill gaps, add missing sections, and include examples.',
    placeholder: 'You are a technical writing assistant. Review the following article for completeness. Identify and fill in any missing sections, add examples where helpful, and ensure all topics are adequately covered. Return the improved text in Markdown format. Only output the improved text, no explanations.',
  },
];

function AiPromptsTab({ settings, onSave }: { settings: SettingsResponse; onSave: (v: Record<string, unknown>) => void }) {
  const [prompts, setPrompts] = useState<CustomPrompts>(settings.customPrompts ?? {});
  const saved = settings.customPrompts ?? {};
  const hasChanges = JSON.stringify(prompts) !== JSON.stringify(saved);

  function handleChange(key: string, value: string) {
    setPrompts((prev) => {
      const next = { ...prev };
      if (value.trim()) {
        next[key as keyof CustomPrompts] = value;
      } else {
        delete next[key as keyof CustomPrompts];
      }
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Customize the system prompts used by the AI Improver. Leave empty to use the built-in default.
          The language preservation instruction is always appended automatically.
        </p>
      </div>

      {PROMPT_TYPES.map((pt) => (
        <div key={pt.key}>
          <label className="mb-1 block text-sm font-medium">{pt.label}</label>
          <p className="mb-1.5 text-xs text-muted-foreground">{pt.description}</p>
          <textarea
            value={prompts[pt.key] ?? ''}
            onChange={(e) => handleChange(pt.key, e.target.value)}
            placeholder={pt.placeholder}
            rows={3}
            className="glass-input w-full resize-y font-mono text-xs"
            data-testid={`prompt-${pt.key}`}
          />
          {prompts[pt.key] && (
            <button
              onClick={() => handleChange(pt.key, '')}
              className="mt-1 text-xs text-muted-foreground hover:text-destructive"
            >
              Reset to default
            </button>
          )}
        </div>
      ))}

      <div>
        <button
          onClick={() => onSave({ customPrompts: prompts })}
          disabled={!hasChanges}
          className="glass-button-primary"
          data-testid="ai-prompts-save-btn"
        >
          Save
        </button>
      </div>
    </div>
  );
}
