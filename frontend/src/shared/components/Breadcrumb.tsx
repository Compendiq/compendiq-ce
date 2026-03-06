import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';

const routeLabels: Record<string, string> = {
  '/': 'Dashboard',
  '/pages': 'Pages',
  '/pages/new': 'New Page',
  '/ai': 'AI Assistant',
  '/settings': 'Settings',
};

export function Breadcrumb() {
  const location = useLocation();
  const pathname = location.pathname;

  if (pathname === '/') {
    return (
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Home size={14} />
        <span className="text-foreground font-medium">Dashboard</span>
      </nav>
    );
  }

  const segments = pathname.split('/').filter(Boolean);
  const crumbs: { label: string; path: string; isLast: boolean }[] = [];

  let accumulated = '';
  for (let i = 0; i < segments.length; i++) {
    accumulated += '/' + segments[i];
    const isLast = i === segments.length - 1;

    let label = routeLabels[accumulated];
    if (!label) {
      label = segments[i].split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    crumbs.push({ label, path: accumulated, isLast });
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
      <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
        <Home size={14} />
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.path} className="flex items-center gap-1.5">
          <ChevronRight size={12} className="text-muted-foreground/50" />
          {crumb.isLast ? (
            <span className="text-foreground font-medium">{crumb.label}</span>
          ) : (
            <Link
              to={crumb.path}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
