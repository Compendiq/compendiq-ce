import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '../../../shared/lib/api';
import type { DashboardProps } from './AnalyticsPage';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from '../../../shared/components/charts/ChartsBundle';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SearchEffectivenessData {
  zeroResultRate: { total: number; zeroResults: number; rate: number } | null;
  topQueries: Array<{ query: string; searchCount: number; avgResults: number; avgScore: number | null }>;
  clickThroughRate: Array<{ searchType: string; withResults: number; total: number; rate: number }>;
  dailyVolume: Array<{ date: string; totalSearches: number; zeroResultSearches: number }>;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

function useSearchEffectiveness(dateRange: DashboardProps['dateRange']) {
  return useQuery<SearchEffectivenessData>({
    queryKey: ['admin', 'analytics', 'search', dateRange],
    queryFn: () =>
      apiFetch(
        `/admin/analytics/search?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}`,
      ),
    staleTime: 60_000,
  });
}

// ── Chart skeleton ─────────────────────────────────────────────────────────────

function ChartSkeleton() {
  return <div className="h-48 animate-pulse rounded-lg bg-foreground/5" />;
}

// ── Gauge chart (custom half-donut) ────────────────────────────────────────────

function GaugeChart({ value, max, label }: { value: number; max: number; label: string }) {
  const percentage = max > 0 ? (value / max) * 100 : 0;
  const gaugeData = [
    { name: 'value', value: percentage },
    { name: 'remainder', value: 100 - percentage },
  ];
  const color = percentage > 30 ? '#ef4444' : percentage > 15 ? '#f59e0b' : '#10b981';

  return (
    <div className="relative" data-testid="gauge-chart">
      <Suspense fallback={<ChartSkeleton />}>
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={gaugeData}
              cx="50%"
              cy="100%"
              startAngle={180}
              endAngle={0}
              innerRadius={60}
              outerRadius={90}
              dataKey="value"
            >
              <Cell fill={color} />
              <Cell fill="var(--color-foreground)" fillOpacity={0.05} />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </Suspense>
      {/* Center label */}
      <div className="absolute inset-0 flex flex-col items-center justify-end pb-4">
        <span className="text-2xl font-semibold" style={{ color }}>{percentage.toFixed(1)}%</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function SearchEffectivenessDashboard({ dateRange, onExportPdf, onExportExcel }: DashboardProps) {
  const { data, isLoading } = useSearchEffectiveness(dateRange);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="search-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="glass-card p-4"><ChartSkeleton /></div>
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="glass-card p-8 text-center text-sm text-muted-foreground" data-testid="search-empty">
        No search data available for the selected date range.
      </div>
    );
  }

  const flatRows: Record<string, unknown>[] = [
    ...(data.zeroResultRate
      ? [{ type: 'zeroResultRate', total: data.zeroResultRate.total, zeroResults: data.zeroResultRate.zeroResults, rate: data.zeroResultRate.rate }]
      : []),
    ...data.topQueries.map((d) => ({ type: 'topQuery', ...d })),
    ...data.clickThroughRate.map((d) => ({ type: 'clickThrough', ...d })),
    ...data.dailyVolume.map((d) => ({ type: 'dailyVolume', ...d })),
  ];

  return (
    <div className="space-y-4" data-testid="search-dashboard">
      {/* Export row */}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => onExportPdf(flatRows, 'Search Effectiveness')}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="search-export-pdf"
        >
          <Download className="h-3.5 w-3.5" /> PDF
        </button>
        <button
          onClick={() => onExportExcel(flatRows, 'Search Effectiveness')}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="search-export-excel"
        >
          <Download className="h-3.5 w-3.5" /> Excel
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Zero-Result Rate Gauge */}
        <div className="glass-card p-4" data-testid="zero-result-gauge">
          <h3 className="text-sm font-medium mb-3">Zero-Result Rate</h3>
          {data.zeroResultRate ? (
            <GaugeChart
              value={data.zeroResultRate.zeroResults}
              max={data.zeroResultRate.total}
              label="of searches return no results"
            />
          ) : (
            <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">
              No search data
            </div>
          )}
        </div>

        {/* Daily Search Volume */}
        <div className="glass-card p-4" data-testid="daily-volume-chart">
          <h3 className="text-sm font-medium mb-3">Daily Search Volume</h3>
          <Suspense fallback={<ChartSkeleton />}>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={data.dailyVolume}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-foreground)" strokeOpacity={0.1} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Area type="monotone" dataKey="totalSearches" name="Total Searches" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} />
                <Area type="monotone" dataKey="zeroResultSearches" name="Zero Results" stroke="#ef4444" fill="#ef4444" fillOpacity={0.15} />
              </AreaChart>
            </ResponsiveContainer>
          </Suspense>
        </div>

        {/* Click-Through Rates */}
        <div className="glass-card p-4" data-testid="ctr-chart">
          <h3 className="text-sm font-medium mb-3">Click-Through Rates by Type</h3>
          <Suspense fallback={<ChartSkeleton />}>
            {data.clickThroughRate.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={data.clickThroughRate}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-foreground)" strokeOpacity={0.1} />
                  <XAxis dataKey="searchType" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip formatter={(value) => `${Number(value).toFixed(1)}%`} />
                  <Bar dataKey="rate" fill="#10b981" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[250px] text-sm text-muted-foreground">
                No click-through data
              </div>
            )}
          </Suspense>
        </div>

        {/* Top Queries Table */}
        <div className="glass-card overflow-hidden" data-testid="top-queries-table">
          <div className="p-4 border-b border-foreground/5">
            <h3 className="text-sm font-medium">Top Queries</h3>
          </div>
          {data.topQueries.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-foreground/5">
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Query</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Searches</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Avg Results</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Avg Score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topQueries.map((row) => (
                    <tr key={row.query} className="border-b border-foreground/5 last:border-0">
                      <td className="px-4 py-2 font-mono text-xs truncate max-w-[200px]">{row.query}</td>
                      <td className="px-4 py-2 text-right">{row.searchCount}</td>
                      <td className="px-4 py-2 text-right">{row.avgResults.toFixed(1)}</td>
                      <td className="px-4 py-2 text-right">{row.avgScore != null ? row.avgScore.toFixed(2) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-muted-foreground">No search queries recorded</div>
          )}
        </div>
      </div>
    </div>
  );
}
