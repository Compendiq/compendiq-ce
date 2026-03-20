import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useClickOutside } from './use-click-outside';

describe('useClickOutside', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls callback when mousedown occurs outside the referenced element', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useClickOutside<HTMLDivElement>(callback));

    // Create and attach a container to simulate ref assignment
    const container = document.createElement('div');
    document.body.appendChild(container);
    // Manually assign ref (renderHook doesn't render DOM for the ref)
    Object.defineProperty(result.current, 'current', {
      value: container,
      writable: true,
    });

    // Click outside the container
    const outsideEl = document.createElement('div');
    document.body.appendChild(outsideEl);
    outsideEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(callback).toHaveBeenCalledTimes(1);

    document.body.removeChild(container);
    document.body.removeChild(outsideEl);
  });

  it('does NOT call callback when mousedown occurs inside the referenced element', () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useClickOutside<HTMLDivElement>(callback));

    const container = document.createElement('div');
    const child = document.createElement('span');
    container.appendChild(child);
    document.body.appendChild(container);

    Object.defineProperty(result.current, 'current', {
      value: container,
      writable: true,
    });

    // Click inside the container (on a child element)
    child.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    expect(callback).not.toHaveBeenCalled();

    document.body.removeChild(container);
  });

  it('calls callback when Escape key is pressed', () => {
    const callback = vi.fn();
    renderHook(() => useClickOutside<HTMLDivElement>(callback));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does NOT call callback for non-Escape keys', () => {
    const callback = vi.fn();
    renderHook(() => useClickOutside<HTMLDivElement>(callback));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));

    expect(callback).not.toHaveBeenCalled();
  });

  it('does NOT call callback when enabled is false', () => {
    const callback = vi.fn();
    renderHook(() => useClickOutside<HTMLDivElement>(callback, false));

    // Neither outside click nor Escape should trigger callback
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(callback).not.toHaveBeenCalled();
  });

  it('cleans up event listeners on unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const callback = vi.fn();
    const { unmount } = renderHook(() => useClickOutside<HTMLDivElement>(callback));

    expect(addSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('mousedown', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('re-enables listeners when enabled changes from false to true', () => {
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useClickOutside<HTMLDivElement>(callback, enabled),
      { initialProps: { enabled: false } },
    );

    // Should not fire while disabled
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(callback).not.toHaveBeenCalled();

    // Re-enable
    rerender({ enabled: true });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
