/**
 * #1154: the one flex item an attach zone contributes to a composer.
 *
 * **Why this exists (WCAG 2.4.3, focus order).** Until now each zone emitted its
 * card and its trigger as two sibling flex items and used `order-*` to put the
 * cards above the triggers. `order` moves boxes and does *not* move the tab
 * sequence, so on a composer holding both zones the eye read
 * `[doc card][image card]` then the two triggers while Tab ran
 * doc-remove → doc-trigger → image-remove → image-trigger, crossing rows twice.
 *
 * The fix is structural rather than a class: each zone wraps its card **and** its
 * own trigger in one row, so document order is reading order and Tab follows the
 * eye with nothing left to reorder. The `order-*` convention is therefore gone
 * from the zones and from all three hosts — reintroducing one anywhere in a
 * composer would desync the two orders again, which is why
 * `expectComposerFocusOrder` fails on any `order-*` under the box.
 *
 * **Why `grow basis-64` and not `w-full`.** A row that is always full width
 * costs a line whenever it holds only a trigger: an empty composer would grow
 * from one line to three, and "image attached, no document" would strand the
 * lone paperclip on a line of its own above the image row — the same stranding
 * the `order-*` convention was originally written to prevent, merely relocated.
 * Sized instead, a bare trigger sits beside a card row (`[📎][🖼 shot.png 🖼]`)
 * while two card rows, each wanting ≥16rem, take a line each on the ~420px dock.
 *
 * This axis is cosmetic and, importantly, cannot affect the fix: flex-basis
 * changes where lines break, never document order, so focus order is correct
 * whichever way a row happens to wrap. Two card rows sitting side by side on a
 * wide `/ai` composer is a different look, not a different defect — left-to-right
 * reading order is still document order.
 *
 * **The host's field must keep a real flex-basis, or this row collapses it.**
 * Each composer's textarea is `min-w-0 grow basis-40`, deliberately not the
 * `flex-1` it used to be. `flex-1` is `flex: 1 1 0%`, and with `min-w-0` removing
 * the automatic minimum, the field's hypothetical main size is only its padding —
 * so it contributes ~16px to line collection, and a `basis-64` row stops forcing
 * the wrap that a `w-full` row used to force. Measured in a browser at a 372px
 * dock, that left a **33px** prompt: too narrow to read what you are typing.
 * Revert any of the three fields to `flex-1` and the collapse comes back.
 * (`AskMode`'s composers keep `flex-1` correctly — they hold no zone and do not
 * wrap.)
 *
 * Measured with the real classes across 320–640px, the dock being clamped to
 * [340, 640] by `ui-store`: empty stays one line at every width, and the field is
 * 200–340px in every attached state. Known limitation at 320px — below the dock's
 * own floor, so the mobile sheet only — an image with no document strands the
 * paperclip on its own line. Chasing that would mean shrinking the row basis on
 * every surface to serve a width the dock cannot be set to.
 *
 * @param hasAttachment whether the zone is showing a card or a drop hint. With
 *                      nothing to show the row is just the trigger, and hugs the
 *                      composer's last line beside the send button as before.
 */
export function composerRowClass(hasAttachment: boolean): string {
  return hasAttachment
    // min-w-0 so the card's own truncation wins over its intrinsic width.
    ? 'flex min-w-0 grow basis-64 items-center gap-2'
    : 'flex shrink-0 items-center self-end';
}
