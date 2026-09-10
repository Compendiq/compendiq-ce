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

  // Similarity is a MEASUREMENT, not a pipeline state, so every level renders
  // the same neutral chip and the WORD is the channel (QualityScoreBadge's
  // de-colouring is the precedent, and this reuses its neutral recipe). The
  // badge used to wear status-connected / status-syncing / status-disconnected
  // beside every cited AI answer, so a weak match sat there in the same red as
  // a broken connection and a partial match in the same amber as a space
  // mid-sync.
  it.each([
    ['High confidence', 0.9],
    ['Medium confidence', 0.5],
    ['Low confidence', 0.15],
  ])('%s renders the neutral chip — no status hue, no hex, no dark:', (label, score) => {
    render(<ConfidenceBadge score={score} />);
    const badge = screen.getByTestId('confidence-badge');
    expect(badge).toHaveTextContent(label);
    expect(badge.className).toContain('bg-muted/40');
    expect(badge.className).toContain('text-foreground');
    expect(badge.className).toContain('border-border');
    expect(badge.className).not.toMatch(
      /status-|success|warning|destructive|emerald|amber|red|green|#[0-9a-fA-F]{3,8}|dark:/,
    );
  });

  it('carries no colour-coded dot — with one neutral chip a dot encodes nothing', () => {
    render(<ConfidenceBadge score={0.8} />);
    const badge = screen.getByTestId('confidence-badge');
    expect(badge.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();
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
