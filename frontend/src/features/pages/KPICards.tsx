import { m } from 'framer-motion';
import { FileText, Layers, Database, Percent, Clock } from 'lucide-react';
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
      icon: Percent,
      label: 'Embedding Coverage',
      value: embeddingStatus ? `${coveragePercent}%` : '--',
      numericValue: embeddingStatus ? coveragePercent : undefined,
      suffix: '%',
      color: coveragePercent === 100
        ? 'text-success'
        : coveragePercent >= 75
          ? 'text-info'
          : 'text-warning',
      testId: 'kpi-embedding-coverage',
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
    </m.div>
  );
}
