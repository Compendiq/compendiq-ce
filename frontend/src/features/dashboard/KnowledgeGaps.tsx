import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { AlertTriangle, ChevronDown, ChevronUp, Plus, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

interface KnowledgeGap {
  query: string;
  occurrences: number;
  lastSearched: string;
  avgMaxScore: number | null;
}

interface KnowledgeGapsResponse {
  gaps: KnowledgeGap[];
  total: number;
  periodDays: number;
}

function useKnowledgeGaps(days = 30) {
  return useQuery<KnowledgeGapsResponse>({
    queryKey: ['analytics', 'knowledge-gaps', days],
    queryFn: () => apiFetch(`/analytics/knowledge-gaps?days=${days}`),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function KnowledgeGaps() {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError } = useKnowledgeGaps();

  const gapCount = data?.gaps?.length ?? 0;

  const handleCreateArticle = (queryText: string) => {
    navigate(`/ai?mode=generate&prompt=${encodeURIComponent(queryText)}`);
  };

  if (isError) return null;

  return (
    <m.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4 }}
      className="glass-card overflow-hidden"
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-foreground/5 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-warning/10 p-2">
            <AlertTriangle size={18} className="text-warning" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">Knowledge Gaps</h3>
            <p className="text-xs text-muted-foreground">
              {isLoading ? 'Loading...' : `${gapCount} unanswered ${gapCount === 1 ? 'query' : 'queries'}`}
            </p>
          </div>
        </div>
        {expanded ? <ChevronUp size={16} className="text-muted-foreground" /> : <ChevronDown size={16} className="text-muted-foreground" />}
      </button>

      {/* Expanded list */}
      {expanded && (
        <div className="border-t border-border/50">
          {isLoading ? (
            <div className="space-y-2 p-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-foreground/5" />
              ))}
            </div>
          ) : gapCount === 0 ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <Search size={24} className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No knowledge gaps detected. Your knowledge base is comprehensive!
              </p>
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {data!.gaps.map((gap, i) => (
                <div
                  key={gap.query}
                  className={cn(
                    'flex items-center justify-between gap-3 px-5 py-3',
                    i !== data!.gaps.length - 1 && 'border-b border-border/30',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{gap.query}</p>
                    <p className="text-xs text-muted-foreground">
                      Searched {gap.occurrences}x - Last: {new Date(gap.lastSearched).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    onClick={() => handleCreateArticle(gap.query)}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                    title="Generate article for this topic"
                  >
                    <Plus size={12} /> Create
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </m.div>
  );
}
