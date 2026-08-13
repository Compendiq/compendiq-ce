/**
 * Layout helper for the dashboard's pinned-pages section.
 */

/**
 * Entrance delay for the card at `index`, in seconds.
 *
 * Plateaus at 0.35s so the entrance stagger is a smooth flourish without lagging
 * for large pin counts.
 */
export function entranceDelay(index: number): number {
  return Math.min(index, 7) * 0.05;
}

