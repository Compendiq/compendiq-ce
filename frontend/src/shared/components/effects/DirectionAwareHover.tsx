import { useRef, useState, useCallback } from 'react';
import { cn } from '../../lib/cn';
import { useCanHover } from '../../hooks/use-can-hover';

type Direction = 'left' | 'right' | 'top' | 'bottom';

interface DirectionAwareHoverProps {
  children: React.ReactNode;
  className?: string;
  /** Color of the bloom highlight (CSS color/gradient) */
  bloomColor?: string;
  'data-testid'?: string;
}

/**
 * Detects which edge the cursor enters from and animates a highlight bloom
 * from that side. Used on article list items for direction-aware hover.
 *
 * - Disabled on touch devices
 * - Respects prefers-reduced-motion (via useCanHover)
 * - GPU-composited (opacity + background only)
 */
export function DirectionAwareHover({
  children,
  className,
  bloomColor = 'oklch(from var(--color-primary) l c h / 0.08)',
  'data-testid': testId,
}: DirectionAwareHoverProps) {
  const canHover = useCanHover();
  const ref = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [isHovering, setIsHovering] = useState(false);

  const detectDirection = useCallback((e: React.MouseEvent): Direction => {
    if (!ref.current) return 'left';
    const rect = ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Normalize to 0..1
    const nx = x / rect.width;
    const ny = y / rect.height;

    // Calculate distance from each edge
    const distLeft = nx;
    const distRight = 1 - nx;
    const distTop = ny;
    const distBottom = 1 - ny;

    const min = Math.min(distLeft, distRight, distTop, distBottom);

    if (min === distLeft) return 'left';
    if (min === distRight) return 'right';
    if (min === distTop) return 'top';
    return 'bottom';
  }, []);

  const handleMouseEnter = useCallback(
    (e: React.MouseEvent) => {
      if (!canHover) return;
      setDirection(detectDirection(e));
      setIsHovering(true);
    },
    [canHover, detectDirection],
  );

  const handleMouseLeave = useCallback(() => {
    setIsHovering(false);
  }, []);

  const bloomGradient = direction
    ? {
        left: `linear-gradient(to right, ${bloomColor}, transparent 60%)`,
        right: `linear-gradient(to left, ${bloomColor}, transparent 60%)`,
        top: `linear-gradient(to bottom, ${bloomColor}, transparent 60%)`,
        bottom: `linear-gradient(to top, ${bloomColor}, transparent 60%)`,
      }[direction]
    : undefined;

  return (
    <div
      ref={ref}
      className={cn('direction-aware-hover', className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      data-testid={testId}
    >
      <div
        className="hover-bloom"
        style={{
          background: bloomGradient,
          opacity: isHovering && canHover ? 1 : 0,
        }}
        aria-hidden
        data-testid={testId ? `${testId}-bloom` : undefined}
      />
      {/* Content sits above the bloom */}
      <div className="relative z-[1]">{children}</div>
    </div>
  );
}
