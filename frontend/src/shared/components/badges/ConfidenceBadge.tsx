import { cn } from '../../lib/cn';

type ConfidenceLevel = 'high' | 'medium' | 'low';

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

const LEVEL_LABEL: Record<ConfidenceLevel, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

/**
 * Similarity is a MEASUREMENT, not a pipeline state, so the badge is one
 * neutral chip whatever the level — the argument that de-coloured
 * QualityScoreBadge, whose neutral recipe (bg-muted/40 fill, border-border,
 * foreground ink) this reuses so the two measurement chips read as one family.
 *
 * It used to wear status-connected / status-syncing / status-disconnected with
 * a colour-coded dot, so a weak-match answer sat beside its citations in the
 * same red as a broken connection and a partial match in the same amber as a
 * space mid-sync. The WORD is the channel; the exact percentage stays in the
 * tooltip. No dot: with one neutral chip a dot encodes nothing.
 */
export function ConfidenceBadge({ score, className }: ConfidenceBadgeProps) {
  const level = getConfidenceLevel(score);

  return (
    <span
      data-testid="confidence-badge"
      data-level={level}
      title={`Confidence: ${Math.round(score * 100)}%`}
      className={cn(
        'inline-flex items-center rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-medium text-foreground',
        className,
      )}
    >
      {LEVEL_LABEL[level]}
    </span>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { getConfidenceLevel };
