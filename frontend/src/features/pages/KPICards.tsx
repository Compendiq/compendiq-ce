import { useMemo } from 'react';
import { m } from 'framer-motion';
import { FileText, Clock, RefreshCw } from 'lucide-react';
import { formatRelativeTime } from '../../shared/lib/format-relative-time';
import { AnimatedCounter } from '../../shared/components/effects/AnimatedCounter';
import { TiltCard } from '../../shared/components/effects/TiltCard';

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

const RING_SIZE = 48;
const RING_STROKE = 5;
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
      <span className="absolute text-xs font-semibold">{percent}%</span>
    </div>
  );
}

// ---------- KPICards ----------

/**
 * Three tiles, one dominant — down from five equal ones.
 *
 * The old row spent five equal-weight cards to say very little: "Embedding
 * Coverage" was `embedded / total * 100` computed from the two tiles sitting
 * immediately to its left, so a fresh install read "5 / 0 / 0%" — one fact,
 * three times — before the user reached a single page. Coverage now lives
 * inside the Embedded tile as "0 of 5 (0%)", where it is a qualifier rather
 * than a headline; the space count rides along with Total Pages, which is the
 * number it qualifies. That frees Last Sync to span two columns and carry the
 * Sync action, so the one tile that implies a next step is also the one the
 * eye lands on first.
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
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="kpi-cards"
    >
      {/* Total pages, qualified by the spaces they came from. */}
      <m.div variants={fadeUp} className="h-full">
        <TiltCard className="rounded-xl border border-border bg-card p-4 h-full" maxTilt={10} data-testid="kpi-total-articles">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-foreground/5 p-2 text-success">
              <FileText size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Total Pages</p>
              <p className="text-base font-semibold">
                {embeddingStatus ? <AnimatedCounter value={totalPages} /> : '--'}
              </p>
              <p className="text-xs text-muted-foreground" data-testid="kpi-spaces-synced">
                across {spacesCount} {spacesCount === 1 ? 'space' : 'spaces'}
              </p>
            </div>
          </div>
        </TiltCard>
      </m.div>

      {/* Embedded pages, with coverage folded in as the qualifier it always
          was. The ring stays as the tile's icon — it reads the ratio faster
          than the text does. */}
      <m.div variants={fadeUp} className="h-full">
        <TiltCard className="rounded-xl border border-border bg-card p-4 h-full" maxTilt={10} data-testid="kpi-embedded-pages">
          <div className="flex items-center gap-3">
            <EmbeddingCoverageRing
              percent={embeddingStatus ? coveragePercent : 0}
              isProcessing={embeddingStatus?.isProcessing ?? false}
            />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Embedded</p>
              <p className="text-base font-semibold">
                {embeddingStatus ? <AnimatedCounter value={embeddedPages} /> : '--'}
              </p>
              <p className="text-xs text-muted-foreground" data-testid="kpi-embedding-coverage">
                {embeddingStatus ? `of ${totalPages} (${coveragePercent}%)` : 'of --'}
              </p>
            </div>
          </div>
        </TiltCard>
      </m.div>

      {/* Double-width and action-bearing: the only tile that implies a next
          step should be the one that gets the visual weight. */}
      <m.div variants={fadeUp} className="h-full sm:col-span-2">
        <TiltCard className="rounded-xl border border-border bg-card p-4 h-full" maxTilt={6} data-testid="kpi-last-sync">
          <div className="flex h-full items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-foreground/5 p-2 text-muted-foreground">
                <Clock size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Last Sync</p>
                <p className="text-lg font-semibold">
                  {lastSynced ? formatRelativeTime(lastSynced) : 'Never'}
                </p>
                {!lastSynced && (
                  <p className="text-xs text-muted-foreground">
                    Nothing has been mirrored from Confluence yet.
                  </p>
                )}
              </div>
            </div>
            {onSync && (
              <button
                type="button"
                onClick={onSync}
                disabled={isSyncing}
                className="shrink-0 inline-flex items-center gap-2 rounded-lg border border-action bg-transparent px-3 py-2 text-sm font-medium text-action transition-colors hover:bg-action hover:text-action-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                data-testid="kpi-sync-btn"
              >
                <RefreshCw size={15} className={isSyncing ? 'animate-spin' : undefined} />
                {isSyncing ? 'Syncing...' : 'Sync now'}
              </button>
            )}
          </div>
        </TiltCard>
      </m.div>
    </m.div>
  );
}
