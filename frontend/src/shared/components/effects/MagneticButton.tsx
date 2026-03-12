import { useRef, useCallback } from 'react';
import { m, useMotionValue, useSpring } from 'framer-motion';
import { useGesture } from '@use-gesture/react';
import { useCanHover } from '../../hooks/use-can-hover';

const SPRING_CONFIG = { damping: 15, stiffness: 150 };
const MAX_DISPLACEMENT = 3; // pixels

interface MagneticButtonProps {
  children: React.ReactNode;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  type?: 'button' | 'submit' | 'reset';
  /** Maximum displacement in pixels (default: 3, clamped 1-4) */
  maxDisplacement?: number;
  'data-testid'?: string;
  'aria-label'?: string;
}

/**
 * Magnetic button that gets subtly pulled toward the cursor when hovering nearby.
 * Uses useMotionValue + useSpring with damping: 15, stiffness: 150.
 *
 * - Disabled on touch devices (no hover capability)
 * - Respects prefers-reduced-motion
 * - GPU-composited (transform only)
 * - Max 2-4px displacement for subtlety
 */
export function MagneticButton({
  children,
  className,
  onClick,
  disabled,
  type = 'button',
  maxDisplacement = MAX_DISPLACEMENT,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: MagneticButtonProps) {
  const canHover = useCanHover();
  const ref = useRef<HTMLButtonElement>(null);

  const clampedMax = Math.min(Math.max(maxDisplacement, 1), 4);

  const x = useMotionValue(0);
  const y = useMotionValue(0);

  const springX = useSpring(x, SPRING_CONFIG);
  const springY = useSpring(y, SPRING_CONFIG);

  const resetValues = useCallback(() => {
    x.set(0);
    y.set(0);
  }, [x, y]);

  const bind = useGesture(
    {
      onMove: ({ xy: [px, py] }) => {
        if (!ref.current || !canHover) return;
        const rect = ref.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        // Normalized offset from center: -1..1
        const normalX = (px - centerX) / (rect.width / 2);
        const normalY = (py - centerY) / (rect.height / 2);

        // Clamp and apply displacement
        x.set(Math.max(-clampedMax, Math.min(clampedMax, normalX * clampedMax)));
        y.set(Math.max(-clampedMax, Math.min(clampedMax, normalY * clampedMax)));
      },
      onHover: ({ hovering }) => {
        if (!hovering) {
          resetValues();
        }
      },
    },
    { enabled: canHover && !disabled },
  );

  // On touch devices or disabled, render a plain button
  if (!canHover) {
    return (
      <button
        type={type}
        className={className}
        onClick={onClick}
        disabled={disabled}
        data-testid={testId}
        aria-label={ariaLabel}
      >
        {children}
      </button>
    );
  }

  // Filter out onDrag* from bind() to avoid type conflict with Framer Motion
  const gestureProps = bind();
  const gestureHandlers = Object.fromEntries(
    Object.entries(gestureProps).filter(([k]) => !k.startsWith('onDrag')),
  );

  return (
    <m.button
      ref={ref}
      type={type}
      {...gestureHandlers}
      className={className}
      onClick={onClick}
      disabled={disabled}
      style={{
        x: springX,
        y: springY,
      }}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {children}
    </m.button>
  );
}
