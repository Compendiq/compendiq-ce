import { describe, it, expect } from 'vitest';
import { composerRowClass } from './composer-row';

/**
 * #1154. `composerRowClass` is the whole layout contract between the two attach
 * zones — both call it, and neither can be read on its own to find out what a
 * composer row is supposed to do. The zone suites cover it only indirectly, via
 * what the rendered DOM happens to contain.
 *
 * These assert the *properties the rationale depends on*, not the literal
 * strings: pinning the exact class list would fail on any harmless reordering
 * while still saying nothing about why the classes are what they are.
 */
describe('composerRowClass (#1154)', () => {
  const tokens = (hasAttachment: boolean) => composerRowClass(hasAttachment).split(/\s+/);

  describe('with something to show (card or drop hint)', () => {
    it('grows from a real basis, so the row can claim a line and force the field to wrap', () => {
      // The measured defect this replaced: with no basis the row could not push
      // the prompt onto its own line and the field collapsed to 33px.
      expect(tokens(true)).toContain('grow');
      expect(tokens(true).some((t) => t.startsWith('basis-'))).toBe(true);
    });

    it('is never w-full, which would strand a lone trigger on its own line', () => {
      // A full-width row costs a line whenever the *other* zone has nothing to
      // show — the stranding the `order-*` convention originally existed to
      // prevent. Sizing the row is what lets `[paperclip][image row]` share one.
      expect(tokens(true)).not.toContain('w-full');
    });

    it('allows the card inside it to truncate rather than push the row wider', () => {
      expect(tokens(true)).toContain('min-w-0');
    });
  });

  describe('with nothing to show', () => {
    it('hugs its content instead of claiming a line, so an empty composer stays one line', () => {
      expect(tokens(false)).toContain('shrink-0');
      expect(tokens(false)).not.toContain('grow');
      expect(tokens(false).some((t) => t.startsWith('basis-'))).toBe(false);
    });

    it('sits on the composer\'s last line, level with the send button', () => {
      // The trigger used to carry `self-end` itself; the row owns it now, which
      // is what keeps a bare trigger optically centred against Send.
      expect(tokens(false)).toContain('self-end');
    });
  });

  it('never orders anything — document order is the composer\'s only order', () => {
    // The WCAG 2.4.3 property this whole structure exists for. An `order-*` here
    // would move the boxes without moving the tab sequence, which is the defect
    // that was removed.
    for (const hasAttachment of [true, false]) {
      expect(tokens(hasAttachment).some((t) => /^order-/.test(t))).toBe(false);
    }
  });

  it('gives the two states genuinely different rows', () => {
    // Guards a refactor that collapses the branches: one class list cannot both
    // claim a line and hug its content.
    expect(composerRowClass(true)).not.toBe(composerRowClass(false));
  });
});
