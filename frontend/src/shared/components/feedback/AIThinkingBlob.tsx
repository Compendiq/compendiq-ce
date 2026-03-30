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
            'bg-gradient-to-br from-purple-500/30 to-violet-600/30',
            'blur-md',
            !shouldReduceMotion && 'animate-[blob-pulse_3s_ease-in-out_infinite]',
          )}
        />
        {/* Morphing blob */}
        <div
          className={cn(
            'absolute inset-0.5 will-change-transform',
            'bg-gradient-to-br from-purple-500 to-violet-600',
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
