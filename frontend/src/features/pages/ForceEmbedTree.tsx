import { useState, useCallback, useEffect, useRef } from 'react';
import { Database, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { streamSSE } from '../../shared/lib/sse';
import { toast } from 'sonner';

interface ForceEmbedTreeProps {
  pageId: string;
  hasChildren: boolean;
}

interface EmbedTreeProgress {
  phase: 'discovering' | 'embedding' | 'complete';
  total: number;
  completed: number;
  errors?: number;
  currentPage?: string;
  done: boolean;
  error?: string;
}

export function ForceEmbedTree({ pageId, hasChildren }: ForceEmbedTreeProps) {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<EmbedTreeProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleForceEmbed = useCallback(async () => {
    if (isRunning) return;

    setIsRunning(true);
    setProgress({ phase: 'discovering', total: 0, completed: 0, done: false });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const stream = streamSSE<EmbedTreeProgress>(
        '/embeddings/force-embed-tree',
        { pageId },
        controller.signal,
      );

      for await (const event of stream) {
        if (event.error) {
          toast.error(event.error);
          break;
        }
        setProgress(event);
      }

      setIsRunning(false);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // User navigated away or cancelled
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to embed page tree');
      }
      setIsRunning(false);
      setProgress(null);
    }
  }, [pageId, isRunning]);

  // Don't show the button if page has no children
  if (!hasChildren) return null;

  const isComplete = progress?.phase === 'complete';
  const isDiscovering = progress?.phase === 'discovering';

  return (
    <div className="inline-flex flex-col items-start">
      <button
        onClick={handleForceEmbed}
        disabled={isRunning}
        className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5 disabled:opacity-50"
        title="Force embed this page and all sub-pages"
      >
        {isRunning ? (
          <Loader2 size={14} className="animate-spin" />
        ) : isComplete ? (
          <CheckCircle2 size={14} className="text-green-500" />
        ) : (
          <Database size={14} />
        )}
        Embed Tree
      </button>

      {/* Progress indicator */}
      {progress && !isComplete && (
        <div className="mt-1.5 rounded-md bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">
          {isDiscovering ? (
            <span>Discovering sub-pages...</span>
          ) : (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span>Embedding {progress.completed}/{progress.total} pages</span>
                {(progress.errors ?? 0) > 0 && (
                  <span className="flex items-center gap-0.5 text-yellow-500">
                    <AlertTriangle size={10} /> {progress.errors} errors
                  </span>
                )}
              </div>
              {progress.currentPage && (
                <div className="truncate max-w-48 text-muted-foreground/70">
                  {progress.currentPage}
                </div>
              )}
              {/* Progress bar */}
              <div className="h-1 w-full rounded-full bg-foreground/10">
                <div
                  className="h-1 rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Completion summary */}
      {isComplete && (
        <div className="mt-1.5 rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-600 dark:text-green-400">
          Embedded {progress.completed} pages
          {(progress.errors ?? 0) > 0 && (
            <span className="text-yellow-500"> ({progress.errors} failed)</span>
          )}
        </div>
      )}
    </div>
  );
}
