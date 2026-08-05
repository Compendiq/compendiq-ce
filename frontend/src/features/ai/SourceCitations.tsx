import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, ExternalLink, FileText, Globe, Layers } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { resolveSourceTarget } from './source-target';

export interface Source {
  pageTitle: string;
  spaceKey: string;
  /**
   * Integer `pages.id` — the id every other navigation in the app uses, and
   * the only one a locally-created page has. 0/absent means the source is not
   * a knowledge-base page at all (web or external docs). Absent entirely on
   * conversations persisted before #1125.
   */
  pageId?: number;
  /**
   * Confluence page id. NULL for locally-created (standalone) pages, so it is
   * only a usable navigation target as a legacy fallback — see
   * {@link resolveSourceTarget}.
   */
  confluenceId?: string | null;
  /** Absolute http(s) URL — present only on web / external-docs sources. */
  url?: string;
  sectionTitle?: string;
  /** RAG similarity score (0-1 scale), used for confidence badges */
  score?: number;
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
            {sources.map((source, i) => {
              const target = resolveSourceTarget(source);
              const motionProps = {
                initial: { opacity: 0, x: -4 },
                animate: { opacity: 1, x: 0 },
                transition: { delay: i * 0.05 },
              };
              const cardClass = cn(
                'flex w-full items-start gap-2.5 rounded-lg bg-primary/10 px-3 py-2 text-left',
                target.kind === 'none'
                  ? 'cursor-default opacity-70'
                  : 'transition-colors hover:bg-primary/15',
              );
              const body = (
                <>
                  {target.kind === 'external'
                    ? <Globe size={14} className="mt-0.5 shrink-0 text-primary" />
                    : <FileText size={14} className="mt-0.5 shrink-0 text-primary" />}
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
                  {target.kind === 'external' && (
                    <ExternalLink size={12} className="mt-0.5 shrink-0 text-muted-foreground" />
                  )}
                </>
              );
              const key = `${source.pageId ?? source.confluenceId ?? source.pageTitle}-${i}`;
              const testId = `source-card-${i + 1}`;

              // Web / external-docs sources are links, not routes. Navigating to
              // `/pages/<url>` never matches `/pages/:id` and lands on the
              // not-found page (#1125).
              if (target.kind === 'external') {
                return (
                  <m.a
                    key={key}
                    {...motionProps}
                    href={target.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cardClass}
                    data-testid={testId}
                  >
                    {body}
                  </m.a>
                );
              }

              if (target.kind === 'internal') {
                return (
                  <m.button
                    key={key}
                    {...motionProps}
                    onClick={() => navigate(target.path)}
                    className={cardClass}
                    data-testid={testId}
                  >
                    {body}
                  </m.button>
                );
              }

              // No usable target: still list the source (the numbering is
              // referenced from the answer text) but don't offer a dead link.
              return (
                <m.div
                  key={key}
                  {...motionProps}
                  className={cardClass}
                  title="This source has no page that can be opened."
                  data-testid={testId}
                >
                  {body}
                </m.div>
              );
            })}
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}
