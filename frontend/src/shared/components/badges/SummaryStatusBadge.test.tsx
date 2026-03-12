import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SummaryStatusBadge } from './SummaryStatusBadge';

describe('SummaryStatusBadge', () => {
  it('renders nothing when status is undefined', () => {
    const { container } = render(<SummaryStatusBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('renders summarized state with green dot', () => {
    render(<SummaryStatusBadge status="summarized" />);
    const badge = screen.getByTestId('summary-status-badge');
    expect(badge).toHaveTextContent('Summarized');
    expect(badge).toHaveAttribute('data-status', 'summarized');
    expect(badge.getAttribute('title')).toContain('AI summary available');
  });

  it('renders summarizing state with purple dot and pulse animation', () => {
    render(<SummaryStatusBadge status="summarizing" />);
    const badge = screen.getByTestId('summary-status-badge');
    expect(badge).toHaveTextContent('Summarizing');
    expect(badge).toHaveAttribute('data-status', 'summarizing');
    // The dot should have animate-pulse
    const dot = badge.querySelector('span:first-child');
    expect(dot?.className).toContain('animate-pulse');
  });

  it('renders pending state with yellow dot', () => {
    render(<SummaryStatusBadge status="pending" />);
    const badge = screen.getByTestId('summary-status-badge');
    expect(badge).toHaveTextContent('Pending');
    expect(badge).toHaveAttribute('data-status', 'pending');
  });

  it('renders failed state with red dot', () => {
    render(<SummaryStatusBadge status="failed" />);
    const badge = screen.getByTestId('summary-status-badge');
    expect(badge).toHaveTextContent('Failed');
    expect(badge).toHaveAttribute('data-status', 'failed');
  });

  it('renders skipped state with gray dot', () => {
    render(<SummaryStatusBadge status="skipped" />);
    const badge = screen.getByTestId('summary-status-badge');
    expect(badge).toHaveTextContent('Skipped');
    expect(badge).toHaveAttribute('data-status', 'skipped');
  });

  it('applies custom className', () => {
    render(<SummaryStatusBadge status="summarized" className="my-class" />);
    const badge = screen.getByTestId('summary-status-badge');
    expect(badge.className).toContain('my-class');
  });

  it('does not animate non-summarizing states', () => {
    const { rerender } = render(<SummaryStatusBadge status="pending" />);
    let dot = screen.getByTestId('summary-status-badge').querySelector('span:first-child');
    expect(dot?.className).not.toContain('animate-pulse');

    rerender(<SummaryStatusBadge status="summarized" />);
    dot = screen.getByTestId('summary-status-badge').querySelector('span:first-child');
    expect(dot?.className).not.toContain('animate-pulse');

    rerender(<SummaryStatusBadge status="failed" />);
    dot = screen.getByTestId('summary-status-badge').querySelector('span:first-child');
    expect(dot?.className).not.toContain('animate-pulse');
  });
});
