import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LazyMotion, domAnimation } from 'framer-motion';
import { ActivityHeatmap } from './ActivityHeatmap';

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation}>
      {children}
    </LazyMotion>
  );
}

/** Format a local Date as YYYY-MM-DD (matches the component's logic) */
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('ActivityHeatmap', () => {
  it('renders the heatmap container', () => {
    render(<ActivityHeatmap data={[]} />, { wrapper: Wrapper });
    expect(screen.getByTestId('activity-heatmap')).toBeInTheDocument();
  });

  it('renders the title', () => {
    render(<ActivityHeatmap data={[]} />, { wrapper: Wrapper });
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });

  it('renders the legend with Less and More labels', () => {
    render(<ActivityHeatmap data={[]} />, { wrapper: Wrapper });
    expect(screen.getByText('Less')).toBeInTheDocument();
    expect(screen.getByText('More')).toBeInTheDocument();
  });

  it('renders an SVG element with accessibility label', () => {
    render(<ActivityHeatmap data={[]} />, { wrapper: Wrapper });
    const svg = screen.getByRole('img');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('aria-label', 'Activity heatmap showing article edits and syncs over time');
  });

  it('renders cells for activity data', () => {
    const today = new Date();
    const todayStr = toLocalDateStr(today);
    const yesterdayStr = toLocalDateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1));

    render(
      <ActivityHeatmap
        data={[
          { date: todayStr, count: 3 },
          { date: yesterdayStr, count: 1 },
        ]}
      />,
      { wrapper: Wrapper },
    );

    // The SVG should have rect elements (cells). We can check via title elements
    // that contain the date and count
    const svg = screen.getByRole('img');
    expect(svg.querySelectorAll('rect').length).toBeGreaterThan(0);
  });

  it('aggregates counts for the same date', () => {
    const today = toLocalDateStr(new Date());

    const { container } = render(
      <ActivityHeatmap
        data={[
          { date: today, count: 2 },
          { date: today, count: 3 },
        ]}
      />,
      { wrapper: Wrapper },
    );

    // Find the title element for today's cell
    const titles = container.querySelectorAll('title');
    const todayTitle = Array.from(titles).find((t) => t.textContent?.startsWith(today));
    expect(todayTitle).toBeDefined();
    expect(todayTitle!.textContent).toContain('5 activities');
  });

  it('handles empty data without errors', () => {
    render(<ActivityHeatmap data={[]} />, { wrapper: Wrapper });
    const svg = screen.getByRole('img');
    // Should still render cells (empty days)
    expect(svg.querySelectorAll('rect').length).toBeGreaterThan(0);
  });

  it('respects custom weeks parameter', () => {
    const { container: container4 } = render(
      <ActivityHeatmap data={[]} weeks={4} />,
      { wrapper: Wrapper },
    );
    const { container: container26 } = render(
      <ActivityHeatmap data={[]} weeks={26} />,
      { wrapper: Wrapper },
    );

    const cells4 = container4.querySelectorAll('rect');
    const cells26 = container26.querySelectorAll('rect');

    // 4 weeks should have fewer cells than 26 weeks
    expect(cells4.length).toBeLessThan(cells26.length);
  });

  it('renders day labels (Mon, Wed, Fri)', () => {
    render(<ActivityHeatmap data={[]} />, { wrapper: Wrapper });
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Wed')).toBeInTheDocument();
    expect(screen.getByText('Fri')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<ActivityHeatmap data={[]} className="custom-class" />, { wrapper: Wrapper });
    expect(screen.getByTestId('activity-heatmap')).toHaveClass('custom-class');
  });
});
