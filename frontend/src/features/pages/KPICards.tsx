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

const RING_SIZE = 22;
const RING_STROKE = 2.5;
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

  // One neutral stroke, deliberately: coverage is a measurement and the arc
  // LENGTH is its channel. The retired ramp (green at 100, indigo ≥75, amber
  // below) restated the same number in borrowed status hues — amber implied a
  // warning at 74% and the undocumented indigo meant nothing at all.
  const strokeColor = 'var(--color-muted-foreground)';

  return (
    <div className="relative flex items-center justify-center shrink-0" data-testid="embedding-coverage-ring">
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
    </div>
  );
}

// ---------- KPICards ----------

/**
 * Status strip aligned in the header row.
 *
 * Displays three corpus facts: total pages, embedded count / coverage, and last sync time with quick-sync CTA.
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
      className="flex flex-wrap items-center gap-x-3 sm:gap-x-3.5 gap-y-1.5"
      data-testid="kpi-cards"
    >
      {/* Total pages, qualified by the spaces they came from. */}
      <m.div variants={fadeUp} className="flex items-center gap-1.5 text-xs sm:text-[13px] shrink-0" data-testid="kpi-total-articles">
        <FileText size={14} className="shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">Total Pages</span>
        <span className="font-semibold tabular-nums">
          {embeddingStatus ? <AnimatedCounter value={totalPages} /> : '--'}
        </span>
        <span className="text-xs text-muted-foreground hidden lg:inline" data-testid="kpi-spaces-synced">
          across {spacesCount} {spacesCount === 1 ? 'space' : 'spaces'}
        </span>
      </m.div>

      <span aria-hidden className="hidden h-3.5 w-px bg-border sm:block" />

      {/* Embedded pages, with coverage folded in as the qualifier it always
          was. The ring reads the ratio faster than the text does. */}
      <m.div variants={fadeUp} className="flex items-center gap-1.5 text-xs sm:text-[13px] shrink-0" data-testid="kpi-embedded-pages">
        <EmbeddingCoverageRing
          percent={embeddingStatus ? coveragePercent : 0}
          isProcessing={embeddingStatus?.isProcessing ?? false}
        />
        <span className="text-muted-foreground">Embedded</span>
        <span className="font-semibold tabular-nums">
          {embeddingStatus ? <AnimatedCounter value={embeddedPages} /> : '--'}
        </span>
        <span className="text-xs text-muted-foreground hidden sm:inline" data-testid="kpi-embedding-coverage">
          {embeddingStatus ? `of ${totalPages} (${coveragePercent}%)` : 'of --'}
        </span>
      </m.div>

      <span aria-hidden className="hidden h-3.5 w-px bg-border sm:block" />

      {/* Last sync and sync action */}
      <m.div
        variants={fadeUp}
        className="flex items-center gap-1.5 text-xs sm:text-[13px] shrink-0"
        data-testid="kpi-last-sync"
      >
        <Clock size={14} className="shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">Last Sync</span>
        <span className="font-semibold">
          {lastSynced ? formatRelativeTime(lastSynced) : 'Never'}
        </span>
        {!lastSynced && (
          <span className="hidden truncate text-xs text-muted-foreground 2xl:inline">
            Nothing mirrored yet.
          </span>
        )}
        {onSync && (
          <button
            type="button"
            onClick={onSync}
            disabled={isSyncing}
            className="nm-button-ghost h-7 px-2 text-xs gap-1 shrink-0 ml-0.5 disabled:opacity-50"
            data-testid="kpi-sync-btn"
            title={isSyncing ? 'Syncing...' : 'Sync knowledge base'}
          >
            <RefreshCw size={12} className={isSyncing ? 'animate-spin' : undefined} />
            <span>{isSyncing ? 'Syncing...' : 'Sync'}</span>
          </button>
        )}
      </m.div>
    </m.div>
  );
}
