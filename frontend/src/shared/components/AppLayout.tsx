import { type ReactNode, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { Home, Settings, Search, BookOpen, Bot, Menu, X } from 'lucide-react';
import { useCommandPaletteStore } from '../../stores/command-palette-store';
import { CommandPalette } from './CommandPalette';
import { ServiceStatus } from './ServiceStatus';
import { Breadcrumb } from './Breadcrumb';
import { UserMenu } from './UserMenu';
import { SidebarTreeView } from './SidebarTreeView';
import { cn } from '../lib/cn';

const navItems = [
  { icon: Home, label: 'Dashboard', path: '/' },
  { icon: BookOpen, label: 'Pages', path: '/pages' },
  { icon: Bot, label: 'AI Assistant', path: '/ai' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const openCommandPalette = useCommandPaletteStore((s) => s.open);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Show tree sidebar on page-related routes
  const showTreeSidebar = location.pathname.startsWith('/pages');

  // Close mobile menu on navigation
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

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
    <div className="mesh-gradient flex h-screen flex-col overflow-hidden">
      <CommandPalette />

      {/* Top navigation bar */}
      <header className="flex h-12 shrink-0 items-center border-b border-border/50 bg-card/80 px-4 backdrop-blur-md">
        {/* Mobile hamburger */}
        <button
          onClick={() => setMobileMenuOpen((v) => !v)}
          className="glass-button-ghost mr-2 md:hidden"
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>

        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 mr-6">
          <span className="text-sm font-semibold text-foreground">AI KB Creator</span>
        </Link>

        {/* Main navigation - hidden on mobile */}
        <nav className="hidden items-center gap-0.5 md:flex">
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
        <div className="ml-auto flex items-center gap-3">
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
            className="overflow-hidden border-b border-border/50 bg-card/90 backdrop-blur-md md:hidden"
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

      {/* Content area with optional tree sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tree sidebar - only on pages routes, hidden on mobile */}
        {showTreeSidebar && <SidebarTreeView />}

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Breadcrumb bar */}
          <div className="flex h-9 shrink-0 items-center border-b border-border/50 bg-card/40 px-4 backdrop-blur-sm">
            <Breadcrumb />
          </div>

          {/* Main content area */}
          <main className="flex flex-1 flex-col overflow-hidden">
            <div className="shrink-0 px-4 pt-3 sm:px-6">
              <ServiceStatus />
            </div>
            <m.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
            >
              <div className="mx-auto max-w-7xl">
                {children}
              </div>
            </m.div>
          </main>
        </div>
      </div>
    </div>
  );
}
