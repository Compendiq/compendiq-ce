import type { ReactElement, ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractBlock } from '../../../test-utils';
import { useThemeStore, type ThemeId } from '../../../stores/theme-store';
import { KnowledgeHealthDashboard } from './KnowledgeHealthDashboard';
import type { DashboardProps } from './AnalyticsPage';

/**
 * The analytics charts used to paint Tailwind v3 hexes: one palette for both
 * themes, tuned for neither, failing contrast on the light pane. They resolve
 * the real tokens now — which is only true if the rendered series colour
 * actually CHANGES with `data-theme`. So this mounts a dashboard against the
 * token values parsed out of index.css, once per theme, and compares.
 *
 * Sibling coverage: `chart-palette-tokens.test.ts` guards the other direction
 * (no literal can come back), `shared/lib/theme-colors.test.ts` covers the
 * resolver and `shared/hooks/use-theme-colors.test.ts` the re-resolution.
 */

// ── Chart stubs that surface the props under test ──────────────────────────────

interface StubProps {
  children?: ReactNode;
  fill?: string;
  stroke?: string;
  data?: { fill?: string }[];
}

vi.mock('../../../shared/components/charts/ChartsBundle', () => {
  const passthrough = ({ children }: StubProps): ReactNode => children ?? null;
  const painted =
    (testId: string) =>
    ({ fill, stroke, children }: StubProps): ReactElement => (
      <div data-testid={testId} data-fill={fill} data-stroke={stroke}>
        {children}
      </div>
    );

  return {
    BarChart: passthrough,
    PieChart: passthrough,
    Pie: passthrough,
    ResponsiveContainer: passthrough,
    XAxis: passthrough,
    YAxis: passthrough,
    Tooltip: passthrough,
    Legend: passthrough,
    Bar: painted('bar'),
    Cell: painted('cell'),
    CartesianGrid: painted('grid'),
    Treemap: ({ data }: StubProps): ReactElement => (
      <div data-testid="treemap" data-fills={JSON.stringify((data ?? []).map((d) => d.fill))} />
    ),
  };
});

const mockFetch = vi.fn();
vi.mock('../../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockFetch(...args),
}));

// ── The real palette, as index.css declares it ─────────────────────────────────

const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf-8');

/**
 * Keep the one-line custom-property declarations; drop comments, nested rules
 * and the multi-line values (shadows) no chart reads.
 */
function customProperties(block: string): string {
  return block
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^--[\w-]+:\s*[^;]+;$/.test(line))
    .join('\n');
}

const graphiteTokens = customProperties(extractBlock(css, '@theme {'));
const paperTokens = customProperties(extractBlock(css, '[data-theme="paper"] {'));

function token(block: string, name: string): string {
  // Last declaration wins, as it does in the cascade.
  const declarations = [...block.matchAll(new RegExp(`${name}:\\s*([^;]+);`, 'g'))];
  const value = declarations.at(-1)?.[1];
  if (!value) throw new Error(`token not declared in index.css: ${name}`);
  return value.trim();
}

let sheet: HTMLStyleElement | null = null;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const dateRange: DashboardProps['dateRange'] = {
  startDate: '2025-01-01',
  endDate: '2025-01-31',
};

const mockData = {
  qualityDistribution: [
    { bucket: 'excellent', count: 10 },
    { bucket: 'good', count: 20 },
    { bucket: 'fair', count: 15 },
    { bucket: 'poor', count: 5 },
  ],
  staleContent: [{ bucket: '> 90 days', count: 20 }],
  coverageBySpace: [
    { spaceKey: 'ENG', pageCount: 100, avgQuality: 0.8 },
    { spaceKey: 'OPS', pageCount: 50, avgQuality: 0.6 },
  ],
  verificationStatus: [
    { status: 'verified_current', count: 40 },
    { status: 'verified_stale', count: 15 },
    { status: 'unverified', count: 45 },
  ],
};

interface Painted {
  qualityCells: string[];
  staleBar: string;
  gridStroke: string;
  treemap: string[];
}

function attribute(element: Element | undefined, name: string): string {
  return element?.getAttribute(name) ?? '';
}

async function paintUnder(theme: ThemeId): Promise<Painted> {
  useThemeStore.setState({ theme });
  document.documentElement.setAttribute('data-theme', theme);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <KnowledgeHealthDashboard dateRange={dateRange} onExportPdf={vi.fn()} />
    </QueryClientProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId('knowledge-dashboard')).toBeInTheDocument();
  });

  const cells = screen.getAllByTestId('cell');
  const bars = screen.getAllByTestId('bar');
  const treemapFills: unknown = JSON.parse(
    attribute(screen.getByTestId('treemap'), 'data-fills') || '[]',
  );

  const painted: Painted = {
    // Quality distribution renders first; the verification pie follows.
    qualityCells: cells
      .slice(0, mockData.qualityDistribution.length)
      .map((cell) => attribute(cell, 'data-fill')),
    // The stale breakdown is the only single-fill bar in the tree.
    staleBar: attribute(bars.at(-1), 'data-fill'),
    gridStroke: attribute(screen.getAllByTestId('grid').at(0), 'data-stroke'),
    treemap: Array.isArray(treemapFills) ? treemapFills.map(String) : [],
  };

  view.unmount();
  return painted;
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(mockData);

  sheet = document.createElement('style');
  sheet.textContent = `:root {\n${graphiteTokens}\n}\n[data-theme="paper"] {\n${paperTokens}\n}`;
  document.head.appendChild(sheet);
});

afterEach(() => {
  sheet?.remove();
  sheet = null;
  useThemeStore.setState({ theme: 'graphite' });
  document.documentElement.setAttribute('data-theme', 'graphite');
});

describe('Analytics charts paint the active theme', () => {
  it('maps each quality bucket onto the token that owns its meaning', async () => {
    const graphite = await paintUnder('graphite');

    expect(graphite.qualityCells).toEqual([
      token(graphiteTokens, '--color-status-connected'),
      token(graphiteTokens, '--color-primary'),
      token(graphiteTokens, '--color-status-syncing'),
      token(graphiteTokens, '--color-status-disconnected'),
    ]);
  });

  it('repaints every series when the theme changes', async () => {
    const graphite = await paintUnder('graphite');
    const paper = await paintUnder('paper');

    expect(paper.qualityCells).toEqual([
      token(paperTokens, '--color-status-connected'),
      token(paperTokens, '--color-primary'),
      token(paperTokens, '--color-status-syncing'),
      token(paperTokens, '--color-status-disconnected'),
    ]);
    // The defect was one palette for both panes: every bucket must move.
    graphite.qualityCells.forEach((colour, i) => {
      expect(paper.qualityCells[i]).not.toBe(colour);
    });
  });

  it('moves a single-series bar with the theme too', async () => {
    const graphite = await paintUnder('graphite');
    const paper = await paintUnder('paper');

    expect(graphite.staleBar).toBe(token(graphiteTokens, '--color-status-syncing'));
    expect(paper.staleBar).toBe(token(paperTokens, '--color-status-syncing'));
  });

  it('derives the categorical treemap ramp from the theme', async () => {
    const graphite = await paintUnder('graphite');
    const paper = await paintUnder('paper');

    expect(graphite.treemap).toHaveLength(mockData.coverageBySpace.length);
    graphite.treemap.forEach((colour, i) => {
      expect(paper.treemap[i]).not.toBe(colour);
    });
  });

  it('paints concrete colours, never an unresolved var()', async () => {
    const paper = await paintUnder('paper');

    for (const colour of [...paper.qualityCells, paper.staleBar, ...paper.treemap]) {
      expect(colour).toMatch(/^(#|rgb)/);
    }
  });

  it('leaves chart chrome as a token reference for CSS to resolve', async () => {
    // Chrome lands as an SVG attribute, where the browser resolves var() per
    // theme with no JS — so it stays a reference rather than a snapshot.
    const graphite = await paintUnder('graphite');

    expect(graphite.gridStroke).toBe('var(--color-border)');
  });
});
