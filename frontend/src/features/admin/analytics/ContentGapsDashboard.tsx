import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '../../../shared/lib/api';
import type { DashboardProps } from './AnalyticsPage';
import {
  PieChart, Pie, Cell,
  Tooltip, ResponsiveContainer, Legend,
} from '../../../shared/components/charts/ChartsBundle';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ContentGapsData {
  gaps: Array<{
    query: string;
    occurrences: number;
    lastSearched: string;
    avgMaxScore: number | null;
    avgResultCount: number;
  }>;
  duplicateCoverage: Array<{
    spaceKey: string | null;
    title: string;
    pageCount: number;
  }>;
  requestBacklog: Array<{
    status: string;
    count: number;
  }>;
}

// ── Colors ─────────────────────────────────────────────────────────────────────

const BACKLOG_COLORS: Record<string, string> = {
  open: '#3b82f6',
  in_progress: '#f59e0b',
  completed: '#10b981',
  rejected: '#6b7280',
};

// ── Hook ───────────────────────────────────────────────────────────────────────

function useContentGaps(dateRange: DashboardProps['dateRange']) {
  return useQuery<ContentGapsData>({
    queryKey: ['admin', 'analytics', 'content-gaps', dateRange],
    queryFn: () =>
      apiFetch(
        `/admin/analytics/content-gaps?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}`,
      ),
    staleTime: 60_000,
  });
}

// ── Chart skeleton ─────────────────────────────────────────────────────────────

function ChartSkeleton() {
  return <div className="h-48 animate-pulse rounded-lg bg-foreground/5" />;
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="glass-card p-4 text-center" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

// ── Severity indicator ─────────────────────────────────────────────────────────

function SeverityDot({ score }: { score: number | null }) {
  const color =
    score == null ? 'bg-gray-400' :
    score < 0.2 ? 'bg-red-500' :
    score < 0.5 ? 'bg-amber-500' : 'bg-green-500';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ContentGapsDashboard({ dateRange, onExportPdf }: DashboardProps) {
  const { data, isLoading } = useContentGaps(dateRange);

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="content-gaps-loading">
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="glass-card h-20 animate-pulse" />
          ))}
        </div>
        <div className="glass-card p-4"><ChartSkeleton /></div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="glass-card p-8 text-center text-sm text-muted-foreground" data-testid="content-gaps-empty">
        No content gaps data available for the selected date range.
      </div>
    );
  }

  const totalGaps = data.gaps.length;
  const totalDuplicates = data.duplicateCoverage.length;
  const openRequests = data.requestBacklog
    .filter((r) => r.status === 'open')
    .reduce((sum, r) => sum + r.count, 0);

  const flatRows: Record<string, unknown>[] = [
    ...data.gaps.map((d) => ({
      type: 'gap',
      query: d.query,
      occurrences: d.occurrences,
      lastSearched: d.lastSearched,
      avgMaxScore: d.avgMaxScore ?? 'N/A',
      avgResultCount: d.avgResultCount,
    })),
    ...data.duplicateCoverage.map((d) => ({
      type: 'duplicate',
      spaceKey: d.spaceKey ?? 'unassigned',
      title: d.title,
      pageCount: d.pageCount,
    })),
    ...data.requestBacklog.map((d) => ({ type: 'backlog', status: d.status, count: d.count })),
  ];

  return (
    <div className="space-y-4" data-testid="content-gaps-dashboard">
      {/* Export row */}
      <div className="flex justify-end gap-2">
        <button
          onClick={() =>
            onExportPdf(flatRows, 'Content Gaps', [
              { label: 'Content gaps', value: totalGaps },
              { label: 'Duplicate topics', value: totalDuplicates },
              { label: 'Open requests', value: openRequests },
            ])
          }
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="gaps-export-pdf"
        >
          <Download className="h-3.5 w-3.5" /> PDF
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Content Gaps" value={totalGaps} />
        <StatCard label="Duplicate Topics" value={totalDuplicates} />
        <StatCard label="Open Requests" value={openRequests} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Request Backlog Pie */}
        <div className="glass-card p-4" data-testid="backlog-chart">
          <h3 className="text-sm font-medium mb-3">Request Backlog</h3>
          <Suspense fallback={<ChartSkeleton />}>
            {data.requestBacklog.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={data.requestBacklog}
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    dataKey="count"
                    nameKey="status"
                    label={({ name, percent }: { name?: string; percent?: number }) =>
                      `${String(name ?? '').replace(/_/g, ' ')} ${((percent ?? 0) * 100).toFixed(0)}%`
                    }
                    labelLine={false}
                  >
                    {data.requestBacklog.map((entry) => (
                      <Cell key={entry.status} fill={BACKLOG_COLORS[entry.status] ?? '#6b7280'} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[250px] text-sm text-muted-foreground">
                No request backlog data
              </div>
            )}
          </Suspense>
        </div>

        {/* Content Gaps Table */}
        <div className="glass-card overflow-hidden" data-testid="gaps-table">
          <div className="p-4 border-b border-foreground/5">
            <h3 className="text-sm font-medium">Content Gaps</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Queries with low or no results, sorted by frequency</p>
          </div>
          {data.gaps.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-foreground/5">
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium" />
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Query</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Occurrences</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Avg Results</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Last Searched</th>
                  </tr>
                </thead>
                <tbody>
                  {data.gaps.map((row) => (
                    <tr key={row.query} className="border-b border-foreground/5 last:border-0">
                      <td className="px-4 py-2"><SeverityDot score={row.avgMaxScore} /></td>
                      <td className="px-4 py-2 font-mono text-xs truncate max-w-[200px]">{row.query}</td>
                      <td className="px-4 py-2 text-right">{row.occurrences}</td>
                      <td className="px-4 py-2 text-right">{row.avgResultCount.toFixed(1)}</td>
                      <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                        {new Date(row.lastSearched).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">No content gaps detected</div>
          )}
        </div>
      </div>

      {/* Duplicate Coverage Table */}
      {data.duplicateCoverage.length > 0 && (
        <div className="glass-card overflow-hidden" data-testid="duplicates-table">
          <div className="p-4 border-b border-foreground/5">
            <h3 className="text-sm font-medium">Duplicate Coverage</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Topics covered by multiple pages</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-foreground/5">
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Space</th>
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Title</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Pages</th>
                </tr>
              </thead>
              <tbody>
                {data.duplicateCoverage.map((row, i) => (
                  <tr key={`${row.spaceKey}-${row.title}-${i}`} className="border-b border-foreground/5 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{row.spaceKey ?? 'Unassigned'}</td>
                    <td className="px-4 py-2">{row.title}</td>
                    <td className="px-4 py-2 text-right">{row.pageCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
