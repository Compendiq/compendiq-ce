import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { TOOLBAR_ITEM_ATTR, useToolbarRovingFocus } from './use-toolbar-roving-focus';

/**
 * The WAI-ARIA toolbar contract: ONE tab stop, arrows to travel inside it.
 *
 * Worth its own file because the failure it prevents is invisible to every
 * other kind of test. A toolbar with 27 native tab stops renders identically,
 * passes axe, and reads correctly to a screen reader — it is only wrong when
 * someone actually tries to Tab past it, which is the thing a keyboard-first
 * product's users do on every trip out of the document.
 */

function Harness({ withPortalledChild = false }: { withPortalledChild?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const roving = useToolbarRovingFocus(ref);
  return (
    <div ref={ref} role="toolbar" aria-label="Test toolbar" {...roving}>
      <button type="button" {...{ [TOOLBAR_ITEM_ATTR]: '' }}>one</button>
      <button type="button" {...{ [TOOLBAR_ITEM_ATTR]: '' }}>two</button>
      <button type="button" {...{ [TOOLBAR_ITEM_ATTR]: '' }} disabled>three (disabled)</button>
      <button type="button" {...{ [TOOLBAR_ITEM_ATTR]: '' }}>four</button>
      {/* Not opted in — a decorative or non-interactive child must be skipped. */}
      <span>label</span>
      {/* Stands in for a Radix menu's content: a React child of the toolbar
          that lives outside its DOM subtree. */}
      {withPortalledChild && createPortal(<button type="button">menu item</button>, document.body)}
    </div>
  );
}

const item = (name: string) => screen.getByRole('button', { name });

describe('useToolbarRovingFocus', () => {
  it('exposes exactly one tab stop', () => {
    render(<Harness />);
    expect(item('one').tabIndex).toBe(0);
    expect(item('two').tabIndex).toBe(-1);
    expect(item('four').tabIndex).toBe(-1);
  });

  it('moves focus with ArrowRight and ArrowLeft', () => {
    render(<Harness />);
    item('one').focus();

    fireEvent.keyDown(item('one'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item('two'));

    fireEvent.keyDown(item('two'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item('one'));
  });

  it('skips a disabled control rather than stranding focus on it', () => {
    // Undo and Redo spend most of a session disabled. Arrowing onto a control
    // that cannot be activated is a dead keypress, not a destination.
    render(<Harness />);
    item('two').focus();

    fireEvent.keyDown(item('two'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item('four'));
  });

  it('wraps at both ends', () => {
    render(<Harness />);
    item('four').focus();
    fireEvent.keyDown(item('four'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item('one'));

    fireEvent.keyDown(item('one'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item('four'));
  });

  it('jumps to the ends with Home and End', () => {
    render(<Harness />);
    item('two').focus();

    fireEvent.keyDown(item('two'), { key: 'End' });
    expect(document.activeElement).toBe(item('four'));

    fireEvent.keyDown(item('four'), { key: 'Home' });
    expect(document.activeElement).toBe(item('one'));
  });

  it('moves the tab stop to whichever control was last focused', () => {
    // Otherwise Tab always re-enters at the first control, and a user working
    // through Insert has to re-arrow across the whole row on every return.
    render(<Harness />);
    fireEvent.focus(item('four'), { target: item('four') });
    item('four').focus();

    expect(item('four').tabIndex).toBe(0);
    expect(item('one').tabIndex).toBe(-1);
  });

  it('does not claim ArrowDown, which is how a menu trigger opens', () => {
    // Radix opens a menu and focuses its first item on ArrowDown. Treating it
    // as toolbar travel would make every menu in the row keyboard-unreachable.
    render(<Harness />);
    item('one').focus();

    fireEvent.keyDown(item('one'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('one'));
  });

  it('ignores a modified arrow', () => {
    render(<Harness />);
    item('one').focus();

    fireEvent.keyDown(item('one'), { key: 'ArrowRight', ctrlKey: true });
    expect(document.activeElement).toBe(item('one'));

    fireEvent.keyDown(item('one'), { key: 'ArrowRight', shiftKey: true });
    expect(document.activeElement).toBe(item('one'));
  });

  it('ignores an arrow pressed inside portalled menu content', () => {
    // The reason the `contains` guard exists. Radix portals its menu content,
    // which stays a child of the toolbar in the REACT tree even though it
    // leaves the DOM subtree — and React replays events up the React tree. So
    // an ArrowRight pressed inside an open Insert menu really does arrive at
    // this handler. Acting on it would yank focus out of the menu the user is
    // part-way through navigating.
    render(<Harness withPortalledChild />);
    const escapee = item('menu item');
    escapee.focus();

    fireEvent.keyDown(escapee, { key: 'ArrowRight' });

    // Focus stayed in the menu, and the toolbar's own tab stop is untouched.
    expect(document.activeElement).toBe(escapee);
    expect(item('one').tabIndex).toBe(0);
  });
});
