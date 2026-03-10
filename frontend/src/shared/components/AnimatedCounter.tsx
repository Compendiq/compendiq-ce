import { useEffect, useRef } from 'react';
import { useMotionValue, useSpring, useReducedMotion } from 'framer-motion';

interface AnimatedCounterProps {
  /** The target value to count up to */
  value: number;
  /** Optional suffix (e.g. '%') */
  suffix?: string;
  /** Spring stiffness (default: 80) */
  stiffness?: number;
  /** Spring damping (default: 20) */
  damping?: number;
  className?: string;
}

/**
 * KPI card value that counts up from 0 to the final value
 * using Framer Motion spring physics.
 * Respects prefers-reduced-motion (shows final value immediately).
 */
export function AnimatedCounter({
  value,
  suffix = '',
  stiffness = 80,
  damping = 20,
  className,
}: AnimatedCounterProps) {
  const shouldReduceMotion = useReducedMotion();
  const motionValue = useMotionValue(shouldReduceMotion ? value : 0);
  const springValue = useSpring(motionValue, { stiffness, damping });
  const ref = useRef<HTMLSpanElement>(null);

  // Update the motion value when target changes
  useEffect(() => {
    motionValue.set(value);
  }, [value, motionValue]);

  // Subscribe to spring changes and update DOM directly (no re-renders)
  useEffect(() => {
    const unsubscribe = springValue.on('change', (latest) => {
      if (ref.current) {
        ref.current.textContent = `${Math.round(latest)}${suffix}`;
      }
    });
    return unsubscribe;
  }, [springValue, suffix]);

  return (
    <span
      ref={ref}
      className={className}
      data-testid="animated-counter"
    >
      {shouldReduceMotion ? `${value}${suffix}` : `0${suffix}`}
    </span>
  );
}
