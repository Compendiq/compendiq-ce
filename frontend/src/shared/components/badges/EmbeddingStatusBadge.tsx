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
        // Token-based neutral, same as `embedded` below — the label is the
        // differentiator. This carried hardcoded warm-gray hexes behind a
        // `dark:` variant, and with no `@custom-variant dark` in this app,
        // `dark:` compiles to the OS media query: OS-dark + user-picked Paper
        // rendered the dark pill on the white page. Tokens follow the active
        // theme. (The hexes had replaced status-inactive/20, which failed AA
        // — the muted pairing passes on every surface it lands on.)
        //
        // Deliberately `bg-muted`, NOT the row chips' `bg-foreground/10`
        // tint (neutral-chip.ts): this badge renders only on ArticleRightPane's
        // non-hovering nm-card, where muted is a real value step. The tint
        // recipe exists for chips on rows that hover with `bg-accent` (== muted
        // in Graphite) and for the elevated hover card — check the ground
        // before "unifying" in either direction.
        badgeClass: 'bg-muted text-muted-foreground',
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
        // Neutral, deliberately: "Embedded <date>" is the resting state of
        // every healthy page — a freshness readout, not an event. Painting it
        // the connected green put a permanent green pill on every Details tab
        // and diluted the one hue that means "a connection is up". The live
        // states above/below keep their reserved hues (Steel = embedding,
        // red on failure).
        badgeClass: 'bg-muted text-muted-foreground',
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
      data-testid={status === 'not_embedded' ? 'badge-not-embedded' : 'embedding-status-badge'}
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
          className="ml-0.5 rounded px-1 py-0.5 text-[11px] font-semibold text-status-disconnected hover:bg-status-disconnected/20 hover:text-status-disconnected/80"
          title="Retry embedding"
          data-testid="embedding-retry-button"
        >
          Retry
        </button>
      )}
    </span>
  );
}
