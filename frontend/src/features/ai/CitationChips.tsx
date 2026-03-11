import { useNavigate } from 'react-router-dom';
import { cn } from '../../shared/lib/cn';
import type { Source } from './SourceCitations';

interface CitationChipsProps {
  sources: Source[];
  className?: string;
}

/**
 * Renders numbered citation chips [1] [2] [3] that link to source articles.
 * Each chip shows the source number and navigates to the referenced page on click.
 * Tooltip shows the page title for context.
 */
export function CitationChips({ sources, className }: CitationChipsProps) {
  const navigate = useNavigate();

  if (!sources.length) return null;

  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)} data-testid="citation-chips">
      {sources.map((source, i) => (
        <button
          key={`${source.confluenceId}-${i}`}
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/pages/${source.confluenceId}`);
          }}
          title={source.pageTitle}
          className={cn(
            'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded',
            'bg-primary/15 px-1.5 text-[10px] font-semibold tabular-nums text-primary',
            'transition-colors hover:bg-primary/25 focus:outline-none focus:ring-1 focus:ring-primary',
          )}
          data-testid={`citation-chip-${i + 1}`}
        >
          {i + 1}
        </button>
      ))}
    </span>
  );
}
