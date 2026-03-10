import { useMemo } from 'react';
import { m } from 'framer-motion';
import { FileText, Layers, Database, Clock } from 'lucide-react';
import { formatRelativeTime } from '../../shared/lib/format-relative-time';
import { AnimatedCounter } from '../../shared/components/AnimatedCounter';
import { TiltCard } from '../../shared/components/TiltCard';

interface KPICardsProps {
  embeddingStatus?: {
    totalPages: number;
    dirtyPages: number;
    totalEmbeddings: number;
    isProcessing: boolean;
  };
  spacesCount: number;
  lastSynced?: string;
}

interface KPICard {
  icon: typeof FileText;
  label: string;
  value: string;
  /** If set, AnimatedCounter counts up to this number */
  numericValue?: number;
  /** Suffix for animated counter (e.g. '%') */
  suffix?: string;
  color: string;
  testId: string;
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

export function KPICards({ embeddingStatus, spacesCount, lastSynced }: KPICardsProps) {
  const totalPages = embeddingStatus?.totalPages ?? 0;
  const embeddedPages = totalPages - (embeddingStatus?.dirtyPages ?? 0);
  const coveragePercent = totalPages > 0
    ? Math.round((embeddedPages / totalPages) * 100)
    : 0;

  const cards: KPICard[] = [
    {
      icon: FileText,
      label: 'Total Articles',
      value: embeddingStatus ? String(totalPages) : '--',
      numericValue: embeddingStatus ? totalPages : undefined,
      color: 'text-success',
      testId: 'kpi-total-articles',
    },
    {
      icon: Database,
      label: 'Embedded Pages',
      value: embeddingStatus ? String(embeddedPages) : '--',
      numericValue: embeddingStatus ? embeddedPages : undefined,
      color: 'text-info',
      testId: 'kpi-embedded-pages',
    },
    {
      icon: Layers,
      label: 'Spaces Synced',
      value: String(spacesCount),
      numericValue: spacesCount,
      color: 'text-primary',
      testId: 'kpi-spaces-synced',
    },
    {
      icon: Clock,
      label: 'Last Sync',
      value: lastSynced ? formatRelativeTime(lastSynced) : 'Never',
      color: 'text-muted-foreground',
      testId: 'kpi-last-sync',
    },
  ];

  return (
    <m.div
      variants={stagger}
      initial="initial"
      animate="animate"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      data-testid="kpi-cards"
    >
      {cards.map(({ icon: Icon, label, value, numericValue, suffix, color, testId }) => (
        <m.div
          key={label}
          variants={fadeUp}
        >
          <TiltCard className="glass-card p-4" maxTilt={10} data-testid={testId}>
            <div className="flex items-center gap-3">
              <div className={`rounded-lg bg-foreground/5 p-2 ${color}`}>
                <Icon size={16} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs text-muted-foreground">{label}</p>
                <p className="text-base font-semibold">
                  {numericValue != null ? (
                    <AnimatedCounter value={numericValue} suffix={suffix} />
                  ) : (
                    value
                  )}
                </p>
              </div>
            </div>
          </TiltCard>
        </m.div>
      ))}

      {/* Embedding Coverage Ring - special card with SVG arc */}
      <m.div
        variants={fadeUp}
        className="glass-card p-4"
        data-testid="kpi-embedding-coverage"
      >
        <div className="flex items-center gap-3">
          <EmbeddingCoverageRing
            percent={embeddingStatus ? coveragePercent : 0}
            isProcessing={embeddingStatus?.isProcessing ?? false}
          />
          <div className="min-w-0">
            <p className="truncate text-xs text-muted-foreground">Embedding Coverage</p>
            <p className="text-base font-semibold">
              {embeddingStatus ? `${coveragePercent}%` : '--'}
            </p>
          </div>
        </div>
      </m.div>
    </m.div>
  );
}
