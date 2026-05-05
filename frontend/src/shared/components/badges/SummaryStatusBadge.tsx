import { cn } from '../../lib/cn';
import type { SummaryStatus } from '../../hooks/use-pages';

interface SummaryStatusBadgeProps {
  status?: SummaryStatus;
  className?: string;
}

interface StatusConfig {
  label: string;
  title: string;
  dotClass: string;
  animate: boolean;
}

function getConfig(status: SummaryStatus): StatusConfig {
  switch (status) {
    case 'summarized':
      return {
        label: 'Summarized',
        title: 'AI summary available',
        dotClass: 'bg-status-connected',
        animate: false,
      };
    case 'summarizing':
      return {
        label: 'Summarizing',
        title: 'Summary is being generated',
        dotClass: 'bg-status-ai',
        animate: true,
      };
    case 'pending':
      return {
        label: 'Pending',
        title: 'Summary queued for generation',
        dotClass: 'bg-status-syncing',
        animate: false,
      };
    case 'failed':
      return {
        label: 'Failed',
        title: 'Summary generation failed',
        dotClass: 'bg-status-disconnected',
        animate: false,
      };
    case 'skipped':
      return {
        label: 'Skipped',
        title: 'Content too short for summarization',
        dotClass: 'bg-status-inactive',
        animate: false,
      };
  }
}

export function SummaryStatusBadge({ status, className }: SummaryStatusBadgeProps) {
  if (!status) return null;

  const config = getConfig(status);

  return (
    <span
      title={config.title}
      data-testid="summary-status-badge"
      data-status={status}
      className={cn('inline-flex items-center gap-1.5', className)}
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          config.dotClass,
          config.animate && 'animate-pulse',
        )}
      />
      <span className="text-xs text-muted-foreground">{config.label}</span>
    </span>
  );
}
