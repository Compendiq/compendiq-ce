import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { ShieldCheck, Clock, AlertTriangle, HelpCircle, CheckCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

interface VerificationStats {
  fresh: number;
  aging: number;
  overdue: number;
  unverified: number;
  total: number;
}

interface OverdueArticle {
  id: string;
  title: string;
  spaceKey: string;
  lastVerifiedAt: string | null;
  lastModifiedAt: string | null;
}

interface VerificationHealthResponse {
  stats: VerificationStats;
  overdueArticles: OverdueArticle[];
}

function useVerificationHealth() {
  return useQuery<VerificationHealthResponse>({
    queryKey: ['analytics', 'verification-health'],
    queryFn: () => apiFetch('/analytics/verification-health'),
    staleTime: 5 * 60 * 1000,
  });
}

function useVerifyArticle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) =>
      apiFetch(`/pages/${pageId}/verify`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['analytics', 'verification-health'] });
    },
  });
}

const STATUS_CARDS = [
  {
    key: 'fresh' as const,
    label: 'Fresh',
    icon: ShieldCheck,
    colorClass: 'text-success',
    bgClass: 'bg-success/10',
    barColor: 'bg-success',
  },
  {
    key: 'aging' as const,
    label: 'Aging',
    icon: Clock,
    colorClass: 'text-warning',
    bgClass: 'bg-warning/10',
    barColor: 'bg-warning',
  },
  {
    key: 'overdue' as const,
    label: 'Overdue',
    icon: AlertTriangle,
    colorClass: 'text-destructive',
    bgClass: 'bg-destructive/10',
    barColor: 'bg-destructive',
  },
  {
    key: 'unverified' as const,
    label: 'Unverified',
    icon: HelpCircle,
    colorClass: 'text-muted-foreground',
    bgClass: 'bg-foreground/5',
    barColor: 'bg-foreground/30',
  },
];

export function VerificationHealth() {
  const navigate = useNavigate();
  const { data, isLoading } = useVerificationHealth();
  const verifyMutation = useVerifyArticle();

  const stats = data?.stats;
  const total = stats?.total ?? 0;

  return (
    <div className="space-y-4" data-testid="verification-health">
      {/* Status cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STATUS_CARDS.map(({ key, label, icon: Icon, colorClass, bgClass, barColor }, i) => {
          const count = stats?.[key] ?? 0;
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;

          return (
            <m.div
              key={key}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              className="glass-card p-4"
              data-testid={`verification-${key}`}
            >
              <div className="flex items-center gap-2">
                <div className={cn('rounded-lg p-1.5', bgClass)}>
                  <Icon size={16} className={colorClass} />
                </div>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <div className="mt-2">
                <span className="text-2xl font-bold">
                  {isLoading ? '--' : count}
                </span>
                <span className="ml-1 text-xs text-muted-foreground">
                  ({isLoading ? '-' : pct}%)
                </span>
              </div>
              {/* Progress bar */}
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/5">
                <div
                  className={cn('h-full rounded-full transition-all duration-500', barColor)}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </m.div>
          );
        })}
      </div>

      {/* Most overdue list */}
      {data?.overdueArticles && data.overdueArticles.length > 0 && (
        <div className="glass-card overflow-hidden" data-testid="overdue-articles-list">
          <div className="border-b border-border/50 px-4 py-3">
            <h3 className="text-sm font-semibold">Most Overdue Articles</h3>
            <p className="text-xs text-muted-foreground">
              These articles need verification
            </p>
          </div>
          <div className="divide-y divide-border/30">
            {data.overdueArticles.map((article) => (
              <div
                key={article.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
              >
                <button
                  onClick={() => navigate(`/pages/${article.id}`)}
                  className="min-w-0 flex-1 text-left hover:text-primary transition-colors"
                >
                  <p className="truncate text-sm font-medium">{article.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {article.spaceKey}
                    {article.lastVerifiedAt
                      ? ` \u2022 Last verified: ${new Date(article.lastVerifiedAt).toLocaleDateString()}`
                      : ' \u2022 Never verified'}
                  </p>
                </button>
                <button
                  onClick={() => verifyMutation.mutate(article.id)}
                  disabled={verifyMutation.isPending}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-success/10 px-2.5 py-1 text-xs font-medium text-success hover:bg-success/20 transition-colors disabled:opacity-50"
                  data-testid={`verify-${article.id}`}
                >
                  <CheckCircle size={12} />
                  Verify
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
