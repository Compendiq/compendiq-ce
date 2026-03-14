import { useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Home, HardDrive, Globe } from 'lucide-react';
import { usePageBreadcrumb } from '../../hooks/use-standalone';

const routeLabels: Record<string, string> = {
  '/': 'Pages',
  '/pages/new': 'New Page',
  '/ai': 'AI Assistant',
  '/settings': 'Settings',
  '/spaces/new': 'New Space',
};

export function Breadcrumb() {
  const location = useLocation();
  const pathname = location.pathname;

  // Detect if we're viewing a specific page (/pages/:id where :id is numeric)
  const pageId = useMemo(() => {
    const match = pathname.match(/^\/pages\/(\d+)$/);
    return match?.[1];
  }, [pathname]);

  // Fetch hierarchy breadcrumb for page views
  const { data: breadcrumbData } = usePageBreadcrumb(pageId);

  if (pathname === '/') {
    return (
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Home size={14} />
        <span className="text-foreground font-medium">Pages</span>
      </nav>
    );
  }

  // Hierarchy-aware breadcrumb for page views
  if (pageId && breadcrumbData) {
    return (
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
        <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
          <Home size={14} />
        </Link>

        {/* Space link */}
        {breadcrumbData.spaceName && (
          <span className="flex items-center gap-1.5">
            <ChevronRight size={12} className="text-muted-foreground/50" />
            <span className="flex items-center gap-1 text-muted-foreground">
              {breadcrumbData.spaceKey
                ? <Globe size={12} className="text-muted-foreground/70" />
                : <HardDrive size={12} className="text-primary/70" />
              }
              <span className="text-xs">{breadcrumbData.spaceName}</span>
            </span>
          </span>
        )}

        {/* Ancestor pages */}
        {breadcrumbData.ancestors.map((ancestor) => (
          <span key={ancestor.id} className="flex items-center gap-1.5">
            <ChevronRight size={12} className="text-muted-foreground/50" />
            <Link
              to={`/pages/${ancestor.id}`}
              className="text-muted-foreground hover:text-foreground transition-colors max-w-[120px] truncate"
            >
              {ancestor.title}
            </Link>
          </span>
        ))}

        {/* Current page */}
        <span className="flex items-center gap-1.5">
          <ChevronRight size={12} className="text-muted-foreground/50" />
          <span className="text-foreground font-medium max-w-[200px] truncate">
            {breadcrumbData.current.title}
          </span>
        </span>
      </nav>
    );
  }

  // Fallback: route-based breadcrumbs for non-page routes
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
