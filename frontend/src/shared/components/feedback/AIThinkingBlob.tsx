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
 * Morphing organic shape with purple gradient glow.
 * Replaces spinner while Ollama processes a request.
 * Uses CSS animations on transform (GPU-composited).
 * Respects prefers-reduced-motion.
 */
export function AIThinkingBlob({
  active = true,
  label = 'Synthesizing knowledge...',
  className,
}: AIThinkingBlobProps) {
  const shouldReduceMotion = useReducedMotion();

  if (!active) return null;

  return (
    <div
      data-testid="ai-thinking-blob"
      className={cn('flex flex-col items-center gap-3', className)}
      role="status"
      aria-label={label}
    >
      <div className="relative h-16 w-16">
        {/* Glow layer */}
        <div
          className={cn(
            'absolute inset-0 rounded-full',
            'bg-gradient-to-br from-purple-500/40 to-violet-600/40',
            'blur-xl',
            !shouldReduceMotion && 'animate-[blob-pulse_3s_ease-in-out_infinite]',
          )}
        />
        {/* Morphing blob */}
        <div
          className={cn(
            'absolute inset-1 will-change-transform',
            'bg-gradient-to-br from-purple-500 to-violet-600',
            !shouldReduceMotion
              ? 'animate-[blob-morph_4s_ease-in-out_infinite]'
              : 'rounded-full',
          )}
        />
      </div>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}
