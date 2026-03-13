import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QualityScoreBadge } from './QualityScoreBadge';

describe('QualityScoreBadge', () => {
  // ---- Null / pending state ----

  it('renders "Not Scored" when score is null and status is null', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus={null} />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('Not Scored');
    expect(badge.className).toContain('text-gray-400');
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
    expect(badge.className).toContain('text-purple-400');
    expect(badge.className).toContain('bg-purple-500/20');
    expect(badge.className).toContain('animate-pulse');
    expect(badge).toHaveAttribute('data-status', 'analyzing');
  });

  // ---- Failed state ----

  it('renders "Analysis Failed" with red styling', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus="failed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('Analysis Failed');
    expect(badge.className).toContain('text-red-400');
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
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge.getAttribute('title')).toContain('LLM connection timeout');
  });

  // ---- Skipped state ----

  it('renders "Skipped" with gray styling', () => {
    render(<QualityScoreBadge qualityScore={null} qualityStatus="skipped" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('Skipped');
    expect(badge.className).toContain('text-gray-400');
    expect(badge).toHaveAttribute('data-status', 'skipped');
  });

  // ---- Score-based states ----

  it('renders "Excellent" with green styling for score 90-100', () => {
    render(<QualityScoreBadge qualityScore={95} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('95 Excellent');
    expect(badge.className).toContain('text-green-400');
    expect(badge.className).toContain('bg-green-500/20');
    expect(badge).toHaveAttribute('data-score', '95');
  });

  it('renders "Good" with blue styling for score 70-89', () => {
    render(<QualityScoreBadge qualityScore={78} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('78 Good');
    expect(badge.className).toContain('text-blue-400');
  });

  it('renders "Needs Work" with yellow styling for score 50-69', () => {
    render(<QualityScoreBadge qualityScore={55} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('55 Needs Work');
    expect(badge.className).toContain('text-yellow-400');
  });

  it('renders "Poor" with red styling for score 0-49', () => {
    render(<QualityScoreBadge qualityScore={30} qualityStatus="analyzed" />);
    const badge = screen.getByTestId('quality-score-badge');
    expect(badge).toHaveTextContent('30 Poor');
    expect(badge.className).toContain('text-red-400');
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
    expect(screen.getByTestId('quality-score-badge').className).not.toContain('animate-pulse');
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
