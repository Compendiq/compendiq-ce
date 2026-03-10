import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useClickRipple } from './use-click-ripple';

let originalMatchMedia: typeof window.matchMedia;

function mockMatchMedia(hover: boolean, reducedMotion: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    let matches = false;
    if (query === '(hover: hover)') matches = hover;
    if (query === '(prefers-reduced-motion: reduce)') matches = reducedMotion;
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
  });
}

describe('useClickRipple', () => {
  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it('returns a function', () => {
    mockMatchMedia(true, false);
    const { result } = renderHook(() => useClickRipple());
    expect(typeof result.current).toBe('function');
  });

  it('creates a ripple element on click for hover-capable devices', () => {
    mockMatchMedia(true, false);
    const { result } = renderHook(() => useClickRipple());

    const container = document.createElement('button');
    container.className = 'ripple-container';
    document.body.appendChild(container);

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 10, top: 20, right: 110, bottom: 70,
      width: 100, height: 50, x: 10, y: 20,
      toJSON: () => ({}),
    });

    const mockEvent = {
      clientX: 60,
      clientY: 45,
      currentTarget: container,
    } as unknown as React.MouseEvent<HTMLElement>;

    result.current(mockEvent);

    const ripple = container.querySelector('.ripple-effect');
    expect(ripple).not.toBeNull();
    expect(ripple?.tagName).toBe('SPAN');
    // Position should be relative to container: 60 - 10 = 50, 45 - 20 = 25
    expect((ripple as HTMLElement).style.left).toBe('50px');
    expect((ripple as HTMLElement).style.top).toBe('25px');

    document.body.removeChild(container);
  });

  it('does not create ripple on touch devices', () => {
    mockMatchMedia(false, false);
    const { result } = renderHook(() => useClickRipple());

    const container = document.createElement('button');
    container.className = 'ripple-container';
    document.body.appendChild(container);

    const mockEvent = {
      clientX: 60,
      clientY: 45,
      currentTarget: container,
    } as unknown as React.MouseEvent<HTMLElement>;

    result.current(mockEvent);

    const ripple = container.querySelector('.ripple-effect');
    expect(ripple).toBeNull();

    document.body.removeChild(container);
  });

  it('does not create ripple with prefers-reduced-motion', () => {
    mockMatchMedia(true, true);
    const { result } = renderHook(() => useClickRipple());

    const container = document.createElement('button');
    container.className = 'ripple-container';
    document.body.appendChild(container);

    const mockEvent = {
      clientX: 60,
      clientY: 45,
      currentTarget: container,
    } as unknown as React.MouseEvent<HTMLElement>;

    result.current(mockEvent);

    const ripple = container.querySelector('.ripple-effect');
    expect(ripple).toBeNull();

    document.body.removeChild(container);
  });

  it('removes ripple element after animation ends', () => {
    mockMatchMedia(true, false);
    const { result } = renderHook(() => useClickRipple());

    const container = document.createElement('button');
    container.className = 'ripple-container';
    document.body.appendChild(container);

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 100, bottom: 50,
      width: 100, height: 50, x: 0, y: 0,
      toJSON: () => ({}),
    });

    const mockEvent = {
      clientX: 50,
      clientY: 25,
      currentTarget: container,
    } as unknown as React.MouseEvent<HTMLElement>;

    result.current(mockEvent);

    const ripple = container.querySelector('.ripple-effect');
    expect(ripple).not.toBeNull();

    // Simulate animationend
    ripple?.dispatchEvent(new Event('animationend'));
    expect(container.querySelector('.ripple-effect')).toBeNull();

    document.body.removeChild(container);
  });
});
