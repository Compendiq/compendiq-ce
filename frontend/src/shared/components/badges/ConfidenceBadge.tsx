import { cn } from '../../lib/cn';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

interface ConfidenceBadgeProps {
  /** Average similarity score from RAG sources (0-1 scale) */
  score: number;
  className?: string;
}

/**
 * Derives a confidence level from a RAG similarity score.
 *
 * Thresholds based on cosine similarity (calibrated for bge-m3; may need adjustment for other models):
 *   >= 0.7  -> High   (strong semantic match)
 *   >= 0.4  -> Medium (partial match)
 *   <  0.4  -> Low    (weak match)
 */
function getConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

const levelConfig: Record<ConfidenceLevel, { label: string; dotClass: string; bgClass: string; textClass: string; glowClass: string }> = {
  high: {
    label: 'High confidence',
    dotClass: 'bg-emerald-400',
    bgClass: 'bg-emerald-400/10',
    textClass: 'text-emerald-400',
    glowClass: 'shadow-[0_0_6px_1px_rgba(52,211,153,0.4)]',
  },
  medium: {
    label: 'Medium confidence',
    dotClass: 'bg-amber-400',
    bgClass: 'bg-amber-400/10',
    textClass: 'text-amber-400',
    glowClass: 'shadow-[0_0_6px_1px_rgba(251,191,36,0.4)]',
  },
  low: {
    label: 'Low confidence',
    dotClass: 'bg-red-400',
    bgClass: 'bg-red-400/10',
    textClass: 'text-red-400',
    glowClass: 'shadow-[0_0_6px_1px_rgba(248,113,113,0.4)]',
  },
};

/**
 * Displays a RAG confidence badge with a color-coded glowing dot
 * and label indicating how confident the AI answer is based on
 * source similarity scores.
 */
export function ConfidenceBadge({ score, className }: ConfidenceBadgeProps) {
  const level = getConfidenceLevel(score);
  const config = levelConfig[level];

  return (
    <span
      data-testid="confidence-badge"
      title={`Confidence: ${Math.round(score * 100)}%`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        config.bgClass,
        config.textClass,
        className,
      )}
    >
      <span
        className={cn(
          'inline-block h-2 w-2 rounded-full',
          config.dotClass,
          config.glowClass,
        )}
        aria-hidden="true"
      />
      {config.label}
    </span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { getConfidenceLevel };
