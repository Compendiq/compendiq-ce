import { useMemo } from 'react';
import { cn } from '../../lib/cn';

interface FreshnessBadgeProps {
  lastModified: string;
  className?: string;
}

interface FreshnessLevel {
  label: string;
  colorClass: string;
  bgClass: string;
}

function getFreshnessLevel(lastModified: string): FreshnessLevel {
  const now = new Date();
  const modified = new Date(lastModified);
  const diffMs = now.getTime() - modified.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 7) {
    return { label: 'Fresh', colorClass: 'text-success', bgClass: 'bg-success/15' };
  }
  if (diffDays < 30) {
    return { label: 'Recent', colorClass: 'text-warning', bgClass: 'bg-warning/15' };
  }
  if (diffDays < 90) {
    return { label: 'Aging', colorClass: 'text-orange-400', bgClass: 'bg-orange-400/15' };
  }
  return { label: 'Stale', colorClass: 'text-destructive', bgClass: 'bg-destructive/15' };
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
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        level.bgClass,
        level.colorClass,
        className,
      )}
    >
      {level.label}
    </span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { getFreshnessLevel };
export type { FreshnessLevel, FreshnessBadgeProps };
