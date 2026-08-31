import { Loader2, type LucideIcon } from 'lucide-react';
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
  /** Glyph channel — the differentiator that outlives reduced motion. */
  icon?: LucideIcon;
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
        // `--color-status-embedding` no longer carries a hue: it resolves to
        // body ink, because it had been byte-identical to `--color-primary`
        // (Steel) through three critiques and ambient pipeline telemetry was
        // wearing the one colour that means "you can act on this". Every alpha
        // here is therefore re-measured against INK, not against Steel. All
        // ratios are WCAG on an sRGB-space (gamma, byte-rounded) composite,
        // which is how a browser blends alpha.
        //
        // Fill at 10%, not the 20% Steel wore: a `bg-` utility on this token at
        // 20% measures 1.53:1 (Paper) / 1.75:1 (Graphite) against Pane, and in
        // Graphite that is LOUDER than `--color-border` itself (1.26:1) — a
        // "still indexing" pill would out-shout the hairlines that structure
        // the page. At 10% it lands 1.225:1 / 1.278:1, which is exactly the
        // measured neutral-chip tint (neutral-chip.ts).
        //
        // The hairline is `border-border`, NOT a `border-` utility on this
        // token: a border tint composites on top of the fill underneath it, so
        // even the cheapest ink alpha that still registers (8%) measures
        // 1.439:1 (Paper) / 1.592:1 (Graphite) at the pill's OUTER edge —
        // past `--color-border` in both themes, Graphite by 26%. The quiet
        // hairline token is the ceiling (1.414 / 1.264) and is what
        // neutral-chip.ts settled on for a fill this subtle.
        //
        // Ink stays full strength. `text-status-embedding` measures 14.36:1
        // (Paper) / 11.62:1 (Graphite) on its own fill, against the resting
        // states' muted-on-muted 4.54 / 6.75:1. That value step is the real
        // separator from `not_embedded` / `embedded`, because the FILL is not
        // one: in Paper this tint (1.225:1 vs Pane) and their `bg-muted`
        // (1.193:1) are 2.7% apart, which nobody can see.
        badgeClass: 'bg-status-embedding/10 text-status-embedding border border-border',
        // The load-bearing channel, and the reason this state does not depend
        // on motion. index.css's blanket `prefers-reduced-motion` rule clamps
        // every animation to 0.01ms and one iteration, so for those users the
        // pulse below simply does not exist and the pill is a static neutral
        // chip. A stopped Loader2 is still a visible arc that no sibling state
        // carries — the same reasoning WorkersTab's Processing pill is built on.
        icon: Loader2,
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
      {config.icon && (
        <config.icon
          size={11}
          className={cn('shrink-0', config.animate && 'animate-spin')}
          data-testid="embedding-status-glyph"
          aria-hidden="true"
        />
      )}
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
