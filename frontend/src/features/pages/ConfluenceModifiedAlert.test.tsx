import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfluenceModifiedAlert } from './ConfluenceModifiedAlert';

const BANNED_HUE = /warning|destructive|amber|status-syncing|status-disconnected|text-error|bg-warning/;

describe('ConfluenceModifiedAlert (#1448)', () => {
  it('is a non-destructive status strip: session stays live, no amber/destructive hue', () => {
    render(
      <ConfluenceModifiedAlert remoteVersion={9} localVersion={7} onDismiss={() => {}} />,
    );

    const alert = screen.getByTestId('confluence-modified-alert');
    expect(alert).toHaveAttribute('role', 'status');
    expect(alert.textContent).toMatch(/Confluence/i);
    expect(alert.textContent).toMatch(/still open|not overwritten|not saved/i);
    expect(alert.className).not.toMatch(BANNED_HUE);
    expect(alert.innerHTML).not.toMatch(BANNED_HUE);
    expect(screen.getByText(/Not saved/i)).toBeInTheDocument();
  });

  it('names the remote and local versions and dismisses without a destructive control', () => {
    const onDismiss = vi.fn();
    render(
      <ConfluenceModifiedAlert remoteVersion={12} localVersion={4} onDismiss={onDismiss} />,
    );

    expect(screen.getByTestId('confluence-modified-alert').textContent).toContain('12');
    expect(screen.getByTestId('confluence-modified-alert').textContent).toContain('4');
    const dismiss = screen.getByRole('button', { name: /dismiss/i });
    expect(dismiss.className).not.toMatch(/destructive|warning/);
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('promises no open session when the save was sent and its result is unknown (#2035)', () => {
    render(
      <ConfluenceModifiedAlert remoteVersion={9} localVersion={4} saveOutcomeUnknown onDismiss={() => {}} />,
    );

    const alert = screen.getByTestId('confluence-modified-alert');
    expect(alert).toHaveAttribute('role', 'status');
    expect(alert).toHaveTextContent('Result unknown');
    expect(alert).toHaveTextContent(
      'This page was modified in Confluence (remote version 9, local version 4) while it was being saved. The result of this save is unknown, and editing is paused until that save is resolved.',
    );
    expect(alert.textContent).not.toMatch(/still open|Not saved|overwritten/i);
    expect(alert.className).not.toMatch(BANNED_HUE);
    expect(alert.innerHTML).not.toMatch(BANNED_HUE);
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });
});
