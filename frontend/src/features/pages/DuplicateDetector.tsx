import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { Copy, Search, ExternalLink, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

interface DuplicateCandidate {
  confluenceId: string;
  title: string;
  spaceKey: string;
  embeddingDistance: number;
  titleSimilarity: number;
  combinedScore: number;
}

interface DuplicateResponse {
  duplicates: DuplicateCandidate[];
  pageId: string;
}

function useDuplicates(pageId: string | undefined, enabled: boolean) {
  return useQuery<DuplicateResponse>({
    queryKey: ['pages', pageId, 'duplicates'],
    queryFn: () => apiFetch(`/pages/${pageId}/duplicates`),
    enabled: !!pageId && enabled,
    staleTime: 10 * 60 * 1000, // 10 minutes
  });
}

function getSimilarityColor(score: number): string {
  if (score >= 0.9) return 'text-destructive';
  if (score >= 0.8) return 'text-warning';
  return 'text-info';
}

function getSimilarityLabel(score: number): string {
  if (score >= 0.9) return 'Very Similar';
  if (score >= 0.8) return 'Similar';
  return 'Somewhat Similar';
}

interface DuplicateDetectorProps {
  pageId: string;
  pageTitle: string;
}

export function DuplicateDetector({ pageId, pageTitle }: DuplicateDetectorProps) {
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  const { data, isLoading, refetch } = useDuplicates(pageId, scanning);

  const handleScan = () => {
    setScanning(true);
    refetch();
  };

  const handleCompare = (duplicateId: string) => {
    navigate(`/pages/${pageId}?compare=${duplicateId}`);
  };

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-card overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <Copy size={16} className="text-primary" />
          <h3 className="text-sm font-semibold">Duplicate Detection</h3>
        </div>
        {!scanning && (
          <button
            onClick={handleScan}
            className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
          >
            <Search size={12} /> Find Duplicates
          </button>
        )}
      </div>

      {scanning && (
        <div className="p-4">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Scanning for similar pages...</span>
            </div>
          ) : data?.duplicates.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No duplicates found for "{pageTitle}"
            </div>
          ) : (
            <div className="space-y-2">
              {data?.duplicates.map((dup) => {
                const similarity = Math.round(dup.combinedScore * 100);
                return (
                  <div
                    key={dup.confluenceId}
                    className="flex items-center justify-between gap-3 rounded-lg bg-foreground/5 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-medium">{dup.title}</p>
                        <span className="shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-xs text-muted-foreground">
                          {dup.spaceKey}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <span className={cn('font-medium', getSimilarityColor(dup.combinedScore))}>
                          {similarity}% {getSimilarityLabel(dup.combinedScore)}
                        </span>
                        <span>Title match: {Math.round(dup.titleSimilarity * 100)}%</span>
                        <span>Content match: {Math.round((1 - dup.embeddingDistance) * 100)}%</span>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => handleCompare(dup.confluenceId)}
                        className="flex items-center gap-1 rounded-md border border-border/50 px-2.5 py-1 text-xs hover:bg-foreground/5 transition-colors"
                      >
                        Compare
                      </button>
                      <button
                        onClick={() => navigate(`/pages/${dup.confluenceId}`)}
                        className="flex items-center gap-1 rounded-md border border-border/50 px-2.5 py-1 text-xs hover:bg-foreground/5 transition-colors"
                      >
                        <ExternalLink size={10} /> View
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </m.div>
  );
}
