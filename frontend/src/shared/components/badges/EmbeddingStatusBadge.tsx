import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format-relative-time';
import type { EmbeddingStatus } from '../../hooks/use-pages';

interface EmbeddingStatusBadgeProps {
  /** Legacy boolean prop for backward compatibility */
  embeddingDirty?: boolean;
  /** New rich status prop (takes precedence when provided) */
  embeddingStatus?: EmbeddingStatus;
  /** Timestamp of the last successful embedding */
  embeddedAt?: string | null;
  /** Error message from the last failed embedding attempt */
  embeddingError?: string | null;
  /** Callback when user clicks retry on a failed embedding */
  onRetry?: () => void;
  className?: string;
}

interface StatusConfig {
  label: string;
  title: string;
  badgeClass: string;
  animate: boolean;
}

function getStatusConfig(
  status: EmbeddingStatus,
  embeddedAt?: string | null,
  embeddingError?: string | null,
): StatusConfig {
  switch (status) {
    case 'not_embedded':
      return {
        label: 'Not Embedded',
        title: 'Content has not been indexed for AI search',
        badgeClass: 'bg-status-inactive/20 text-status-inactive border border-status-inactive/30',
        animate: false,
      };
    case 'embedding':
      return {
        label: 'Embedding...',
        title: 'Content is being indexed for AI search',
        badgeClass: 'bg-status-embedding/20 text-status-embedding border border-status-embedding/30',
        animate: true,
      };
    case 'embedded':
      return {
        label: embeddedAt ? `Embedded ${formatRelativeTime(embeddedAt)}` : 'Embedded',
        title: embeddedAt
          ? `Indexed for AI search on ${new Date(embeddedAt).toLocaleString()}`
          : 'Content is indexed for AI search',
        badgeClass: 'bg-status-connected/20 text-status-connected border border-status-connected/30',
        animate: false,
      };
    case 'failed':
      return {
        label: 'Embedding Failed',
        title: embeddingError
          ? `Embedding failed: ${embeddingError}`
          : 'Last embedding attempt failed — click retry to try again',
        badgeClass: 'bg-status-disconnected/20 text-status-disconnected border border-status-disconnected/30',
        animate: false,
      };
  }
}

/** Resolve the effective status from props, preferring embeddingStatus over legacy embeddingDirty */
function resolveStatus(props: EmbeddingStatusBadgeProps): EmbeddingStatus {
  if (props.embeddingStatus) return props.embeddingStatus;
  // Fallback: legacy boolean
  if (props.embeddingDirty !== undefined) {
    return props.embeddingDirty ? 'not_embedded' : 'embedded';
  }
  return 'not_embedded';
}

export function EmbeddingStatusBadge(props: EmbeddingStatusBadgeProps) {
  const { embeddedAt, embeddingError, onRetry, className } = props;
  const status = resolveStatus(props);
  const config = getStatusConfig(status, embeddedAt, embeddingError);

  return (
    <span
      title={config.title}
      data-testid="embedding-status-badge"
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        config.badgeClass,
        config.animate && 'animate-pulse',
        className,
      )}
    >
      {config.label}
      {status === 'failed' && onRetry && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onRetry();
          }}
          className="ml-0.5 rounded px-1 py-0.5 text-[10px] font-semibold text-status-disconnected hover:bg-status-disconnected/20 hover:text-status-disconnected/80"
          title="Retry embedding"
          data-testid="embedding-retry-button"
        >
          Retry
        </button>
      )}
    </span>
  );
}

export type { EmbeddingStatusBadgeProps };
