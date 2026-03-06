import { type ReactNode, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { m } from 'framer-motion';
import { Home, Settings, PanelLeftClose, PanelLeft, Search, BookOpen, Bot } from 'lucide-react';
import { useUiStore } from '../../stores/ui-store';
import { useCommandPaletteStore } from '../../stores/command-palette-store';
import { CommandPalette } from './CommandPalette';
import { ServiceStatus } from './ServiceStatus';
import { Breadcrumb } from './Breadcrumb';
import { UserMenu } from './UserMenu';
import { cn } from '../lib/cn';

const navItems = [
  { icon: Home, label: 'Dashboard', path: '/' },
  { icon: BookOpen, label: 'Pages', path: '/pages' },
  { icon: Bot, label: 'AI Assistant', path: '/ai' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  const openCommandPalette = useCommandPaletteStore((s) => s.open);

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
    <div className="mesh-gradient flex h-screen overflow-hidden">
      <CommandPalette />
      {/* Sidebar */}
      <aside
        className={cn(
          'glass-card flex flex-col border-r border-white/10 transition-all duration-300',
          sidebarCollapsed ? 'w-16' : 'w-64',
        )}
      >
        {/* Logo */}
        <div className="flex h-14 items-center justify-between border-b border-white/10 px-5">
          {!sidebarCollapsed && (
            <span className="text-sm font-semibold text-foreground">AI KB Creator</span>
          )}
          <button
            onClick={toggleSidebar}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground"
          >
            {sidebarCollapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>

        {/* Search - opens Command Palette */}
        {!sidebarCollapsed && (
          <div className="border-b border-white/10 p-4">
            <button
              onClick={openCommandPalette}
              className="flex w-full items-center gap-2 rounded-md bg-white/5 px-3 py-2 text-sm text-muted-foreground hover:bg-white/10"
            >
              <Search size={14} />
              <span className="flex-1 text-left">Search...</span>
              <kbd className="rounded border border-white/10 px-1 py-0.5 text-[10px]">
                {navigator.platform?.includes('Mac') ? '\u2318' : 'Ctrl'}K
              </kbd>
            </button>
          </div>
        )}

        {/* Nav */}
        <nav className="flex-1 space-y-1.5 p-3">
          {navItems.map(({ icon: Icon, label, path }) => {
            const active = location.pathname === path;
            return (
              <Link
                key={path}
                to={path}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                  active
                    ? 'bg-primary/15 text-primary'
                    : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
                  sidebarCollapsed && 'justify-center px-2',
                )}
              >
                <Icon size={18} />
                {!sidebarCollapsed && label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main area with top bar */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-14 items-center justify-between border-b border-white/10 bg-card/80 px-6 backdrop-blur-md">
          <Breadcrumb />
          <UserMenu />
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <div className="px-6 pt-4">
            <ServiceStatus />
          </div>
          <m.div
            key={location.pathname}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="p-6"
          >
            {children}
          </m.div>
        </main>
      </div>
    </div>
  );
}
