import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import type { DashboardProps } from './AnalyticsPage';
import { useThemeColors } from '../../../shared/hooks/use-theme-colors';
import type { ReadThemeColor } from '../../../shared/lib/theme-colors';
import {
  CHART_LEGEND_WRAPPER_STYLE,
  CHART_TOOLTIP_CONTENT_STYLE,
  CHART_TOOLTIP_LABEL_STYLE,
} from '../../../shared/components/charts/chart-chrome';
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

/**
 * Series colours, resolved from the palette per theme. These were Tailwind v3
 * defaults, which follow no theme and fail contrast on the light pane
 * (v3 emerald-500 measures 2.54:1 on white). An open request is informational,
 * not a fault; in-progress is the warning hue because the work is outstanding.
 */
const buildColors = (read: ReadThemeColor) => ({
  backlog: {
    open: read('--color-info'),
    in_progress: read('--color-status-syncing'),
    completed: read('--color-status-connected'),
    rejected: read('--color-status-inactive'),
  } as Record<string, string>,
  /** Any status the API reports that has no mapping above. */
  unmapped: read('--color-status-inactive'),
});

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
    <div className="nm-card p-4 text-center" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </div>
  );
}

// ── Severity indicator ─────────────────────────────────────────────────────────

/**
 * Severity is carried by BAR COUNT first and hue second.
 *
 * Hue alone was the whole signal here and it failed WCAG 1.4.1: the column has
 * no header text, nothing else in the row names the severity, and the four
 * states used `status-inactive`/`destructive`/`warning`/`success` — pairs that
 * collapse to near-identical warm greys under deuteranopia, so an unscored gap
 * and a healthy one rendered as the same dot.
 *
 * Filled-segment count is a pre-attentive length channel that survives
 * greyscale, forced-colors and desaturation. It is the same channel
 * QualityScoreBadge uses for the quality band, for the same reason. More bars =
 * worse gap; no bars = never scored, which no longer needs a hue of its own.
 * The `sr-only` word is the accessible name — a `title` would not be.
 */
const SEVERITY_BARS = 3;

interface Severity {
  /** 0–3; how many of the bars are filled. */
  filled: number;
  label: string;
  barClass: string;
}

function severityFor(score: number | null): Severity {
  if (score == null) return { filled: 0, label: 'Never scored', barClass: 'bg-border' };
  if (score < 0.2) return { filled: 3, label: 'Severe gap', barClass: 'bg-destructive' };
  if (score < 0.5) return { filled: 2, label: 'Moderate gap', barClass: 'bg-warning' };
  return { filled: 1, label: 'Minor gap', barClass: 'bg-success' };
}

function SeverityMeter({ score }: { score: number | null }) {
  const { filled, label, barClass } = severityFor(score);
  return (
    <span className="inline-flex items-center" data-testid="gap-severity" data-filled={filled}>
      <span aria-hidden="true" className="flex items-center gap-px">
        {Array.from({ length: SEVERITY_BARS }, (_, i) => (
          <span
            key={i}
            className={cn('h-2 w-[3px] rounded-[1px]', i < filled ? barClass : 'bg-border')}
          />
        ))}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ContentGapsDashboard({ dateRange, onExportPdf }: DashboardProps) {
  const { data, isLoading } = useContentGaps(dateRange);
  const colors = useThemeColors(buildColors);

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="content-gaps-loading">
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="nm-card h-20 animate-pulse" />
          ))}
        </div>
        <div className="nm-card p-4"><ChartSkeleton /></div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="nm-card p-8 text-center text-sm text-muted-foreground" data-testid="content-gaps-empty">
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
        <div className="nm-card p-4" data-testid="backlog-chart">
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
                      <Cell key={entry.status} fill={colors.backlog[entry.status] ?? colors.unmapped} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
                    labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  />
                  <Legend wrapperStyle={CHART_LEGEND_WRAPPER_STYLE} />
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
        <div className="nm-card overflow-hidden" data-testid="gaps-table">
          <div className="p-4 border-b border-foreground/5">
            <h3 className="text-sm font-medium">Content Gaps</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Queries with low or no results, sorted by frequency</p>
          </div>
          {data.gaps.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-foreground/5">
                    {/* Header text the column always lacked, so the severity
                        cells have a column name to be read against. sr-only:
                        the meter is a 9px graphic and a visible label would
                        outweigh it. */}
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">
                      <span className="sr-only">Severity</span>
                    </th>
                    <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Query</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Occurrences</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Avg Results</th>
                    <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Last Searched</th>
                  </tr>
                </thead>
                <tbody>
                  {data.gaps.map((row) => (
                    <tr key={row.query} className="border-b border-foreground/5 last:border-0">
                      <td className="px-4 py-2"><SeverityMeter score={row.avgMaxScore} /></td>
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
        <div className="nm-card overflow-hidden" data-testid="duplicates-table">
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
