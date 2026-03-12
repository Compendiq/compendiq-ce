import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { Search, BookOpen, Bot, Menu, X, Share2 } from 'lucide-react';
import { useCommandPaletteStore } from '../../stores/command-palette-store';
import { CommandPalette } from './CommandPalette';
import { ServiceStatus } from './ServiceStatus';
import { Breadcrumb } from './Breadcrumb';
import { UserMenu } from './UserMenu';
import { SidebarTreeView } from './SidebarTreeView';
import { ArticleRightPane } from './ArticleRightPane';
import { AuroraBackground } from './AuroraBackground';
import { NoiseOverlay } from './NoiseOverlay';
import { PageTransition } from './PageTransition';
import { cn } from '../lib/cn';

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
    if (el) el.scrollTop = 0;
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
      <AuroraBackground />
      <NoiseOverlay />
      <CommandPalette />

      {/* Top navigation bar - full width, always on top */}
      <header className="relative z-10 flex h-12 shrink-0 items-center border-b border-border/40 bg-card/80 px-4 backdrop-blur-md">
        {/* Mobile hamburger */}
        <button
          onClick={() => setMobileMenuOpen((v) => !v)}
          className="glass-button-ghost mr-2 md:hidden"
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Logo - always visible in header */}
        <Link to="/" className="flex items-center gap-2 mr-6">
          <span className="text-sm font-semibold text-foreground">AI KB Creator</span>
        </Link>

        {/* Breadcrumb */}
        <div className="flex items-center">
          <Breadcrumb />
        </div>

        {/* Main navigation - hidden on mobile */}
        <nav className="ml-auto hidden items-center gap-0.5 md:flex">
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
                  'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-primary/15 text-primary font-medium'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                )}
              >
                <Icon size={16} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Right side: search + user */}
        <div className="flex items-center gap-3 ml-3">
          <button
            onClick={openCommandPalette}
            className="flex items-center gap-1.5 rounded-md bg-foreground/5 px-2.5 py-1 text-xs text-muted-foreground hover:bg-foreground/10 transition-colors"
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
            className="overflow-hidden border-b border-border/40 bg-card/90 backdrop-blur-md md:hidden"
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
                      'flex items-center gap-3 rounded-lg px-4 py-3 text-sm transition-colors',
                      active
                        ? 'bg-primary/15 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
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

      {/* Below header: sidebar + content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar - below header, only on pages routes */}
        {showTreeSidebar && <SidebarTreeView />}

        {/* Main content area + optional right sidebar */}
        <div className="flex flex-1 overflow-hidden">
          <main className="flex flex-1 flex-col overflow-hidden">
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
