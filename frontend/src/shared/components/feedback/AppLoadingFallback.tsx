import { useLocation } from 'react-router-dom';
import { Logo } from '../Logo';
import { isAiRoute } from '../../lib/ai-routes';
import { isArticlePath } from '../../lib/article-route';
import { cn } from '../../lib/cn';
import { PageViewSkeleton, SettingsSkeleton, SkeletonChatMessage } from './Skeleton';

function Bone({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('skeleton', className)} />;
}

function BootAnnouncer({ label }: { label: string }) {
  return <span className="sr-only">{label}</span>;
}

function LibraryListSkeleton() {
  return (
    <div data-testid="library-list-skeleton" className="mx-auto w-full max-w-7xl">
      <Bone className="mb-6 h-7 w-40" />
      <div className="mb-4 flex gap-2">
        <Bone className="h-8 w-64 max-w-full" />
        <Bone className="h-8 w-24" />
      </div>
      <div className="space-y-0.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Bone key={i} className="h-11 w-full" />
        ))}
      </div>
    </div>
  );
}

function WorkspaceBones() {
  return (
    <div className="app-shell flex min-h-0 flex-1 overflow-hidden">
      <div
        aria-hidden="true"
        className="hidden w-[var(--app-nav-rail-width)] shrink-0 flex-col items-center gap-3 pt-1 md:flex"
      >
        <Bone className="h-10 w-10 rounded-lg" />
        <Bone className="h-10 w-10 rounded-lg" />
        <Bone className="h-10 w-10 rounded-lg" />
      </div>
      <div className="app-workspace flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <aside
          aria-hidden="true"
          className="hidden w-[282px] shrink-0 flex-col gap-2 border-r border-border p-3 md:flex"
        >
          <Bone className="h-8 w-full" />
          <Bone className="mt-3 h-3 w-16" />
          {Array.from({ length: 10 }).map((_, i) => (
            <Bone key={i} className="h-7 w-full" />
          ))}
        </aside>
        <div className="min-h-0 flex-1 overflow-hidden px-4 pt-5 sm:px-6">
          <LibraryListSkeleton />
        </div>
      </div>
    </div>
  );
}

/**
 * Full-viewport boot state. Replaces the old centered `nm-card` "Loading..."
 * box: the authenticated app already has a chassis, and sitting a card in
 * empty canvas made the first load (and every reload while setup-status
 * resolves) feel like a stalled dialog.
 *
 * `workspace` paints the inset shell so a returning session never leaves the
 * product. `quiet` is the guest/setup wait — brand in the header, no fake
 * navigation that would then jump to login or the wizard.
 */
export function AppBootSkeleton({
  variant = 'workspace',
}: {
  variant?: 'workspace' | 'quiet';
}) {
  const quiet = variant === 'quiet';
  return (
    <div
      data-testid={quiet ? 'quiet-boot-skeleton' : 'app-boot-skeleton'}
      className="app-chassis pointer-events-none flex h-screen flex-col overflow-hidden"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <BootAnnouncer label="Loading Compendiq" />
      <header className="app-header relative z-10 flex shrink-0 items-center px-3">
        <Logo className="h-6 w-auto text-foreground md:ml-3" title="Compendiq" />
      </header>
      {quiet ? null : <WorkspaceBones />}
    </div>
  );
}

/**
 * Inner-route Suspense fallback. AppLayout is already on screen, so this
 * must not re-paint the chassis — only the content pane, matching the
 * destination's own skeleton where one exists.
 */
export function RouteLoadingFallback() {
  const { pathname } = useLocation();

  if (isArticlePath(pathname)) {
    return (
      <div role="status" aria-busy="true" aria-live="polite">
        <BootAnnouncer label="Loading page" />
        <PageViewSkeleton />
      </div>
    );
  }

  if (pathname.startsWith('/settings')) {
    return (
      <div role="status" aria-busy="true" aria-live="polite">
        <BootAnnouncer label="Loading settings" />
        <SettingsSkeleton />
      </div>
    );
  }

  if (isAiRoute(pathname)) {
    return (
      <div
        data-testid="ai-route-skeleton"
        className="space-y-4"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <BootAnnouncer label="Loading conversation" />
        <SkeletonChatMessage />
        <SkeletonChatMessage />
      </div>
    );
  }

  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <BootAnnouncer label="Loading pages" />
      <LibraryListSkeleton />
    </div>
  );
}
