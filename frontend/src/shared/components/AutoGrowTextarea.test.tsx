import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { AutoGrowTextarea } from './AutoGrowTextarea';

function Harness({ initial = '', onEnter }: { initial?: string; onEnter?: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <AutoGrowTextarea
      value={value}
      onValueChange={setValue}
      onEnter={onEnter}
      data-testid="field"
      placeholder="Page title…"
    />
  );
}

describe('AutoGrowTextarea', () => {
  it('is a textarea, not an input — the whole point is that it wraps', () => {
    render(<Harness initial="hello" />);
    expect(screen.getByTestId('field').tagName).toBe('TEXTAREA');
  });

  it('starts at one row and never scrolls', () => {
    render(<Harness initial="hello" />);
    const el = screen.getByTestId('field');
    expect(el).toHaveAttribute('rows', '1');
    expect(el.className).toContain('resize-none');
    expect(el.className).toContain('overflow-hidden');
  });

  // Auto margins are a no-op on an inline box, so without this the title takes
  // the right width inside a measured column and stays left-aligned in it.
  it('is a block box so a measured column can centre it', () => {
    render(<Harness />);
    expect(screen.getByTestId('field').className).toContain('block');
  });

  it('reports edits through onValueChange', () => {
    render(<Harness />);
    const el = screen.getByTestId('field');
    fireEvent.change(el, { target: { value: 'Incident runbook' } });
    expect(el).toHaveValue('Incident runbook');
  });

  it('keeps a long title in full rather than clipping it', () => {
    const long =
      'Incident runbook: Postgres connection saturation during sync bursts';
    render(<Harness initial={long} />);
    // The value is intact and readable — an <input> would render the same value
    // but show only the leading ~58 characters with no ellipsis.
    expect(screen.getByTestId('field')).toHaveValue(long);
  });

  describe('Enter', () => {
    it('is refused, because a newline in a title is silently stripped on save', () => {
      render(<Harness initial="Title" />);
      const el = screen.getByTestId('field');
      const event = createEnter();
      el.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('runs the supplied handler instead of inserting a newline', () => {
      const onEnter = vi.fn();
      render(<Harness initial="Title" onEnter={onEnter} />);
      fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter' });
      expect(onEnter).toHaveBeenCalledOnce();
    });

    it('leaves every other key alone', () => {
      render(<Harness initial="Title" />);
      const el = screen.getByTestId('field');
      for (const key of ['a', 'Backspace', 'ArrowLeft', 'Escape', 'Tab']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        expect(event.defaultPrevented, `${key} must not be swallowed`).toBe(false);
      }
    });
  });

  it('still forwards a caller-supplied onKeyDown', () => {
    const onKeyDown = vi.fn();
    render(
      <AutoGrowTextarea value="x" onValueChange={() => {}} onKeyDown={onKeyDown} data-testid="f" />,
    );
    fireEvent.keyDown(screen.getByTestId('f'), { key: 'a' });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });
});

function createEnter(): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
}
