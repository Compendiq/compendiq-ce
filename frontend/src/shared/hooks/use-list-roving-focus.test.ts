import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createElement, useRef, type ReactElement, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useListRovingFocus } from './use-list-roving-focus';

/**
 * A minimal stand-in for `ConversationList`: a container holding one focusable
 * row per id, plus one control OUTSIDE the container wired to the same handler.
 * That outside control is how the Radix replay case is exercised — portalled
 * menu content is a React child of the row but not a DOM descendant of the
 * list, so React replays its keydowns up to this handler.
 */
function Harness({ ids, activeId }: { ids: readonly string[]; activeId: string | null }): ReactElement {
  const containerRef = useRef<HTMLUListElement>(null);
  const { rovingId, handleRowFocus, handleRowKeyDown } = useListRovingFocus({
    ids,
    activeId,
    containerRef,
    itemAttr: 'data-row-id',
  });

  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'roving' }, rovingId ?? 'none'),
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'outside',
        onKeyDown: (event: ReactKeyboardEvent) => handleRowKeyDown(event, ids[0] ?? ''),
      },
      'outside',
    ),
    createElement(
      'ul',
      { ref: containerRef },
      ids.map((id) =>
        createElement(
          'li',
          { key: id },
          createElement(
            'a',
            {
              href: '#',
              'data-row-id': id,
              'data-testid': `row-${id}`,
              tabIndex: rovingId === id ? 0 : -1,
              onFocus: () => handleRowFocus(id),
              onKeyDown: (event: ReactKeyboardEvent) => handleRowKeyDown(event, id),
            },
            id,
          ),
        ),
      ),
    ),
  );
}

const IDS = ['a', 'b', 'c'];

function renderHarness(props: { ids?: readonly string[]; activeId?: string | null } = {}) {
  const { ids = IDS, activeId = null } = props;
  return render(createElement(Harness, { ids, activeId }));
}

const roving = () => screen.getByTestId('roving').textContent;

describe('useListRovingFocus', () => {
  it('makes the first row the tab stop when nothing is active', () => {
    renderHarness();
    expect(roving()).toBe('a');
  });

  it('makes the active row the tab stop when it is in the list', () => {
    renderHarness({ activeId: 'c' });
    expect(roving()).toBe('c');
  });

  it('falls back to the first row when the active id is not in the list', () => {
    renderHarness({ activeId: 'zzz' });
    expect(roving()).toBe('a');
  });

  it('is undefined for an empty list, so nothing claims a tab stop', () => {
    renderHarness({ ids: [] });
    expect(roving()).toBe('none');
  });

  it('moves the tab stop with ArrowDown and gives the row real DOM focus', () => {
    renderHarness();
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowDown' });
    expect(roving()).toBe('b');
    expect(document.activeElement).toBe(screen.getByTestId('row-b'));
  });

  it('moves the tab stop back with ArrowUp', () => {
    renderHarness({ activeId: 'c' });
    fireEvent.keyDown(screen.getByTestId('row-c'), { key: 'ArrowUp' });
    expect(roving()).toBe('b');
    expect(document.activeElement).toBe(screen.getByTestId('row-b'));
  });

  it('clamps at the end: ArrowDown on the last row does not wrap to the first', () => {
    renderHarness({ activeId: 'c' });
    fireEvent.keyDown(screen.getByTestId('row-c'), { key: 'ArrowDown' });
    expect(roving()).toBe('c');
  });

  it('clamps at the start: ArrowUp on the first row does not wrap to the last', () => {
    renderHarness();
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowUp' });
    expect(roving()).toBe('a');
  });

  it('Home goes to the first row and End to the last', () => {
    renderHarness({ activeId: 'b' });
    fireEvent.keyDown(screen.getByTestId('row-b'), { key: 'End' });
    expect(roving()).toBe('c');
    expect(document.activeElement).toBe(screen.getByTestId('row-c'));

    fireEvent.keyDown(screen.getByTestId('row-c'), { key: 'Home' });
    expect(roving()).toBe('a');
    expect(document.activeElement).toBe(screen.getByTestId('row-a'));
  });

  it('takes the tab stop from a row that receives focus directly', () => {
    renderHarness();
    fireEvent.focus(screen.getByTestId('row-c'));
    expect(roving()).toBe('c');
  });

  it('keeps an explicit choice across a list change while the row is still present', () => {
    const { rerender } = renderHarness();
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowDown' });
    expect(roving()).toBe('b');

    rerender(createElement(Harness, { ids: ['b', 'c'], activeId: null }));
    expect(roving()).toBe('b');
  });

  it('falls back to the active row when the explicit choice leaves the list', () => {
    const { rerender } = renderHarness({ activeId: 'c' });
    fireEvent.keyDown(screen.getByTestId('row-c'), { key: 'Home' });
    expect(roving()).toBe('a');

    rerender(createElement(Harness, { ids: ['b', 'c'], activeId: 'c' }));
    expect(roving()).toBe('c');
  });

  it('falls back to the first row when the explicit choice leaves and nothing is active', () => {
    const { rerender } = renderHarness();
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'End' });
    expect(roving()).toBe('c');

    rerender(createElement(Harness, { ids: ['a', 'b'], activeId: null }));
    expect(roving()).toBe('a');
  });

  it('ignores a keydown whose target is outside the container (Radix replays through the React tree)', () => {
    renderHarness();
    fireEvent.keyDown(screen.getByTestId('outside'), { key: 'ArrowDown' });
    expect(roving()).toBe('a');
  });

  it('ignores a key it does not own, so ArrowRight stays available to the row', () => {
    renderHarness();
    const event = fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowRight', cancelable: true });
    expect(roving()).toBe('a');
    // `fireEvent` returns false when a handler called preventDefault.
    expect(event).toBe(true);
  });
});
