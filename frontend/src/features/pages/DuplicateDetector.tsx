import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Search, ExternalLink, Loader2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
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
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const { data, isLoading, refetch } = useDuplicates(pageId, scanning);

  // Reset scanning state when dialog closes
  useEffect(() => {
    if (!open) {
      setScanning(false);
    }
  }, [open]);

  const handleScan = () => {
    setScanning(true);
    refetch();
  };

  const handleCompare = (duplicateId: string) => {
    setOpen(false);
    navigate(`/pages/${pageId}?compare=${duplicateId}`);
  };

  const handleView = (duplicateId: string) => {
    setOpen(false);
    navigate(`/pages/${duplicateId}`);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
          title="Find duplicate pages"
        >
          <Copy size={14} />
          Duplicates
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 glass-card overflow-hidden shadow-xl max-h-[85vh] flex flex-col"
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <div className="flex items-center gap-2">
              <Copy size={16} className="text-primary" />
              <Dialog.Title className="font-semibold">Duplicate Detection</Dialog.Title>
            </div>
            <div className="flex items-center gap-2">
              {!scanning && (
                <button
                  onClick={handleScan}
                  className="flex items-center gap-1.5 rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
                >
                  <Search size={12} /> Find Duplicates
                </button>
              )}
              <Dialog.Close asChild>
                <button
                  className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
                  aria-label="Close"
                >
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-4">
            {!scanning ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Click "Find Duplicates" to scan for similar pages to "{pageTitle}".
              </div>
            ) : isLoading ? (
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
                          onClick={() => handleView(dup.confluenceId)}
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
