import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Globe, CheckCircle2, XCircle, Loader2, Trash2, Plus, ExternalLink } from 'lucide-react';
import {
  MCP_DOCS_CACHE_TTL_DEFAULT,
  MCP_DOCS_CACHE_TTL_MAX,
  MCP_DOCS_CACHE_TTL_MIN,
  MCP_DOCS_MAX_CONTENT_LENGTH_DEFAULT,
  MCP_DOCS_MAX_CONTENT_LENGTH_MAX,
  MCP_DOCS_MAX_CONTENT_LENGTH_MIN,
} from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';
import { Button } from '../../shared/components/Button';

interface McpDocsSettings {
  enabled: boolean;
  url: string;
  domainMode: 'allowlist' | 'blocklist';
  allowedDomains: string[];
  blockedDomains: string[];
  cacheTtl: number;
  maxContentLength: number;
}

interface TestResult {
  ok: boolean;
  tools?: string[];
  error?: string;
}

export function McpDocsTab() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<McpDocsSettings>({
    queryKey: ['admin', 'mcp-docs'],
    queryFn: () => apiFetch('/admin/mcp-docs'),
  });

  const [form, setForm] = useState<McpDocsSettings>({
    enabled: false,
    url: 'http://mcp-docs:3100/mcp',
    domainMode: 'blocklist',
    allowedDomains: ['*'],
    blockedDomains: [],
    cacheTtl: MCP_DOCS_CACHE_TTL_DEFAULT,
    maxContentLength: MCP_DOCS_MAX_CONTENT_LENGTH_DEFAULT,
  });

  const [newDomain, setNewDomain] = useState('');
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (settings) {
      setForm(settings);
      setIsDirty(false);
    }
  }, [settings]);

  const updateField = <K extends keyof McpDocsSettings>(key: K, value: McpDocsSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: (body: Partial<McpDocsSettings>) =>
      apiFetch('/admin/mcp-docs', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'mcp-docs'] });
      toast.success('MCP Docs settings saved');
      setIsDirty(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const testMutation = useMutation<TestResult>({
    mutationFn: () => apiFetch('/admin/mcp-docs/test', { method: 'POST' }),
    onSuccess: (data) => {
      if (data.ok) {
        toast.success(`Connected! Tools: ${data.tools?.join(', ')}`);
      } else {
        toast.error(`Connection failed: ${data.error}`);
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const addDomain = () => {
    if (!newDomain.trim()) return;
    const list = form.domainMode === 'allowlist' ? 'allowedDomains' : 'blockedDomains';
    const current = form[list];
    if (!current.includes(newDomain.trim())) {
      updateField(list, [...current, newDomain.trim()]);
    }
    setNewDomain('');
  };

  const removeDomain = (domain: string) => {
    const list = form.domainMode === 'allowlist' ? 'allowedDomains' : 'blockedDomains';
    updateField(list, form[list].filter((d) => d !== domain));
  };

  const activeDomains = form.domainMode === 'allowlist' ? form.allowedDomains : form.blockedDomains;

  if (isLoading) {
    return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 size={16} className="animate-spin" /> Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Globe size={20} className="text-action" />
        <div>
          <h3 className="text-base font-semibold">MCP Documentation Sidecar</h3>
          <p className="text-sm text-muted-foreground">
            Fetch online documentation for air-gapped LLM environments via a sidecar container.
          </p>
        </div>
      </div>

      {/* Enable/Disable */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-foreground/[0.03] p-4">
        <div>
          <div className="text-sm font-medium">Enable MCP Docs</div>
          <div className="text-xs text-muted-foreground">When enabled, users can attach external URLs to Q&amp;A queries</div>
        </div>
        <button
          onClick={() => updateField('enabled', !form.enabled)}
          className={`relative h-6 w-11 rounded-full transition-colors ${form.enabled ? 'bg-action' : 'bg-muted'}`}
          role="switch"
          aria-checked={form.enabled}
          data-testid="mcp-docs-toggle"
        >
          <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${form.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      {form.enabled && (
        <>
          {/* Sidecar URL */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">Sidecar URL</label>
            <div className="flex gap-2">
              <input
                value={form.url}
                onChange={(e) => updateField('url', e.target.value)}
                className="flex-1 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-sm outline-none focus:border-primary/50"
                placeholder="http://mcp-docs:3100/mcp"
                data-testid="mcp-docs-url"
              />
              <button
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-sm hover:bg-foreground/[0.06] disabled:opacity-50"
                data-testid="mcp-docs-test"
              >
                {testMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : testMutation.data?.ok ? (
                  <CheckCircle2 size={14} className="text-success" />
                ) : testMutation.data && !testMutation.data.ok ? (
                  <XCircle size={14} className="text-destructive" />
                ) : (
                  <ExternalLink size={14} />
                )}
                Test
              </button>
            </div>
          </div>

          {/* Domain Mode */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">Domain Control Mode</label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="domainMode"
                  checked={form.domainMode === 'blocklist'}
                  onChange={() => updateField('domainMode', 'blocklist')}
                  className="accent-primary"
                />
                Blocklist <span className="text-xs text-muted-foreground">(allow all except blocked)</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="domainMode"
                  checked={form.domainMode === 'allowlist'}
                  onChange={() => updateField('domainMode', 'allowlist')}
                  className="accent-primary"
                />
                Allowlist <span className="text-xs text-muted-foreground">(block all except allowed)</span>
              </label>
            </div>
          </div>

          {/* Domain List */}
          <div>
            <label className="mb-1.5 block text-sm font-medium">
              {form.domainMode === 'allowlist' ? 'Allowed Domains' : 'Blocked Domains'}
            </label>
            <p className="mb-2 text-xs text-muted-foreground">
              {form.domainMode === 'allowlist'
                ? 'Only these domains can be fetched. Use * to allow all.'
                : 'These domains will be blocked. SSRF protection blocks internal IPs by default.'}
            </p>
            <div className="flex gap-2">
              <input
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addDomain()}
                className="flex-1 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-sm outline-none focus:border-primary/50"
                placeholder="e.g. docs.example.com or *.mozilla.org"
                data-testid="mcp-docs-domain-input"
              />
              <button
                onClick={addDomain}
                className="flex items-center gap-1 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-sm hover:bg-foreground/[0.06]"
              >
                <Plus size={14} /> Add
              </button>
            </div>
            {activeDomains.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {activeDomains.map((domain) => (
                  <span
                    key={domain}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-foreground/[0.03] px-2.5 py-1 text-xs"
                  >
                    {domain}
                    <button onClick={() => removeDomain(domain)} className="text-muted-foreground hover:text-destructive">
                      <Trash2 size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Cache TTL + content ceiling — the backend sends both to the sidecar with every fetch (#1769) */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="mcp-docs-cache-ttl" className="mb-1.5 block text-sm font-medium">Cache TTL (seconds)</label>
              <input
                id="mcp-docs-cache-ttl"
                type="number"
                value={form.cacheTtl}
                onChange={(e) => updateField('cacheTtl', parseInt(e.target.value, 10) || MCP_DOCS_CACHE_TTL_DEFAULT)}
                min={MCP_DOCS_CACHE_TTL_MIN}
                max={MCP_DOCS_CACHE_TTL_MAX}
                aria-describedby="mcp-docs-cache-ttl-help"
                className="w-full rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-sm outline-none focus:border-primary/50"
                data-testid="mcp-docs-cache-ttl"
              />
              <p id="mcp-docs-cache-ttl-help" className="mt-1 text-xs text-muted-foreground">
                How long a newly fetched document stays cached{' '}
                <span className="whitespace-nowrap">({MCP_DOCS_CACHE_TTL_MIN}–{MCP_DOCS_CACHE_TTL_MAX})</span>.
                Documents already cached keep the lifetime they were stored with.
              </p>
            </div>
            <div>
              <label htmlFor="mcp-docs-max-length" className="mb-1.5 block text-sm font-medium">Max Content Length</label>
              <input
                id="mcp-docs-max-length"
                type="number"
                value={form.maxContentLength}
                onChange={(e) => updateField('maxContentLength', parseInt(e.target.value, 10) || MCP_DOCS_MAX_CONTENT_LENGTH_DEFAULT)}
                min={MCP_DOCS_MAX_CONTENT_LENGTH_MIN}
                max={MCP_DOCS_MAX_CONTENT_LENGTH_MAX}
                aria-describedby="mcp-docs-max-length-help"
                className="w-full rounded-lg border border-border bg-foreground/[0.03] px-3 py-2 text-sm outline-none focus:border-primary/50"
                data-testid="mcp-docs-max-length"
              />
              <p id="mcp-docs-max-length-help" className="mt-1 text-xs text-muted-foreground">
                Upper limit on the characters taken from one fetched document{' '}
                <span className="whitespace-nowrap">
                  ({MCP_DOCS_MAX_CONTENT_LENGTH_MIN.toLocaleString('en-US')}–{MCP_DOCS_MAX_CONTENT_LENGTH_MAX.toLocaleString('en-US')})
                </span>.
                Web search uses up to 5,000 per source and attached URLs up to 10,000, never more than this limit.
              </p>
            </div>
          </div>
        </>
      )}

      {/* Save button */}
      {isDirty && (
        <div className="sticky bottom-0 flex justify-end border-t border-border bg-card pt-4">
          <Button
            onClick={() => saveMutation.mutate(form)}
            disabled={saveMutation.isPending}
            isLoading={saveMutation.isPending}
            variant="primary"
            data-testid="mcp-docs-save"
          >
            Save MCP Docs Settings
          </Button>
        </div>
      )}
    </div>
  );
}
