import { useCallback, useEffect, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Enter is blocked by default — these are single-logical-line fields (a page
   * title) that only wrap for display. Pass a handler to do something with the
   * keystroke instead of dropping it.
   */
  onEnter?: () => void;
};

/**
 * A textarea that grows to fit its content and never scrolls.
 *
 * Exists because a page title is one logical line but not one *visual* line. An
 * `<input>` clips: on `/pages/:id` a 66-character title showed ~58 characters
 * on desktop and 22 on mobile, cut mid-word with no ellipsis, while read mode
 * wrapped the same string across two lines. That is the one field where you
 * cannot verify what you typed, on a page that syncs back to Confluence — an
 * author renaming a page was editing blind. Narrowing the column to the reading
 * measure made it worse, not better.
 *
 * Reset to `auto` before measuring so the height can shrink as well as grow.
 * Value changes are measured before paint; width changes are observed on the
 * field itself because adjacent panels can resize it without a viewport resize.
 * Ignore height-only observer notifications to avoid a resize feedback loop.
 */
export function AutoGrowTextarea({
  value,
  onValueChange,
  onEnter,
  className,
  onKeyDown,
  ...rest
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useLayoutEffect(resize, [value, resize]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = el.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resize]);

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={1}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          // A newline in a title is never wanted and would be silently stripped
          // on save, so refuse it here where the user can see nothing happened.
          event.preventDefault();
          onEnter?.();
        }
        onKeyDown?.(event);
      }}
      className={cn(
        // `block` so a measured column's `margin-inline: auto` can centre it,
        // and `resize-none overflow-hidden` because the height is ours to own.
        'block w-full resize-none overflow-hidden bg-transparent outline-none',
        className,
      )}
    />
  );
}
