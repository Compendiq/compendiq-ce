import { Ban, Cloud, Cpu, HardDrive, Sparkles, type LucideIcon } from 'lucide-react';
import type { AiPolicy, ProviderLocality, AiPolicyBlockReason } from '@compendiq/contracts';
import { cn } from '../../lib/cn';
import {
  AI_POLICY_CHIP_LABEL,
  LOCALITY_CHIP_LABEL,
  BLOCK_REASON_LABEL,
  workerStatusTone,
} from '../../lib/article-ai-policy';

/**
 * Article AI policy and provider locality are CATEGORIES, not connection
 * states or trust certificates (#283). Every chip is neutral ink with a
 * glyph: the glyph is the channel that survives `forced-colors` and colour
 * blindness, the same argument as `FrozenBadge`. No Steel fill, no green
 * seal, no amber — those stay interaction/brand and attention signals.
 */
const NEUTRAL = 'inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground';

const POLICY_GLYPH: Record<AiPolicy, LucideIcon> = {
  all: Sparkles,
  local_only: HardDrive,
  none: Ban,
};

interface AiPolicyChipProps {
  policy: AiPolicy;
  /** Compact header form: glyph only, name still announced. */
  compact?: boolean;
  className?: string;
}

export function AiPolicyChip({ policy, compact = false, className }: AiPolicyChipProps) {
  const Glyph = POLICY_GLYPH[policy];
  const label = AI_POLICY_CHIP_LABEL[policy];
  if (compact) {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center text-muted-foreground', className)}
        data-testid="ai-policy-chip-compact"
        data-policy={policy}
        title={label}
      >
        <Glyph size={12} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className={cn(NEUTRAL, className)} data-testid="ai-policy-chip" data-policy={policy}>
      <Glyph size={12} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

const LOCALITY_GLYPH: Record<ProviderLocality, LucideIcon> = {
  local: HardDrive,
  external: Cloud,
};

export function LocalityChip({ locality }: { locality: ProviderLocality | null }) {
  const Glyph = locality ? LOCALITY_GLYPH[locality] : Cpu;
  return (
    <span className={NEUTRAL} data-testid="locality-chip" data-locality={locality ?? 'undeclared'}>
      <Glyph size={12} aria-hidden="true" />
      <span>{locality ? LOCALITY_CHIP_LABEL[locality] : 'Locality not declared'}</span>
    </span>
  );
}

const TONE_CLASS = {
  success: 'border-success/40 text-success',
  failure: 'border-destructive/40 text-destructive',
  policy: 'border-dashed border-border text-muted-foreground',
  recovering: 'border-dotted border-border text-muted-foreground',
  neutral: 'border-border text-muted-foreground',
} as const;

const TONE_LABEL = {
  success: 'Completed',
  failure: 'Failed',
  policy: 'Policy blocked',
  recovering: 'Recovering',
  neutral: '',
} as const;

/**
 * The block reason is rendered as visible prose wired through
 * `aria-describedby`, never as a `title` alone: a tooltip on an unfocusable
 * span is unreachable by keyboard, touch and most screen readers.
 */
export function WorkerStatusBadge({
  status,
  reason,
  id,
}: { status: string; reason?: AiPolicyBlockReason | null; id?: string }) {
  const tone = workerStatusTone(status);
  const reasonText = tone === 'policy' && reason ? BLOCK_REASON_LABEL[reason] : null;
  const reasonId = reasonText ? `${id ?? 'worker-status'}-reason` : undefined;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs', TONE_CLASS[tone])}
        data-testid="worker-status-badge"
        data-tone={tone}
        aria-describedby={reasonId}
      >
        {TONE_LABEL[tone] || status}
      </span>
      {reasonText ? (
        <span id={reasonId} className="text-xs text-muted-foreground" data-testid="worker-status-reason">
          {reasonText}
        </span>
      ) : null}
    </span>
  );
}
