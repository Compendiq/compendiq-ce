import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QualityScoreBadge } from './QualityScoreBadge';

/** How many of the meter's four segments are filled. */
function filledSegments(badge: HTMLElement): number {
  return badge.querySelectorAll('[data-filled="true"]').length;
}

describe('QualityScoreBadge', () => {
  // ---- Null / pending state ----

  it('renders "Not Scored" when score is null and status is null', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus={null} />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('Not Scored');
    expect(badge.className).toContain('text-status-inactive');
    expect(badge).toHaveAttribute('data-status', 'pending');
  });

  it('renders "Not Scored" when status is pending', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus="pending" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('Not Scored');
    expect(badge).toHaveAttribute('data-status', 'pending');
  });

  // ---- Analyzing state ----

  it('renders "Analyzing..." with purple styling and pulse animation', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus="analyzing" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('Analyzing...');
    expect(badge.className).toContain('text-status-ai');
    expect(badge.className).toContain('bg-status-ai/20');
    expect(badge.className).toContain('animate-pulse');
    expect(badge).toHaveAttribute('data-status', 'analyzing');
  });

  // ---- Failed state ----

  it('renders "Analysis Failed" in amber, from tokens rather than hex literals', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus="failed" />);
    const badge = screen.getByTestId('badge-failed');
    expect(badge).toHaveTextContent('Analysis Failed');
    // Failure is the one quality state that IS attention-worthy, so it is the
    // one that earns amber. Via --color-warning, so the palette tests can see
    // it — the previous hex literals were invisible to them.
    expect(badge.className).toContain('text-warning');
    expect(badge.className).toContain('bg-warning/10');
    expect(badge.className).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(badge).toHaveAttribute('data-status', 'failed');
  });

  it('shows error in tooltip when failed', () => {
    render(
      <QualityScoreBadge
        qualityScore={null}
        qualityStatus="failed"
        qualityError="LLM connection timeout"
      />,
    );
    const badge = screen.getByTestId('badge-failed');
    expect(badge.getAttribute('title')).toContain('LLM connection timeout');
  });

  // ---- Skipped state ----

  it('renders "Skipped" neutral, from tokens rather than hex literals', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus="skipped" />);
    const badge = screen.getByTestId('badge-skipped');
    expect(badge).toHaveTextContent('Skipped');
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.className).not.toMatch(/amber|warning|yellow|primary/);
    expect(badge.className).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(badge).toHaveAttribute('data-status', 'skipped');
  });

  // ---- Score-based states ----

  it('renders "Excellent" for score 90-100, neutral with a full meter', () => {
    render(<QualityScoreBadge qualityScore={95} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('95 Excellent');
    expect(badge.className).toContain('text-foreground');
    expect(badge).toHaveAttribute('data-score', '95');
    expect(filledSegments(badge)).toBe(4);
  });

  it('renders "Good" for score 70-89 with three of four segments', () => {
    render(<QualityScoreBadge qualityScore={78} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('78 Good');
    expect(filledSegments(badge)).toBe(3);
  });

  it('renders "Needs Work" for score 50-69 with two of four segments', () => {
    render(<QualityScoreBadge qualityScore={55} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('55 Needs Work');
    expect(filledSegments(badge)).toBe(2);
  });

  it('renders "Poor" for score 0-49 with one of four segments', () => {
    render(<QualityScoreBadge qualityScore={30} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('30 Poor');
    expect(filledSegments(badge)).toBe(1);
  });

  // ---- The score is neutral; only the pipeline STATES wear status colours ----

  it.each([
    [95, 'Excellent'],
    [78, 'Good'],
    [55, 'Needs Work'],
    [30, 'Poor'],
  ])('score %i (%s) reaches for no status colour and no hex literal', (score) => {
    render(<QualityScoreBadge qualityScore={score} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    // Quality is a measurement, not a pipeline state. Painting it in the status
    // palette put a page scoring 65 in the same amber as a space mid-sync, and
    // one scoring 74 in the same Steel as "embedding", on the densest scanning
    // surface in the app. If this fails, that regression is back.
    expect(badge.className).not.toMatch(
      /status-(connected|syncing|embedding|disconnected)/,
    );
    expect(badge.className).not.toMatch(/\b(bg|text|border)-(primary|warning|success|destructive)\b/);
    expect(badge.className).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('keeps the number and the word, so the meter is never the only channel', () => {
    // WCAG 1.4.1: the meter is aria-hidden and purely a scanning aid.
    render(<QualityScoreBadge qualityScore={74} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('74 Good');
    expect(screen.getByTestId('quality-meter')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders no meter for the non-score states', () => {
    const { rerender } = render(
      <QualityScoreBadge qualityScore={null} qualityStatus="analyzing" />,
    );
    expect(screen.queryByTestId('quality-meter')).toBeNull();
    rerender(<QualityScoreBadge qualityScore={null} qualityStatus="failed" />);
    expect(screen.queryByTestId('quality-meter')).toBeNull();
    rerender(<QualityScoreBadge qualityScore={null} qualityStatus="skipped" />);
    expect(screen.queryByTestId('quality-meter')).toBeNull();
    rerender(<QualityScoreBadge qualityScore={null} qualityStatus="pending" />);
    expect(screen.queryByTestId('quality-meter')).toBeNull();
  });

  it('renders score 90 as "Excellent" (boundary)', () => {
    render(<QualityScoreBadge qualityScore={90} qualityStatus="analyzed" />);
    expect(screen.getByTestId('quality-score-badge')).toHaveTextContent('90 Excellent');
  });

  it('renders score 70 as "Good" (boundary)', () => {
    render(<QualityScoreBadge qualityScore={70} qualityStatus="analyzed" />);
    expect(screen.getByTestId('quality-score-badge')).toHaveTextContent('70 Good');
  });

  it('renders score 50 as "Needs Work" (boundary)', () => {
    render(<QualityScoreBadge qualityScore={50} qualityStatus="analyzed" />);
    expect(screen.getByTestId('quality-score-badge')).toHaveTextContent('50 Needs Work');
  });

  it('renders score 0 as "Poor" (boundary)', () => {
    render(<QualityScoreBadge qualityScore={0} qualityStatus="analyzed" />);
    expect(screen.getByTestId('quality-score-badge')).toHaveTextContent('0 Poor');
  });

  // ---- Tooltip with dimension breakdown ----

  it('shows per-dimension breakdown in tooltip', () => {
    render(
      <QualityScoreBadge
        qualityScore={75}
        qualityStatus="analyzed"
        qualityCompleteness={80}
        qualityClarity={70}
        qualityStructure={78}
        qualityAccuracy={72}
        qualityReadability={68}
      />,
    );
    const badge = screen.getByTestId('quality-score-badge');
    const tooltip = badge.getAttribute('title') ?? '';
    expect(tooltip).toContain('Quality Score: 75/100');
    expect(tooltip).toContain('Completeness: 80/100');
    expect(tooltip).toContain('Clarity: 70/100');
    expect(tooltip).toContain('Structure: 78/100');
    expect(tooltip).toContain('Accuracy: 72/100');
    expect(tooltip).toContain('Readability: 68/100');
  });

  it('shows summary in tooltip when provided', () => {
    render(
      <QualityScoreBadge
        qualityScore={80}
        qualityStatus="analyzed"
        qualitySummary="This article is well-written but needs more examples."
      />,
    );
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge.getAttribute('title')).toContain('well-written but needs more examples');
  });

  // ---- No animation for non-analyzing states ----

  it('does not apply animate-pulse for analyzed state', () => {
    render(<QualityScoreBadge qualityScore={85} qualityStatus="analyzed" />);
    expect(screen.getByTestId('quality-score-badge').className).not.toContain('animate-pulse');
  });

  it('does not apply animate-pulse for failed state', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus="failed" />);
    expect(screen.getByTestId('badge-failed').className).not.toContain('animate-pulse');
  });

  // ---- Custom className ----

  it('applies custom className', () => {
    render(
      <QualityScoreBadge qualityScore={80} qualityStatus="analyzed" className="my-custom-class" />,
    );
    expect(screen.getByTestId('quality-score-badge').className).toContain('my-custom-class');
  });

  // ---- Tooltip for pending state ----

  it('shows appropriate tooltip for pending state', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus={null} />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge.getAttribute('title')).toContain('not been analyzed');
  });

  it('shows appropriate tooltip for analyzing state', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus="analyzing" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge.getAttribute('title')).toContain('in progress');
  });
});
