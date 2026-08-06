import { useMemo } from 'react';
import { m } from 'framer-motion';
import { FileText, Clock, RefreshCw } from 'lucide-react';
import { formatRelativeTime } from '../../shared/lib/format-relative-time';
import { AnimatedCounter } from '../../shared/components/effects/AnimatedCounter';

interface KPICardsProps {
  embeddingStatus?: {
    totalPages: number;
    embeddedPages: number;
    dirtyPages: number;
    totalEmbeddings: number;
    isProcessing: boolean;
  };
  spacesCount: number;
  lastSynced?: string;
  /** Triggers a sync from inside the Last Sync card. Omitted → no CTA. */
  onSync?: () => void;
  isSyncing?: boolean;
}

const stagger = {
  animate: { transition: { staggerChildren: 0.08 } },
};

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
};

// ---------- Embedding Coverage Ring ----------

const RING_SIZE = 28;
const RING_STROKE = 3;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface EmbeddingCoverageRingProps {
  percent: number;
  isProcessing: boolean;
}

function EmbeddingCoverageRing({ percent, isProcessing }: EmbeddingCoverageRingProps) {
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const strokeDashoffset = RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE;

  // Color based on coverage
  const strokeColor = percent === 100
    ? 'var(--color-success)'
    : percent >= 75
      ? 'var(--color-info)'
      : 'var(--color-warning)';

  return (
    <div className="relative flex items-center justify-center" data-testid="embedding-coverage-ring">
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
        className={isProcessing && !prefersReducedMotion ? 'animate-spin' : ''}
        style={isProcessing && !prefersReducedMotion ? { animationDuration: '3s' } : undefined}
        role="img"
        aria-label={`Embedding coverage: ${percent}%`}
      >
        {/* Background circle */}
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={RING_STROKE}
          className="text-foreground/10"
        />
        {/* Progress arc */}
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={RING_RADIUS}
          fill="none"
          stroke={strokeColor}
          strokeWidth={RING_STROKE}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={prefersReducedMotion ? strokeDashoffset : undefined}
          strokeLinecap="round"
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          style={!prefersReducedMotion ? {
            strokeDashoffset,
            transition: 'stroke-dashoffset 0.6s ease-out',
          } : undefined}
        />
      </svg>
      {/* No number inside the ring. At 28px it would have to set below the
          11px legibility floor, and the exact figure is already spelled out
          immediately beside it as "of N (X%)". The ring is the glyph that
          reads the ratio at a glance; the text is what reads it precisely.
          Screen readers get the value from the svg's aria-label. */}
    </div>
  );
}

// ---------- KPICards ----------

/**
 * One status strip, not a row of tiles.
 *
 * These are three small facts about the corpus — how much of it there is, how
 * much is embedded, when it last synced. As `p-4` cards on a 4-column grid
 * they cost ~96px of the first viewport and read as the page's headline, which
 * is the hero-metric template: a big number, a small label, an icon chip, and
 * no next step except the one button hiding in the third tile.
 *
 * As a single ~52px strip the same facts read left to right in one pass, and
 * the pages list — the actual content of this route — starts a full card
 * higher up. Nothing was dropped: total, spaces, embedded, coverage, last sync
 * and the Sync action are all still here, and the coverage ring survives as
 * the one glyph that reads a ratio faster than its text does.
 *
 * The tiles were also `TiltCard`s, which rotated in 3D under the cursor. That
 * is the clearest surviving gesture of the retired neumorphic world and it had
 * no counterpart anywhere else in the app.
 */
export function KPICards({ embeddingStatus, spacesCount, lastSynced, onSync, isSyncing }: KPICardsProps) {
  const totalPages = embeddingStatus?.totalPages ?? 0;
  const embeddedPages = embeddingStatus?.embeddedPages ?? 0;
  const coveragePercent = totalPages > 0
    ? Math.round((embeddedPages / totalPages) * 100)
    : 0;

  return (
    <m.div
      variants={stagger}
      initial="initial"
      animate="animate"
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-border bg-card px-3 py-2"
      data-testid="kpi-cards"
    >
      {/* Total pages, qualified by the spaces they came from. */}
      <m.div variants={fadeUp} className="flex items-center gap-2" data-testid="kpi-total-articles">
        <FileText size={14} className="shrink-0 text-muted-foreground" />
        <span className="text-[13px] text-muted-foreground">Total Pages</span>
        <span className="text-[13px] font-semibold tabular-nums">
          {embeddingStatus ? <AnimatedCounter value={totalPages} /> : '--'}
        </span>
        <span className="text-xs text-muted-foreground" data-testid="kpi-spaces-synced">
          across {spacesCount} {spacesCount === 1 ? 'space' : 'spaces'}
        </span>
      </m.div>

      <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />

      {/* Embedded pages, with coverage folded in as the qualifier it always
          was. The ring reads the ratio faster than the text does. */}
      <m.div variants={fadeUp} className="flex items-center gap-2" data-testid="kpi-embedded-pages">
        <EmbeddingCoverageRing
          percent={embeddingStatus ? coveragePercent : 0}
          isProcessing={embeddingStatus?.isProcessing ?? false}
        />
        <span className="text-[13px] text-muted-foreground">Embedded</span>
        <span className="text-[13px] font-semibold tabular-nums">
          {embeddingStatus ? <AnimatedCounter value={embeddedPages} /> : '--'}
        </span>
        <span className="text-xs text-muted-foreground" data-testid="kpi-embedding-coverage">
          {embeddingStatus ? `of ${totalPages} (${coveragePercent}%)` : 'of --'}
        </span>
      </m.div>

      <span aria-hidden className="hidden h-4 w-px bg-border sm:block" />

      {/* Last sync carries the only next step on the strip, so it sits at the
          end where the eye finishes rather than buried mid-row. */}
      {/* `basis-full` below sm: this segment carries a label, a value, prose and
          a button, so sharing a wrapped line with "Embedded" pushed the Sync
          button off the right edge at 390px. It takes its own line on mobile
          and the remaining width from sm up. */}
      <m.div
        variants={fadeUp}
        className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto sm:flex-1"
        data-testid="kpi-last-sync"
      >
        <Clock size={14} className="shrink-0 text-muted-foreground" />
        <span className="text-[13px] text-muted-foreground">Last Sync</span>
        <span className="text-[13px] font-semibold">
          {lastSynced ? formatRelativeTime(lastSynced) : 'Never'}
        </span>
        {!lastSynced && (
          <span className="hidden truncate text-xs text-muted-foreground lg:inline">
            Nothing has been mirrored from Confluence yet.
          </span>
        )}
        {onSync && (
          <button
            type="button"
            onClick={onSync}
            disabled={isSyncing}
            className="nm-button-ghost ml-auto shrink-0 gap-1.5 disabled:opacity-50"
            data-testid="kpi-sync-btn"
          >
            <RefreshCw size={13} className={isSyncing ? 'animate-spin' : undefined} />
            {isSyncing ? 'Syncing...' : 'Sync now'}
          </button>
        )}
      </m.div>
    </m.div>
  );
}
