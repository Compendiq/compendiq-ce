import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format-relative-time';
import type { QualityStatus } from '../../hooks/use-pages';

export interface QualityScoreBadgeProps {
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
      badgeClass: 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
      animate: true,
    };
  }

  if (status === 'failed') {
    return {
      label: 'Analysis Failed',
      badgeClass: 'bg-red-500/20 text-red-400 border border-red-500/30',
      animate: false,
    };
  }

  if (status === 'skipped') {
    return {
      label: 'Skipped',
      badgeClass: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
      animate: false,
    };
  }

  if (score === null || score === undefined || status === 'pending' || !status) {
    return {
      label: 'Not Scored',
      badgeClass: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
      animate: false,
    };
  }

  // Score-based labels
  if (score >= 90) {
    return {
      label: `${score} Excellent`,
      badgeClass: 'bg-green-500/20 text-green-400 border border-green-500/30',
      animate: false,
    };
  }

  if (score >= 70) {
    return {
      label: `${score} Good`,
      badgeClass: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
      animate: false,
    };
  }

  if (score >= 50) {
    return {
      label: `${score} Needs Work`,
      badgeClass: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
      animate: false,
    };
  }

  return {
    label: `${score} Poor`,
    badgeClass: 'bg-red-500/20 text-red-400 border border-red-500/30',
    animate: false,
  };
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
      data-testid="quality-score-badge"
      data-status={qualityStatus ?? 'pending'}
      data-score={qualityScore ?? ''}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        config.badgeClass,
        config.animate && 'animate-pulse',
        className,
      )}
    >
      {config.label}
    </span>
  );
}
