import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  MainNavChassisRail,
  MainNavStripExpanded,
  MainNavStripCollapsed,
} from './MainNavStrip';

function renderWithRouter(ui: React.ReactElement, route = '/') {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}

describe('MainNavChassisRail', () => {
  it('renders Pages, AI, and Graph destination links', () => {
    renderWithRouter(<MainNavChassisRail />, '/');
    expect(screen.getByRole('link', { name: 'Pages' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'AI chat, full page' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Graph' })).toBeInTheDocument();
  });

  it('marks Pages as active on root with left indicator marker without background change or border', () => {
    renderWithRouter(<MainNavChassisRail />, '/');
    const pages = screen.getByRole('link', { name: 'Pages' });
    const ai = screen.getByRole('link', { name: 'AI chat, full page' });
    const graph = screen.getByRole('link', { name: 'Graph' });

    expect(pages).toHaveAttribute('aria-current', 'page');
    expect(pages.className).not.toContain('bg-accent');
    expect(pages.className).toContain('text-foreground');
    expect(pages.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(pages.className).not.toContain('nav-selection');

    const pagesMarker = pages.querySelector('[data-testid="nav-marker"]');
    expect(pagesMarker?.getAttribute('class')).toContain('h-5');
    expect(pagesMarker?.getAttribute('class')).toContain('bg-primary-ink');
    expect(pagesMarker?.getAttribute('class')).toContain('-left-2');

    expect(ai).not.toHaveAttribute('aria-current');
    expect(ai.className).toContain('text-muted-foreground');
    expect(ai.className).not.toContain('bg-accent');
    expect(ai.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(ai.className).toContain('hover:text-foreground');

    const aiMarker = ai.querySelector('[data-testid="nav-marker"]');
    expect(aiMarker?.getAttribute('class')).toContain('h-0');
    expect(aiMarker?.getAttribute('class')).toContain('group-hover:h-3');

    expect(graph).not.toHaveAttribute('aria-current');
    expect(graph.className).toContain('text-muted-foreground');
    expect(graph.className).not.toContain('bg-accent');
    expect(graph.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(graph.className).toContain('hover:text-foreground');
  });

  it('marks Pages as active on subpages without border or background change, with left marker', () => {
    renderWithRouter(<MainNavChassisRail />, '/pages/some-page-id');
    const pages = screen.getByRole('link', { name: 'Pages' });
    expect(pages).toHaveAttribute('aria-current', 'page');
    expect(pages.className).not.toContain('bg-accent');
    expect(pages.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(pages.className).not.toContain('nav-selection');

    const marker = pages.querySelector('[data-testid="nav-marker"]');
    expect(marker?.getAttribute('class')).toContain('h-5');
    expect(marker?.getAttribute('class')).toContain('bg-primary-ink');
    expect(marker?.getAttribute('class')).toContain('-left-2');
  });

  it('marks AI as active on /ai without border or background change, with accent icon and left marker', () => {
    renderWithRouter(<MainNavChassisRail />, '/ai');
    const ai = screen.getByRole('link', { name: 'AI chat, full page' });
    expect(ai).toHaveAttribute('aria-current', 'page');
    expect(ai.className).not.toContain('bg-accent');
    expect(ai.className).toContain('text-foreground');
    expect(ai.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(ai.className).not.toContain('nav-selection');

    const icon = ai.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-primary-ink');

    const marker = ai.querySelector('[data-testid="nav-marker"]');
    expect(marker?.getAttribute('class')).toContain('h-5');
    expect(marker?.getAttribute('class')).toContain('bg-primary-ink');
    expect(marker?.getAttribute('class')).toContain('-left-2');
  });

  it('marks Graph as active on /graph without border or background change, with accent icon and left marker', () => {
    renderWithRouter(<MainNavChassisRail />, '/graph');
    const graph = screen.getByRole('link', { name: 'Graph' });
    expect(graph).toHaveAttribute('aria-current', 'page');
    expect(graph.className).not.toContain('bg-accent');
    expect(graph.className).toContain('text-foreground');
    expect(graph.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(graph.className).not.toContain('nav-selection');

    const icon = graph.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-primary-ink');

    const marker = graph.querySelector('[data-testid="nav-marker"]');
    expect(marker?.getAttribute('class')).toContain('h-5');
    expect(marker?.getAttribute('class')).toContain('bg-primary-ink');
    expect(marker?.getAttribute('class')).toContain('-left-2');
  });

  it('calls onNavigate callback when link is clicked', () => {
    const onNavigate = vi.fn();
    renderWithRouter(<MainNavChassisRail onNavigate={onNavigate} />, '/');
    fireEvent.click(screen.getByRole('link', { name: 'Graph' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('MainNavStripCollapsed', () => {
  it('renders icon navigation without border or background change, with left marker on active and hover marker on inactive', () => {
    renderWithRouter(<MainNavStripCollapsed />, '/ai');
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(3);

    const aiLink = links[1];
    expect(aiLink.className).not.toContain('bg-accent');
    expect(aiLink.className).toContain('text-foreground');
    expect(aiLink.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(aiLink.className).not.toContain('nav-selection');
    const aiSvg = aiLink.querySelector('svg');
    expect(aiSvg?.getAttribute('class')).toContain('text-primary-ink');
    const aiMarker = aiLink.querySelector('[data-testid="nav-marker"]');
    expect(aiMarker?.getAttribute('class')).toContain('h-5');
    expect(aiMarker?.getAttribute('class')).toContain('bg-primary-ink');

    const pagesLink = links[0];
    expect(pagesLink.className).toContain('text-muted-foreground');
    expect(pagesLink.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(pagesLink.className).toContain('hover:text-foreground');
    const pagesMarker = pagesLink.querySelector('[data-testid="nav-marker"]');
    expect(pagesMarker?.getAttribute('class')).toContain('h-0');
    expect(pagesMarker?.getAttribute('class')).toContain('group-hover:h-3');
  });
});

describe('MainNavStripExpanded', () => {
  it('renders horizontal segmented control with active pill using nm-pill-active', () => {
    renderWithRouter(<MainNavStripExpanded />, '/');
    const pages = screen.getByRole('link', { name: 'Pages' });
    expect(pages.className).toContain('nm-pill-active');

    const ai = screen.getByRole('link', { name: 'AI chat, full page' });
    expect(ai.className).toContain('text-muted-foreground');
    expect(ai.className).toContain('hover:text-foreground');
  });
});
