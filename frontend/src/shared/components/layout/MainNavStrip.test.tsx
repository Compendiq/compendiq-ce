import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  MainNavStripExpanded,
  MainNavStripCollapsed,
  MainNavHeaderTabs,
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

describe('MainNavHeaderTabs', () => {
  it('renders Notion flat tabs with Pages, AI, and Graph destination links', () => {
    renderWithRouter(<MainNavHeaderTabs />, '/');
    const nav = screen.getByTestId('main-nav-header');
    expect(nav).toHaveAccessibleName('Main navigation');
    expect(screen.getByRole('link', { name: 'Pages' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'AI chat, full page' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Graph' })).toBeInTheDocument();
  });

  it('marks active tab with bottom indicator and page current attribute', () => {
    renderWithRouter(<MainNavHeaderTabs />, '/');
    const pages = screen.getByRole('link', { name: 'Pages' });
    const ai = screen.getByRole('link', { name: 'AI chat, full page' });
    expect(pages).toHaveAttribute('aria-current', 'page');
    expect(pages.className).toContain('text-foreground');
    expect(pages.querySelector('[data-testid="nav-tab-active-indicator"]')).toBeInTheDocument();

    expect(ai).not.toHaveAttribute('aria-current');
    expect(ai.className).toContain('text-muted-foreground');
    expect(ai.querySelector('[data-testid="nav-tab-active-indicator"]')).toBeNull();
  });

  it('marks AI tab as active on /ai', () => {
    renderWithRouter(<MainNavHeaderTabs />, '/ai');
    const ai = screen.getByRole('link', { name: 'AI chat, full page' });
    expect(ai).toHaveAttribute('aria-current', 'page');
    expect(ai.querySelector('[data-testid="nav-tab-active-indicator"]')).toBeInTheDocument();
  });

  it('marks Graph tab as active on /graph', () => {
    renderWithRouter(<MainNavHeaderTabs />, '/graph');
    const graph = screen.getByRole('link', { name: 'Graph' });
    expect(graph).toHaveAttribute('aria-current', 'page');
    expect(graph.querySelector('[data-testid="nav-tab-active-indicator"]')).toBeInTheDocument();
  });

  it('invokes onNavigate when clicked', () => {
    const onNavigate = vi.fn();
    renderWithRouter(<MainNavHeaderTabs onNavigate={onNavigate} />, '/');
    fireEvent.click(screen.getByRole('link', { name: 'Graph' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
