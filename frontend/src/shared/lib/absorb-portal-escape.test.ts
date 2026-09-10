import { describe, it, expect, vi } from 'vitest';
import { absorbPortalEscape } from './absorb-portal-escape';
import { absorbBlockMenuEscape } from '../components/article/use-block-menu-target';

/**
 * The two halves are independently load-bearing and neither is observable from
 * the outside, so they are asserted directly rather than through a rendered
 * layer:
 *
 * - `preventDefault()` is what `use-keyboard-shortcuts` reads (#1206) to yield a
 *   single-key shortcut — it is the reason Escape in a portalled layer does not
 *   run `handleCancelEditing()`.
 * - `stopPropagation()` keeps the key off every OTHER document listener, which
 *   have no reason to consult a flag Radix set.
 */
describe('absorbPortalEscape', () => {
  it('prevents default, stops propagation, and closes exactly once', () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const close = vi.fn();

    absorbPortalEscape({ preventDefault, stopPropagation }, close);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  /**
   * The block menu's historical name is an alias now, not a copy. If it ever
   * drifts back into its own implementation the two can diverge silently, and
   * the failure mode — Escape quietly exiting edit mode — is invisible in jsdom
   * unless something pins them together.
   */
  it('is the same function the block menu imports under its historical name', () => {
    expect(absorbBlockMenuEscape).toBe(absorbPortalEscape);
  });
});
