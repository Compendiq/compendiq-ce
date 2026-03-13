import { useRef, useCallback } from 'react';
import { m, useMotionValue, useMotionTemplate, useSpring } from 'framer-motion';
import { useGesture } from '@use-gesture/react';
import { cn } from '../../lib/cn';
import { useCanHover } from '../../hooks/use-can-hover';

const SPRING_CONFIG = { stiffness: 300, damping: 25 };
const MAX_TILT_DEG = 12;

interface TiltCardProps {
  children: React.ReactNode;
  className?: string;
  /** Maximum tilt angle in degrees (default: 12, clamped 0-15) */
  maxTilt?: number;
  /** Whether to show dynamic shadow shift (default: true) */
  dynamicShadow?: boolean;
  /** data-testid for testing */
  'data-testid'?: string;
}

/**
 * 3D tilt card that responds to cursor position with subtle perspective tilt
 * and dynamic shadow shift. Resets on mouse leave with spring animation.
 *
 * - Disabled on touch devices (no hover capability)
 * - Respects prefers-reduced-motion (via Framer Motion defaults)
 * - GPU-composited (transform + will-change)
 */
export function TiltCard({
  children,
  className,
  maxTilt = MAX_TILT_DEG,
  dynamicShadow = true,
  'data-testid': testId,
}: TiltCardProps) {
  const canHover = useCanHover();
  const ref = useRef<HTMLDivElement>(null);

  const clampedMaxTilt = Math.min(Math.max(maxTilt, 0), 15);

  const rotateX = useMotionValue(0);
  const rotateY = useMotionValue(0);
  const shadowX = useMotionValue(0);
  const shadowY = useMotionValue(0);

  const springRotateX = useSpring(rotateX, SPRING_CONFIG);
  const springRotateY = useSpring(rotateY, SPRING_CONFIG);
  const springShadowX = useSpring(shadowX, SPRING_CONFIG);
  const springShadowY = useSpring(shadowY, SPRING_CONFIG);

  const dropShadowFilter = useMotionTemplate`drop-shadow(${springShadowX}px ${springShadowY}px 16px var(--glass-shadow))`;

  const resetValues = useCallback(() => {
    rotateX.set(0);
    rotateY.set(0);
    shadowX.set(0);
    shadowY.set(0);
  }, [rotateX, rotateY, shadowX, shadowY]);

  const bind = useGesture(
    {
      onMove: ({ xy: [px, py] }) => {
        if (!ref.current || !canHover) return;
        const rect = ref.current.getBoundingClientRect();
        // Normalize cursor position to -1..1 range
        const normalX = ((px - rect.left) / rect.width) * 2 - 1;
        const normalY = ((py - rect.top) / rect.height) * 2 - 1;

        // rotateX is controlled by Y position (tilting around X-axis)
        // rotateY is controlled by X position (tilting around Y-axis)
        rotateX.set(-normalY * clampedMaxTilt);
        rotateY.set(normalX * clampedMaxTilt);

        if (dynamicShadow) {
          shadowX.set(-normalX * 8);
          shadowY.set(-normalY * 8);
        }
      },
      onHover: ({ hovering }) => {
        if (!hovering) {
          resetValues();
        }
      },
    },
    { enabled: canHover },
  );

  // On touch devices, render without tilt
  if (!canHover) {
    return (
      <div className={className} data-testid={testId}>
        {children}
      </div>
    );
  }

  // Filter out onDrag* from bind() to avoid type conflict with Framer Motion
  const gestureProps = bind();
  const gestureHandlers = Object.fromEntries(
    Object.entries(gestureProps).filter(([k]) => !k.startsWith('onDrag')),
  );

  return (
    <m.div
      ref={ref}
      {...gestureHandlers}
      className={cn('will-change-transform', className)}
      style={{
        perspective: 800,
        rotateX: springRotateX,
        rotateY: springRotateY,
        transformStyle: 'preserve-3d',
        ...(dynamicShadow
          ? {
              filter: dropShadowFilter,
            }
          : {}),
      }}
      data-testid={testId}
    >
      {children}
    </m.div>
  );
}
