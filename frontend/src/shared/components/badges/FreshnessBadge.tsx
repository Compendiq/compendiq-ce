import { useMemo } from 'react';
import { cn } from '../../lib/cn';

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
        'inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground',
        className,
      )}
    >
      {level.label}
    </span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { getFreshnessLevel };
