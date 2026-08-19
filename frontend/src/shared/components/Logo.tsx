interface LogoProps {
  className?: string;
  title?: string;
}

/**
 * Compendiq wordmark + Q-glyph + magnifier.
 *
 * Two color regions:
 * - Wordmark "Compendiq" text + Q outline → `currentColor` (inherits from
 *   the host's text color so it stays readable in BOTH themes).
 * - The two magnifier strokes → hard-coded teal #4dd0e1. This is the brand
 *   accent and must not invert with theme. (Teal here, not the AI violet:
 *   the mark identifies the product, it does not label an AI affordance.)
 *
 * Retinted twice now, and both times it lagged the palette by a release:
 * honey (tile #1a1a1a, glyph #fff8e9, strokes #f9c74f) → steel (#151b2c /
 * #e8ecf5 / #6ea8ff) → the current Graphite values. The mark is the most
 * visible thing on the surface and the easiest to forget, because it is the
 * one part of the UI that a token sweep cannot reach.
 *
 * The values stay literal rather than `var(--color-*)` because the same
 * geometry is mirrored in public/compendiq-lockup-horizontal.svg and the
 * favicons, which render with no CSS custom properties available. That is
 * also why `logo-color-parity.test.ts` exists: it reads the literals back out
 * of all five files and fails if they drift apart or off the palette.
 *
 * Geometry copied verbatim from public/compendiq-lockup-horizontal.svg. That
 * file has no runtime consumer — favicon.svg, logo.svg and logo-maskable.svg
 * each carry their own copy of the icon block, and og:image points at
 * favicon-512.png — but it is the only place the *wordmark* geometry exists
 * outside this component, so it stays on disk as the design source of truth.
 * Retint it whenever these literals change.
 */
export function Logo({ className, title = 'Compendiq' }: LogoProps) {
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox="0 0 4000 1000"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={{ fillRule: 'evenodd', clipRule: 'evenodd', strokeLinecap: 'round' }}
    >
      <title>{title}</title>
      <path
        d="M1000,115l0,770c0,63.47 -51.53,115 -115,115l-770,0c-63.47,0 -115,-51.53 -115,-115l0,-770c0,-63.47 51.53,-115 115,-115l770,0c63.47,0 115,51.53 115,115Z"
        fill="#161717"
      />
      <path
        d="M500,95c222.176,-0 405,182.824 405,405c0,222.176 -182.824,405 -405,405c-222.176,0 -405,-182.824 -405,-405c-0,-222.176 182.824,-405 405,-405Zm285.424,301.118c-43.57,-119.717 -158.035,-199.868 -285.434,-199.868c-166.632,0 -303.75,137.118 -303.75,303.75c0,166.632 137.118,303.75 303.75,303.75c127.399,0 241.863,-80.151 285.434,-199.868l-95.074,-48.532c-24.669,86.814 -104.537,147.15 -194.789,147.15c-111.088,0 -202.5,-91.412 -202.5,-202.5c0,-111.088 91.412,-202.5 202.5,-202.5c90.251,0 170.12,60.336 194.789,147.15l95.074,-48.532Z"
        fill="#e4e6e7"
      />
      <path d="M618.125,618.125l165.375,165.375" fill="none" stroke="#4dd0e1" strokeWidth="67.5" />
      <text
        x="1064.82"
        y="692.255"
        fill="currentColor"
        style={{ fontFamily: 'Helvetica', fontSize: '537.02px' }}
      >
        C
        <tspan
          x="1444.583 1735.193 2174.48 2465.089 2755.699 3046.309 3336.919"
          y="692.255 692.255 692.255 692.255 692.255 692.255 692.255"
        >
          ompendi
        </tspan>
      </text>
      <g>
        <path d="M3761.869,554.017l0,138.238" fill="none" stroke="currentColor" strokeWidth="40.28" strokeLinecap="butt" />
        <path d="M3627.682,692.207l138.238,0.057" fill="none" stroke="currentColor" strokeWidth="40.28" strokeLinecap="butt" />
        <circle cx="3623.631" cy="554.017" r="138.238" fill="none" stroke="currentColor" strokeWidth="40.28" strokeLinecap="butt" />
        <path d="M3723.288,649.755l101.86,101.86" fill="none" stroke="#4dd0e1" strokeWidth="40.28" strokeLinejoin="bevel" />
      </g>
    </svg>
  );
}
