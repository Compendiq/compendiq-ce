import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '../../../shared/lib/api';
import type { DashboardProps } from './AnalyticsPage';
import {
  BarChart, Bar, PieChart, Pie, Cell, Treemap,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from '../../../shared/components/charts/ChartsBundle';

// ── Types ──────────────────────────────────────────────────────────────────────

interface KnowledgeHealthData {
  qualityDistribution: Array<{ bucket: string; count: number }>;
  staleContent: Array<{ bucket: string; count: number }>;
  coverageBySpace: Array<{ spaceKey: string | null; pageCount: number; avgQuality: number | null }>;
  verificationStatus: Array<{ status: string; count: number }>;
}

// ── Colors ─────────────────────────────────────────────────────────────────────

const QUALITY_COLORS: Record<string, string> = {
  excellent: '#10b981',
  good: '#3b82f6',
  fair: '#f59e0b',
  poor: '#ef4444',
  unscored: '#6b7280',
};

const VERIFICATION_COLORS: Record<string, string> = {
  verified_current: '#10b981',
  verified_stale: '#f59e0b',
  unverified: '#6b7280',
};

const TREEMAP_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#6b7280'];

// ── Hook ───────────────────────────────────────────────────────────────────────

function useKnowledgeHealth(dateRange: DashboardProps['dateRange']) {
  return useQuery<KnowledgeHealthData>({
    queryKey: ['admin', 'analytics', 'knowledge-health', dateRange],
    queryFn: () =>
      apiFetch(
        `/admin/analytics/knowledge-health?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}`,
      ),
    staleTime: 60_000,
  });
}

// ── Chart skeleton ─────────────────────────────────────────────────────────────

function ChartSkeleton() {
  return <div className="h-64 animate-pulse rounded-lg bg-foreground/5" />;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function KnowledgeHealthDashboard({ dateRange, onExportPdf, onExportExcel }: DashboardProps) {
  const { data, isLoading } = useKnowledgeHealth(dateRange);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="knowledge-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="glass-card p-4">
            <ChartSkeleton />
          </div>
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="glass-card p-8 text-center text-sm text-muted-foreground" data-testid="knowledge-empty">
        No knowledge health data available for the selected date range.
      </div>
    );
  }

  const flatRows: Record<string, unknown>[] = [
    ...data.qualityDistribution.map((d) => ({ type: 'quality', bucket: d.bucket, count: d.count })),
    ...data.staleContent.map((d) => ({ type: 'stale', bucket: d.bucket, count: d.count })),
    ...data.coverageBySpace.map((d) => ({
      type: 'coverage',
      spaceKey: d.spaceKey ?? 'unassigned',
      pageCount: d.pageCount,
      avgQuality: d.avgQuality ?? 'N/A',
    })),
    ...data.verificationStatus.map((d) => ({ type: 'verification', status: d.status, count: d.count })),
  ];

  return (
    <div className="space-y-4" data-testid="knowledge-dashboard">
      {/* Export row */}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => onExportPdf(flatRows, 'Knowledge Health')}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="knowledge-export-pdf"
        >
          <Download className="h-3.5 w-3.5" /> PDF
        </button>
        <button
          onClick={() => onExportExcel(flatRows, 'Knowledge Health')}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="knowledge-export-excel"
        >
          <Download className="h-3.5 w-3.5" /> Excel
        </button>
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Quality Score Distribution */}
        <div className="glass-card p-4" data-testid="quality-chart">
          <h3 className="text-sm font-medium mb-3">Quality Score Distribution</h3>
          <Suspense fallback={<ChartSkeleton />}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={data.qualityDistribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-foreground)" strokeOpacity={0.1} />
                <XAxis dataKey="bucket" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {data.qualityDistribution.map((entry) => (
                    <Cell key={entry.bucket} fill={QUALITY_COLORS[entry.bucket] ?? '#6b7280'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Suspense>
        </div>

        {/* Stale Content Breakdown */}
        <div className="glass-card p-4" data-testid="stale-chart">
          <h3 className="text-sm font-medium mb-3">Stale Content Breakdown</h3>
          <Suspense fallback={<ChartSkeleton />}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={data.staleContent} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-foreground)" strokeOpacity={0.1} />
                <XAxis type="number" tick={{ fontSize: 12 }} />
                <YAxis dataKey="bucket" type="category" tick={{ fontSize: 12 }} width={100} />
                <Tooltip />
                <Bar dataKey="count" fill="#f59e0b" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Suspense>
        </div>

        {/* Coverage by Space (Treemap) */}
        <div className="glass-card p-4" data-testid="coverage-chart">
          <h3 className="text-sm font-medium mb-3">Coverage by Space</h3>
          <Suspense fallback={<ChartSkeleton />}>
            {data.coverageBySpace.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <Treemap
                  data={data.coverageBySpace.map((d, i) => ({
                    name: d.spaceKey ?? 'Unassigned',
                    size: d.pageCount,
                    fill: TREEMAP_COLORS[i % TREEMAP_COLORS.length],
                  }))}
                  dataKey="size"
                  stroke="var(--color-background)"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  content={({ x, y, width, height, name, fill }: any) => (
                    <g>
                      <rect x={x} y={y} width={width} height={height} fill={fill} rx={4} opacity={0.85} />
                      {width > 40 && height > 20 && (
                        <text x={x + width / 2} y={y + height / 2} textAnchor="middle" dominantBaseline="central" fontSize={11} fill="#fff">
                          {name}
                        </text>
                      )}
                    </g>
                  )}
                />
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[250px] text-sm text-muted-foreground">
                No space coverage data
              </div>
            )}
          </Suspense>
        </div>

        {/* Verification Status */}
        <div className="glass-card p-4" data-testid="verification-chart">
          <h3 className="text-sm font-medium mb-3">Verification Status</h3>
          <Suspense fallback={<ChartSkeleton />}>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={data.verificationStatus}
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
                  {data.verificationStatus.map((entry) => (
                    <Cell key={entry.status} fill={VERIFICATION_COLORS[entry.status] ?? '#6b7280'} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </Suspense>
        </div>
      </div>
    </div>
  );
}
