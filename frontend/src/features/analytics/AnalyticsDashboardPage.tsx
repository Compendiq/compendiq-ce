import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import {
  TrendingUp, BarChart3, ThumbsUp, ThumbsDown,
  FileText, AlertTriangle, Star,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../shared/lib/api';
import { VerificationHealth } from './VerificationHealth';
import { cn } from '../../shared/lib/cn';

interface TrendingArticle {
  id: string;
  title: string;
  spaceKey: string;
  viewCount: number;
}

interface QualityOverview {
  averageScore: number;
  articlesNeedingAttention: number;
  totalScored: number;
}

interface ContentGapSummary {
  query: string;
  occurrences: number;
}

interface FeedbackSummary {
  id: string;
  title: string;
  spaceKey: string;
  helpfulCount: number;
  unhelpfulCount: number;
}

interface AnalyticsDashboardData {
  trending: TrendingArticle[];
  quality: QualityOverview;
  contentGaps: ContentGapSummary[];
  mostHelpful: FeedbackSummary[];
  leastHelpful: FeedbackSummary[];
}

function useAnalyticsDashboard() {
  return useQuery<AnalyticsDashboardData>({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => apiFetch('/analytics/dashboard'),
    staleTime: 5 * 60 * 1000,
  });
}

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
};

export function AnalyticsDashboardPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useAnalyticsDashboard();

  const qualityPct = data?.quality.averageScore ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Content Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Overview of your knowledge base health and engagement
        </p>
      </div>

      {/* Top row: Trending + Quality */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Trending Articles */}
        <m.div {...fadeUp} transition={{ delay: 0.05 }} className="glass-card overflow-hidden" data-testid="trending-articles">
          <div className="flex items-center gap-2 border-b border-border/50 px-5 py-3">
            <TrendingUp size={16} className="text-primary" />
            <h2 className="text-sm font-semibold">Trending Articles</h2>
            <span className="ml-auto text-xs text-muted-foreground">Last 7 days</span>
          </div>
          <div className="divide-y divide-border/30">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse bg-foreground/5" />
              ))
            ) : !data?.trending.length ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No trending data available yet
              </div>
            ) : (
              data.trending.slice(0, 10).map((article, i) => (
                <button
                  key={article.id}
                  onClick={() => navigate(`/pages/${article.id}`)}
                  className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-foreground/5 transition-colors"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{article.title}</p>
                    <p className="text-xs text-muted-foreground">{article.spaceKey}</p>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {article.viewCount} views
                  </span>
                </button>
              ))
            )}
          </div>
        </m.div>

        {/* Content Quality Overview */}
        <m.div {...fadeUp} transition={{ delay: 0.1 }} className="glass-card overflow-hidden" data-testid="quality-overview">
          <div className="flex items-center gap-2 border-b border-border/50 px-5 py-3">
            <BarChart3 size={16} className="text-info" />
            <h2 className="text-sm font-semibold">Content Quality</h2>
          </div>
          <div className="p-5">
            {isLoading ? (
              <div className="h-32 animate-pulse rounded-lg bg-foreground/5" />
            ) : (
              <div className="space-y-4">
                {/* Average quality score */}
                <div className="text-center">
                  <p className="text-xs text-muted-foreground">Average Quality Score</p>
                  <p className={cn(
                    'text-4xl font-bold',
                    qualityPct >= 80 ? 'text-success' :
                    qualityPct >= 50 ? 'text-warning' :
                    'text-destructive',
                  )}>
                    {Math.round(qualityPct)}
                  </p>
                  <div className="mx-auto mt-2 h-2 w-48 overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all duration-500',
                        qualityPct >= 80 ? 'bg-success' :
                        qualityPct >= 50 ? 'bg-warning' :
                        'bg-destructive',
                      )}
                      style={{ width: `${Math.min(qualityPct, 100)}%` }}
                    />
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg bg-foreground/5 p-3 text-center">
                    <p className="text-lg font-bold">{data?.quality.totalScored ?? 0}</p>
                    <p className="text-xs text-muted-foreground">Articles Scored</p>
                  </div>
                  <div className="rounded-lg bg-destructive/5 p-3 text-center">
                    <p className="text-lg font-bold text-destructive">
                      {data?.quality.articlesNeedingAttention ?? 0}
                    </p>
                    <p className="text-xs text-muted-foreground">Need Attention</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </m.div>
      </div>

      {/* Verification Health */}
      <m.div {...fadeUp} transition={{ delay: 0.15 }}>
        <h2 className="mb-3 text-sm font-semibold">Verification Health</h2>
        <VerificationHealth />
      </m.div>

      {/* Bottom row: Content Gaps + Feedback */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Content Gaps */}
        <m.div {...fadeUp} transition={{ delay: 0.2 }} className="glass-card overflow-hidden" data-testid="content-gaps-summary">
          <div className="flex items-center gap-2 border-b border-border/50 px-5 py-3">
            <AlertTriangle size={16} className="text-warning" />
            <h2 className="text-sm font-semibold">Content Gaps</h2>
            <button
              onClick={() => navigate('/content-gaps')}
              className="ml-auto text-xs text-primary hover:underline"
            >
              View all
            </button>
          </div>
          <div className="divide-y divide-border/30">
            {isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse bg-foreground/5" />
              ))
            ) : !data?.contentGaps.length ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                <FileText size={24} className="mx-auto mb-2 text-muted-foreground" />
                No content gaps detected
              </div>
            ) : (
              data.contentGaps.slice(0, 5).map((gap) => (
                <div key={gap.query} className="flex items-center justify-between px-5 py-2.5">
                  <p className="truncate text-sm">{gap.query}</p>
                  <span className="shrink-0 rounded bg-warning/10 px-2 py-0.5 text-xs text-warning">
                    {gap.occurrences}x
                  </span>
                </div>
              ))
            )}
          </div>
        </m.div>

        {/* Reader Feedback */}
        <m.div {...fadeUp} transition={{ delay: 0.25 }} className="glass-card overflow-hidden" data-testid="feedback-summary">
          <div className="flex items-center gap-2 border-b border-border/50 px-5 py-3">
            <Star size={16} className="text-primary" />
            <h2 className="text-sm font-semibold">Reader Feedback</h2>
          </div>
          <div className="p-4 space-y-3">
            {isLoading ? (
              <div className="h-24 animate-pulse rounded-lg bg-foreground/5" />
            ) : (
              <>
                {/* Most helpful */}
                {data?.mostHelpful && data.mostHelpful.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <ThumbsUp size={12} className="text-success" />
                      Most Helpful
                    </p>
                    {data.mostHelpful.slice(0, 3).map((article) => (
                      <button
                        key={article.id}
                        onClick={() => navigate(`/pages/${article.id}`)}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-foreground/5"
                      >
                        <span className="truncate">{article.title}</span>
                        <span className="shrink-0 text-xs text-success">+{article.helpfulCount}</span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Least helpful */}
                {data?.leastHelpful && data.leastHelpful.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <ThumbsDown size={12} className="text-destructive" />
                      Needs Improvement
                    </p>
                    {data.leastHelpful.slice(0, 3).map((article) => (
                      <button
                        key={article.id}
                        onClick={() => navigate(`/pages/${article.id}`)}
                        className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-foreground/5"
                      >
                        <span className="truncate">{article.title}</span>
                        <span className="shrink-0 text-xs text-destructive">-{article.unhelpfulCount}</span>
                      </button>
                    ))}
                  </div>
                )}

                {!data?.mostHelpful?.length && !data?.leastHelpful?.length && (
                  <div className="py-4 text-center text-sm text-muted-foreground">
                    No feedback data yet
                  </div>
                )}
              </>
            )}
          </div>
        </m.div>
      </div>
    </div>
  );
}
