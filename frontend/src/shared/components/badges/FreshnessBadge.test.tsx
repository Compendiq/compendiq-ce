import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FreshnessBadge, getFreshnessLevel } from './FreshnessBadge';

describe('FreshnessBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders "Fresh" for content modified less than 7 days ago', () => {
    render(<FreshnessBadge lastModified="2026-03-03T12:00:00Z" />);
    expect(screen.getByText('Fresh')).toBeInTheDocument();
  });

  it('renders "Recent" for content modified 7-30 days ago', () => {
    render(<FreshnessBadge lastModified="2026-02-15T12:00:00Z" />);
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('renders "Aging" for content modified 30-90 days ago', () => {
    render(<FreshnessBadge lastModified="2026-01-01T12:00:00Z" />);
    expect(screen.getByText('Aging')).toBeInTheDocument();
  });

  it('renders "Stale" for content modified more than 90 days ago', () => {
    render(<FreshnessBadge lastModified="2025-06-01T12:00:00Z" />);
    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  it('shows tooltip with exact date on hover', () => {
    render(<FreshnessBadge lastModified="2026-03-03T12:00:00Z" />);
    const badge = screen.getByText('Fresh');
    expect(badge.getAttribute('title')).toContain('Last modified:');
  });

  it('applies custom className', () => {
    render(<FreshnessBadge lastModified="2026-03-03T12:00:00Z" className="custom-class" />);
    const badge = screen.getByText('Fresh');
    expect(badge.className).toContain('custom-class');
  });

  // Freshness is a measurement, not a pipeline state, so every level renders
  // the same neutral chip and the LABEL is the channel (the QualityScoreBadge
  // argument). The ladder used to wear the full status vocabulary — Fresh in
  // the connected green, Aging literally in status-syncing, Stale in the
  // disconnected red — plus a one-off sage hex for Recent that existed
  // nowhere else in the palette.
  it.each([
    ['Fresh', '2026-03-03T12:00:00Z'],
    ['Recent', '2026-02-15T12:00:00Z'],
    ['Aging', '2026-01-01T12:00:00Z'],
    ['Stale', '2025-06-01T12:00:00Z'],
  ])('%s renders neutral — no status hue, no hex literal', (label, lastModified) => {
    render(<FreshnessBadge lastModified={lastModified} />);
    const badge = screen.getByText(label);
    expect(badge.className).toContain('bg-muted');
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.className).not.toMatch(
      /success|warning|destructive|status-|amber|yellow|primary|#[0-9a-fA-F]{3,8}/,
    );
  });
});

describe('getFreshnessLevel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-05T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns Fresh for 0 days old', () => {
    expect(getFreshnessLevel('2026-03-05T12:00:00Z').label).toBe('Fresh');
  });

  it('returns Fresh for 6 days old', () => {
    expect(getFreshnessLevel('2026-02-27T12:00:00Z').label).toBe('Fresh');
  });

  it('returns Recent for 7 days old', () => {
    expect(getFreshnessLevel('2026-02-26T12:00:00Z').label).toBe('Recent');
  });

  it('returns Recent for 29 days old', () => {
    expect(getFreshnessLevel('2026-02-04T12:00:00Z').label).toBe('Recent');
  });

  it('returns Aging for 30 days old', () => {
    expect(getFreshnessLevel('2026-02-03T12:00:00Z').label).toBe('Aging');
  });

  it('returns Aging for 89 days old', () => {
    expect(getFreshnessLevel('2025-12-06T12:00:00Z').label).toBe('Aging');
  });

  it('returns Stale for 90 days old', () => {
    expect(getFreshnessLevel('2025-12-05T12:00:00Z').label).toBe('Stale');
  });

  it('returns Stale for 365 days old', () => {
    expect(getFreshnessLevel('2025-03-05T12:00:00Z').label).toBe('Stale');
  });
});
