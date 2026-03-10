import { useUiStore } from '../../stores/ui-store';

/**
 * Animated SVG noise grain overlay using feTurbulence. Provides a subtle
 * film-grain texture over the entire viewport.
 *
 * - opacity: 0.15 so it tints without obscuring content
 * - pointer-events: none so it never intercepts clicks
 * - Hidden entirely when "Reduce Effects" is active
 */
export function NoiseOverlay() {
  const reduceEffects = useUiStore((s) => s.reduceEffects);

  if (reduceEffects) {
    return null;
  }

  return (
    <div
      data-testid="noise-overlay"
      className="pointer-events-none fixed inset-0 z-10 opacity-15"
      aria-hidden="true"
    >
      <svg
        className="h-full w-full"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="none"
      >
        <filter id="noise-filter">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.65"
            numOctaves="4"
            stitchTiles="stitch"
          >
            <animate
              attributeName="baseFrequency"
              dur="30s"
              values="0.65;0.68;0.65"
              repeatCount="indefinite"
            />
          </feTurbulence>
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#noise-filter)" />
      </svg>
    </div>
  );
}
