import { cn } from '../../lib/cn';

/**
 * #1154: whether the model assigned to `chat` accepts image input.
 *
 * Three states, not two. `null` means capability is **not established**, which
 * is not the same claim as "this model is text-only" — see ADR-021's #1154
 * amendment.
 *
 * It covers two situations, and the copy must not pick one: the model has not
 * been probed *yet*, or a probe ran and could not tell (a rate limit, an auth
 * hiccup, an open breaker). Not-yet is the dominant one and the only one a user
 * normally sees — `getVisionCapability` is a pure cache read, so a model with no
 * row schedules a background refresh and returns `null` immediately, which is
 * every first paint for an unseen model.
 *
 * Steel and slate rather than green/amber: ADR-010 reserves amber for
 * warning/attention, and a capability verdict is information, not a warning.
 */

interface VisionStateConfig {
  label: string;
  title: string;
  badgeClass: string;
}

const CONFIG: Record<'yes' | 'no' | 'unknown', VisionStateConfig> = {
  yes: {
    label: 'Vision',
    title: 'This model has been probed with a test image and can read images.',
    badgeClass: 'bg-primary/15 text-primary-ink',
  },
  no: {
    label: 'Text-only',
    title: 'This model refused a test image. Image attachments will be rejected.',
    badgeClass: 'bg-muted text-muted-foreground',
  },
  unknown: {
    label: 'Unconfirmed',
    title:
      'Image support has not been established yet. '
      + 'Image attachments are refused until a probe confirms it.',
    badgeClass: 'bg-muted text-muted-foreground',
  },
};

export function VisionBadge({ vision }: { vision: boolean | null }) {
  const config = CONFIG[vision === true ? 'yes' : vision === false ? 'no' : 'unknown'];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        config.badgeClass,
      )}
      title={config.title}
      data-testid="vision-badge"
    >
      {config.label}
    </span>
  );
}
