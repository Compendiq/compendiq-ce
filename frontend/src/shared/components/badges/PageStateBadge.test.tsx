import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageStateBadge } from './PageStateBadge';

/**
 * The severity ladder is pinned in page-state.test.ts; THIS file pins the tone
 * recipes, because the badge renders inside PagesPage rows that hover with
 * `bg-accent` — the ground the neutral-chip recipe was measured for.
 *
 * `idle` ('Not indexed') used to be `bg-muted text-muted-foreground`: in
 * Graphite accent == muted (1.00:1 measured), so the one chip whose job is
 * "this page is invisible to semantic search" itself went invisible exactly
 * while the row was being pointed at, while Local/Shared beside it (already on
 * the tint recipe) stayed crisp.
 *
 * `failed` keeps its destructive fill and border — failure is a state and
 * earns its hue — but the LABEL takes the secondary ink: text-destructive
 * measured 3.94:1 on its own /10 tint over a hovered Paper row, under AA at
 * 11px. The secondary ink measures 8.33–10.28:1 on the same fills.
 *
 * `working` stays on the status-ai tint: measured 4.94–6.00:1 on both row
 * grounds in both themes.
 */
describe('PageStateBadge tone recipes', () => {
  it('idle ("Not indexed") wears the settled neutral-chip recipe, never bg-muted', () => {
    render(<PageStateBadge embeddingDirty={true} />);
    const badge = screen.getByTestId('page-state-badge');
    expect(badge).toHaveTextContent('Not indexed');
    expect(badge.className).toContain('bg-foreground/10');
    expect(badge.className).toContain('text-secondary-foreground');
    expect(badge.className).toContain('border-border');
    expect(badge.className).not.toContain('bg-muted');
    expect(badge.className).not.toContain('text-muted-foreground');
  });

  it('failed keeps the destructive fill and border but carries its label in the secondary ink', () => {
    render(<PageStateBadge summaryStatus="failed" />);
    const badge = screen.getByTestId('page-state-badge');
    expect(badge).toHaveTextContent('Failed');
    expect(badge.className).toContain('bg-destructive/10');
    expect(badge.className).toContain('border-destructive/40');
    expect(badge.className).toContain('text-secondary-foreground');
    expect(badge.className).not.toContain('text-destructive');
  });

  it('working keeps the status-ai tint — a running job is a pipeline state', () => {
    render(<PageStateBadge summaryStatus="summarizing" />);
    const badge = screen.getByTestId('page-state-badge');
    expect(badge).toHaveTextContent('Processing');
    expect(badge.className).toContain('bg-status-ai/10');
    expect(badge.className).toContain('text-status-ai');
  });

  it('no tone hardcodes a hex literal or a dark: variant', () => {
    for (const props of [
      { embeddingDirty: true },
      { summaryStatus: 'failed' as const },
      { summaryStatus: 'summarizing' as const },
    ]) {
      const { unmount } = render(<PageStateBadge {...props} />);
      const badge = screen.getByTestId('page-state-badge');
      expect(badge.className).not.toMatch(/#[0-9a-fA-F]{3,8}|dark:/);
      unmount();
    }
  });
});
