import { useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/cn';

interface AIThinkingBlobProps {
  /** Whether the blob is visible */
  active?: boolean;
  /** Text displayed below the blob */
  label?: string;
  className?: string;
}

/**
 * Compact inline indicator with morphing blob + status text.
 * Replaces the previous large centered blob (#21 redesign).
 * Uses CSS animations on transform (GPU-composited).
 * Respects prefers-reduced-motion.
 */
export function AIThinkingBlob({
  active = true,
  label = 'Thinking...',
  className,
}: AIThinkingBlobProps) {
  const shouldReduceMotion = useReducedMotion();

  if (!active) return null;

  return (
    <div
      data-testid="ai-thinking-blob"
      className={cn('flex items-center gap-2', className)}
      role="status"
      aria-label={label}
    >
      <div className="relative h-5 w-5 shrink-0">
        {/* Glow layer */}
        <div
          className={cn(
            'absolute inset-0 rounded-full',
            // `--color-status-ai`, not raw `purple-500`/`violet-600`. The blob
            // is the app's one AI-thinking glyph, so it has to be the same
            // violet as every other AI marker — and the Tailwind palette does
            // not track the theme, which put a bright dark-theme violet on
            // Paper where the token is a much deeper `#7041a8`. Flat rather
            // than a gradient for the same reason as every other surface.
            'bg-status-ai/30',
            'blur-md',
            !shouldReduceMotion && 'animate-[blob-pulse_3s_ease-in-out_infinite]',
          )}
        />
        {/* Morphing blob */}
        <div
          className={cn(
            'absolute inset-0.5 will-change-transform',
            'bg-status-ai',
            !shouldReduceMotion
              ? 'animate-[blob-morph_4s_ease-in-out_infinite]'
              : 'rounded-full',
          )}
        />
      </div>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
