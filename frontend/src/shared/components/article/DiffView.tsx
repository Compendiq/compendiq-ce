import { useState, useMemo } from 'react';
import { m } from 'framer-motion';
import { Check, X, Columns2, Rows3, Loader2 } from 'lucide-react';
import { diffWords } from 'diff';
import { cn } from '../../lib/cn';

interface DiffViewProps {
  original: string;
  improved: string;
  onAccept?: () => void;
  onReject?: () => void;
  isAccepting?: boolean;
}

type ViewMode = 'unified' | 'side-by-side';

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export function DiffView({ original, improved, onAccept, onReject, isAccepting = false }: DiffViewProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('unified');

  const diff = useMemo(
    () => diffWords(original, improved) as DiffPart[],
    [original, improved],
  );

  // Build side-by-side lines
  const sideBySide = useMemo(() => {
    const leftParts: DiffPart[] = [];
    const rightParts: DiffPart[] = [];

    diff.forEach((part) => {
      if (part.removed) {
        leftParts.push(part);
      } else if (part.added) {
        rightParts.push(part);
      } else {
        leftParts.push(part);
        rightParts.push(part);
      }
    });

    return { left: leftParts, right: rightParts };
  }, [diff]);

  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    diff.forEach((part) => {
      if (part.added) additions += part.value.length;
      if (part.removed) deletions += part.value.length;
    });
    return { additions, deletions };
  }, [diff]);

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="nm-card overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
        <div className="flex items-center gap-4">
          <h3 className="text-sm font-medium">Changes</h3>
          <span className="text-xs text-success">+{stats.additions}</span>
          <span className="text-xs text-destructive">-{stats.deletions}</span>
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex rounded-md border border-border/50">
            <button
              onClick={() => setViewMode('unified')}
              className={cn(
                'flex items-center gap-1 px-2 py-1 text-xs transition-colors',
                viewMode === 'unified'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-foreground/5',
              )}
              title="Unified view"
            >
              <Rows3 size={12} /> Unified
            </button>
            <button
              onClick={() => setViewMode('side-by-side')}
              className={cn(
                'flex items-center gap-1 px-2 py-1 text-xs transition-colors',
                viewMode === 'side-by-side'
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-foreground/5',
              )}
              title="Side-by-side view"
            >
              <Columns2 size={12} /> Side-by-Side
            </button>
          </div>
        </div>
      </div>

      {/* Diff content */}
      <div className="overflow-auto p-4">
        {viewMode === 'unified' ? (
          <pre className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="unified-diff">
            {diff.map((part, i) => (
              <span
                key={i}
                className={cn(
                  part.added && 'bg-success/20 text-success',
                  part.removed && 'bg-destructive/20 text-destructive line-through',
                )}
              >
                {part.value}
              </span>
            ))}
          </pre>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="side-by-side-diff">
            {/* Original */}
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Original</p>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-3 text-sm leading-relaxed">
                {sideBySide.left.map((part, i) => (
                  <span
                    key={i}
                    className={cn(
                      part.removed && 'bg-destructive/20 text-destructive line-through',
                    )}
                  >
                    {part.value}
                  </span>
                ))}
              </pre>
            </div>
            {/* Improved */}
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Improved</p>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-3 text-sm leading-relaxed">
                {sideBySide.right.map((part, i) => (
                  <span
                    key={i}
                    className={cn(
                      part.added && 'bg-success/20 text-success',
                    )}
                  >
                    {part.value}
                  </span>
                ))}
              </pre>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      {(onAccept || onReject) && (
        <div className="flex items-center justify-end gap-3 border-t border-border/50 px-4 py-3">
          {onReject && (
            <button
              onClick={onReject}
              className="flex items-center gap-1.5 rounded-lg border border-border/50 px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <X size={14} /> Reject
            </button>
          )}
          {onAccept && (
            <button
              onClick={onAccept}
              disabled={isAccepting}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isAccepting ? (
                <><Loader2 size={14} className="animate-spin" /> Applying…</>
              ) : (
                <><Check size={14} /> Accept</>
              )}
            </button>
          )}
        </div>
      )}
    </m.div>
  );
}
