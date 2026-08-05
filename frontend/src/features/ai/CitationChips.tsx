import { useNavigate } from 'react-router-dom';
import { cn } from '../../shared/lib/cn';
import type { Source } from './SourceCitations';
import { resolveSourceTarget } from './source-target';

interface CitationChipsProps {
  sources: Source[];
  className?: string;
}

const CHIP_CLASS = cn(
  'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded',
  'bg-primary/15 px-1.5 text-[11px] font-semibold tabular-nums text-primary-ink',
);
const CHIP_INTERACTIVE = 'transition-colors hover:bg-primary/25 focus:outline-none focus:ring-1 focus:ring-primary';

/**
 * Renders numbered citation chips [1] [2] [3] that link to source articles.
 * Each chip shows the source number and opens the referenced source on click.
 * Tooltip shows the page title for context.
 *
 * Knowledge-base sources navigate by internal page id; web / external-docs
 * sources open in a new tab. Routing a URL through `/pages/` was #1125.
 */
export function CitationChips({ sources, className }: CitationChipsProps) {
  const navigate = useNavigate();

  if (!sources.length) return null;

  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)} data-testid="citation-chips">
      {sources.map((source, i) => {
        const target = resolveSourceTarget(source);
        const testId = `citation-chip-${i + 1}`;

        if (target.kind === 'external') {
          return (
            <a
              key={i}
              href={target.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={source.pageTitle}
              aria-label={`${source.pageTitle} (opens in a new tab)`}
              className={cn(CHIP_CLASS, CHIP_INTERACTIVE)}
              data-testid={testId}
            >
              {i + 1}
            </a>
          );
        }

        if (target.kind === 'internal') {
          return (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation();
                navigate(target.path);
              }}
              title={source.pageTitle}
              className={cn(CHIP_CLASS, CHIP_INTERACTIVE)}
              data-testid={testId}
            >
              {i + 1}
            </button>
          );
        }

        // No usable target — keep the number (the answer text refers to it)
        // but don't render a link that lands on the not-found page.
        return (
          <span
            key={i}
            title={`${source.pageTitle} — no page to open`}
            className={cn(CHIP_CLASS, 'opacity-60')}
            data-testid={testId}
          >
            {i + 1}
          </span>
        );
      })}
    </span>
  );
}
