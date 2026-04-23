import { lazy, Suspense, useState, useCallback } from 'react';
import {
  BarChart3, Brain, Search, AlertTriangle,
} from 'lucide-react';
import { useEnterprise } from '../../../shared/enterprise/use-enterprise';
import { useAuthStore } from '../../../stores/auth-store';
import { cn } from '../../../shared/lib/cn';

// ── Types ──────────────────────────────────────────────────────────────────────

export type AnalyticsTab = 'knowledge' | 'ai-usage' | 'search' | 'content-gaps';

export interface DateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

export interface DashboardProps {
  dateRange: DateRange;
  /**
   * Export rows to PDF. The `kpis` argument is optional — dashboards that
   * have headline KPIs can surface them on the cover page; others can
   * skip it and the cover still renders (title + date range + integrity
   * hash). Excel export was removed in #303 — CSV opens cleanly in Excel.
   */
  onExportPdf: (
    rows: Record<string, unknown>[],
    title: string,
    kpis?: Array<{ label: string; value: string | number; unit?: string }>,
  ) => Promise<void>;
}

// ── Lazy-loaded dashboards ─────────────────────────────────────────────────────

const KnowledgeHealthDashboard = lazy(() =>
  import('./KnowledgeHealthDashboard').then((m) => ({ default: m.KnowledgeHealthDashboard })),
);
const AiUsageDashboard = lazy(() =>
  import('./AiUsageDashboard').then((m) => ({ default: m.AiUsageDashboard })),
);
const SearchEffectivenessDashboard = lazy(() =>
  import('./SearchEffectivenessDashboard').then((m) => ({ default: m.SearchEffectivenessDashboard })),
);
const ContentGapsDashboard = lazy(() =>
  import('./ContentGapsDashboard').then((m) => ({ default: m.ContentGapsDashboard })),
);

// ── Tab config ─────────────────────────────────────────────────────────────────

interface TabDef {
  id: AnalyticsTab;
  label: string;
  icon: typeof BarChart3;
  requiresFeature?: string;
}

const TABS: TabDef[] = [
  { id: 'knowledge', label: 'Knowledge Health', icon: BarChart3 },
  { id: 'ai-usage', label: 'AI Usage', icon: Brain, requiresFeature: 'ai_usage_analytics' },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'content-gaps', label: 'Content Gaps', icon: AlertTriangle },
];

// ── Loading fallback ───────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="glass-card h-64 animate-pulse" />
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const { hasFeature } = useEnterprise();
  const analyticsEnabled = hasFeature('advanced_analytics');

  const [activeTab, setActiveTab] = useState<AnalyticsTab>('knowledge');
  const [dateRange, setDateRange] = useState<DateRange>(() => ({
    startDate: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
  }));
  const authUser = useAuthStore((s) => s.user);

  const handleExportPdf = useCallback(
    async (
      rows: Record<string, unknown>[],
      title: string,
      kpis?: Array<{ label: string; value: string | number; unit?: string }>,
    ) => {
      const { exportToPdf } = await import('../../../shared/lib/export-helpers');
      // Filename includes both dates so exports with the same start but a
      // different end don't silently collide on the user's disk.
      const slug = title.toLowerCase().replace(/\s+/g, '-');
      await exportToPdf(
        `${slug}-${dateRange.startDate}-to-${dateRange.endDate}.pdf`,
        rows,
        {
          title,
          dateRange,
          generatedBy: authUser?.username,
          instanceUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
          kpis,
        },
      );
    },
    [dateRange, authUser],
  );

  // Feature gate: require advanced_analytics
  if (!analyticsEnabled) {
    return (
      <div className="space-y-6" data-testid="analytics-gate">
        <h1 className="text-2xl font-semibold">Enterprise Analytics</h1>
        <div className="glass-card p-8 text-center">
          <BarChart3 className="mx-auto mb-3 h-12 w-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium mb-2">Advanced Analytics</h2>
          <p className="text-sm text-muted-foreground">
            Analytics dashboards require an Enterprise license with the Advanced Analytics feature.
          </p>
        </div>
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);

  const dashboardProps: DashboardProps = {
    dateRange,
    onExportPdf: handleExportPdf,
  };

  return (
    <div className="space-y-6" data-testid="analytics-page">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Enterprise Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Knowledge base health, AI usage, search effectiveness, and content gaps.
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {/* Date range */}
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={dateRange.startDate}
              max={dateRange.endDate}
              onChange={(e) => setDateRange((prev) => ({ ...prev, startDate: e.target.value }))}
              className="glass-card px-2 py-1.5 text-xs"
              data-testid="date-start"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={dateRange.endDate}
              min={dateRange.startDate}
              max={today}
              onChange={(e) => setDateRange((prev) => ({ ...prev, endDate: e.target.value }))}
              className="glass-card px-2 py-1.5 text-xs"
              data-testid="date-end"
            />
          </div>

          {/* Header-level export dropdown removed in #303 — it only ever
              had dead handlers. Export is triggered by the per-dashboard
              PDF button inside each dashboard, which knows which rows +
              KPIs to serialize. */}
        </div>
      </div>

      {/* Tab bar */}
      <div className="glass-card p-1.5 flex gap-1" data-testid="analytics-tabs">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isDisabled = tab.requiresFeature ? !hasFeature(tab.requiresFeature) : false;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-2 rounded px-3 py-2 text-sm transition-colors',
                activeTab === tab.id
                  ? 'bg-foreground/10 font-medium'
                  : 'hover:bg-foreground/5',
                isDisabled && activeTab !== tab.id && 'opacity-50',
              )}
              data-testid={`tab-${tab.id}`}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <Suspense fallback={<DashboardSkeleton />}>
        {activeTab === 'knowledge' && <KnowledgeHealthDashboard {...dashboardProps} />}
        {activeTab === 'ai-usage' && <AiUsageDashboard {...dashboardProps} />}
        {activeTab === 'search' && <SearchEffectivenessDashboard {...dashboardProps} />}
        {activeTab === 'content-gaps' && <ContentGapsDashboard {...dashboardProps} />}
      </Suspense>
    </div>
  );
}
