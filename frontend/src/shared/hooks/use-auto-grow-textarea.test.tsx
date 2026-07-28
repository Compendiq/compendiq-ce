import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useAutoGrowTextarea, AUTO_GROW_MAX_HEIGHT } from './use-auto-grow-textarea';

// jsdom has no layout engine, so every element reports scrollHeight 0. Stand in
// for it on the prototype so the measured paths can be exercised; leaving it at
// 0 is itself the "no layout" case the hook has to survive.
let scrollHeightPx = 0;

beforeEach(() => {
  scrollHeightPx = 0;
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeightPx,
  });
});

afterEach(() => {
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
});

function Harness({ value, maxHeight }: { value: string; maxHeight?: number }) {
  const ref = useAutoGrowTextarea(value, maxHeight);
  return <textarea ref={ref} rows={1} value={value} readOnly data-testid="ta" />;
}

function getTextarea() {
  return screen.getByTestId('ta') as HTMLTextAreaElement;
}

describe('useAutoGrowTextarea', () => {
  it('leaves height to the rows attribute when the environment reports no layout', () => {
    // scrollHeightPx stays 0 — pinning height to "0px" here would collapse the
    // field to an invisible sliver in jsdom and in any layout-less renderer.
    render(<Harness value="hello" />);
    expect(getTextarea().style.height).toBe('');
  });

  it('grows to fit content that is shorter than the cap', () => {
    scrollHeightPx = 72;
    render(<Harness value="two lines of prompt" />);

    const el = getTextarea();
    expect(el.style.height).toBe('72px');
    // No scrollbar while the content still fits.
    expect(el.style.overflowY).toBe('hidden');
  });

  it('caps at the max height and scrolls internally beyond it', () => {
    scrollHeightPx = 400;
    render(<Harness value="a very long prompt" />);

    const el = getTextarea();
    expect(el.style.height).toBe(`${AUTO_GROW_MAX_HEIGHT}px`);
    expect(el.style.overflowY).toBe('auto');
  });

  it('honours a caller-supplied max height', () => {
    scrollHeightPx = 400;
    render(<Harness value="a very long prompt" maxHeight={64} />);
    expect(getTextarea().style.height).toBe('64px');
  });

  it('shrinks back down when the value gets shorter', () => {
    scrollHeightPx = 140;
    const { rerender } = render(<Harness value="several lines of prompt" />);
    expect(getTextarea().style.height).toBe('140px');

    // Submitting clears the composer: it has to return to a single row.
    scrollHeightPx = 32;
    rerender(<Harness value="" />);
    expect(getTextarea().style.height).toBe('32px');
  });

  it('re-measures on viewport resize, since a narrower field rewraps the text', () => {
    scrollHeightPx = 32;
    render(<Harness value="a prompt that wraps once the composer narrows" />);
    expect(getTextarea().style.height).toBe('32px');

    scrollHeightPx = 92;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(getTextarea().style.height).toBe('92px');
  });
});
