import { type ReactNode, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { m } from 'framer-motion';
import { Home, Settings, Search, BookOpen, Bot } from 'lucide-react';
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

  // Show tree sidebar on page-related routes
  const showTreeSidebar = location.pathname.startsWith('/pages');

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
      <header className="flex h-12 shrink-0 items-center border-b border-white/10 bg-card/80 px-4 backdrop-blur-md">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2 mr-6">
          <span className="text-sm font-semibold text-foreground">AI KB Creator</span>
        </Link>

        {/* Main navigation */}
        <nav className="flex items-center gap-0.5">
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
                    : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
                )}
              >
                <Icon size={16} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Right side: search + breadcrumb + user */}
        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={openCommandPalette}
            className="flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1 text-xs text-muted-foreground hover:bg-white/10 transition-colors"
          >
            <Search size={12} />
            <span>Search...</span>
            <kbd className="rounded border border-white/10 px-1 py-0.5 text-[10px]">
              {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}K
            </kbd>
          </button>
          <UserMenu />
        </div>
      </header>

      {/* Content area with optional tree sidebar */}
      <div className="flex flex-1 overflow-hidden">
        {/* Tree sidebar - only on pages routes */}
        {showTreeSidebar && <SidebarTreeView />}

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Breadcrumb bar */}
          <div className="flex h-9 shrink-0 items-center border-b border-white/10 bg-card/40 px-4 backdrop-blur-sm">
            <Breadcrumb />
          </div>

          {/* Main content area */}
          <main className="flex flex-1 flex-col overflow-hidden">
            <div className="shrink-0 px-6 pt-3">
              <ServiceStatus />
            </div>
            <m.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className="min-h-0 flex-1 overflow-y-auto p-6"
            >
              {children}
            </m.div>
          </main>
        </div>
      </div>
    </div>
  );
}
