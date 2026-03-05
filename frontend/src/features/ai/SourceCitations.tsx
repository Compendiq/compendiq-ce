import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, FileText, Layers } from 'lucide-react';
import { cn } from '../../shared/lib/cn';

export interface Source {
  pageTitle: string;
  spaceKey: string;
  confluenceId: string;
  sectionTitle?: string;
}

interface SourceCitationsProps {
  sources: Source[];
}

export function SourceCitations({ sources }: SourceCitationsProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const navigate = useNavigate();

  if (!sources.length) return null;

  return (
    <m.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3"
    >
      {/* Toggle button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Sources ({sources.length})
      </button>

      {/* Source cards */}
      <AnimatePresence>
        {isExpanded && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-2 space-y-1.5 overflow-hidden"
          >
            {sources.map((source, i) => (
              <m.button
                key={`${source.confluenceId}-${i}`}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
                onClick={() => navigate(`/pages/${source.confluenceId}`)}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-lg bg-primary/10 px-3 py-2 text-left',
                  'transition-colors hover:bg-primary/15',
                )}
              >
                <FileText size={14} className="mt-0.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">
                    {source.pageTitle}
                  </p>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-0.5">
                      <Layers size={10} /> {source.spaceKey}
                    </span>
                    {source.sectionTitle && (
                      <span className="truncate">
                        {source.sectionTitle}
                      </span>
                    )}
                  </div>
                </div>
              </m.button>
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}
