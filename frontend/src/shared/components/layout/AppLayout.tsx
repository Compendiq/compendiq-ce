import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { ListTree, Menu, X } from 'lucide-react';
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
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { Logo } from '../Logo';
import { HeaderSessionCluster } from './HeaderSessionCluster';
import { MainNavChassisRail } from './MainNavStrip';
import { PageTransition } from './PageTransition';
import { type LayoutPreset } from './LayoutPresetMenu';
import { ArticleLayoutControlsProvider } from './article-layout-controls';
import { useIsInspectorWideLayout, useIsMobileLayout } from '../../hooks/use-media-query';
import { cn } from '../../lib/cn';
import { isExistingArticlePath } from '../../lib/article-route';

const overlayFocusableSelector =
  'a[href], button:not([disabled]), textarea:not([disabled]), ' +
  'input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Focus containment for a hand-rolled overlay: move focus in on open, trap
 * Tab, Escape to dismiss, restore focus on close. Same contract the mobile
 * navigation drawer and the page inspector sheet both need.
 */
function useOverlayFocusTrap(
  open: boolean,
  panelRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = () =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>(overlayFocusableSelector)) : [];

    (getFocusable()[0] ?? panel)?.focus();

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
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
  }, [open, onClose, panelRef]);
}

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
  const setArticleSidebarLaptopExpanded = useUiStore((s) => s.setArticleSidebarLaptopExpanded);
  const singleKeyShortcutsEnabled = useUiStore((s) => s.singleKeyShortcutsEnabled);
  const dockOpen = useAiDockStore((s) => s.open);
  const openDock = useAiDockStore((s) => s.openDock);
  const closeDock = useAiDockStore((s) => s.closeDock);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [activeLayoutPreset, setActiveLayoutPreset] = useState<LayoutPreset | null>(null);
  const [inspectorViewRequest, setInspectorViewRequest] = useState<InspectorViewRequest | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const mobileSidebarRef = useRef<HTMLDivElement>(null);
  const mobileContextRef = useRef<HTMLDivElement>(null);
  const previousLayoutPathRef = useRef(location.pathname);
  const isArticleRoute = isExistingArticlePath(location.pathname);
  const isMobileLayout = useIsMobileLayout();
  const inspectorWide = useIsInspectorWideLayout();
  const articleSidebarLaptopExpanded = useUiStore((s) => s.articleSidebarLaptopExpanded);
  // On /settings* we swap the Pages tree for a Settings-specific sidebar so
  // the main nav (Pages / AI / Graph) stays accessible — otherwise users land
  // in Settings with no in-rail path back to the rest of the app, since the
  // header breadcrumb was retired in the same change.
  const isSettingsRoute = /^\/settings(\/|$)/.test(location.pathname);

  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);
  const closeMobileContext = useCallback(() => setMobileContextOpen(false), []);
  const openMobileContext = useCallback(() => {
    setMobileSidebarOpen(false);
    setMobileContextOpen(true);
  }, []);
  const toggleMobileContext = useCallback(() => {
    setMobileSidebarOpen(false);
    setMobileContextOpen((open) => !open);
  }, []);

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
      setArticleSidebarLaptopExpanded(true);
      closeDock();
      requestInspectorView('outline');
      return;
    }

    if (preset === 'editing') {
      setTreeSidebarCollapsed(false);
      setArticleSidebarCollapsed(false);
      setArticleSidebarLaptopExpanded(true);
      closeDock();
      requestInspectorView('details');
      return;
    }

    if (preset === 'focus') {
      setTreeSidebarCollapsed(true);
      setArticleSidebarCollapsed(true);
      setArticleSidebarLaptopExpanded(false);
      closeDock();
      return;
    }

    // The AI preset. `setArticleSidebarCollapsed(true)` here was correct when
    // the assistant was its own column and the inspector had to step aside for
    // it; now the assistant IS a tab in that inspector, so collapsing it hid
    // the very thing the preset asks for. The effect below turns `openDock()`
    // into the tab selection on every layout that has an inspector.
    setTreeSidebarCollapsed(false);
    setArticleSidebarCollapsed(false);
    setArticleSidebarLaptopExpanded(true);
    openDock();
  }, [
    closeDock,
    openDock,
    requestInspectorView,
    setArticleSidebarCollapsed,
    setArticleSidebarLaptopExpanded,
    setTreeSidebarCollapsed,
  ]);

  // "Show me the assistant" is raised as `openDock()` from Alt+I, the AI
  // layout preset, and the inspector rail. On an article route it is always
  // consumed here and re-expressed as: show the inspector, select Assistant.
  // Below `md` that is the page-inspector sheet (Outline / Details / Assistant
  // together). At `md` and up it is the detached context rail.
  //
  // Left unconsumed the flag used to do real damage on desktop — the pane
  // ORed it into `collapsed` or unmounted itself — and on a phone it opened
  // an assistant-only bottom sheet while Outline and Details stayed hidden.
  // Lowering it immediately keeps `open` a request, not a second layout
  // state. Off an article route there is no inspector to select, so the flag
  // is left alone.
  useEffect(() => {
    if (!dockOpen || !isArticleRoute) return;
    requestInspectorView('assistant');
    if (isMobileLayout) {
      openMobileContext();
    } else {
      setArticleSidebarCollapsed(false);
      setArticleSidebarLaptopExpanded(true);
    }
    closeDock();
  }, [
    closeDock,
    dockOpen,
    isArticleRoute,
    isMobileLayout,
    openMobileContext,
    requestInspectorView,
    setArticleSidebarCollapsed,
    setArticleSidebarLaptopExpanded,
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
  }, [location.pathname]);

  // `.` means "the page inspector". Below `md` that is the inspector sheet;
  // at `md` and up it is the detached rail. A leftover dock flag is closed
  // first so the key is never dead if a request is still in flight.
  const toggleRightSide = useCallback(() => {
    if (isMobileLayout && isArticleRoute) {
      toggleMobileContext();
      return;
    }
    if (isArticleRoute && useAiDockStore.getState().open) {
      useAiDockStore.getState().closeDock();
      return;
    }
    if (isArticleRoute && !inspectorWide) {
      setArticleSidebarLaptopExpanded(!articleSidebarLaptopExpanded);
      return;
    }
    toggleArticleSidebar();
  }, [
    articleSidebarLaptopExpanded,
    inspectorWide,
    isArticleRoute,
    isMobileLayout,
    setArticleSidebarLaptopExpanded,
    toggleArticleSidebar,
    toggleMobileContext,
  ]);

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
      description: 'Toggle page inspector',
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

  // Close mobile overlays on navigation
  useEffect(() => {
    setMobileSidebarOpen(false);
    setMobileContextOpen(false);
  }, [location.pathname]);

  useOverlayFocusTrap(mobileSidebarOpen, mobileSidebarRef, closeMobileSidebar);
  useOverlayFocusTrap(
    isArticleRoute && isMobileLayout && mobileContextOpen,
    mobileContextRef,
    closeMobileContext,
  );

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
    {/* Chassis is the viewport ground. The rounded shell sits inset on the
        end and bottom on desktop; the destination rail is flush to the start
        edge. Edge-to-edge below `md`. Do not swap `app-chassis` for a `bg-*`
        utility: the inset padding is part of the same contract. */}
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
                ? <SettingsSidebar onNavigate={closeMobileSidebar} embedMainNav />
                : <SidebarTreeView onNavigate={closeMobileSidebar} embedMainNav />}
            </m.div>
          </>
        )}
      </AnimatePresence>

      {/* Mobile page inspector — Outline, Details, and Assistant together.
          Chassis-level so it is not clipped by the shell. Mirrors the left
          nav drawer: same overlay recipe, opposite edge. */}
      <AnimatePresence>
        {isArticleRoute && isMobileLayout && mobileContextOpen && (
          <>
            <m.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden"
              onClick={closeMobileContext}
              aria-hidden="true"
            />
            <m.div
              ref={mobileContextRef}
              id="mobile-context-sidebar"
              role="dialog"
              aria-modal="true"
              aria-label="Page inspector"
              tabIndex={-1}
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              className="fixed inset-y-0 right-0 z-50 flex w-[90vw] max-w-[24rem] flex-col overflow-hidden md:hidden"
            >
              <ArticleRightPane
                inspectorViewRequest={inspectorViewRequest}
                presentation="sheet"
                onRequestClose={closeMobileContext}
              />
            </m.div>
          </>
        )}
      </AnimatePresence>

      {/* Header sits on the grey chassis, outside the brighter workspace
          card — logo, alerts and the user menu are chrome, not
          document. Height is --app-header-height so the side inset can
          grow without stretching this band. */}
      <header className="app-header relative z-10 flex shrink-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-3 md:contents">
        {/* Mobile hamburger — opens sidebar slide-over */}
        <button
          type="button"
          onClick={() => {
            setMobileContextOpen(false);
            setMobileSidebarOpen((v) => !v);
          }}
          className="nm-icon-button md:hidden"
          aria-label={mobileSidebarOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileSidebarOpen}
          aria-controls="mobile-nav-sidebar"
        >
          {mobileSidebarOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Same column as MainNavChassisRail so the mark sits on the grey
            chassis above Pages / AI / Graph instead of a wider header slot
            that made the rail look off-centre. */}
        <Link
          to="/"
          aria-label="Compendiq home"
          data-testid="header-chassis-slot"
          className="flex w-[var(--app-nav-rail-width)] shrink-0 items-center justify-center group"
        >
          {/* Clip to the Q-tile below `md` so hamburger + lockup + session
              controls fit the 60px. The SVG itself stays the full
              lockup; overflow hides the wordmark rather than squashing it. */}
          <span className="block h-[22px] w-[22px] overflow-hidden">
            <Logo className="h-[22px] w-auto text-foreground" title="Compendiq" />
          </span>
        </Link>
        </div>
        <div className="ml-auto flex min-w-0 items-center justify-end gap-1">
          {isArticleRoute && isMobileLayout && (
            <button
              type="button"
              onClick={toggleMobileContext}
              className="nm-icon-button"
              aria-label={mobileContextOpen ? 'Close page inspector' : 'Open page inspector'}
              aria-expanded={mobileContextOpen}
              aria-controls="mobile-context-sidebar"
            >
              {mobileContextOpen ? <X size={18} /> : <ListTree size={18} />}
            </button>
          )}
          <HeaderSessionCluster />
        </div>
      </header>

      {/* Service status & notification banners — streamlined compact container */}
      <div className="shrink-0 space-y-1 px-3">
        <ServiceStatus />
        <TrialBanner />
      </div>

      <div data-testid="app-shell" className="app-shell flex min-h-0 flex-1 overflow-hidden">
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
            : <SidebarTreeView embedMainNav={false} />}
        </div>

          {/* Navigation is quiet chrome; <main> is the brighter content pane.
              They remain one clipped workspace composition, separated by a
              single value step and hairline rather than nested cards or
              elevation. */}
          <main
            id="main-content"
            // Not natively focusable — the skip link above targets this id and
            // needs an explicit tabIndex to accept programmatic focus at all.
            tabIndex={-1}
            className="app-content-pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden focus:outline-none"
          >
            <div
              ref={scrollContainerRef}
              data-scroll-container
              className={cn(
                'flex min-h-0 flex-1 flex-col',
                // Article view owns its own scroller below the 48px strip, so
                // the workspace scrollbar cannot sit beside the toolbar and
                // make the strip look short of the pane edge. Other routes
                // keep this container as the page scroller.
                isArticleRoute
                  ? 'overflow-hidden'
                  : 'overflow-y-auto px-4 pb-5 pt-5 sm:px-6 [scrollbar-gutter:stable_both-edges]',
              )}
            >
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
                <div className={cn('mx-auto flex w-full min-h-0 flex-1 flex-col', isArticleRoute ? 'max-w-none' : 'max-w-7xl')}>
                  {children}
                </div>
              </PageTransition>
            </div>
          </main>
        </div>

          {/* Detached context rail. Sits on the chassis beside the brighter
              workspace card, below the header. Mounted only at md+ so the
              mobile sheet below is the single inspector instance — two
              panes would duplicate tab ids and DockPanel state. */}
          {isArticleRoute && !isMobileLayout && (
            <div className="app-rail-beside min-h-0">
              <ArticleRightPane inspectorViewRequest={inspectorViewRequest} />
            </div>
          )}
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
