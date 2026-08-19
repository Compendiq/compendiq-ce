import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';
import { useUiStore } from '../../../stores/ui-store';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../hooks/use-keyboard-shortcuts';
import { CommandPalette } from './CommandPalette';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { ServiceStatus } from '../badges/ServiceStatus';
import { TrialBanner } from '../banners/TrialBanner';
import { SidebarTreeView } from './SidebarTreeView';
import { SettingsSidebar } from './SettingsSidebar';
import {
  ArticleRightPane,
  type InspectorViewRequest,
} from '../article/ArticleRightPane';
import { AiProvider } from '../../../features/ai/AiContext';
import { AiDock } from '../../../features/ai/dock/AiDock';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { Logo } from '../Logo';
import { AppHeaderMain } from './header-slot';
import { HeaderFindButton, HeaderSessionCluster } from './HeaderSessionCluster';
import { MainNavChassisRail } from './MainNavStrip';
import { PageTransition } from './PageTransition';
import { type LayoutPreset } from './LayoutPresetMenu';
import { ArticleLayoutControlsProvider } from './article-layout-controls';
import { useMediaQuery, useIsMobileLayout } from '../../hooks/use-media-query';
import { cn } from '../../lib/cn';
import { isExistingArticlePath } from '../../lib/article-route';

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const openCommandPalette = useCommandPaletteStore((s) => s.open);
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
  const isArticleRoute = isExistingArticlePath(location.pathname);
  const isInspectorCompactLayout = useMediaQuery('(min-width: 768px) and (max-width: 1439px)');
  const isMobileLayout = useIsMobileLayout();
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

    // The AI preset. `setArticleSidebarCollapsed(true)` here was correct when
    // the assistant was its own column and the inspector had to step aside for
    // it; now the assistant IS a tab in that inspector, so collapsing it hid
    // the very thing the preset asks for. The effect below turns `openDock()`
    // into the tab selection on every layout that has an inspector.
    setTreeSidebarCollapsed(false);
    setArticleSidebarCollapsed(false);
    openDock();
    setMidWidthTreeExpandedOverride(false);
  }, [
    closeDock,
    openDock,
    requestInspectorView,
    setArticleSidebarCollapsed,
    setTreeSidebarCollapsed,
  ]);

  // "Show me the assistant" is raised as `openDock()` from three places: Alt+I
  // in PageViewPage, the AI layout preset above, and the inspector's own rail
  // button. Below `md` that still means the bottom sheet, which is all `AiDock`
  // renders now.
  //
  // At `md` and above it can no longer mean "open the dock", because there is
  // no dock: the assistant became a tab inside the inspector and `AiDock`
  // returns null. Left unhandled the flag did real damage — `ArticleRightPane`
  // ORs it into its own `collapsed`, so at >=1100px Alt+I collapsed the
  // inspector to a 40px rail, and between 768 and 1099px the pane's
  // `dockOpen && !dockLayoutIsWide` guard removed the right side of the screen
  // outright. The keystroke destroyed the panel it was supposed to open.
  //
  // So the intent is consumed here and re-expressed as what it now means:
  // show the inspector, select Assistant. Lowering the flag immediately keeps
  // `open` meaning exactly one thing again — "the mobile sheet is up" — rather
  // than a second, contradictory desktop state that every consumer would have
  // to special-case.
  // Gated on `isArticleRoute` as well: the inspector exists only there, so off
  // an article route there is no tab to select and consuming the flag would
  // just stomp the user's saved pane preference on an unrelated page.
  useEffect(() => {
    if (!dockOpen || isMobileLayout || !isArticleRoute) return;
    setArticleSidebarCollapsed(false);
    requestInspectorView('assistant');
    closeDock();
  }, [
    closeDock,
    dockOpen,
    isArticleRoute,
    isMobileLayout,
    requestInspectorView,
    setArticleSidebarCollapsed,
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
      // Research asks for the assistant tab. The dock-open effect below
      // immediately turns `openDock()` into an expanded inspector, so the
      // live match is tree + inspector, same as editing. The request is what
      // distinguishes them; a later manual panel change still clears.
      research: !treeSidebarCollapsed && !articleSidebarCollapsed && !dockOpen,
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
      description: 'Find',
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
    <ArticleLayoutControlsProvider
      value={isArticleRoute
        ? { activePreset: activeLayoutPreset, applyPreset: applyLayoutPreset }
        : null}
    >
    {/* Chassis is the viewport ground. The rounded shell sits inset on
        desktop and goes edge-to-edge below `md`. Do not swap `app-chassis`
        for a `bg-*` utility: the inset padding is part of the same contract. */}
    <div data-testid="app-chassis" className="app-chassis flex h-screen flex-col overflow-hidden">
      {/* WCAG 2.4.1 Bypass Blocks (Level A): the first focusable element in the
          whole app, invisible until it earns focus. Without it a keyboard user
          who lands on an article route has to tab past the header controls and
          the full sidebar tree before reaching the document — the roving
          tabindex on the tree (sidebar-tree-keyboard.ts) fixes the tree itself,
          but this is the only way past the header on routes with no tree at all.
          It lives on the chassis, not inside the overflow-clipped shell. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <CommandPalette />
      <KeyboardShortcutsModal />

      {/* Mobile sidebar slide-over — chassis-level so it covers the inset
          and is not clipped by the shell's overflow:hidden. */}
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
              // The sidebar inside animates to the persisted `treeSidebarWidth`,
              // which clamps at 600 — so a fixed `w-72` (288px) container let a
              // user who had widened the tree on desktop overflow the drawer on
              // a phone. Sizing the drawer to the viewport with a cap contains
              // it, and `overflow-hidden` makes that a clip rather than a
              // horizontal scroll. The sidebar itself carries `max-w-full`.
              className="fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[20rem] overflow-hidden md:hidden"
            >
              {isSettingsRoute
                ? <SettingsSidebar onNavigate={closeMobileSidebar} />
                : <SidebarTreeView onNavigate={closeMobileSidebar} />}
            </m.div>
          </>
        )}
      </AnimatePresence>

      {/* Header sits on the grey chassis, outside the brighter workspace
          card — logo, Find, alerts and the user menu are chrome, not
          document. Height is --app-header-height so the side inset can
          grow without stretching this band. */}
      <header className="app-header relative z-10 grid shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3">
        <div className="flex min-w-0 items-center gap-3">
        {/* Mobile hamburger — opens sidebar slide-over */}
        <button
          type="button"
          onClick={() => setMobileSidebarOpen((v) => !v)}
          className="nm-icon-button md:hidden"
          aria-label={mobileSidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileSidebarOpen}
          aria-controls="mobile-nav-sidebar"
        >
          {mobileSidebarOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        <Link to="/" aria-label="Compendiq home" className="flex shrink-0 items-center group">
          {/* Clip to the Q-tile below `md` so hamburger + lockup + title +
              session cluster fit the 48px. The SVG itself stays the full
              lockup; overflow hides the wordmark rather than squashing it. */}
          <span className="block h-[22px] w-[22px] overflow-hidden md:w-auto">
            <Logo className="h-[22px] w-auto text-foreground" title="Compendiq" />
          </span>
        </Link>

        <AppHeaderMain />
        </div>
        <HeaderFindButton />
        <div className="flex min-w-0 items-center justify-end">
          <HeaderSessionCluster />
        </div>
      </header>

      {/* Service status & notification banners — streamlined compact container */}
      <div className="shrink-0 space-y-1 px-3">
        <ServiceStatus />
        <TrialBanner />
      </div>

      <div data-testid="app-shell" className="app-shell flex min-h-0 flex-1 gap-2 overflow-hidden">
      <MainNavChassisRail />
      <div
        data-testid="panel-wrapper"
        className={cn(
          'flex min-h-0 min-w-0 flex-1 overflow-hidden',
          isArticleRoute && 'app-body-with-rail',
        )}
      >
        <div data-testid="app-workspace" className="app-workspace flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Left sidebar — desktop only (mobile uses the slide-over above).
            On /settings* we swap to SettingsSidebar so the main nav strip
            stays visible alongside the Settings section nav. */}
        <div className="hidden md:flex">
          {isSettingsRoute
            ? <SettingsSidebar embedMainNav={false} />
            : (
              <SidebarTreeView
                embedMainNav={false}
                forceCollapsed={forceTreeCollapsed}
                onForceExpand={() => setMidWidthTreeExpandedOverride(true)}
              />
            )}
        </div>

          {/* The workspace card is one surface: nav and document share
              --app-shell-bg. Painting <main> as bg-card made a second fill
              inside the same rounded card. The chassis is now the ground,
              so the card does not need a pane-within-pane. */}
          <main
            id="main-content"
            // Not natively focusable — the skip link above targets this id and
            // needs an explicit tabIndex to accept programmatic focus at all.
            tabIndex={-1}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-none"
          >
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
        </div>

          {/* Detached context rail. Sits on the chassis beside the brighter
              workspace card, below the header. */}
          {isArticleRoute && (
            <div className="hidden min-h-0 self-stretch md:flex">
              <ArticleRightPane inspectorViewRequest={inspectorViewRequest} />
            </div>
          )}
          {/* No desktop dock column any more: at md and up the assistant is a
              tab inside ArticleRightPane (owner decision, superseding #1126's
              third column). `AiDock` still renders here for its MOBILE form —
              it returns the bottom sheet below md and nothing above it — which
              is the only reachable assistant on a phone, since the inspector
              pane itself is `hidden md:flex`. */}
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
            className="fixed bottom-4 right-4 z-50 flex items-center gap-1.5 nm-card-elevated px-3 py-1.5"
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
    </ArticleLayoutControlsProvider>
    </AiProvider>
  );
}
