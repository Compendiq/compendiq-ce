import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  PANEL_COLLAPSE_TRANSITION,
  usePanelCollapseInitial,
} from './use-panel-collapse-motion';

describe('usePanelCollapseInitial', () => {
  it('disables initial animation on first mount in both open and collapsed states', () => {
    const openMount = renderHook(() => usePanelCollapseInitial(false, 282, 40, false));
    expect(openMount.result.current).toEqual({
      collapsedInitial: false,
      expandedInitial: false,
    });

    const collapsedMount = renderHook(() => usePanelCollapseInitial(true, 282, 40, false));
    expect(collapsedMount.result.current).toEqual({
      collapsedInitial: false,
      expandedInitial: false,
    });
  });

  it('animates smoothly between expanded and collapsed widths when toggled while mounted', () => {
    const { result, rerender } = renderHook(
      ({ collapsed, reduce }: { collapsed: boolean; reduce: boolean }) =>
        usePanelCollapseInitial(collapsed, 282, 40, reduce),
      { initialProps: { collapsed: false, reduce: false } },
    );

    rerender({ collapsed: true, reduce: false });
    expect(result.current.collapsedInitial).toEqual({ width: 282, opacity: 1 });

    rerender({ collapsed: false, reduce: false });
    expect(result.current.expandedInitial).toEqual({ width: 40, opacity: 1 });
  });

  it('disables animation when reduced motion is preferred', () => {
    const { result, rerender } = renderHook(
      ({ collapsed }: { collapsed: boolean }) =>
        usePanelCollapseInitial(collapsed, 282, 40, true),
      { initialProps: { collapsed: false } },
    );

    rerender({ collapsed: true });
    expect(result.current).toEqual({
      collapsedInitial: false,
      expandedInitial: false,
    });
  });

  it('uses a deliberate tween slower than the retired 180ms spring', () => {
    expect(PANEL_COLLAPSE_TRANSITION.type).toBe('tween');
    expect(PANEL_COLLAPSE_TRANSITION.duration).toBeGreaterThanOrEqual(0.35);
  });
});
