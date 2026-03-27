import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, CheckCircle2, XCircle, Loader2, ExternalLink } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';

interface SearxngSettings {
  url: string;
  maxResults: number;
  categories: string;
}

interface TestResult {
  ok: boolean;
  resultCount?: number;
  sample?: Array<{ title: string; url: string }>;
  error?: string;
}

export function SearxngTab() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery<SearxngSettings>({
    queryKey: ['admin', 'searxng'],
    queryFn: () => apiFetch('/admin/searxng'),
  });

  const [form, setForm] = useState<SearxngSettings>({ url: 'http://searxng:8080', maxResults: 5, categories: 'general' });
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => { if (settings) { setForm(settings); setIsDirty(false); } }, [settings]);

  const updateField = <K extends keyof SearxngSettings>(key: K, value: SearxngSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: (body: Partial<SearxngSettings>) => apiFetch('/admin/searxng', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['admin', 'searxng'] }); toast.success('SearXNG settings saved'); setIsDirty(false); },
    onError: (err) => toast.error(err.message),
  });

  const testMutation = useMutation<TestResult>({
    mutationFn: () => apiFetch('/admin/searxng/test', { method: 'POST' }),
    onSuccess: (data) => {
      if (data.ok) { toast.success(`Connected! ${data.resultCount} results`); }
      else { toast.error(`Test failed: ${data.error}`); }
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 size={16} className="animate-spin" /> Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Search size={20} className="text-primary" />
        <div>
          <h3 className="text-base font-semibold">SearXNG Web Search Engine</h3>
          <p className="text-sm text-muted-foreground">Self-hosted meta-search engine used by the MCP sidecar for web search queries.</p>
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-medium">SearXNG URL</label>
        <div className="flex gap-2">
          <input value={form.url} onChange={(e) => updateField('url', e.target.value)}
            className="flex-1 rounded-lg border border-border/40 bg-foreground/[0.03] px-3 py-2 text-sm outline-none focus:border-primary/50"
            placeholder="http://searxng:8080" data-testid="searxng-url" />
          <button onClick={() => testMutation.mutate()} disabled={testMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg border border-border/40 bg-foreground/[0.03] px-3 py-2 text-sm hover:bg-foreground/[0.06] disabled:opacity-50" data-testid="searxng-test">
            {testMutation.isPending ? <Loader2 size={14} className="animate-spin" />
              : testMutation.data?.ok ? <CheckCircle2 size={14} className="text-emerald-400" />
              : testMutation.data && !testMutation.data.ok ? <XCircle size={14} className="text-red-400" />
              : <ExternalLink size={14} />}
            Test
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Internal Docker URL of the SearXNG instance. Default: http://searxng:8080</p>
      </div>

      {testMutation.data?.ok && testMutation.data.sample && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
          <p className="text-sm font-medium text-emerald-300">Connection successful ({testMutation.data.resultCount} results)</p>
          <ul className="mt-1 space-y-1 text-xs text-emerald-300/80">
            {testMutation.data.sample.map((s, i) => <li key={i}>{s.title}</li>)}
          </ul>
        </div>
      )}

      {testMutation.data && !testMutation.data.ok && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <p className="text-sm text-red-300">{testMutation.data.error}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Max Results</label>
          <input type="number" value={form.maxResults} onChange={(e) => updateField('maxResults', parseInt(e.target.value, 10) || 5)}
            min={1} max={20} className="w-full rounded-lg border border-border/40 bg-foreground/[0.03] px-3 py-2 text-sm outline-none focus:border-primary/50" data-testid="searxng-max-results" />
          <p className="mt-1 text-xs text-muted-foreground">Number of search results returned (1-20)</p>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium">Search Categories</label>
          <input value={form.categories} onChange={(e) => updateField('categories', e.target.value)}
            className="w-full rounded-lg border border-border/40 bg-foreground/[0.03] px-3 py-2 text-sm outline-none focus:border-primary/50"
            placeholder="general" data-testid="searxng-categories" />
          <p className="mt-1 text-xs text-muted-foreground">Comma-separated: general, it, science, files</p>
        </div>
      </div>

      <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-300">
        <p className="font-medium">How web search works</p>
        <p className="mt-1 text-xs text-sky-300/80">
          When users enable &quot;Search web for reference material&quot; in any AI mode, the MCP sidecar queries SearXNG,
          fetches the top results, and injects them into the LLM prompt as verified reference material.
        </p>
      </div>

      {isDirty && (
        <div className="sticky bottom-0 flex justify-end border-t border-border/40 bg-card/80 pt-4 backdrop-blur-sm">
          <button onClick={() => saveMutation.mutate(form)} disabled={saveMutation.isPending}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="searxng-save">
            {saveMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Save SearXNG Settings
          </button>
        </div>
      )}
    </div>
  );
}
