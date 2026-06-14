import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

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

// Mock localStorage for jsdom (Vitest 4 may not initialise it correctly when
// --localstorage-file is provided without a path; zustand persist middleware
// requires a functional setItem/getItem implementation).
if (typeof window !== 'undefined' && typeof window.localStorage?.setItem !== 'function') {
  const store: Record<string, string> = {};
  Object.defineProperty(window, 'localStorage', {
    writable: true,
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
      get length() { return Object.keys(store).length; },
      key: (index: number) => Object.keys(store)[index] ?? null,
    },
  });
}

// Stub `getClientRects` for jsdom. ProseMirror's `scrollToSelection`
// (which fires after every paste/transaction) calls this on the current
// selection's DOM node and crashes the test run with a `TypeError:
// target.getClientRects is not a function` otherwise. The crash propagates
// as a Vitest "Unhandled Error" which makes CI's `vitest run` exit 1 even
// when every test assertion passed. An empty DOMRectList-shaped value is
// enough — ProseMirror only iterates it.
function emptyDOMRectList(): DOMRectList {
  const list: { length: number; item: (i: number) => DOMRect | null; [Symbol.iterator]: () => Iterator<DOMRect> } = {
    length: 0,
    item: () => null,
    [Symbol.iterator]: () => ({ next: () => ({ done: true, value: undefined as unknown as DOMRect }) }),
  };
  return list as unknown as DOMRectList;
}
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => emptyDOMRectList();
}
if (typeof Range !== 'undefined' && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) }) as DOMRect;
}

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

// Radix focus-scope schedules a setTimeout(…, 0) in its unmount cleanup that
// dispatches an event on its container (@radix-ui/react-focus-scope
// dist/index.mjs:89). If that macrotask fires after jsdom has torn the document
// down, dispatchEvent gets an invalid target and vitest reports an uncaught
// TypeError — intermittently reddening a green run (#799). The leak is cross-file.
// Unmount explicitly, then flush one real macrotask so the focus-scope timer
// fires while the document is still attached, instead of leaking into teardown.
// Skip the flush when a test left fake timers active: a faked setTimeout would
// never resolve (hanging the run), and a faked focus-scope timer can't leak into
// real teardown anyway.
afterEach(async () => {
  cleanup();
  if (vi.isFakeTimers()) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
});
