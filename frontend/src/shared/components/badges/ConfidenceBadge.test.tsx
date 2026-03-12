import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfidenceBadge, getConfidenceLevel } from './ConfidenceBadge';

describe('getConfidenceLevel', () => {
  it('returns "high" for score >= 0.7', () => {
    expect(getConfidenceLevel(0.7)).toBe('high');
    expect(getConfidenceLevel(0.85)).toBe('high');
    expect(getConfidenceLevel(1.0)).toBe('high');
  });

  it('returns "medium" for score >= 0.4 and < 0.7', () => {
    expect(getConfidenceLevel(0.4)).toBe('medium');
    expect(getConfidenceLevel(0.55)).toBe('medium');
    expect(getConfidenceLevel(0.69)).toBe('medium');
  });

  it('returns "low" for score < 0.4', () => {
    expect(getConfidenceLevel(0.39)).toBe('low');
    expect(getConfidenceLevel(0.1)).toBe('low');
    expect(getConfidenceLevel(0)).toBe('low');
  });
});

describe('ConfidenceBadge', () => {
  it('renders "High confidence" for high scores', () => {
    render(<ConfidenceBadge score={0.85} />);
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  it('renders "Medium confidence" for medium scores', () => {
    render(<ConfidenceBadge score={0.55} />);
    expect(screen.getByText('Medium confidence')).toBeInTheDocument();
  });

  it('renders "Low confidence" for low scores', () => {
    render(<ConfidenceBadge score={0.2} />);
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
  });

  it('has data-testid for easy querying', () => {
    render(<ConfidenceBadge score={0.5} />);
    expect(screen.getByTestId('confidence-badge')).toBeInTheDocument();
  });

  it('shows percentage in title tooltip', () => {
    render(<ConfidenceBadge score={0.73} />);
    const badge = screen.getByTestId('confidence-badge');
    expect(badge.getAttribute('title')).toBe('Confidence: 73%');
  });

  it('applies emerald classes for high confidence', () => {
    render(<ConfidenceBadge score={0.9} />);
    const badge = screen.getByTestId('confidence-badge');
    expect(badge.className).toContain('text-emerald-400');
  });

  it('applies amber classes for medium confidence', () => {
    render(<ConfidenceBadge score={0.5} />);
    const badge = screen.getByTestId('confidence-badge');
    expect(badge.className).toContain('text-amber-400');
  });

  it('applies red classes for low confidence', () => {
    render(<ConfidenceBadge score={0.15} />);
    const badge = screen.getByTestId('confidence-badge');
    expect(badge.className).toContain('text-red-400');
  });

  it('renders the glowing dot element', () => {
    render(<ConfidenceBadge score={0.8} />);
    const badge = screen.getByTestId('confidence-badge');
    const dot = badge.querySelector('[aria-hidden="true"]');
    expect(dot).toBeInTheDocument();
    expect(dot?.className).toContain('rounded-full');
  });

  it('applies custom className', () => {
    render(<ConfidenceBadge score={0.8} className="my-custom" />);
    const badge = screen.getByTestId('confidence-badge');
    expect(badge.className).toContain('my-custom');
  });

  it('handles edge case score of exactly 0.7', () => {
    render(<ConfidenceBadge score={0.7} />);
    expect(screen.getByText('High confidence')).toBeInTheDocument();
  });

  it('handles edge case score of exactly 0.4', () => {
    render(<ConfidenceBadge score={0.4} />);
    expect(screen.getByText('Medium confidence')).toBeInTheDocument();
  });
});
