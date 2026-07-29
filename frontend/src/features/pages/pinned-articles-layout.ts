/**
 * Layout policy for the dashboard's pinned-pages strip (#1130).
 *
 * Lives beside the component rather than inside it so both values stay
 * directly testable — a component module may only export components without
 * breaking fast refresh.
 */

/**
 * How many pins the section shows before it asks to be expanded.
 *
 * There is no cap on pinning any more — the server accepts as many as the user
 * wants. But this section sits above the filter bar and the page list on the
 * dashboard, so an ungoverned grid at 30+ pins pushes the actual work below the
 * fold. Eight is two rows at the widest breakpoint, and it leaves every user who
 * was under the old cap with exactly the dashboard they had yesterday.
 *
 * Deliberately a constant rather than a per-breakpoint count: a responsive count
 * would need a JS width query, and the only one in this app is
 * `useIsDockWideLayout()` — every other responsive decision stays a Tailwind
 * class. It would also make the toggle's "N more" label wrong at some widths.
 */
export const COLLAPSED_PIN_COUNT = 8;

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
