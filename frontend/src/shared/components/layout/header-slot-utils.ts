export const APP_HEADER_SLOT_ID = 'app-header-slot';

/**
 * Route wayfinding for the app header when a page has not claimed the slot.
 * New Page claims the slot itself. The article keeps its title in the
 * document, so /pages/:id stays null here.
 */
export function routeHeaderTitle(pathname: string): string | null {
  if (pathname === '/' || pathname === '/pages') return 'Pages';
  if (pathname.startsWith('/ai')) return 'AI';
  if (pathname.startsWith('/graph')) return 'Graph';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/trash')) return 'Trash';
  if (pathname === '/spaces/new') return 'New Space';
  if (pathname.startsWith('/admin/analytics')) return 'Analytics';
  return null;
}
