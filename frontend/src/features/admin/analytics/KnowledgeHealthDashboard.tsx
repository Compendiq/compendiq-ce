import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '../../../shared/lib/api';
import type { DashboardProps } from './AnalyticsPage';
import { useThemeColors } from '../../../shared/hooks/use-theme-colors';
import { categoricalRamp, type ReadThemeColor } from '../../../shared/lib/theme-colors';
import {
  CHART_GRID_STROKE,
  CHART_LEGEND_WRAPPER_STYLE,
  CHART_TICK_FILL,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from '../../../shared/components/charts/chart-chrome';
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

/**
 * Series colours, resolved from the palette per theme: every bucket maps onto
 * the token that already owns its meaning, so a retune in index.css moves the
 * chart with it. These were Tailwind v3 defaults, which follow no theme and
 * fail contrast on the light pane: v3 emerald-500 measures 2.54:1 on white
 * where `--color-status-connected` measures 5.43:1.
 */
const buildColors = (read: ReadThemeColor) => ({
  quality: {
    excellent: read('--color-status-connected'),
    good: read('--color-primary'),
    fair: read('--color-status-syncing'),
    poor: read('--color-status-disconnected'),
    unscored: read('--color-status-inactive'),
  } as Record<string, string>,
  verification: {
    verified_current: read('--color-status-connected'),
    verified_stale: read('--color-status-syncing'),
    unverified: read('--color-status-inactive'),
  } as Record<string, string>,
  /** Any bucket the API reports that has no mapping above. */
  unmapped: read('--color-status-inactive'),
  /** Stale content is a warning, and only a warning. */
  stale: read('--color-status-syncing'),
  /**
   * Spaces carry no status — a space is not "healthy", its tile only has to
   * differ from the tile beside it. See `categoricalRamp`.
   */
  coverage: categoricalRamp(read, 8),
  /**
   * Ink on a saturated tile. `--color-background` is the counter-ink by
   * construction: dark on Graphite, where the status hues are light, and
   * light on Paper, where they are dark. The hard-coded white this replaces
   * measured 3.4:1 against Paper's amber tile.
   */
  coverageLabel: read('--color-background'),
});

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

export function KnowledgeHealthDashboard({ dateRange, onExportPdf }: DashboardProps) {
  const { data, isLoading } = useKnowledgeHealth(dateRange);
  const colors = useThemeColors(buildColors);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="knowledge-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="nm-card p-4">
            <ChartSkeleton />
          </div>
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="nm-card p-8 text-center text-sm text-muted-foreground" data-testid="knowledge-empty">
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
          onClick={() =>
            onExportPdf(flatRows, 'Knowledge Health', [
              { label: 'Total pages', value: data.coverageBySpace.reduce((acc, s) => acc + s.pageCount, 0) },
              { label: 'Spaces', value: data.coverageBySpace.length },
              { label: 'Stale (>90d)', value: data.staleContent.reduce((acc, s) => acc + s.count, 0) },
              { label: 'Verification buckets', value: data.verificationStatus.length },
            ])
          }
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="knowledge-export-pdf"
        >
          <Download className="h-3.5 w-3.5" /> PDF
        </button>
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Quality Score Distribution */}
        <div className="nm-card p-4" data-testid="quality-chart">
          <h3 className="text-sm font-medium mb-3">Quality Score Distribution</h3>
          <Suspense fallback={<ChartSkeleton />}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={data.qualityDistribution}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                <XAxis dataKey="bucket" tick={{ fontSize: 12, fill: CHART_TICK_FILL }} stroke={CHART_GRID_STROKE} />
                <YAxis tick={{ fontSize: 12, fill: CHART_TICK_FILL }} stroke={CHART_GRID_STROKE} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {data.qualityDistribution.map((entry) => (
                    <Cell key={entry.bucket} fill={colors.quality[entry.bucket] ?? colors.unmapped} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Suspense>
        </div>

        {/* Stale Content Breakdown */}
        <div className="nm-card p-4" data-testid="stale-chart">
          <h3 className="text-sm font-medium mb-3">Stale Content Breakdown</h3>
          <Suspense fallback={<ChartSkeleton />}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={data.staleContent} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID_STROKE} />
                <XAxis type="number" tick={{ fontSize: 12, fill: CHART_TICK_FILL }} stroke={CHART_GRID_STROKE} />
                <YAxis dataKey="bucket" type="category" tick={{ fontSize: 12, fill: CHART_TICK_FILL }} width={100} stroke={CHART_GRID_STROKE} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                />
                <Bar dataKey="count" fill={colors.stale} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Suspense>
        </div>

        {/* Coverage by Space (Treemap) */}
        <div className="nm-card p-4" data-testid="coverage-chart">
          <h3 className="text-sm font-medium mb-3">Coverage by Space</h3>
          <Suspense fallback={<ChartSkeleton />}>
            {data.coverageBySpace.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <Treemap
                  data={data.coverageBySpace.map((d, i) => ({
                    name: d.spaceKey ?? 'Unassigned',
                    size: d.pageCount,
                    fill: colors.coverage[i % colors.coverage.length],
                  }))}
                  dataKey="size"
                  stroke="var(--color-background)"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  content={({ x, y, width, height, name, fill }: any) => (
                    <g>
                      <rect x={x} y={y} width={width} height={height} fill={fill} rx={4} opacity={0.85} />
                      {width > 40 && height > 20 && (
                        <text x={x + width / 2} y={y + height / 2} textAnchor="middle" dominantBaseline="central" fontSize={11} fill={colors.coverageLabel}>
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
        <div className="nm-card p-4" data-testid="verification-chart">
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
                    <Cell key={entry.status} fill={colors.verification[entry.status] ?? colors.unmapped} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                  labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                />
                <Legend wrapperStyle={CHART_LEGEND_WRAPPER_STYLE} />
              </PieChart>
            </ResponsiveContainer>
          </Suspense>
        </div>
      </div>
    </div>
  );
}
