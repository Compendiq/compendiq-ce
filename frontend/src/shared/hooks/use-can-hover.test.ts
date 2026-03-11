import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCanHover } from './use-can-hover';

let originalMatchMedia: typeof window.matchMedia;

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  onchange: null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

function createMockMediaQueryList(matches: boolean, query: string): MockMediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

describe('useCanHover', () => {
  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it('returns true when hover is supported and no reduced motion', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => {
      if (query === '(hover: hover)') return createMockMediaQueryList(true, query);
      if (query === '(prefers-reduced-motion: reduce)') return createMockMediaQueryList(false, query);
      return createMockMediaQueryList(false, query);
    });

    const { result } = renderHook(() => useCanHover());
    expect(result.current).toBe(true);
  });

  it('returns false on touch devices (no hover)', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => {
      if (query === '(hover: hover)') return createMockMediaQueryList(false, query);
      if (query === '(prefers-reduced-motion: reduce)') return createMockMediaQueryList(false, query);
      return createMockMediaQueryList(false, query);
    });

    const { result } = renderHook(() => useCanHover());
    expect(result.current).toBe(false);
  });

  it('returns false when prefers-reduced-motion is set', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => {
      if (query === '(hover: hover)') return createMockMediaQueryList(true, query);
      if (query === '(prefers-reduced-motion: reduce)') return createMockMediaQueryList(true, query);
      return createMockMediaQueryList(false, query);
    });

    const { result } = renderHook(() => useCanHover());
    expect(result.current).toBe(false);
  });

  it('updates when media query changes', () => {
    const listeners: Array<() => void> = [];

    const hoverMql = createMockMediaQueryList(true, '(hover: hover)');
    hoverMql.addEventListener = vi.fn().mockImplementation((_: string, cb: () => void) => {
      listeners.push(cb);
    });

    const motionMql = createMockMediaQueryList(false, '(prefers-reduced-motion: reduce)');
    motionMql.addEventListener = vi.fn().mockImplementation((_: string, cb: () => void) => {
      listeners.push(cb);
    });

    window.matchMedia = vi.fn().mockImplementation((query: string) => {
      if (query === '(hover: hover)') return hoverMql;
      if (query === '(prefers-reduced-motion: reduce)') return motionMql;
      return createMockMediaQueryList(false, query);
    });

    const { result } = renderHook(() => useCanHover());
    expect(result.current).toBe(true);

    // Simulate hover capability changing (e.g., touch mode)
    hoverMql.matches = false;
    act(() => {
      listeners.forEach((cb) => cb());
    });

    expect(result.current).toBe(false);
  });

  it('cleans up event listeners on unmount', () => {
    const hoverMql = createMockMediaQueryList(true, '(hover: hover)');
    const motionMql = createMockMediaQueryList(false, '(prefers-reduced-motion: reduce)');

    window.matchMedia = vi.fn().mockImplementation((query: string) => {
      if (query === '(hover: hover)') return hoverMql;
      if (query === '(prefers-reduced-motion: reduce)') return motionMql;
      return createMockMediaQueryList(false, query);
    });

    const { unmount } = renderHook(() => useCanHover());
    unmount();

    expect(hoverMql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(motionMql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
