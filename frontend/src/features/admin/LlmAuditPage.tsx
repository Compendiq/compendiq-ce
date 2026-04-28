import { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  FileText, AlertTriangle, Download, ChevronLeft, ChevronRight,
  Filter,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';

// ── Types ──────────────────────────────────────────────────────────────────────

// Matches the backend `llm_audit_log` row shape (snake_case columns).
interface AuditEntry {
  id: number;
  user_id: string | null;
  action: string;
  model: string;
  provider: string;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  status: 'success' | 'error';
  error_message: string | null;
  created_at: string;
}

interface AuditResponse {
  items: AuditEntry[];
  total: number;
  page: number;
  limit: number;
}

interface AuditStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byAction: Record<string, number>;
  byModel: Record<string, number>;
  byStatus: Record<string, number>;
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

// Convert a YYYY-MM-DD from the date input to an ISO-8601 string with offset,
// which is what the backend Zod schema (`z.string().datetime({ offset: true })`)
// accepts. Returns `undefined` when the input is empty.
function dateInputToIso(value: string, endOfDay = false): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  if (endOfDay) d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

function useAuditLog(params: {
  page: number;
  limit: number;
  userId?: string;
  action?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}) {
  const searchParams = new URLSearchParams();
  searchParams.set('page', String(params.page));
  searchParams.set('limit', String(params.limit));
  if (params.userId) searchParams.set('userId', params.userId);
  if (params.action) searchParams.set('action', params.action);
  if (params.status) searchParams.set('status', params.status);
  if (params.startDate) searchParams.set('startDate', params.startDate);
  if (params.endDate) searchParams.set('endDate', params.endDate);

  return useQuery<AuditResponse>({
    queryKey: ['admin', 'llm-audit', params],
    queryFn: () => apiFetch(`/admin/llm-audit?${searchParams.toString()}`),
    staleTime: 10_000,
  });
}

function useAuditStats() {
  return useQuery<AuditStats>({
    queryKey: ['admin', 'llm-audit', 'stats'],
    queryFn: () => apiFetch('/admin/llm-audit/stats'),
    staleTime: 30_000,
  });
}

// ── Component ──────────────────────────────────────────────────────────────────

export function LlmAuditPage() {
  const { hasFeature } = useEnterprise();

  const [page, setPage] = useState(1);
  const [pageSize] = useState(25);
  const [filterUser, setFilterUser] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const featureEnabled = hasFeature('llm_audit_trail');

  // Validate userId filter: the backend requires a UUID. Silently drop
  // partial input so the list doesn't error out on every keystroke.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const { data, isLoading } = useAuditLog({
    page,
    limit: pageSize,
    userId: isUuid.test(filterUser.trim()) ? filterUser.trim() : undefined,
    action: filterAction || undefined,
    status: filterStatus || undefined,
    startDate: dateInputToIso(filterFrom),
    endDate: dateInputToIso(filterTo, true),
  });

  const { data: stats } = useAuditStats();

  const derivedStats = useMemo(() => {
    if (!stats) return null;
    const totalTokens = (stats.totalInputTokens ?? 0) + (stats.totalOutputTokens ?? 0);
    const errorCount = stats.byStatus?.error ?? 0;
    const errorRate = stats.totalRequests > 0 ? errorCount / stats.totalRequests : 0;
    return {
      totalRequests: stats.totalRequests ?? 0,
      totalTokens,
      errorRate,
    };
  }, [stats]);

  const handleExportCsv = useCallback(async () => {
    try {
      const { accessToken } = (await import('../../stores/auth-store')).useAuthStore.getState();
      const res = await fetch(`/api/admin/llm-audit/export?format=csv`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `llm-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
      toast.success('CSV exported');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    }
  }, []);

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  if (!featureEnabled) {
    // #347: per-call LLM audit (model, tokens, duration, status) is an EE
    // capability. CE keeps the route mounted so direct-URL access surfaces a
    // clear upgrade message instead of a 404; the nav entry is already
    // hidden in settings-nav.ts via enterpriseOnly. Operational events
    // (login, sync, admin actions) live in the regular audit log and are
    // CE-available — link the user there.
    return (
      <div className="space-y-6" data-testid="llm-audit-gated">
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="space-y-2">
            <div className="text-sm font-medium text-amber-200">LLM Audit Trail — Enterprise feature</div>
            <p className="text-xs text-muted-foreground">
              Per-LLM-call records (model, tokens, latency, status, prompt
              redaction) ship with the Enterprise Edition. The Community
              Edition does not persist these to keep the install lightweight
              and avoid storing prompt content by default.
            </p>
            <p className="text-xs text-muted-foreground">
              Need basic ops auditing today? Login, sync, admin, and PAT events
              are recorded in the regular <strong>Audit Log</strong>{' '}
              (Settings → Security → Audit) on every edition.
            </p>
          </div>
        </m.div>
      </div>
    );
  }

  const items = data?.items ?? [];

  return (
    <div className="space-y-6" data-testid="llm-audit-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <FileText size={18} className="text-muted-foreground" />
            LLM Audit Trail
          </h2>
          <p className="text-sm text-muted-foreground">
            View and export all LLM API requests across the organization.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-2 text-sm transition-colors',
              showFilters ? 'bg-primary/15 text-primary' : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
            )}
            data-testid="toggle-filters-btn"
          >
            <Filter size={14} />
            Filters
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="flex items-center gap-1.5 rounded-md bg-foreground/5 px-3 py-2 text-sm text-muted-foreground hover:bg-foreground/10"
            data-testid="export-csv-btn"
          >
            <Download size={14} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Stats cards */}
      {derivedStats && (
        <div className="grid gap-3 sm:grid-cols-3" data-testid="audit-stats">
          <StatCard label="Total Requests" value={derivedStats.totalRequests.toLocaleString()} />
          <StatCard label="Total Tokens" value={derivedStats.totalTokens.toLocaleString()} />
          <StatCard
            label="Error Rate"
            value={`${(derivedStats.errorRate * 100).toFixed(1)}%`}
            variant={derivedStats.errorRate > 0.1 ? 'warning' : 'default'}
          />
        </div>
      )}

      {/* Filters */}
      {showFilters && (
        <m.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="nm-card space-y-3 p-4"
          data-testid="audit-filters"
        >
          <div className="grid gap-3 sm:grid-cols-5">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">User ID (UUID)</label>
              <input
                type="text"
                value={filterUser}
                onChange={(e) => { setFilterUser(e.target.value); setPage(1); }}
                placeholder="Filter by user UUID"
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-user"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Action</label>
              <input
                type="text"
                value={filterAction}
                onChange={(e) => { setFilterAction(e.target.value); setPage(1); }}
                placeholder="e.g. chat, embed"
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-action"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Status</label>
              <select
                value={filterStatus}
                onChange={(e) => { setFilterStatus(e.target.value); setPage(1); }}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-status"
              >
                <option value="">All</option>
                <option value="success">Success</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">From</label>
              <input
                type="date"
                value={filterFrom}
                onChange={(e) => { setFilterFrom(e.target.value); setPage(1); }}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-from"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">To</label>
              <input
                type="date"
                value={filterTo}
                onChange={(e) => { setFilterTo(e.target.value); setPage(1); }}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="filter-to"
              />
            </div>
          </div>
        </m.div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-3" data-testid="audit-loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-foreground/5" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="nm-card py-12 text-center text-sm text-muted-foreground" data-testid="audit-empty">
          No audit entries found
        </div>
      ) : (
        <div className="nm-card overflow-hidden" data-testid="audit-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">User ID</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Model</th>
                <th className="px-4 py-3 font-medium">Tokens</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {items.map((entry) => {
                const tokens = (entry.input_tokens ?? 0) + (entry.output_tokens ?? 0);
                return (
                  <tr key={entry.id} className="hover:bg-foreground/5">
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {entry.created_at ? new Date(entry.created_at).toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {entry.user_id ? entry.user_id.slice(0, 8) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                        {entry.action}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">{entry.model}</td>
                    <td className="px-4 py-2.5 text-xs">{tokens.toLocaleString()}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn(
                        'rounded px-2 py-0.5 text-xs font-medium',
                        entry.status === 'success'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-destructive/10 text-destructive',
                      )}>
                        {entry.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground" data-testid="audit-pagination">
          <span>
            Page {page} of {totalPages} ({data?.total.toLocaleString()} entries)
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded p-1.5 hover:bg-foreground/10 disabled:opacity-50"
              data-testid="prev-page-btn"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="rounded p-1.5 hover:bg-foreground/10 disabled:opacity-50"
              data-testid="next-page-btn"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Helper Components ────────────────────────────────────────────────────────

function StatCard({ label, value, variant = 'default' }: { label: string; value: string; variant?: 'default' | 'warning' }) {
  return (
    <div className="nm-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn(
        'mt-1 text-xl font-semibold',
        variant === 'warning' ? 'text-amber-400' : 'text-foreground',
      )}>
        {value}
      </div>
    </div>
  );
}
