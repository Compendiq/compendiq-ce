import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { neutralChipInk } from './neutral-chip';

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
 * The chip is the TINT recipe (neutral-chip.ts), not `bg-muted`: this badge
 * renders on PagePreview's nm-card-elevated hover card, where bg-muted
 * measured 1.05:1 in Graphite — no visible pill, just bare floating text
 * beside the space-key chip. The tint steps up from both grounds it sits on
 * (1.33:1 on card-elevated, 1.29:1 on ArticleRightPane's nm-card in Graphite;
 * 1.23:1 on both in Paper), the border-border hairline defines the shape, and
 * the secondary ink measures 7.63–9.73:1 across all four.
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
      data-testid={level.testId}
      className={cn(
        'inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium',
        neutralChipInk,
        className,
      )}
    >
      {level.label}
    </span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { getFreshnessLevel };
