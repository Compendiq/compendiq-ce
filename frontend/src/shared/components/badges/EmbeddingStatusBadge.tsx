import { AlertCircle, CircleDashed, Cpu, Loader2, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { formatRelativeTime } from '../../lib/format-relative-time';
import type { EmbeddingStatus } from '../../hooks/use-pages';
import { statusChipClass } from './neutral-chip';

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
  /** Fill/ink overrides on top of `statusChipClass`; empty for the neutral resting states. */
  badgeClass: string;
  /**
   * Glyph channel — every state carries one. The label says which state this
   * is; the glyph is what tells the chip apart from its siblings at a glance
   * and is the channel that outlives reduced motion and forced-colors.
   */
  icon: LucideIcon;
  animate: boolean;
}

/**
 * The label speaks the reader's language — "indexed", the word the Document
 * health sentence above this chip and the Pages list's PageStateBadge already
 * use — not the pipeline's ("embedded"). Sentence case, like every other
 * readout in the inspector.
 */
function getStatusConfig(
  status: EmbeddingStatus,
  embeddedAt?: string | null,
  embeddingError?: string | null,
): StatusConfig {
  switch (status) {
    case 'not_embedded':
      return {
        label: 'Not indexed',
        title: 'Content has not been indexed for AI search',
        // Neutral: the resting recipe (neutral-chip.ts) is the whole chip.
        // This state used to keep `bg-muted` on the argument that it sat on an
        // nm-card; the inspector is flat Pane now, where bg-muted measures
        // 1.04:1 in Graphite and the pill disappeared.
        badgeClass: '',
        icon: CircleDashed,
        animate: false,
      };
    case 'embedding':
      return {
        label: 'Indexing…',
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
        // The hairline stays `border-border`, NOT a `border-` utility on this
        // token: a border tint composites on top of the fill underneath it, so
        // even the cheapest ink alpha that still registers (8%) measures
        // 1.439:1 (Paper) / 1.592:1 (Graphite) at the pill's OUTER edge —
        // past `--color-border` in both themes, Graphite by 26%.
        //
        // Ink stays full strength. `text-status-embedding` measures 14.36:1
        // (Paper) / 11.62:1 (Graphite) on its own fill, against the resting
        // states' secondary ink. That value step is the real separator from
        // `not_embedded` / `embedded`, because the FILL is not one: this tint
        // and the resting tint are the same alpha of the same ink.
        badgeClass: 'bg-status-embedding/10 text-status-embedding',
        // The load-bearing channel, and the reason this state does not depend
        // on motion. index.css's blanket `prefers-reduced-motion` rule clamps
        // every animation to 0.01ms and one iteration, so for those users the
        // pulse below simply does not exist. A stopped Loader2 is still a
        // visible arc that no sibling state carries — the same reasoning
        // WorkersTab's Processing pill is built on.
        icon: Loader2,
        animate: true,
      };
    case 'embedded':
      return {
        label: embeddedAt ? `Indexed ${formatRelativeTime(embeddedAt)}` : 'Indexed',
        title: embeddedAt
          ? `Indexed for AI search on ${new Date(embeddedAt).toLocaleString()}`
          : 'Content is indexed for AI search',
        // Neutral, deliberately: "Indexed <date>" is the resting state of
        // every healthy page — a freshness readout, not an event. Painting it
        // the connected green put a permanent green pill on every Details tab
        // and diluted the one hue that means "a connection is up". The live
        // states above/below keep their reserved hues (ink = indexing, red on
        // failure).
        badgeClass: '',
        // The same glyph the health sentence and the Re-embed action wear for
        // the AI index, so the three read as one subject.
        icon: Cpu,
        animate: false,
      };
    case 'failed':
      return {
        label: 'Indexing failed',
        title: embeddingError
          ? `Indexing failed: ${embeddingError}`
          : 'Last indexing attempt failed — click retry to try again',
        badgeClass: 'bg-status-disconnected/20 text-status-disconnected border-status-disconnected/30',
        icon: AlertCircle,
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

/**
 * A passive readout: no `role`, no `tabIndex`, no `aria-label` — the
 * accessible name is the visible label and a Tab walk does not stop on it.
 * `title` supplements with the exact timestamp / error for pointer users.
 *
 * The one operable part, Retry, is a real sibling button beside the chip —
 * never nested inside it — at the 32px control height.
 */
export function EmbeddingStatusBadge(props: EmbeddingStatusBadgeProps) {
  const { embeddedAt, embeddingError, onRetry, className } = props;
  const status = resolveStatus(props);
  const config = getStatusConfig(status, embeddedAt, embeddingError);

  const chip = (
    <span
      title={config.title}
      data-testid={status === 'not_embedded' ? 'badge-not-embedded' : 'embedding-status-badge'}
      data-status={status}
      className={cn(
        statusChipClass,
        'whitespace-nowrap',
        config.badgeClass,
        config.animate && 'animate-pulse',
        className,
      )}
    >
      <config.icon
        size={12}
        className={cn('shrink-0', config.animate && 'animate-spin')}
        data-testid="embedding-status-glyph"
        aria-hidden="true"
      />
      {config.label}
    </span>
  );

  if (status !== 'failed' || !onRetry) return chip;

  return (
    <span className="inline-flex items-center gap-1.5">
      {chip}
      <button
        type="button"
        onClick={(e) => {
          // List rows are buttons: a retry must not also open the row.
          e.stopPropagation();
          e.preventDefault();
          onRetry();
        }}
        className="nm-button-ghost h-8 text-xs"
        aria-label="Retry indexing"
        data-testid="embedding-retry-button"
      >
        Retry
      </button>
    </span>
  );
}
