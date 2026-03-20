import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { Search, Menu, X } from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';
import { useUiStore } from '../../../stores/ui-store';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../hooks/use-keyboard-shortcuts';
import { AtlasMindLogo } from '../AtlasMindLogo';
import { CommandPalette } from './CommandPalette';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { ServiceStatus } from '../badges/ServiceStatus';
import { Breadcrumb } from './Breadcrumb';
import { UserMenu } from './UserMenu';
import { SidebarTreeView } from './SidebarTreeView';
import { ArticleRightPane } from '../article/ArticleRightPane';
import { ShortcutHint } from '../ShortcutHint';
import { ThemeToggle } from './ThemeToggle';
import { PageTransition } from './PageTransition';
import { cn } from '../../lib/cn';

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const openCommandPalette = useCommandPaletteStore((s) => s.open);
  const toggleShortcutsModal = useKeyboardShortcutsStore((s) => s.toggle);
  const shortcutsModalOpen = useKeyboardShortcutsStore((s) => s.isOpen);
  const closeShortcutsModal = useKeyboardShortcutsStore((s) => s.close);
  const toggleTreeSidebar = useUiStore((s) => s.toggleTreeSidebar);
  const toggleArticleSidebar = useUiStore((s) => s.toggleArticleSidebar);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isArticleRoute = /^\/pages\/[^/]+$/.test(location.pathname);

  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);

  // Toggle both panels at once (zen mode)
  const toggleBothPanels = useCallback(() => {
    toggleTreeSidebar();
    toggleArticleSidebar();
  }, [toggleTreeSidebar, toggleArticleSidebar]);

  // Navigate to new page
  const navigateToNewPage = useCallback(() => {
    navigate('/pages/new');
  }, [navigate]);

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
      description: 'Toggle right panel (article outline)',
      category: 'panels',
      action: toggleArticleSidebar,
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
    {
      key: 'Escape',
      keys: ['Escape'],
      description: 'Close modals',
      category: 'navigation',
      action: closeShortcutsModal,
    },
  ], [openCommandPalette, toggleShortcutsModal, closeShortcutsModal, toggleTreeSidebar, toggleArticleSidebar, toggleBothPanels, navigateToNewPage]);

  useKeyboardShortcuts(shortcutsModalOpen ? [] : shortcuts);

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

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
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <CommandPalette />
      <KeyboardShortcutsModal />

      {/* Top navigation bar — Liquid Glass floating header */}
      <header className="relative z-10 mx-3 mt-3 flex h-11 shrink-0 items-center rounded-xl glass-header px-4">
        {/* Mobile hamburger — opens sidebar slide-over */}
        <button
          onClick={() => setMobileSidebarOpen((v) => !v)}
          className="glass-button-ghost mr-2 md:hidden"
          aria-label="Toggle sidebar"
        >
          {mobileSidebarOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Logo - always visible in header */}
        <Link to="/" className="flex items-center gap-1.5 mr-3 group">
          <AtlasMindLogo size={20} className="text-primary transition-transform duration-200 group-hover:scale-110" />
          <span className="text-sm font-semibold text-foreground">
            Atlas<span className="font-bold">Mind</span>
          </span>
        </Link>

        {/* Breadcrumb — gets full width now that nav pills moved to sidebar */}
        <div className="flex min-w-0 flex-1 items-center">
          <Breadcrumb />
        </div>

        {/* Center: search bar */}
        <div className="mx-4 hidden min-w-0 flex-1 justify-center sm:flex" role="search">
          <button
            onClick={openCommandPalette}
            aria-label="Search knowledge base"
            className="flex w-full max-w-xl items-center gap-2 rounded-lg border border-border/50 bg-foreground/5 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:border-border"
          >
            <Search size={16} className="shrink-0" />
            <span className="truncate">Search pages, articles, commands...</span>
            <span className="ml-auto shrink-0">
              <ShortcutHint shortcutId="search" />
            </span>
          </button>
        </div>

        {/* Mobile search button (visible on small screens only) */}
        <button
          onClick={openCommandPalette}
          aria-label="Search knowledge base"
          className="ml-auto mr-2 flex items-center rounded-md bg-foreground/5 p-1.5 text-muted-foreground transition-colors hover:bg-foreground/10 sm:hidden"
        >
          <Search size={16} />
        </button>

        {/* Right side: theme + user */}
        <div className="flex items-center gap-3 sm:ml-auto">
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
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 400, damping: 35 }}
              className="fixed inset-y-0 left-0 z-50 w-72 md:hidden"
            >
              <SidebarTreeView onNavigate={closeMobileSidebar} />
            </m.div>
          </>
        )}
      </AnimatePresence>

      {/* Service status banner (Ollama, etc.) — sits between header and panels */}
      <div className="shrink-0 px-4 sm:px-6">
        <ServiceStatus />
      </div>

      {/* Below header: sidebar + content area with floating gaps */}
      <div data-testid="panel-wrapper" className="flex flex-1 gap-2.5 overflow-hidden p-3">
        {/* Left sidebar — always visible on desktop, hidden on mobile (slide-over instead) */}
        <div className="hidden md:flex">
          <SidebarTreeView />
        </div>

        {/* Main content area + optional right sidebar */}
        <div className="flex flex-1 gap-2.5 overflow-hidden">
          <main className="flex flex-1 flex-col overflow-hidden bg-card/5">
            <div ref={scrollContainerRef} data-scroll-container className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 [scrollbar-gutter:stable_both-edges]">
              <PageTransition>
                <div className={cn('mx-auto w-full', isArticleRoute ? 'max-w-[1400px]' : 'max-w-7xl')}>
                  {children}
                </div>
              </PageTransition>
            </div>
          </main>

          {isArticleRoute && <ArticleRightPane />}
        </div>
      </div>
    </div>
  );
}
