import {
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';

export const APP_HEADER_SLOT_ID = 'app-header-slot';

/**
 * Route wayfinding for the app header when a page has not claimed the slot.
 * Article and New Page own their titles in the document, so they stay null.
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

/**
 * Renders into the app header when AppLayout is mounted; otherwise in place
 * so page tests that skip the shell still see the same heading and actions.
 */
export function HeaderHost({
  children,
  fallbackClassName,
}: {
  children: ReactNode | ((portaled: boolean) => ReactNode);
  fallbackClassName?: string;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(() =>
    typeof document === 'undefined' ? null : document.getElementById(APP_HEADER_SLOT_ID),
  );

  useLayoutEffect(() => {
    setTarget(document.getElementById(APP_HEADER_SLOT_ID));
  }, []);

  const node = typeof children === 'function' ? children(Boolean(target)) : children;
  if (target) return createPortal(node, target);
  return <div className={fallbackClassName}>{node}</div>;
}

/** Slot + fallback title. Lives in the 48px app header. */
export function AppHeaderMain() {
  const { pathname } = useLocation();
  const defaultTitle = routeHeaderTitle(pathname);
  const slotRef = useRef<HTMLDivElement>(null);
  const [occupied, setOccupied] = useState(false);

  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    const sync = () => setOccupied(el.childElementCount > 0);
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(el, { childList: true });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div
        ref={slotRef}
        id={APP_HEADER_SLOT_ID}
        data-testid="app-header-slot"
        className="flex min-w-0 flex-1 items-center gap-3 [&_[data-header-kpis]]:max-lg:hidden"
      />
      {!occupied && defaultTitle && (
        <h1 className="min-w-0 truncate text-[15px] font-semibold sm:text-lg">
          {defaultTitle}
        </h1>
      )}
    </>
  );
}
