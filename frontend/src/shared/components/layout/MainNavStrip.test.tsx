import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  MainNavStripExpanded,
  MainNavStripCollapsed,
  MainNavChassisRail,
  MainNavTextLinks,
} from './MainNavStrip';

function renderWithRouter(ui: React.ReactElement, route = '/') {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}

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
    expect(aiLink).toHaveAttribute('aria-current', 'page');
    const aiSvg = aiLink.querySelector('svg');
    expect(aiSvg?.getAttribute('class')).toContain('text-primary-ink');
    const aiMarker = aiLink.querySelector('[data-testid="nav-marker"]');
    expect(aiMarker?.getAttribute('class')).toContain('h-5');
    expect(aiMarker?.getAttribute('class')).toContain('bg-primary-ink');

    const pagesLink = links[0];
    expect(pagesLink.className).toContain('text-muted-foreground');
    expect(pagesLink.className).not.toMatch(/(^|\s)border(-|\s|$)/);
    expect(pagesLink.className).toContain('hover:text-foreground');
    expect(pagesLink).not.toHaveAttribute('aria-current');
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

describe('MainNavChassisRail', () => {
  it('renders vertical icon-only destination links sized to --app-nav-rail-width', () => {
    renderWithRouter(<MainNavChassisRail />, '/');
    const nav = screen.getByTestId('main-nav-chassis');
    expect(nav).toHaveAccessibleName('Main navigation');
    expect(nav.className).toContain('w-[var(--app-nav-rail-width)]');
    expect(nav.className).toContain('flex-col');
    expect(nav.className).toContain('gap-1.5');

    const pages = screen.getByRole('link', { name: 'Pages' });
    const ai = screen.getByRole('link', { name: 'AI chat, full page' });
    const graph = screen.getByRole('link', { name: 'Graph' });

    expect(pages).toHaveAttribute('title', 'Pages (G then P)');
    expect(ai).toHaveAttribute('title', 'AI chat, full page (G then A)');
    expect(graph).toHaveAttribute('title', 'Graph (G then G)');

    // Symbols only — no visible text labels.
    expect(pages.textContent).toBe('');
    expect(ai.textContent).toBe('');
    expect(graph.textContent).toBe('');
  });

  it('marks the active destination with aria-current="page", primary-ink icon, and left marker', () => {
    renderWithRouter(<MainNavChassisRail />, '/');
    const pages = screen.getByRole('link', { name: 'Pages' });
    const ai = screen.getByRole('link', { name: 'AI chat, full page' });

    expect(pages).toHaveAttribute('aria-current', 'page');
    expect(pages.className).toContain('text-foreground');
    expect(pages.querySelector('svg')?.getAttribute('class')).toContain('text-primary-ink');
    expect(pages.querySelector('[data-testid="nav-marker"]')?.getAttribute('class')).toContain('h-5');
    expect(pages.querySelector('[data-testid="nav-marker"]')?.getAttribute('class')).toContain('bg-primary-ink');

    expect(ai).not.toHaveAttribute('aria-current');
    expect(ai.className).toContain('text-muted-foreground');
    expect(ai.querySelector('[data-testid="nav-marker"]')?.getAttribute('class')).toContain('h-0');
    expect(ai.querySelector('[data-testid="nav-marker"]')?.getAttribute('class')).toContain('group-hover:h-3');
  });

  it('marks Pages active on /pages/*, AI active on /ai/*, and Graph active on /graph', () => {
    const { unmount } = renderWithRouter(<MainNavChassisRail />, '/pages/abc');
    expect(screen.getByRole('link', { name: 'Pages' })).toHaveAttribute('aria-current', 'page');
    unmount();

    const { unmount: unmountAi } = renderWithRouter(<MainNavChassisRail />, '/ai/c/conv-1');
    expect(screen.getByRole('link', { name: 'AI chat, full page' })).toHaveAttribute('aria-current', 'page');
    unmountAi();

    renderWithRouter(<MainNavChassisRail />, '/graph');
    expect(screen.getByRole('link', { name: 'Graph' })).toHaveAttribute('aria-current', 'page');
  });

  it('invokes onNavigate when clicked', () => {
    const onNavigate = vi.fn();
    renderWithRouter(<MainNavChassisRail onNavigate={onNavigate} />, '/');
    fireEvent.click(screen.getByRole('link', { name: 'Graph' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('MainNavTextLinks', () => {
  it('names Library, AI and Graph, and marks the destination by route', () => {
    const { unmount } = renderWithRouter(<MainNavTextLinks />, '/pages/abc');
    let nav = screen.getByRole('navigation', { name: 'Destinations' });
    expect(within(nav).getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'AI chat, full page' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Graph' })).not.toHaveAttribute('aria-current');
    unmount();

    renderWithRouter(<MainNavTextLinks />, '/ai/c/conv-1');
    nav = screen.getByRole('navigation', { name: 'Destinations' });
    expect(within(nav).getByRole('link', { name: 'AI chat, full page' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Library' })).not.toHaveAttribute('aria-current');
  });

  it('invokes onNavigate when a destination is clicked', () => {
    const onNavigate = vi.fn();
    renderWithRouter(<MainNavTextLinks onNavigate={onNavigate} />, '/');
    fireEvent.click(screen.getByRole('link', { name: 'Graph' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
