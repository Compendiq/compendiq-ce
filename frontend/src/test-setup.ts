import '@testing-library/jest-dom';

// Mock IntersectionObserver for jsdom (used by TableOfContents scroll-spy)
class MockIntersectionObserver {
  readonly root: Element | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

// Mock ResizeObserver for jsdom (used by @dnd-kit/dom and @tanstack/react-virtual)
// Fires callback asynchronously on observe so virtualizers can compute visible items
// without causing infinite recursion (observe -> callback -> measure -> observe).
class MockResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    // Use queueMicrotask to fire after the current synchronous stack unwinds,
    // preventing the infinite loop that occurs when _measureElement triggers
    // observe which immediately calls the callback.
    queueMicrotask(() => {
      const rect = target.getBoundingClientRect();
      this.callback(
        [
          {
            target,
            contentRect: rect,
            borderBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
            contentBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
            devicePixelContentBoxSize: [{ blockSize: rect.height, inlineSize: rect.width }],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    });
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock matchMedia for jsdom (used by useCanHover, prefers-reduced-motion checks, and media query listeners)
// Default: hover-capable device, no reduced motion
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query === '(hover: hover)',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
