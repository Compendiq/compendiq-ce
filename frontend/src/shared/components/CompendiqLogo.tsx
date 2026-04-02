/**
 * Compendiq logo mark — inline SVG React component.
 *
 * Design: "The Neural Atlas" — seven nodes arranged in a hexagonal
 * constellation that simultaneously reads as a brain (bilateral symmetry)
 * and a star-chart / atlas (connected constellation dots). Two subtle
 * arcs in the background suggest globe meridians.
 *
 * Uses `currentColor` so the mark automatically inherits the theme's
 * primary color via a Tailwind text-* class on the parent (e.g.
 * `text-primary`). Every theme gets a matched logo for free.
 */

interface CompendiqLogoProps {
  /** Display size in px (width = height). */
  size?: number;
  className?: string;
  /** Enable a gentle pulse on the center hub node. */
  animated?: boolean;
}

/*
 * Coordinates (64 × 64 viewBox, 0-indexed):
 *
 *            ●  (32, 8)   Crown
 *           / \
 *    (13,20) ● — ● (51,20)  Frontal pair
 *          |\ /|
 *          | ◉ |  (32, 32)  Core hub (largest)
 *          |/ \|
 *    (13,44) ● — ● (51,44)  Temporal pair
 *           \ /
 *            ●  (32, 56)  Stem
 */

// Node definitions: [x, y, radius, opacity]
const NODES: [number, number, number, number][] = [
  [32,  8, 4.5, 1],     // 0  Crown
  [13, 20, 3.5, 0.85],  // 1  Front-L
  [51, 20, 3.5, 0.85],  // 2  Front-R
  [32, 32, 6,   1],     // 3  Core hub
  [13, 44, 3.5, 0.85],  // 4  Temp-L
  [51, 44, 3.5, 0.85],  // 5  Temp-R
  [32, 56, 4.5, 1],     // 6  Stem
];

// Connections from core (index 3) to every other node
const RADIAL: [number, number][] = [
  [3, 0], [3, 1], [3, 2], [3, 4], [3, 5], [3, 6],
];

// Hexagonal outline path (connects outer nodes in ring order)
const HEX_PATH = 'M32,8 L51,20 L51,44 L32,56 L13,44 L13,20 Z';

// Subtle globe-meridian accent arcs
const ARC_TR = 'M46,2 Q60,16 56,32';
const ARC_BL = 'M18,62 Q4,48 8,32';

export function CompendiqLogo({
  size = 24,
  className,
  animated = false,
}: CompendiqLogoProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      fill="none"
      role="img"
      aria-label="Compendiq"
    >
      {/* CSS animation for the hub glow (respects prefers-reduced-motion) */}
      {animated && (
        <style>{`
          @keyframes am-pulse{0%,100%{opacity:.12}50%{opacity:.22}}
          .am-glow{animation:am-pulse 3s ease-in-out infinite}
          @media(prefers-reduced-motion:reduce){.am-glow{animation:none}}
        `}</style>
      )}

      {/* Globe accent arcs — very subtle */}
      <path d={ARC_TR} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".07" />
      <path d={ARC_BL} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".07" />

      {/* Hexagonal outline (outer ring connecting all 6 peripheral nodes) */}
      <path
        d={HEX_PATH}
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
        opacity=".12"
      />

      {/* Radial connections — core hub to each outer node */}
      {RADIAL.map(([from, to]) => (
        <line
          key={`${from}-${to}`}
          x1={NODES[from][0]}
          y1={NODES[from][1]}
          x2={NODES[to][0]}
          y2={NODES[to][1]}
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity=".25"
        />
      ))}

      {/* Core hub glow (soft halo behind the center node) */}
      <circle
        cx={32}
        cy={32}
        r={12}
        fill="currentColor"
        opacity={animated ? undefined : 0.12}
        className={animated ? 'am-glow' : undefined}
      />

      {/* Nodes — outer ring first, then hub on top */}
      {NODES.map(([x, y, r, opacity], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="currentColor" opacity={opacity} />
      ))}

      {/* Specular highlight on center hub (glassmorphic design language) */}
      <circle cx={32} cy={32} r={2.2} fill="white" opacity={0.65} />
    </svg>
  );
}
