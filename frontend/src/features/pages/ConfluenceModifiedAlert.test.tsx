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
});
