import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format-relative-time';
import type { QualityStatus } from '../../hooks/use-pages';

interface QualityScoreBadgeProps {
  qualityScore: number | null;
  qualityStatus: QualityStatus | null;
  qualityCompleteness?: number | null;
  qualityClarity?: number | null;
  qualityStructure?: number | null;
  qualityAccuracy?: number | null;
  qualityReadability?: number | null;
  qualitySummary?: string | null;
  qualityAnalyzedAt?: string | null;
  qualityError?: string | null;
  className?: string;
}

interface ScoreConfig {
  label: string;
  badgeClass: string;
  animate: boolean;
  testId?: string;
  /** 1–4 when the badge shows a score; null for the pipeline states. */
  band: number | null;
}

/**
 * Quality is a *measurement*, not a pipeline state, and it is the only thing on
 * the Pages list that used to be painted in the status palette. A page scoring
 * 65 wore the same amber as a space mid-sync, and one scoring 74 the same Steel
 * as "embedding" — on the densest scanning surface in the app, in the two hues
 * the system reserves most tightly (amber = warning, Steel = brand AND
 * interaction). So the split is now explicit:
 *
 *   - the pipeline STATES (analyzing / failed / skipped / not scored) keep
 *     status colours, because they genuinely are states;
 *   - the SCORE renders neutral, and carries its band in a 4-segment meter.
 *
 * The meter is what keeps the list scannable without colour: filled-segment
 * count is a pre-attentive length channel, so a column of scores still reads at
 * a glance, and it survives both themes, forced-colors and colour blindness.
 * The number and word remain, so the meter is a redundant channel and never the
 * only carrier (WCAG 1.4.1).
 */
const BAND_COUNT = 4;

function bandForScore(score: number): number {
  if (score >= 90) return 4;
  if (score >= 70) return 3;
  if (score >= 50) return 2;
  return 1;
}

function getScoreConfig(
  score: number | null,
  status: QualityStatus | null,
  _error?: string | null,
): ScoreConfig {
  // Handle non-analyzed statuses first
  if (status === 'analyzing') {
    return {
      label: 'Analyzing...',
      badgeClass: 'bg-status-ai/20 text-status-ai border border-status-ai/30',
      animate: true,
      band: null,
    };
  }

  if (status === 'failed') {
    return {
      label: 'Analysis Failed',
      // The one quality state that IS attention-worthy, so it is the one that
      // earns amber. Tokens, not hex literals, so the palette tests can see it.
      badgeClass: 'bg-warning/10 text-warning border border-warning/30',
      animate: false,
      testId: 'badge-failed',
      band: null,
    };
  }

  if (status === 'skipped') {
    return {
      label: 'Skipped',
      badgeClass: 'bg-muted/40 text-muted-foreground border border-border',
      animate: false,
      testId: 'badge-skipped',
      band: null,
    };
  }

  if (score === null || score === undefined || status === 'pending' || !status) {
    return {
      label: 'Not Scored',
      badgeClass: 'bg-status-inactive/20 text-status-inactive border border-status-inactive/30',
      animate: false,
      band: null,
    };
  }

  // Score-based labels — one neutral chip for every band; the meter carries the
  // difference. Deliberately no per-band colour: see the note above.
  const label =
    score >= 90 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Needs Work' : 'Poor';

  return {
    label: `${score} ${label}`,
    badgeClass: 'bg-muted/40 text-foreground border border-border',
    animate: false,
    band: bandForScore(score),
  };
}

/**
 * Four segments, filled to the band. `aria-hidden` because the adjacent text
 * already says "74 Good" — this is the scanning channel, not the accessible
 * one.
 */
function QualityMeter({ band }: { band: number }) {
  return (
    <span aria-hidden="true" className="flex items-center gap-px" data-testid="quality-meter">
      {Array.from({ length: BAND_COUNT }, (_, i) => (
        <span
          key={i}
          data-filled={i < band ? 'true' : 'false'}
          className={cn(
            'h-2 w-[3px] rounded-[1px]',
            i < band ? 'bg-foreground' : 'bg-border',
          )}
        />
      ))}
    </span>
  );
}

function buildTooltip(props: QualityScoreBadgeProps): string {
  const { qualityScore, qualityStatus, qualityError, qualityAnalyzedAt } = props;

  if (qualityStatus === 'analyzing') {
    return 'Quality analysis in progress';
  }

  if (qualityStatus === 'failed') {
    return qualityError
      ? `Quality analysis failed: ${qualityError}`
      : 'Quality analysis failed';
  }

  if (qualityStatus === 'skipped') {
    return 'Page skipped (no content to analyze)';
  }

  if (qualityScore === null || qualityScore === undefined || qualityStatus === 'pending' || !qualityStatus) {
    return 'Quality has not been analyzed yet';
  }

  const lines: string[] = [`Quality Score: ${qualityScore}/100`];

  if (props.qualityCompleteness !== null && props.qualityCompleteness !== undefined) {
    lines.push(`Completeness: ${props.qualityCompleteness}/100`);
  }
  if (props.qualityClarity !== null && props.qualityClarity !== undefined) {
    lines.push(`Clarity: ${props.qualityClarity}/100`);
  }
  if (props.qualityStructure !== null && props.qualityStructure !== undefined) {
    lines.push(`Structure: ${props.qualityStructure}/100`);
  }
  if (props.qualityAccuracy !== null && props.qualityAccuracy !== undefined) {
    lines.push(`Accuracy: ${props.qualityAccuracy}/100`);
  }
  if (props.qualityReadability !== null && props.qualityReadability !== undefined) {
    lines.push(`Readability: ${props.qualityReadability}/100`);
  }

  if (qualityAnalyzedAt) {
    lines.push(`Analyzed ${formatRelativeTime(qualityAnalyzedAt)}`);
  }

  if (props.qualitySummary) {
    lines.push('', props.qualitySummary.slice(0, 200));
  }

  return lines.join('\n');
}

export function QualityScoreBadge(props: QualityScoreBadgeProps) {
  const { qualityScore, qualityStatus, qualityError, className } = props;
  const config = getScoreConfig(qualityScore, qualityStatus, qualityError);
  const tooltip = buildTooltip(props);

  return (
    <span
      title={tooltip}
      data-testid={config.testId ?? 'quality-score-badge'}
      data-status={qualityStatus ?? 'pending'}
      data-score={qualityScore ?? ''}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        config.badgeClass,
        config.animate && 'animate-pulse',
        className,
      )}
    >
      {config.band !== null && <QualityMeter band={config.band} />}
      {config.label}
    </span>
  );
}
