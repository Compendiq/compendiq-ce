import { Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Brain, Download, AlertTriangle, Info } from 'lucide-react';
import { apiFetch } from '../../../shared/lib/api';
import { useEnterprise } from '../../../shared/enterprise/use-enterprise';
import { cn } from '../../../shared/lib/cn';
import type { DashboardProps } from './AnalyticsPage';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from '../../../shared/components/charts/ChartsBundle';

// ── Types ──────────────────────────────────────────────────────────────────────

interface AiUsageData {
  available: boolean;
  message?: string;
  requestsOverTime: Array<{ date: string; requests: number; errors: number }>;
  tokenConsumption: Array<{ model: string; inputTokens: number; outputTokens: number; totalRequests: number }>;
  modelBreakdown: Array<{ model: string; action: string; count: number; avgDurationMs: number }>;
  errorRate: { total: number; errors: number; rate: number } | null;
}

// ── Hook ───────────────────────────────────────────────────────────────────────

function useAiUsage(dateRange: DashboardProps['dateRange'], enabled: boolean) {
  return useQuery<AiUsageData>({
    queryKey: ['admin', 'analytics', 'ai-usage', dateRange],
    queryFn: () =>
      apiFetch(
        `/admin/analytics/ai-usage?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}`,
      ),
    staleTime: 60_000,
    enabled,
  });
}

// ── Chart skeleton ─────────────────────────────────────────────────────────────

function ChartSkeleton() {
  return <div className="h-64 animate-pulse rounded-lg bg-foreground/5" />;
}

// ── Stat card ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, warning }: { label: string; value: string | number; warning?: boolean }) {
  return (
    <div className={cn('glass-card p-4 text-center', warning && 'border-amber-500/30')} data-testid={`stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={cn('text-2xl font-semibold', warning && 'text-amber-500')}>{value}</p>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function AiUsageDashboard({ dateRange, onExportPdf }: DashboardProps) {
  const { hasFeature } = useEnterprise();
  const aiUsageEnabled = hasFeature('ai_usage_analytics');

  const { data, isLoading } = useAiUsage(dateRange, aiUsageEnabled);

  // Feature gate: ai_usage_analytics (separate from outer advanced_analytics)
  if (!aiUsageEnabled) {
    return (
      <div className="glass-card p-8 text-center" data-testid="ai-usage-gate">
        <Brain className="mx-auto mb-3 h-12 w-12 text-muted-foreground/50" />
        <h2 className="text-lg font-medium mb-2">AI Usage Analytics</h2>
        <p className="text-sm text-muted-foreground">
          AI Usage analytics requires the AI Usage Analytics feature in your Enterprise license.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="ai-usage-loading">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="glass-card h-20 animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="glass-card p-4"><ChartSkeleton /></div>
          <div className="glass-card p-4"><ChartSkeleton /></div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="glass-card p-8 text-center text-sm text-muted-foreground" data-testid="ai-usage-empty">
        No AI usage data available for the selected date range.
      </div>
    );
  }

  // When the llm_audit_log table does not exist
  if (!data.available) {
    return (
      <div className="glass-card p-6 flex items-start gap-3" data-testid="ai-usage-unavailable">
        <Info className="h-5 w-5 text-blue-400 mt-0.5 shrink-0" />
        <div>
          <h3 className="text-sm font-medium mb-1">AI Audit Logging Not Available</h3>
          <p className="text-sm text-muted-foreground">{data.message ?? 'The AI audit log table has not been initialized.'}</p>
        </div>
      </div>
    );
  }

  // Compute stat values
  const totalRequests = data.requestsOverTime.reduce((sum, d) => sum + d.requests, 0);
  const totalTokens = data.tokenConsumption.reduce(
    (sum, d) => sum + d.inputTokens + d.outputTokens,
    0,
  );
  const modelsUsed = new Set(data.tokenConsumption.map((d) => d.model)).size;
  const errorRate = data.errorRate?.rate ?? 0;
  const errorRateWarning = errorRate > 10;

  const flatRows: Record<string, unknown>[] = [
    ...data.requestsOverTime.map((d) => ({ type: 'requests', ...d })),
    ...data.tokenConsumption.map((d) => ({ type: 'tokens', ...d })),
    ...data.modelBreakdown.map((d) => ({ type: 'breakdown', ...d })),
  ];

  return (
    <div className="space-y-4" data-testid="ai-usage-dashboard">
      {/* Export row */}
      <div className="flex justify-end gap-2">
        <button
          onClick={() =>
            onExportPdf(flatRows, 'AI Usage', [
              { label: 'Total requests', value: totalRequests },
              { label: 'Total tokens', value: totalTokens },
              { label: 'Models used', value: modelsUsed },
              { label: 'Error rate', value: errorRate.toFixed(1), unit: '%' },
            ])
          }
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          data-testid="ai-export-pdf"
        >
          <Download className="h-3.5 w-3.5" /> PDF
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Requests" value={totalRequests.toLocaleString()} />
        <StatCard label="Total Tokens" value={totalTokens.toLocaleString()} />
        <StatCard label="Models Used" value={modelsUsed} />
        <StatCard label="Error Rate" value={`${errorRate.toFixed(1)}%`} warning={errorRateWarning} />
      </div>

      {/* Error rate warning */}
      {errorRateWarning && (
        <div className="glass-card border-amber-500/30 p-3 flex items-center gap-2 text-sm text-amber-500" data-testid="error-rate-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Error rate is above 10% ({errorRate.toFixed(1)}%). Investigate failing requests.
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Requests Over Time */}
        <div className="glass-card p-4" data-testid="requests-chart">
          <h3 className="text-sm font-medium mb-3">Requests Over Time</h3>
          <Suspense fallback={<ChartSkeleton />}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={data.requestsOverTime}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-foreground)" strokeOpacity={0.1} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="requests" stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="errors" stroke="#ef4444" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </Suspense>
        </div>

        {/* Token Consumption by Model */}
        <div className="glass-card p-4" data-testid="tokens-chart">
          <h3 className="text-sm font-medium mb-3">Token Consumption by Model</h3>
          <Suspense fallback={<ChartSkeleton />}>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={data.tokenConsumption}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-foreground)" strokeOpacity={0.1} />
                <XAxis dataKey="model" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="inputTokens" name="Input Tokens" fill="#3b82f6" stackId="tokens" radius={[0, 0, 0, 0]} />
                <Bar dataKey="outputTokens" name="Output Tokens" fill="#10b981" stackId="tokens" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Suspense>
        </div>
      </div>

      {/* Model Breakdown Table */}
      {data.modelBreakdown.length > 0 && (
        <div className="glass-card overflow-hidden" data-testid="model-breakdown-table">
          <div className="p-4 border-b border-foreground/5">
            <h3 className="text-sm font-medium">Model Breakdown</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-foreground/5">
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Model</th>
                  <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Action</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Count</th>
                  <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">Avg Duration</th>
                </tr>
              </thead>
              <tbody>
                {data.modelBreakdown.map((row, i) => (
                  <tr key={`${row.model}-${row.action}-${i}`} className="border-b border-foreground/5 last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{row.model}</td>
                    <td className="px-4 py-2">{row.action}</td>
                    <td className="px-4 py-2 text-right">{row.count.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right">{row.avgDurationMs.toFixed(0)}ms</td>
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
