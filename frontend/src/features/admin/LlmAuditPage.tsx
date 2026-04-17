import { useState, useCallback } from 'react';
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

interface AuditEntry {
  id: number;
  userId: string;
  username: string;
  action: string;
  model: string;
  provider: string;
  tokensUsed: number;
  status: 'success' | 'error';
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

interface AuditStats {
  totalRequests: number;
  totalTokens: number;
  uniqueUsers: number;
  errorRate: number;
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

function useAuditLog(params: {
  page: number;
  pageSize: number;
  userId?: string;
  action?: string;
  status?: string;
  from?: string;
  to?: string;
}) {
  const searchParams = new URLSearchParams();
  searchParams.set('page', String(params.page));
  searchParams.set('pageSize', String(params.pageSize));
  if (params.userId) searchParams.set('userId', params.userId);
  if (params.action) searchParams.set('action', params.action);
  if (params.status) searchParams.set('status', params.status);
  if (params.from) searchParams.set('from', params.from);
  if (params.to) searchParams.set('to', params.to);

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

  const { data, isLoading } = useAuditLog({
    page,
    pageSize,
    userId: filterUser || undefined,
    action: filterAction || undefined,
    status: filterStatus || undefined,
    from: filterFrom || undefined,
    to: filterTo || undefined,
  });

  const { data: stats } = useAuditStats();

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
    return (
      <div className="space-y-6" data-testid="llm-audit-gated">
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <div className="text-sm font-medium text-amber-200">Enterprise Feature</div>
            <div className="mt-1 text-xs text-muted-foreground">
              LLM audit trail requires an enterprise license with the Audit Trail feature enabled.
            </div>
          </div>
        </m.div>
      </div>
    );
  }

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
      {stats && (
        <div className="grid gap-3 sm:grid-cols-4" data-testid="audit-stats">
          <StatCard label="Total Requests" value={stats.totalRequests.toLocaleString()} />
          <StatCard label="Total Tokens" value={stats.totalTokens.toLocaleString()} />
          <StatCard label="Unique Users" value={stats.uniqueUsers.toLocaleString()} />
          <StatCard
            label="Error Rate"
            value={`${(stats.errorRate * 100).toFixed(1)}%`}
            variant={stats.errorRate > 0.1 ? 'warning' : 'default'}
          />
        </div>
      )}

      {/* Filters */}
      {showFilters && (
        <m.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="glass-card space-y-3 p-4"
          data-testid="audit-filters"
        >
          <div className="grid gap-3 sm:grid-cols-5">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">User ID</label>
              <input
                type="text"
                value={filterUser}
                onChange={(e) => { setFilterUser(e.target.value); setPage(1); }}
                placeholder="Filter by user"
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
      ) : !data?.entries.length ? (
        <div className="glass-card py-12 text-center text-sm text-muted-foreground" data-testid="audit-empty">
          No audit entries found
        </div>
      ) : (
        <div className="glass-card overflow-hidden" data-testid="audit-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Time</th>
                <th className="px-4 py-3 font-medium">User</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Model</th>
                <th className="px-4 py-3 font-medium">Tokens</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {data.entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-foreground/5">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-xs">{entry.username}</td>
                  <td className="px-4 py-2.5">
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      {entry.action}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs">{entry.model}</td>
                  <td className="px-4 py-2.5 text-xs">{entry.tokensUsed.toLocaleString()}</td>
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
              ))}
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
    <div className="glass-card p-4">
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
