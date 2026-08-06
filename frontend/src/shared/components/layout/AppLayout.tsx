import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { Search, Menu, X } from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';
import { useUiStore } from '../../../stores/ui-store';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../hooks/use-keyboard-shortcuts';
import { CommandPalette } from './CommandPalette';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { ServiceStatus } from '../badges/ServiceStatus';
import { TrialBanner } from '../banners/TrialBanner';
import { ConfluencePatBanner } from '../banners/ConfluencePatBanner';
import { UserMenu } from './UserMenu';
import { SidebarTreeView } from './SidebarTreeView';
import { SettingsSidebar } from './SettingsSidebar';
import {
  ArticleRightPane,
  type InspectorViewRequest,
} from '../article/ArticleRightPane';
import { AiProvider } from '../../../features/ai/AiContext';
import { AiDock } from '../../../features/ai/dock/AiDock';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { ShortcutHint } from '../ShortcutHint';
import { Logo } from '../Logo';
import { ThemeToggle } from './ThemeToggle';
import { PageTransition } from './PageTransition';
import { LayoutPresetMenu, type LayoutPreset } from './LayoutPresetMenu';
import { useMediaQuery } from '../../hooks/use-media-query';
import { cn } from '../../lib/cn';

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const openCommandPalette = useCommandPaletteStore((s) => s.open);
  const isCommandPaletteOpen = useCommandPaletteStore((s) => s.isOpen);
  const toggleShortcutsModal = useKeyboardShortcutsStore((s) => s.toggle);
  const shortcutsModalOpen = useKeyboardShortcutsStore((s) => s.isOpen);
  const pendingSequence = useKeyboardShortcutsStore((s) => s.pendingSequence);
  const setPendingSequence = useKeyboardShortcutsStore((s) => s.setPendingSequence);
  const toggleTreeSidebar = useUiStore((s) => s.toggleTreeSidebar);
  const toggleArticleSidebar = useUiStore((s) => s.toggleArticleSidebar);
  const treeSidebarCollapsed = useUiStore((s) => s.treeSidebarCollapsed);
  const articleSidebarCollapsed = useUiStore((s) => s.articleSidebarCollapsed);
  const setTreeSidebarCollapsed = useUiStore((s) => s.setTreeSidebarCollapsed);
  const setArticleSidebarCollapsed = useUiStore((s) => s.setArticleSidebarCollapsed);
  const singleKeyShortcutsEnabled = useUiStore((s) => s.singleKeyShortcutsEnabled);
  const dockOpen = useAiDockStore((s) => s.open);
  const openDock = useAiDockStore((s) => s.openDock);
  const closeDock = useAiDockStore((s) => s.closeDock);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [activeLayoutPreset, setActiveLayoutPreset] = useState<LayoutPreset | null>(null);
  const [inspectorViewRequest, setInspectorViewRequest] = useState<InspectorViewRequest | null>(null);
  const [midWidthTreeExpandedOverride, setMidWidthTreeExpandedOverride] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const mobileSidebarRef = useRef<HTMLDivElement>(null);
  const previousLayoutPathRef = useRef(location.pathname);
  const isArticleRoute = /^\/pages\/[^/]+$/.test(location.pathname);
  const isInspectorCompactLayout = useMediaQuery('(min-width: 768px) and (max-width: 1439px)');
  // On /settings* we swap the Pages tree for a Settings-specific sidebar so
  // the main nav (Pages / AI / Graph) stays accessible — otherwise users land
  // in Settings with no in-rail path back to the rest of the app, since the
  // header breadcrumb was retired in the same change.
  const isSettingsRoute = /^\/settings(\/|$)/.test(location.pathname);

  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);

  const requestInspectorView = useCallback((view: InspectorViewRequest['view']) => {
    setInspectorViewRequest((current) => ({
      view,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  }, []);

  const applyLayoutPreset = useCallback((preset: LayoutPreset) => {
    setActiveLayoutPreset(preset);

    if (preset === 'reading') {
      setTreeSidebarCollapsed(true);
      setArticleSidebarCollapsed(false);
      closeDock();
      requestInspectorView('outline');
      setMidWidthTreeExpandedOverride(false);
      return;
    }

    if (preset === 'editing') {
      setTreeSidebarCollapsed(false);
      setArticleSidebarCollapsed(false);
      closeDock();
      requestInspectorView('details');
      // Editing intentionally keeps navigation available even where the
      // inspector would normally compact it for reading room.
      setMidWidthTreeExpandedOverride(true);
      return;
    }

    if (preset === 'focus') {
      setTreeSidebarCollapsed(true);
      setArticleSidebarCollapsed(true);
      closeDock();
      setMidWidthTreeExpandedOverride(false);
      return;
    }

    setTreeSidebarCollapsed(false);
    setArticleSidebarCollapsed(true);
    openDock();
    setMidWidthTreeExpandedOverride(false);
  }, [
    closeDock,
    openDock,
    requestInspectorView,
    setArticleSidebarCollapsed,
    setTreeSidebarCollapsed,
  ]);

  // At intermediate desktop widths, an expanded inspector temporarily turns
  // the left navigation into its rail. This never writes to the persisted UI
  // preference, and the rail's expand control remains an explicit override.
  const forceTreeCollapsed =
    isArticleRoute &&
    isInspectorCompactLayout &&
    !articleSidebarCollapsed &&
    !dockOpen &&
    !midWidthTreeExpandedOverride;

  useEffect(() => {
    if (
      midWidthTreeExpandedOverride &&
      (!isArticleRoute || !isInspectorCompactLayout || articleSidebarCollapsed || dockOpen)
    ) {
      setMidWidthTreeExpandedOverride(false);
    }
  }, [
    articleSidebarCollapsed,
    dockOpen,
    isArticleRoute,
    isInspectorCompactLayout,
    midWidthTreeExpandedOverride,
  ]);

  // A manual panel change means the last command is no longer an exact preset.
  useEffect(() => {
    if (!activeLayoutPreset) return;
    const matches = {
      reading: treeSidebarCollapsed && !articleSidebarCollapsed && !dockOpen,
      editing: !treeSidebarCollapsed && !articleSidebarCollapsed && !dockOpen,
      focus: treeSidebarCollapsed && articleSidebarCollapsed && !dockOpen,
      research: !treeSidebarCollapsed && articleSidebarCollapsed && dockOpen,
    }[activeLayoutPreset];
    if (!matches) setActiveLayoutPreset(null);
  }, [activeLayoutPreset, articleSidebarCollapsed, dockOpen, treeSidebarCollapsed]);

  useEffect(() => {
    if (previousLayoutPathRef.current === location.pathname) return;
    previousLayoutPathRef.current = location.pathname;
    setActiveLayoutPreset(null);
    setMidWidthTreeExpandedOverride(false);
  }, [location.pathname]);

  // `.` means "give me the right side of the screen back". While the docked
  // assistant is open it holds that side and forces the article pane into its
  // rail, so toggling the pane's own preference would do nothing visible — the
  // key would read as broken. Closing the dock is the same intent, and it
  // restores whatever collapse state the user had chosen (#1126).
  const toggleRightSide = useCallback(() => {
    if (isArticleRoute && useAiDockStore.getState().open) {
      useAiDockStore.getState().closeDock();
      return;
    }
    toggleArticleSidebar();
  }, [isArticleRoute, toggleArticleSidebar]);

  // Toggle both panels at once (zen mode)
  const toggleBothPanels = useCallback(() => {
    toggleTreeSidebar();
    toggleRightSide();
  }, [toggleTreeSidebar, toggleRightSide]);

  // Navigate to new page
  const navigateToNewPage = useCallback(() => {
    navigate('/pages/new');
  }, [navigate]);

  // Navigation sequence callbacks
  const goToPages = useCallback(() => navigate('/'), [navigate]);
  const goToGraph = useCallback(() => navigate('/graph'), [navigate]);
  const goToAi = useCallback(() => navigate('/ai'), [navigate]);
  const goToSettings = useCallback(() => navigate('/settings'), [navigate]);
  const goToTrash = useCallback(() => navigate('/trash'), [navigate]);

  // Global keyboard shortcuts
  const shortcuts = useMemo<ShortcutDefinition[]>(() => [
    {
      key: ',',
      keys: [','],
      description: 'Toggle left sidebar',
      category: 'panels',
      action: toggleTreeSidebar,
    },
    {
      key: '.',
      keys: ['.'],
      description: 'Toggle right panel (page outline)',
      category: 'panels',
      action: toggleRightSide,
    },
    {
      key: '\\',
      keys: ['\\'],
      description: 'Toggle both panels (zen mode)',
      category: 'panels',
      action: toggleBothPanels,
    },
    {
      key: 'Ctrl+K',
      keys: ['k'],
      mod: true,
      description: 'Open command palette / quick search',
      category: 'navigation',
      action: openCommandPalette,
    },
    {
      key: 'Alt+N',
      keys: ['n'],
      alt: true,
      description: 'Create new page',
      category: 'navigation',
      action: navigateToNewPage,
    },
    {
      key: '?',
      keys: ['?'],
      description: 'Show keyboard shortcuts',
      category: 'navigation',
      action: toggleShortcutsModal,
    },
    {
      key: 'Ctrl+/',
      keys: ['/'],
      mod: true,
      description: 'Show keyboard shortcuts',
      category: 'navigation',
      action: toggleShortcutsModal,
    },
    // Navigation sequences (G then X)
    {
      key: 'g p',
      keys: [],
      sequence: 'g p',
      description: 'Go to Pages',
      category: 'navigation',
      action: goToPages,
    },
    {
      key: 'g g',
      keys: [],
      sequence: 'g g',
      description: 'Go to Graph',
      category: 'navigation',
      action: goToGraph,
    },
    {
      key: 'g a',
      keys: [],
      sequence: 'g a',
      description: 'Go to AI',
      category: 'navigation',
      action: goToAi,
    },
    {
      key: 'g s',
      keys: [],
      sequence: 'g s',
      description: 'Go to Settings',
      category: 'navigation',
      action: goToSettings,
    },
    {
      key: 'g t',
      keys: [],
      sequence: 'g t',
      description: 'Go to Trash',
      category: 'navigation',
      action: goToTrash,
    },
  ], [openCommandPalette, toggleShortcutsModal, toggleTreeSidebar, toggleRightSide, toggleBothPanels, navigateToNewPage, goToPages, goToGraph, goToAi, goToSettings, goToTrash]);

  useKeyboardShortcuts(
    shortcutsModalOpen ? [] : shortcuts,
    { singleKeyEnabled: singleKeyShortcutsEnabled, onSequenceChange: setPendingSequence },
  );

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  // Focus containment for the mobile slide-over (#942): mirror the hand-rolled
  // dialog treatment ImageLightbox uses — move focus into the panel on open,
  // trap Tab within it, restore focus to the trigger on close — plus the
  // Escape/overlay dismissal. Hand-rolled overlays otherwise strand keyboard
  // and screen-reader users behind the backdrop with no way out.
  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const panel = mobileSidebarRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), ' +
      'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const getFocusable = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)) : [];

    // Move focus into the slide-over on open (first control, or the panel).
    (getFocusable()[0] ?? panel)?.focus();

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMobileSidebar();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const items = getFocusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previouslyFocused?.focus?.();
    };
  }, [mobileSidebarOpen, closeMobileSidebar]);

  // Reset scroll to top on every route change (use location.key so it fires
  // on every navigation, including between same-pathname routes like /pages/id1 → /pages/id2)
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollTop = 0;
      requestAnimationFrame(() => {
        if (el) el.scrollTop = 0;
      });
      // Safety: ensure scroll is at 0 after PageTransition exit animation (220ms)
      const timer = setTimeout(() => {
        if (el) el.scrollTop = 0;
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [location.key]);

  return (
    // AiProvider sits above the whole shell, not inside the /ai route (#1126),
    // so a conversation survives navigation instead of being torn down with
    // the page that started it. It is inert until an AI surface mounts and
    // registers as a consumer — see `retainAi` in AiContext.
    <AiProvider>
    {/* `app-backdrop` (index.css) paints the gradient chassis rather than a flat
        --color-background. It must not be swapped back to a `bg-*` utility:
        those set background-color, which cannot express the gradient. */}
    <div className="app-backdrop flex h-screen flex-col overflow-hidden">
      <CommandPalette />
      <KeyboardShortcutsModal />

      {/* Top navigation bar — a denser mineral surface over the app canvas. */}
      <header className="app-header relative z-10 flex h-[58px] shrink-0 items-center border-b px-4">
        {/* Mobile hamburger — opens sidebar slide-over */}
        <button
          onClick={() => setMobileSidebarOpen((v) => !v)}
          className="nm-icon-button mr-2 md:hidden"
          aria-label={mobileSidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileSidebarOpen}
          aria-controls="mobile-nav-sidebar"
        >
          {mobileSidebarOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Logo - always visible in header */}
        <Link to="/" aria-label="Compendiq home" className="mr-3 flex shrink-0 items-center group">
          <Logo className="h-[26px] w-auto text-foreground" title="Compendiq" />
        </Link>

        {/* Spacer — the in-page breadcrumb was removed; the sidebar carries all
            navigation context now (main nav strip + tree / settings nav). */}
        <div className="flex min-w-0 flex-1 items-center" />


        {/* Center: search bar — absolutely centered in header */}
        <div className="pointer-events-none absolute inset-x-0 hidden justify-center sm:flex" role="search">
          <button
            onClick={openCommandPalette}
            aria-label="Search knowledge base"
            aria-expanded={isCommandPaletteOpen}
            className="app-search pointer-events-auto flex h-9 w-full max-w-xl items-center gap-2 rounded-lg px-3 text-sm"
          >
            <Search size={16} className="shrink-0" />
            <span className="truncate">Search pages, commands...</span>
            <span className="ml-auto shrink-0">
              <ShortcutHint shortcutId="search" />
            </span>
          </button>
        </div>

        {/* Mobile search button (visible on small screens only) */}
        <button
          onClick={openCommandPalette}
          aria-label="Search"
          aria-expanded={isCommandPaletteOpen}
          className="app-search ml-auto mr-2 flex items-center rounded-md p-1.5 sm:hidden"
        >
          <Search size={16} />
        </button>

        {/* Right side: article layout + theme + user */}
        <div className="flex items-center gap-3 sm:ml-auto">
          {isArticleRoute && (
            <LayoutPresetMenu
              activePreset={activeLayoutPreset}
              onSelect={applyLayoutPreset}
            />
          )}
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>

      {/* Mobile sidebar slide-over */}
      <AnimatePresence>
        {mobileSidebarOpen && (
          <>
            {/* Backdrop */}
            <m.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
              onClick={closeMobileSidebar}
              aria-hidden="true"
            />
            {/* Slide-over panel */}
            <m.div
              ref={mobileSidebarRef}
              id="mobile-nav-sidebar"
              role="dialog"
              aria-modal="true"
              aria-label="Navigation menu"
              tabIndex={-1}
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              className="fixed inset-y-0 left-0 z-50 w-72 md:hidden"
            >
              {isSettingsRoute
                ? <SettingsSidebar onNavigate={closeMobileSidebar} />
                : <SidebarTreeView onNavigate={closeMobileSidebar} />}
            </m.div>
          </>
        )}
      </AnimatePresence>

      {/* Service status banner (Ollama, etc.) — sits between header and panels */}
      <div className="shrink-0 px-4 sm:px-6">
        <ServiceStatus />
        <TrialBanner />
        <ConfluencePatBanner />
      </div>

      {/* Below header: sidebar + content area, edge-to-edge with borders. */}
      <div data-testid="panel-wrapper" className="flex flex-1 overflow-hidden">
        {/* Left sidebar — desktop only (mobile uses the slide-over above).
            On /settings* we swap to SettingsSidebar so the main nav strip
            stays visible alongside the Settings section nav. */}
        <div className="hidden md:flex">
          {isSettingsRoute
            ? <SettingsSidebar />
            : (
              <SidebarTreeView
                forceCollapsed={forceTreeCollapsed}
                onForceExpand={() => setMidWidthTreeExpandedOverride(true)}
              />
            )}
        </div>

        {/* Main content area + optional right sidebar */}
        <div className="flex flex-1 overflow-hidden">
          <main className="flex flex-1 flex-col overflow-hidden">
            <div ref={scrollContainerRef} data-scroll-container className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-5 pt-5 sm:px-6 [scrollbar-gutter:stable_both-edges]">
              <PageTransition>
                {/* flex flex-1 flex-col so pages that opt in (e.g. /ai) can use
                    flex-1 on a child to fill the available scroll height
                    without resorting to a `calc(100vh - chrome)` magic number.
                    Pages that don't opt in render with natural flow as before.

                    min-h-0 is one link of a four-link chain (#1218): a flex
                    item's automatic minimum size refuses to shrink below its
                    content, so this wrapper alone kept /ai's column growing to
                    its content and left this scroll container — not the
                    message pane — as the thing that scrolls. The chain is
                    scroll container -> PageTransition -> this wrapper ->
                    AiAssistantPage's page root -> the pane's own scroller;
                    every link is load-bearing, three of four fixes nothing.
                    It stays out of the max-width ternary on purpose: a link
                    that only holds on one route is not a link. Guarded by name
                    in `src/ai-scroll-chain.test.ts`.

                    Two measured side effects.

                    (1) On every route that does NOT cap its own height, the
                    content now overflows this clamped box with
                    `overflow: visible` instead of sizing it, and a scroll
                    container's end padding is not part of the scrollable
                    overflow an overflowing descendant contributes. The `pb-5`
                    below is therefore unreachable at the scroll end: the loss
                    is exactly -20px, always, on every long page. What is left
                    is whatever trailing space the last element carries itself,
                    so it is shape-dependent — 36px becomes 16px where the page
                    body has its own py-4, and on the `space-y-6` routes
                    (`/`, `/trash`, `/admin/analytics`), where a space-y stack
                    puts no margin after its last child, 20px becomes 0 and the
                    last row sits flush on the clip edge. Scrolling,
                    reachability of the last element and #1186's toolbar mask
                    are unchanged. Restoring it means moving or re-scoping this
                    container's padding, which is shared by every route —
                    rejected in #1218 as route-wide collateral for a
                    page-specific bug.

                    (2) The clamp propagates only into routes that cap their
                    own height — /ai (flex-1 chain) and /graph (h-full) — and
                    inside those, a cross-axis-stretched box with a visible
                    border and no overflow paints its excess content straight
                    past that border. All three such boxes handle it: /ai's
                    message pane scrolls, GraphPage's canvas is
                    overflow-hidden, and its filter sidebar became
                    overflow-y-auto in #1218 (it spilled 39px at 1440x560
                    before). A new one is the thing to check when adding a
                    height-capping page. */}
                <div className={cn('mx-auto flex w-full min-h-0 flex-1 flex-col', isArticleRoute ? 'max-w-[1400px]' : 'max-w-7xl')}>
                  {children}
                </div>
              </PageTransition>
            </div>
          </main>

          {/* Rail then dock, in that order: the assistant is the outermost
              column. Both are siblings of <main> in the same flex row, so the
              editor column flex-shrinks around them and each panel scrolls
              independently — the dock is part of the layout, not an overlay
              floating above it (#1126). */}
          {isArticleRoute && <ArticleRightPane inspectorViewRequest={inspectorViewRequest} />}
          {isArticleRoute && <AiDock />}
        </div>
      </div>

      {/* Pending sequence indicator (bottom-right) */}
      <AnimatePresence>
        {pendingSequence && (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 rounded-lg bg-card border border-border px-3 py-1.5 shadow-lg"
            role="status"
            aria-live="polite"
          >
            <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-border bg-muted px-1.5 text-xs font-medium text-muted-foreground">
              {pendingSequence.toUpperCase()}
            </kbd>
            <span className="text-xs text-muted-foreground">...</span>
          </m.div>
        )}
      </AnimatePresence>
    </div>
    </AiProvider>
  );
}
