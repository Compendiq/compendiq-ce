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

  it('applies correct color classes for fresh content', () => {
    render(<FreshnessBadge lastModified="2026-03-03T12:00:00Z" />);
    const badge = screen.getByText('Fresh');
    expect(badge.className).toContain('text-success');
    expect(badge.className).toContain('bg-success/15');
  });

  it('applies correct color classes for stale content', () => {
    render(<FreshnessBadge lastModified="2025-06-01T12:00:00Z" />);
    const badge = screen.getByText('Stale');
    expect(badge.className).toContain('text-destructive');
    expect(badge.className).toContain('bg-destructive/15');
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
