import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Tallest a prompt composer grows before it starts scrolling internally, in px.
 * 160px is ~7 lines at the composer's 14px/20px type, which is a generous
 * prompt without the composer eating the conversation it sits under.
 */
export const AUTO_GROW_MAX_HEIGHT = 160;

/**
 * Grow a textarea to fit its content up to `maxHeight`, then let it scroll.
 *
 * Returns the ref to attach to the textarea. Re-measures whenever `value`
 * changes and on viewport resize, since a narrower composer rewraps the text
 * into a different number of lines.
 *
 * Degrades safely without layout: jsdom reports `scrollHeight` as 0, so the
 * measured path is skipped and the element's `rows` attribute stays in charge
 * rather than the field collapsing to 0px.
 */
export function useAutoGrowTextarea(value: string, maxHeight = AUTO_GROW_MAX_HEIGHT) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    // Collapse before measuring — scrollHeight can never report less than the
    // height already set, so without this the field would only ever grow.
    el.style.height = 'auto';
    const contentHeight = el.scrollHeight;

    if (contentHeight <= 0) {
      el.style.height = '';
      return;
    }

    el.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [maxHeight]);

  // Layout effect so the height is correct in the same frame the text changes;
  // a passive effect would paint one frame at the stale height.
  useLayoutEffect(resize, [value, resize]);

  useEffect(() => {
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [resize]);

  return ref;
}
