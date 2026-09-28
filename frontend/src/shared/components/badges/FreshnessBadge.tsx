import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import { cn } from '../../lib/cn';
import { statusChipClass } from './neutral-chip';

interface FreshnessBadgeProps {
  lastModified: string;
  className?: string;
}

interface FreshnessLevel {
  label: string;
  testId?: string;
}

/**
 * Freshness is a MEASUREMENT (days since last edit), not a pipeline state, so
 * it renders as one neutral chip — the same argument that de-coloured
 * QualityScoreBadge. It used to wear the full status vocabulary: Fresh in the
 * connected green, Aging literally in `status-syncing`, Stale in the
 * disconnected red, so a page untouched for a month read as a space mid-sync
 * and a stale one as a broken connection. The label is the channel; the exact
 * date stays in the tooltip.
 *
 * The chip is the shared status recipe (neutral-chip.ts), not `bg-muted`:
 * this badge renders on PagePreview's nm-card-elevated hover card, where
 * bg-muted measured 1.05:1 in Graphite — no visible pill, just bare floating
 * text beside the space-key chip — and on the inspector's flat Pane, where it
 * measures 1.04:1. The tint steps up from both grounds, the border-border
 * hairline defines the shape, and the secondary ink measures 7.5:1+ on all
 * four. The clock is the glyph every sibling in the Document health row also
 * carries: the shape channel does not depend on which chip happens to render.
 */
function getFreshnessLevel(lastModified: string): FreshnessLevel {
  const now = new Date();
  const modified = new Date(lastModified);
  const diffMs = now.getTime() - modified.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 7) return { label: 'Fresh' };
  if (diffDays < 30) return { label: 'Recent', testId: 'badge-recent' };
  if (diffDays < 90) return { label: 'Aging' };
  return { label: 'Stale' };
}

export function FreshnessBadge({ lastModified, className }: FreshnessBadgeProps) {
  const level = useMemo(() => getFreshnessLevel(lastModified), [lastModified]);
  const formattedDate = useMemo(
    () => new Date(lastModified).toLocaleString(),
    [lastModified],
  );

  return (
    <span
      title={`Last modified: ${formattedDate}`}
      tabIndex={0}
      role="note"
      aria-label={`Last modified: ${formattedDate}`}
      data-testid={level.testId}
      className={cn(
        statusChipClass,
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <Clock size={12} className="shrink-0" aria-hidden="true" />
      {level.label}
    </span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { getFreshnessLevel };
