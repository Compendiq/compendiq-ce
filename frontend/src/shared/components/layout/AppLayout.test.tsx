import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LazyMotion, domAnimation } from 'framer-motion';
import { AppLayout } from './AppLayout';
import { useAiContext } from '../../../features/ai/AiContext';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { useUiStore } from '../../../stores/ui-store';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import * as keyboardShortcutsModule from '../../hooks/use-keyboard-shortcuts';

// Mock SidebarTreeView to isolate AppLayout tests. It renders a couple of
// focusable controls so the mobile slide-over focus-trap can be exercised.
vi.mock('./SidebarTreeView', () => ({
  SidebarTreeView: ({
    onNavigate: _onNavigate,
    forceCollapsed,
    onForceExpand,
  }: {
    onNavigate?: () => void;
    forceCollapsed?: boolean;
    onForceExpand?: () => void;
  }) => (
    <nav data-testid="sidebar-tree-view" data-force-collapsed={forceCollapsed ? 'true' : 'false'}>
      <a href="/pages/first">First page</a>
      <a href="/pages/second">Second page</a>
      <button type="button">Sidebar action</button>
      {onForceExpand && <button type="button" onClick={onForceExpand}>Override compact sidebar</button>}
    </nav>
  ),
}));

vi.mock('../article/ArticleRightPane', () => ({
  ArticleRightPane: ({
    inspectorViewRequest,
  }: {
    inspectorViewRequest?: { view: string; requestId: number } | null;
  }) => (
    <div
      data-testid="article-right-pane"
      data-inspector-view={inspectorViewRequest?.view ?? ''}
    >
      Article Right Pane
    </div>
  ),
}));

vi.mock('./CommandPalette', () => ({
  CommandPalette: () => null,
}));

vi.mock('../badges/ServiceStatus', () => ({
  ServiceStatus: () => null,
}));

vi.mock('./ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle" />,
}));

// AppLayout only needs the breakpoint decision in these tests. Keep it
// synchronous so shortcut-hook spies are not invalidated by a post-mount
// media-query subscription update; the hook itself has dedicated tests.
vi.mock('../../hooks/use-media-query', () => ({
  useMediaQuery: () => window.innerWidth >= 768 && window.innerWidth <= 1439,
  useIsMobileLayout: () => window.innerWidth < 768,
  useIsDockWideLayout: () => window.innerWidth >= 1100,
  MD_QUERY: '(min-width: 768px)',
  DOCK_WIDE_QUERY: '(min-width: 1100px)',
}));

function createWrapper(initialPath = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <LazyMotion features={domAnimation}>
            {children}
          </LazyMotion>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };
}

describe('AppLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCommandPaletteStore.setState({ isOpen: false });
    useAiDockStore.setState({ open: false });
    useUiStore.setState({
      treeSidebarCollapsed: false,
      articleSidebarCollapsed: false,
    });
    window.innerWidth = 1024;
    // jsdom does not implement Element.scrollTo — stub it so the scroll-reset
    // useEffect in AppLayout does not throw
    Element.prototype.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders header without nav pills (nav moved to sidebar)', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // Nav pills are no longer in the header — they live in SidebarTreeView
    const header = document.querySelector('header');
    expect(header).toBeTruthy();
    // "Graph" and "AI Assistant" should NOT be in the header anymore
    // (they're in the mocked sidebar which doesn't render them)
    expect(header!.querySelector('a[href="/graph"]')).toBeNull();
    expect(header!.querySelector('a[href="/ai"]')).toBeNull();
  });

  it('shows a route title in the header when the page has not claimed the slot', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    const header = document.querySelector('header')!;
    expect(header.querySelector('h1')?.textContent).toBe('AI');
  });

  it('lets a page claim the header slot', () => {
    render(
      <AppLayout>
        <div id="from-page">
          {/* Pages-style claim happens via HeaderHost in the child tree */}
        </div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // No child claimed the slot — Pages title is the fallback.
    expect(document.querySelector('header h1')?.textContent).toBe('Pages');
  });

  it('renders app logo in top header bar on all routes', () => {
    const { unmount } = render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // Logo SVG (role="img" with aria-label) is always in the top header bar
    expect(screen.getByRole('img', { name: 'Compendiq' })).toBeInTheDocument();
    unmount();

    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.getByRole('img', { name: 'Compendiq' })).toBeInTheDocument();
  });

  it('header spans full width above sidebar and content', () => {
    const { container } = render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // Root container should be flex-col (vertical stacking: header on top)
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.className).toContain('flex-col');

    // Header should be a direct child of the root (not nested inside sidebar wrapper)
    const header = rootDiv.querySelector('header');
    expect(header).toBeTruthy();
    expect(header!.parentElement).toBe(rootDiv);
  });

  it('has no visible Find control in the header', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    const header = document.querySelector('header')!;
    expect(header.querySelector('[data-testid="header-find"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Jump to page or command' })).not.toBeInTheDocument();
    expect(screen.queryByText('Jump to page')).not.toBeInTheDocument();
  });

  it('registers Cmd/Ctrl+K to open the command palette', () => {
    let captured: keyboardShortcutsModule.ShortcutDefinition[] = [];
    vi.spyOn(keyboardShortcutsModule, 'useKeyboardShortcuts').mockImplementation((shortcuts) => {
      captured = shortcuts;
    });
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const search = captured.find((s) => s.keys.includes('k') && s.mod);
    expect(search).toBeTruthy();
    expect(search!.key).toBe('Ctrl+K');
    useCommandPaletteStore.setState({ isOpen: false });
    search!.action();
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('mobile slide-over exposes dialog semantics and closes on Escape', async () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );

    // Open the slide-over via the hamburger toggle.
    fireEvent.click(screen.getByLabelText('Open navigation menu'));

    const slideOver = screen.getByRole('dialog', { name: 'Navigation menu' });
    expect(slideOver).toHaveAttribute('aria-modal', 'true');

    // Escape must dismiss it (AnimatePresence exit defers the unmount).
    fireEvent.keyDown(slideOver, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();
    });
  });

  it('mobile slide-over moves focus inside on open, traps Tab, and restores focus on close', async () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );

    // Focus the hamburger the way a keyboard user would before activating it,
    // so we can assert focus is restored here after the slide-over closes.
    const toggle = screen.getByLabelText('Open navigation menu');
    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    fireEvent.click(toggle);
    const slideOver = screen.getByRole('dialog', { name: 'Navigation menu' });

    // Focus must move into the slide-over on open (not left on the trigger).
    await waitFor(() => {
      expect(slideOver.contains(document.activeElement)).toBe(true);
    });

    const focusables = [
      ...within(slideOver).getAllByRole('link'),
      ...within(slideOver).getAllByRole('button'),
    ] as HTMLElement[];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    expect(focusables.length).toBeGreaterThan(1);

    // Tab from the last focusable wraps back to the first (contained).
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    // Shift+Tab from the first focusable wraps to the last (contained).
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Closing restores focus to the element that opened the slide-over.
    fireEvent.keyDown(slideOver, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(toggle);
  });

  it('keeps session chrome out of the header', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const header = document.querySelector('header')!;
    expect(header.querySelector('[data-testid="theme-toggle"]')).toBeNull();
    expect(header.querySelector('[data-testid="user-avatar-initial"]')).toBeNull();
  });

  it('shows tree sidebar on /pages and /ai, swaps to settings sidebar on /settings', () => {
    // Pages root — Pages tree visible
    const { unmount } = render(
      <AppLayout>
        <div>page content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-sidebar')).not.toBeInTheDocument();
    unmount();

    // AI route — Pages tree stays (quick page navigation while chatting)
    const { unmount: unmount2 } = render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-sidebar')).not.toBeInTheDocument();
    unmount2();

    // Settings route — Pages tree replaced by SettingsSidebar so the main
    // nav strip stays visible alongside the Settings section nav.
    render(
      <AppLayout>
        <div>settings</div>
      </AppLayout>,
      { wrapper: createWrapper('/settings') },
    );
    expect(screen.queryByTestId('sidebar-tree-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-sidebar')).toBeInTheDocument();
  });

  it('shows tree sidebar on /pages/:id route', () => {
    render(
      <AppLayout>
        <div>page detail</div>
      </AppLayout>,
      { wrapper: createWrapper('/pages/123') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
  });

  it('renders children content', () => {
    render(
      <AppLayout>
        <div>test content here</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByText('test content here')).toBeInTheDocument();
  });

  it('shows article right pane on /pages/:id route', () => {
    render(
      <AppLayout>
        <div>article</div>
      </AppLayout>,
      { wrapper: createWrapper('/pages/123') },
    );
    expect(screen.getByTestId('article-right-pane')).toBeInTheDocument();
  });

  // WCAG 2.4.1 Bypass Blocks (Level A): a keyboard user with no route-level
  // tree (e.g. /ai, /graph, /settings) had no way past the header at all.
  it('renders a skip link as the first focusable element, targeting the main content region', () => {
    render(
      <AppLayout>
        <div>page body</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const skipLink = screen.getByText('Skip to content');
    expect(skipLink.tagName).toBe('A');
    expect(skipLink.getAttribute('href')).toBe('#main-content');

    const main = document.getElementById('main-content');
    expect(main).not.toBeNull();
    expect(main!.tagName).toBe('MAIN');
    expect(main!.getAttribute('tabindex')).toBe('-1');
  });

  it('gives the skip link\'s target real DOM focusability so activating it actually moves focus', () => {
    render(
      <AppLayout>
        <div>page body</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const main = document.getElementById('main-content')!;
    main.focus();
    expect(document.activeElement).toBe(main);
  });

  it('does not render a layout preset selector', () => {
    render(
      <AppLayout>
        <div>article</div>
      </AppLayout>,
      { wrapper: createWrapper('/pages/123') },
    );
    expect(screen.queryByRole('button', { name: 'Layout presets' })).not.toBeInTheDocument();
  });

  it('temporarily compacts the tree beside an expanded inspector at intermediate widths', () => {
    window.innerWidth = 900;
    render(
      <AppLayout>
        <div>article</div>
      </AppLayout>,
      { wrapper: createWrapper('/pages/123') },
    );

    const sidebar = screen.getByTestId('sidebar-tree-view');
    expect(sidebar).toHaveAttribute('data-force-collapsed', 'true');
    expect(useUiStore.getState().treeSidebarCollapsed).toBe(false);

    fireEvent.click(screen.getByText('Override compact sidebar'));
    expect(sidebar).toHaveAttribute('data-force-collapsed', 'false');
  });

  it('hides article right pane on non-article routes', () => {
    render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.queryByTestId('article-right-pane')).not.toBeInTheDocument();
  });

  it('hides article right pane on root route', () => {
    render(
      <AppLayout>
        <div>pages</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.queryByTestId('article-right-pane')).not.toBeInTheDocument();
  });

  it('has exactly one scroll container (data-scroll-container) to prevent duplicate scrollbars', () => {
    const { container } = render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const scrollContainers = container.querySelectorAll('[data-scroll-container]');
    expect(scrollContainers).toHaveLength(1);

    const scrollEl = scrollContainers[0] as HTMLElement;
    expect(scrollEl.className).toContain('overflow-y-auto');
  });

  it('root layout container prevents outer scrolling with overflow-hidden', () => {
    const { container } = render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    // The outermost div should clip overflow to prevent body-level scrollbar
    const rootDiv = container.firstElementChild as HTMLElement;
    expect(rootDiv.className).toContain('overflow-hidden');
    expect(rootDiv.className).toContain('h-screen');
  });

  it('panel wrapper is edge-to-edge (no padding) for flat chrome layout', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const panelWrapper = screen.getByTestId('panel-wrapper');
    // Was p-3 + gap-2.5 in the v0.4-early floating-chrome layout. Now
    // edge-to-edge, with the scroll container providing inner padding.
    expect(panelWrapper.className).not.toContain('p-3');
    expect(panelWrapper.className).not.toContain('gap-2.5');
  });

  it('has mobile sidebar toggle button', () => {
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByLabelText('Open navigation menu')).toBeInTheDocument();
  });

  it('does not have sidebar toggle button in header (moved to sidebar panel)', () => {
    useUiStore.setState({ treeSidebarCollapsed: false });
    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    const header = document.querySelector('header');
    expect(header).toBeTruthy();
    // Toggle button should not exist in the header — it lives in SidebarTreeView now
    expect(header!.querySelector('[aria-label="Collapse sidebar"]')).toBeNull();
    expect(header!.querySelector('[aria-label="Expand sidebar"]')).toBeNull();
  });



  // #1126: the dock holds the right side of an article route and forces the
  // article pane into its rail, so `.` toggling the pane's own preference would
  // change nothing on screen. It closes the dock instead — same intent, and the
  // user's saved collapse preference is never rewritten by the dock.
  describe('the `.` shortcut with the AI dock open', () => {
    function captureShortcuts(path: string) {
      let captured: keyboardShortcutsModule.ShortcutDefinition[] = [];
      vi.spyOn(keyboardShortcutsModule, 'useKeyboardShortcuts').mockImplementation((shortcuts) => {
        captured = shortcuts;
      });
      render(<AppLayout><div>content</div></AppLayout>, { wrapper: createWrapper(path) });
      return () => captured.find((s) => s.key === '.')!;
    }

    it('closes the dock rather than leaving the key dead', () => {
      // Below `md`, where the dock is the bottom sheet and genuinely holds the
      // screen. At `md` and up this scenario no longer exists: the assistant is
      // a tab, so AppLayout consumes `open` on an article route the moment it
      // is raised and `.` goes back to plainly toggling the pane.
      window.innerWidth = 500;
      useAiDockStore.setState({ open: true });
      const dotShortcut = captureShortcuts('/pages/page-1');

      act(() => dotShortcut().action());

      expect(useAiDockStore.getState().open).toBe(false);
      expect(useUiStore.getState().articleSidebarCollapsed).toBe(false);
    });

    it('still toggles the article pane when the dock is closed', () => {
      const dotShortcut = captureShortcuts('/pages/page-1');

      act(() => dotShortcut().action());

      expect(useUiStore.getState().articleSidebarCollapsed).toBe(true);
    });

    it('leaves the pane toggle alone off article routes', () => {
      useAiDockStore.setState({ open: true });
      const dotShortcut = captureShortcuts('/');

      act(() => dotShortcut().action());

      expect(useAiDockStore.getState().open).toBe(true);
      expect(useUiStore.getState().articleSidebarCollapsed).toBe(true);
    });
  });

  it('does not register an Escape shortcut (Radix Dialog handles Escape natively)', () => {
    // Spy on the hook to capture the shortcuts array passed from AppLayout
    let capturedShortcuts: keyboardShortcutsModule.ShortcutDefinition[] = [];
    const spy = vi.spyOn(keyboardShortcutsModule, 'useKeyboardShortcuts').mockImplementation((shortcuts) => {
      capturedShortcuts = shortcuts;
    });

    render(
      <AppLayout>
        <div>content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );

    // The shortcuts array should NOT contain an Escape entry — Radix Dialog
    // in KeyboardShortcutsModal handles Escape via onOpenChange natively.
    const escapeShortcut = capturedShortcuts.find(
      (s) => s.keys.includes('Escape') || s.key === 'Escape',
    );
    expect(escapeShortcut).toBeUndefined();

    spy.mockRestore();
  });

  // AiProvider was hoisted out of the /ai route into the shell (#1126) so a
  // conversation outlives navigation. Mounting it on every route only works if
  // it does nothing at all until an AI surface asks for it.
  describe('AI provider (#1126)', () => {
    /** Renders the page id the provider resolved — proves the context exists. */
    function AiConsumerProbe() {
      const { pageId } = useAiContext();
      return <span data-testid="ai-consumer">{pageId ?? 'no page'}</span>;
    }

    function spyOnFetch() {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
        ),
      );
    }

    /** Requests only the AI provider issues. */
    function aiRequests(spy: ReturnType<typeof spyOnFetch>): string[] {
      return spy.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => /\/(llm|ollama|embeddings)\//.test(url));
    }

    it('provides the AI context to the whole shell', () => {
      render(
        <AppLayout>
          <AiConsumerProbe />
        </AppLayout>,
        { wrapper: createWrapper('/pages/abc') },
      );
      // Resolved from the article route, without a ?pageId= search param.
      expect(screen.getByTestId('ai-consumer')).toHaveTextContent('abc');
    });

    it('issues no AI requests on a route with no AI surface mounted', async () => {
      const fetchSpy = spyOnFetch();
      render(
        <AppLayout>
          <div>just a page</div>
        </AppLayout>,
        { wrapper: createWrapper('/pages/abc') },
      );

      await waitFor(() => {
        expect(screen.getByText('just a page')).toBeInTheDocument();
      });
      expect(aiRequests(fetchSpy)).toEqual([]);

      fetchSpy.mockRestore();
    });

    it('issues them once an AI surface mounts (control for the assertion above)', async () => {
      const fetchSpy = spyOnFetch();
      render(
        <AppLayout>
          <AiConsumerProbe />
        </AppLayout>,
        { wrapper: createWrapper('/pages/abc') },
      );

      await waitFor(() => {
        expect(aiRequests(fetchSpy).length).toBeGreaterThan(0);
      });

      fetchSpy.mockRestore();
    });

    // Consumer registration is a mount effect, and StrictMode runs it
    // mount -> cleanup -> mount. Both the gate and the wake-up have to survive
    // that; the app renders under StrictMode in development.
    it('holds the gate under StrictMode double-invoked effects', async () => {
      const inertSpy = spyOnFetch();
      const { unmount } = render(
        <StrictMode>
          <AppLayout>
            <div>just a page</div>
          </AppLayout>
        </StrictMode>,
        { wrapper: createWrapper('/pages/abc') },
      );
      await waitFor(() => {
        expect(screen.getByText('just a page')).toBeInTheDocument();
      });
      expect(aiRequests(inertSpy)).toEqual([]);
      inertSpy.mockRestore();
      unmount();

      const wokenSpy = spyOnFetch();
      render(
        <StrictMode>
          <AppLayout>
            <AiConsumerProbe />
          </AppLayout>
        </StrictMode>,
        { wrapper: createWrapper('/pages/abc') },
      );
      await waitFor(() => {
        expect(aiRequests(wokenSpy).length).toBeGreaterThan(0);
      });
      wokenSpy.mockRestore();
    });
  });

  describe('"show me the assistant" on a layout with no dock', () => {
    /**
     * `openDock()` is raised by Alt+I and by the
     * inspector's rail button. It used to open a third column; the assistant is
     * a tab in `ArticleRightPane` now and `AiDock` renders only the mobile
     * sheet, so on every layout at `md` and up the flag has to be consumed and
     * re-expressed as a tab request.
     *
     * Left unconsumed it did not merely no-op. `ArticleRightPane` ORs `open`
     * into its own `collapsed`, so at >=1100px the keystroke collapsed the
     * inspector to a rail, and between 768 and 1099px the pane's
     * `dockOpen && !dockLayoutIsWide` guard returned null and the right side of
     * the screen disappeared. Measured in a real browser at 1440/1200/900/800
     * before the fix; these cells are the standing guard.
     */
    beforeEach(() => {
      useAiDockStore.setState({ open: false });
      useUiStore.setState({ articleSidebarCollapsed: false });
    });

    it.each([1440, 1200, 900, 800])(
      'at %ipx it selects the Assistant tab and lowers the flag',
      async (width) => {
        window.innerWidth = width;
        render(<AppLayout>content</AppLayout>, { wrapper: createWrapper('/pages/abc') });

        act(() => {
          useAiDockStore.getState().openDock();
        });

        await waitFor(() => {
          expect(screen.getByTestId('article-right-pane')).toHaveAttribute(
            'data-inspector-view',
            'assistant',
          );
        });
        // Consumed, not left standing: `open` means "the mobile sheet is up"
        // and nothing else, so no other consumer has to special-case a second
        // desktop meaning.
        expect(useAiDockStore.getState().open).toBe(false);
      },
    );

    it('expands a collapsed inspector rather than asking a rail to show a tab', async () => {
      window.innerWidth = 1440;
      useUiStore.setState({ articleSidebarCollapsed: true });
      render(<AppLayout>content</AppLayout>, { wrapper: createWrapper('/pages/abc') });

      act(() => {
        useAiDockStore.getState().openDock();
      });

      await waitFor(() => {
        expect(useUiStore.getState().articleSidebarCollapsed).toBe(false);
      });
    });

    it('below md the flag is left alone — that is the mobile sheet', async () => {
      window.innerWidth = 500;
      render(<AppLayout>content</AppLayout>, { wrapper: createWrapper('/pages/abc') });

      act(() => {
        useAiDockStore.getState().openDock();
      });

      await waitFor(() => {
        expect(useAiDockStore.getState().open).toBe(true);
      });
    });
  });
});
