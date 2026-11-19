import type { LucideIcon } from 'lucide-react';
import type { PAGE_LUCIDE_ICONS } from './page-lucide-icons';

export interface PageLucideCatalog {
  PAGE_LUCIDE_ICONS: typeof PAGE_LUCIDE_ICONS;
  getPageLucideIcon: (id: string) => LucideIcon | null;
}

let cachedCatalog: PageLucideCatalog | null = null;
let inflightLoad: Promise<PageLucideCatalog> | null = null;

export function getCachedPageLucideCatalog(): PageLucideCatalog | null {
  return cachedCatalog;
}

export function loadPageLucideCatalog(): Promise<PageLucideCatalog> {
  if (cachedCatalog) return Promise.resolve(cachedCatalog);
  if (!inflightLoad) {
    inflightLoad = import('./page-lucide-icons')
      .then((mod) => {
        cachedCatalog = {
          PAGE_LUCIDE_ICONS: mod.PAGE_LUCIDE_ICONS,
          getPageLucideIcon: mod.getPageLucideIcon,
        };
        return cachedCatalog;
      })
      .finally(() => {
        inflightLoad = null;
      });
  }
  return inflightLoad;
}
