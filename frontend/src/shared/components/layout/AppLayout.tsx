import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { Search, BookOpen, Bot, Menu, X, Share2 } from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { AtlasMindLogo } from '../AtlasMindLogo';
import { CommandPalette } from './CommandPalette';
import { ServiceStatus } from '../badges/ServiceStatus';
import { Breadcrumb } from './Breadcrumb';
import { UserMenu } from './UserMenu';
import { SidebarTreeView } from './SidebarTreeView';
import { ArticleRightPane } from '../article/ArticleRightPane';
// Aurora background removed — replaced with plain background
import { NoiseOverlay } from '../effects/NoiseOverlay';
import { PageTransition } from './PageTransition';
import { cn } from '../../lib/cn';

const navItems = [
  { icon: BookOpen, label: 'Pages', path: '/' },
  { icon: Share2, label: 'Graph', path: '/graph' },
  { icon: Bot, label: 'AI Assistant', path: '/ai' },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const openCommandPalette = useCommandPaletteStore((s) => s.open);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isArticleRoute = /^\/pages\/[^/]+$/.test(location.pathname);

  // Show tree sidebar on page-related routes (/ is now the pages view)
  const showTreeSidebar = location.pathname === '/' || location.pathname.startsWith('/pages');

  // Close mobile menu on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
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

  // Register Cmd/Ctrl+K keyboard shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openCommandPalette();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openCommandPalette]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <NoiseOverlay />
      <CommandPalette />

      {/* Top navigation bar — Liquid Glass floating header */}
      <header className="relative z-10 mx-2 mt-2 flex h-11 shrink-0 items-center rounded-xl glass-header px-4">
        {/* Mobile hamburger */}
        <button
          onClick={() => setMobileMenuOpen((v) => !v)}
          className="glass-button-ghost mr-2 md:hidden"
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Logo - always visible in header */}
        <Link to="/" className="flex items-center gap-1.5 mr-6 group">
          <AtlasMindLogo size={20} className="text-primary transition-transform duration-200 group-hover:scale-110" />
          <span className="text-sm font-semibold text-foreground">
            Atlas<span className="font-bold">Mind</span>
          </span>
        </Link>

        {/* Breadcrumb */}
        <div className="flex items-center">
          <Breadcrumb />
        </div>

        {/* Main navigation — glass pill active states */}
        <nav className="ml-auto hidden items-center gap-1 md:flex">
          {navItems.map(({ icon: Icon, label, path }) => {
            const active =
              path === '/'
                ? location.pathname === '/' || location.pathname.startsWith('/pages')
                : location.pathname.startsWith(path);
            return (
              <Link
                key={path}
                to={path}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                  active
                    ? 'glass-pill-active text-primary font-medium'
                    : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
                )}
              >
                <Icon size={15} className={cn(active && 'drop-shadow-[0_1px_2px_oklch(from_var(--color-primary)_l_c_h_/_0.3)]')} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Right side: search + user */}
        <div className="flex items-center gap-3 ml-3">
          <button
            onClick={openCommandPalette}
            className="flex items-center gap-1.5 rounded-lg bg-foreground/5 px-2.5 py-1 text-xs text-muted-foreground hover:bg-foreground/8 transition-colors"
          >
            <Search size={12} />
            <span className="hidden sm:inline">Search...</span>
            <kbd className="hidden rounded border border-border/50 px-1 py-0.5 text-[10px] sm:inline">
              {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}K
            </kbd>
          </button>
          <UserMenu />
        </div>
      </header>

      {/* Mobile navigation menu */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <m.nav
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden mx-2 mt-1 rounded-xl glass-header md:hidden"
          >
            <div className="space-y-1 p-3">
              {navItems.map(({ icon: Icon, label, path }) => {
                const active =
                  path === '/'
                    ? location.pathname === '/'
                    : location.pathname.startsWith(path);
                return (
                  <Link
                    key={path}
                    to={path}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-4 py-3 text-sm transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                      active
                        ? 'glass-pill-active text-primary font-medium'
                        : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
                    )}
                  >
                    <Icon size={18} />
                    {label}
                  </Link>
                );
              })}
            </div>
          </m.nav>
        )}
      </AnimatePresence>

      {/* Below header: sidebar + content area with floating gaps */}
      <div data-testid="panel-wrapper" className="flex flex-1 gap-1.5 overflow-hidden p-2">
        {/* Left sidebar - below header, only on pages routes */}
        {showTreeSidebar && <SidebarTreeView />}

        {/* Main content area + optional right sidebar */}
        <div className="flex flex-1 gap-1.5 overflow-hidden">
          <main className="flex flex-1 flex-col overflow-hidden rounded-xl bg-card/40">
            <div className="shrink-0 px-4 pt-3 sm:px-6">
              <ServiceStatus />
            </div>
            <div ref={scrollContainerRef} data-scroll-container className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
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
