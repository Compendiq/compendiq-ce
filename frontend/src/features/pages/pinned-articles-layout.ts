/**
 * Layout policy for the dashboard's pinned-pages strip (#1130).
 *
 * Lives beside the component rather than inside it so both values stay
 * directly testable — a component module may only export components without
 * breaking fast refresh.
 */

/**
 * How many pins the section shows before it asks to be expanded.
 * Four is one row at the widest breakpoint.
 */
export const COLLAPSED_PIN_COUNT = 4;

/**
 * Maximum pins shown when expanded (bounded to 2 rows at the widest breakpoint).
 * Prevents ungoverned vertical growth from displacing the search bar.
 */
export const MAX_EXPANDED_PIN_COUNT = 8;

/**
 * Entrance delay for the card at `index`, in seconds.
 *
 * Plateaus, because the stagger is a flourish on the first screenful, not a
 * queue: at a flat 0.05s per card the hundredth pin would arrive five seconds
 * after the user pressed "Show all", which reads as a hang rather than a
 * transition.
 */
export function entranceDelay(index: number): number {
  return Math.min(index, COLLAPSED_PIN_COUNT - 1) * 0.05;
}

/**
 * Position to stagger a card from, given its absolute index and whether the
 * section is expanded.
 *
 * Expanding only mounts the cards past the cut-off — the first
 * `COLLAPSED_PIN_COUNT` keep their keys and never re-animate. Feeding those new
 * cards their absolute index would put every one of them at the plateau, so
 * they would all appear together after a 350ms dead beat instead of arriving in
 * sequence. Counting from the cut-off restores the stagger for exactly the
 * cards that are actually new.
 */
export function staggerPosition(index: number, expanded: boolean): number {
  return expanded && index >= COLLAPSED_PIN_COUNT ? index - COLLAPSED_PIN_COUNT : index;
}
