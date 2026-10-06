import { Lock } from 'lucide-react';
import { cn } from '../../lib/cn';

interface FrozenBadgeProps {
  /** Baseline version the freeze captured, when the surface knows it. */
  frozenVersion?: number | null;
  /** Compact form for dense rows: glyph only, name still announced. */
  compact?: boolean;
  className?: string;
}

/**
 * A frozen article is a STATE, and this is deliberately not a status hue
 * (#277). Amber, green and red are reserved pipeline signals; a frozen page
 * is neither a warning nor a failure, so the badge is neutral ink and the
 * lock glyph carries the channel that survives `forced-colors` and colour
 * blindness — the same argument as the quality meter.
 *
 * It states only what `pages` records: this article is frozen at a version.
 * Who approved it, and whether that evidence verifies, are separate claims
 * made by the Details section, never inferred from `isFrozen`.
 */
export function FrozenBadge({ frozenVersion, compact = false, className }: FrozenBadgeProps) {
  const versionLabel = typeof frozenVersion === 'number' ? ` at v${frozenVersion}` : '';
  const accessibleName = `Frozen${versionLabel}`;

  if (compact) {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center text-muted-foreground', className)}
        data-testid="frozen-badge-compact"
        title={accessibleName}
      >
        <Lock size={12} aria-hidden="true" />
        <span className="sr-only">{accessibleName}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex min-h-[24px] items-center gap-1 rounded-full border border-border',
        'bg-background/45 px-2.5 py-0.5 text-xs font-medium text-muted-foreground',
        className,
      )}
      data-testid="frozen-badge"
    >
      <Lock size={12} aria-hidden="true" />
      <span>Frozen{versionLabel}</span>
    </span>
  );
}
