/**
 * Escape containment for a portalled Radix layer opened over the article editor.
 *
 * `use-keyboard-shortcuts` binds bare Escape to `handleCancelEditing()`. A layer
 * that leaves the keystroke unmarked therefore dismisses itself AND throws the
 * user out of edit mode into a "Discard changes?" prompt — the class of bug
 * #1179 hit with the block menu and #1206 fixed the shared half of.
 *
 * Wire it to Radix's `onEscapeKeyDown`, never `onKeyDown`: the latter is bypassed
 * when the layer unmounts in Radix's capture pass (React rebuilds its dispatch
 * path from the fiber tree, and there is no fiber left), and again when the key
 * is dispatched from outside the layer. `block-menu-escape.test.tsx` runs the
 * full grid of both wirings; `onKeyDown`'s handler never runs in three of its
 * four cells, so it is not a containment mechanism even where the grid is green.
 *
 * Both halves are needed, for different reasons:
 *
 * - `preventDefault()` so Radix skips its own dismissal — we close here instead,
 *   so `close` runs once rather than twice. Since #1206 it is also the signal
 *   `use-keyboard-shortcuts` reads: that hook yields any single-key shortcut
 *   whose keystroke is already `defaultPrevented`, which is what keeps
 *   `PageViewPage`'s Escape from running `handleCancelEditing()`.
 * - `stopPropagation()` on the native event, so the key reaches no document
 *   listener whatsoever. `use-keyboard-shortcuts` is not the only thing bound to
 *   `document`, and the others have no reason to consult a flag Radix set. This
 *   is the half that does not depend on the listener being well behaved.
 *
 * Two callers: the editor block menu (via its historical
 * `absorbBlockMenuEscape` alias) and `TagPopover`.
 */
export function absorbPortalEscape(
  event: { preventDefault: () => void; stopPropagation: () => void },
  close: () => void,
): void {
  event.preventDefault();
  event.stopPropagation();
  close();
}
