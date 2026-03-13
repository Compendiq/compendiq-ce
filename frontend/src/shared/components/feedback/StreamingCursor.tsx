import { useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/cn';

interface StreamingCursorProps {
  /** Whether the cursor is actively visible (during streaming) */
  active?: boolean;
  className?: string;
}

/**
 * Glowing cyan block cursor that blinks at the end of streaming text.
 * Replaces spinner during AI text generation.
 * GPU-composited: uses opacity animation only.
 * Respects prefers-reduced-motion.
 */
export function StreamingCursor({ active = true, className }: StreamingCursorProps) {
  const shouldReduceMotion = useReducedMotion();

  if (!active) return null;

  return (
    <span
      data-testid="streaming-cursor"
      className={cn(
        'inline-block w-[2px] h-5 bg-cyan-400 rounded-sm align-middle',
        'shadow-[0_0_8px_#22d3ee]',
        !shouldReduceMotion && 'animate-[cursor-blink_1s_step-end_infinite]',
        className,
      )}
      aria-hidden="true"
    />
  );
}
