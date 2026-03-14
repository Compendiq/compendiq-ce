import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { Search, Plus, FileText, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../shared/lib/api';

interface ContentGap {
  query: string;
  occurrences: number;
  lastSearched: string;
  avgMaxScore: number | null;
}

interface ContentGapsResponse {
  gaps: ContentGap[];
  total: number;
  periodDays: number;
}

function useContentGaps(days = 30) {
  return useQuery<ContentGapsResponse>({
    queryKey: ['analytics', 'knowledge-gaps', days],
    queryFn: () => apiFetch(`/analytics/knowledge-gaps?days=${days}`),
    staleTime: 5 * 60 * 1000,
  });
}

export function ContentGapsPage() {
  const navigate = useNavigate();
  const { data, isLoading } = useContentGaps();

  const handleCreateArticle = (queryText: string) => {
    navigate(`/pages/new?title=${encodeURIComponent(queryText)}`);
  };

  const handleCreateRequest = (queryText: string) => {
    navigate(`/knowledge-requests?title=${encodeURIComponent(queryText)}`);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Content Gaps</h1>
        <p className="text-sm text-muted-foreground">
          Search queries with no results, sorted by frequency
        </p>
      </div>

      {/* Gap list */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="glass-card h-16 animate-pulse" />
          ))}
        </div>
      ) : !data?.gaps.length ? (
        <div className="glass-card flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 rounded-full bg-muted p-3">
            <Search size={32} className="text-muted-foreground" />
          </div>
          <p className="text-lg font-medium" data-testid="no-gaps-title">No content gaps</p>
          <p className="mt-1 text-sm text-muted-foreground">
            All recent searches returned results. Your knowledge base is comprehensive!
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground" data-testid="gaps-summary">
            {data.total} failed {data.total === 1 ? 'query' : 'queries'} in the last {data.periodDays} days
          </p>
          <div className="glass-card overflow-hidden" data-testid="content-gaps-list">
            <div className="divide-y divide-border/30">
              {data.gaps.map((gap, i) => (
                <m.div
                  key={gap.query}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                  data-testid={`gap-${i}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={14} className="shrink-0 text-warning" />
                      <p className="truncate text-sm font-medium">{gap.query}</p>
                    </div>
                    <p className="ml-6 text-xs text-muted-foreground">
                      Searched {gap.occurrences}x
                      {' \u2022 '}
                      Last: {new Date(gap.lastSearched).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      onClick={() => handleCreateArticle(gap.query)}
                      className="flex items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                      data-testid={`create-article-${i}`}
                    >
                      <FileText size={12} />
                      Create Article
                    </button>
                    <button
                      onClick={() => handleCreateRequest(gap.query)}
                      className="flex items-center gap-1 rounded-md bg-foreground/5 px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-foreground/10 transition-colors"
                      data-testid={`create-request-${i}`}
                    >
                      <Plus size={12} />
                      Request
                    </button>
                  </div>
                </m.div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
