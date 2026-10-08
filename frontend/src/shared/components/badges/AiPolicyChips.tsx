import type { AiPolicy, ProviderLocality, AiPolicyBlockReason } from '@compendiq/contracts';
import { cn } from '../../lib/cn';
import {
  AI_POLICY_CHIP_LABEL,
  LOCALITY_CHIP_LABEL,
  BLOCK_REASON_LABEL,
  workerStatusTone,
} from '../../lib/article-ai-policy';

const NEUTRAL = 'inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground';

export function AiPolicyChip({ policy }: { policy: AiPolicy }) {
  return (
    <span className={NEUTRAL} data-testid="ai-policy-chip" data-policy={policy}>
      {AI_POLICY_CHIP_LABEL[policy]}
    </span>
  );
}

export function LocalityChip({ locality }: { locality: ProviderLocality | null }) {
  return (
    <span className={NEUTRAL} data-testid="locality-chip" data-locality={locality ?? 'undeclared'}>
      {locality ? LOCALITY_CHIP_LABEL[locality] : 'Locality not declared'}
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

export function WorkerStatusBadge({ status, reason }: { status: string; reason?: AiPolicyBlockReason | null }) {
  const tone = workerStatusTone(status);
  return (
    <span
      className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs', TONE_CLASS[tone])}
      data-testid="worker-status-badge"
      data-tone={tone}
      title={tone === 'policy' && reason ? BLOCK_REASON_LABEL[reason] : undefined}
    >
      {TONE_LABEL[tone] || status}
    </span>
  );
}
