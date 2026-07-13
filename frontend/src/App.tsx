import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { LazyMotion, MotionConfig, domAnimation } from 'framer-motion';
import { useAuthStore } from './stores/auth-store';
import { useSessionInit } from './shared/hooks/useSessionInit';
import { useClearCacheOnLogout } from './shared/hooks/useClearCacheOnLogout';
import { useThemeEffect } from './shared/hooks/useThemeEffect';
import { useTokenRefreshTimer } from './shared/hooks/useTokenRefreshTimer';
import { useSetupStatus } from './shared/hooks/useSetupStatus';
import { AppLayout } from './shared/components/layout/AppLayout';
import { ErrorBoundary } from './shared/components/feedback/ErrorBoundary';

import { LoginPage } from './features/settings/LoginPage';
import { OidcCallbackPage } from './features/auth/OidcCallbackPage';
import { SetupWizard } from './features/setup/SetupWizard';
// Route-based code splitting: lazy-load all page components (#186)
// LoginPage is statically imported — it's the first screen for
// unauthenticated users and lazy-loading it causes a "Loading..." flash.
const SettingsLayout = lazy(() =>
  import('./features/settings/SettingsLayout').then((m) => ({
    default: m.SettingsLayout,
  })),
);
const SettingsIndexRedirect = lazy(() =>
  import('./features/settings/SettingsLayout').then((m) => ({
    default: m.SettingsIndexRedirect,
  })),
);
const SettingsPanelRoute = lazy(() =>
  import('./features/settings/SettingsPanelRoute').then((m) => ({
    default: m.SettingsPanelRoute,
  })),
);
const PagesPage = lazy(() =>
  import('./features/pages/PagesPage').then((m) => ({
    default: m.PagesPage,
  })),
);
const PageViewPage = lazy(() =>
  import('./features/pages/PageViewPage').then((m) => ({
    default: m.PageViewPage,
  })),
);
const NewPagePage = lazy(() =>
  import('./features/pages/NewPagePage').then((m) => ({
    default: m.NewPagePage,
  })),
);
const AiAssistantPage = lazy(() =>
  import('./features/ai/AiAssistantPage').then((m) => ({
    default: m.AiAssistantPage,
  })),
);
const TrashPage = lazy(() =>
  import('./features/pages/TrashPage').then((m) => ({
    default: m.TrashPage,
  })),
);
const GraphPage = lazy(() =>
  import('./features/graph/GraphPage').then((m) => ({
    default: m.GraphPage,
  })),
);
const NewSpacePage = lazy(() =>
  import('./features/spaces/NewSpacePage').then((m) => ({
    default: m.NewSpacePage,
  })),
);
const SpaceSettingsPage = lazy(() =>
  import('./features/spaces/SpaceSettingsPage').then((m) => ({
    default: m.SpaceSettingsPage,
  })),
);
const AnalyticsPage = lazy(() =>
  import('./features/admin/analytics/AnalyticsPage').then((m) => ({
    default: m.AnalyticsPage,
  })),
);
// AI review detail (Compendiq/compendiq-ee#120). Lives at the app
// level rather than inside SettingsLayout because the side-by-side
// diff needs the full viewport.
const ReviewDetailPage = lazy(() =>
  import('./features/ai/ReviewDetailPage').then((m) => ({
    default: m.ReviewDetailPage,
  })),
);
export function PageLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="nm-card p-8 text-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    </div>
  );
}

/**
 * Terminal error state for SetupRoute: the setup-status fetch failed and we
 * have no cached data to route on. Offers an explicit retry instead of an
 * infinite spinner (useSetupStatus disables refetchOnWindowFocus, so once
 * retries are exhausted nothing would ever recover on its own).
 */
function SetupStatusUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="nm-card p-8 text-center">
        <p className="mb-6 text-sm text-muted-foreground">
          Could not check the setup status. The server may be restarting.
        </p>
        <button onClick={onRetry} className="nm-button-primary">
          Try Again
        </button>
      </div>
    </div>
  );
}

/**
 * SetupRoute — only accessible when setup is NOT complete.
 * Redirects to "/" once setup has been finished.
 */
function SetupRoute({ children }: { children: React.ReactNode }) {
  const { setupComplete, hasData, isLoading, error, refetch } = useSetupStatus();
  const [searchParams] = useSearchParams();
  const isRerun = searchParams.get('rerun') === 'true';
  if (isLoading) return <PageLoadingFallback />;
  // A failed setup-status fetch with no cached data leaves setup state truly
  // unknown. Don't render the first-run wizard on that ambiguity — an already
  // configured instance would otherwise show setup to a real user (#932) —
  // but do offer a retry rather than spinning forever. When React Query still
  // holds stale successful data, fall through and route on that instead.
  if (error && !hasData) return <SetupStatusUnavailable onRetry={() => void refetch()} />;
  if (setupComplete && !isRerun) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { setupComplete, isLoading, error } = useSetupStatus();

  // While checking setup status, show loading
  if (isLoading) return <PageLoadingFallback />;

  // Redirect to the setup wizard only when we positively know setup is
  // incomplete. A failed/undefined setup-status fetch (backend restart,
  // transient 5xx, network blip) must NOT be treated as "setup incomplete":
  // doing so would dump an authenticated user into the first-run wizard and
  // destroy their deep link (#932). Fail safe and fall through instead.
  if (!error && !setupComplete) return <Navigate to="/setup" replace />;

  // Only non-sensitive `user` + `isAuthenticated` persist in localStorage; the
  // access token is memory-only. On reload / new tab, useSessionInit re-mints a
  // token from the httpOnly refresh cookie, and apiFetch's 401 interceptor
  // refreshes an expired one transparently — so an authenticated user is not
  // bounced to /login just because the in-memory token isn't present yet.
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  useSessionInit();
  useClearCacheOnLogout();
  useTokenRefreshTimer();
  useThemeEffect();

  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">
        <ErrorBoundary>
          <Suspense fallback={<PageLoadingFallback />}>
            <Routes>
              <Route path="/setup" element={<SetupRoute><SetupWizard /></SetupRoute>} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/auth/oidc/callback" element={<OidcCallbackPage />} />
              <Route
                path="/*"
                element={
                  <ProtectedRoute>
                    <AppLayout>
                      <ErrorBoundary>
                        <Suspense fallback={<PageLoadingFallback />}>
                          <Routes>
                            <Route path="/" element={<PagesPage />} />
                            <Route
                              path="/pages"
                              element={<Navigate to="/" replace />}
                            />
                            <Route
                              path="/pages/new"
                              element={<NewPagePage />}
                            />
                            <Route
                              path="/pages/:id"
                              element={<PageViewPage />}
                            />
                            <Route path="/trash" element={<TrashPage />} />
                            <Route path="/ai" element={<AiAssistantPage />} />
                            <Route path="/graph" element={<GraphPage />} />
                            <Route path="/spaces/new" element={<NewSpacePage />} />
                            <Route path="/spaces/:key/settings" element={<SpaceSettingsPage />} />
                            <Route path="/admin/analytics" element={<AnalyticsPage />} />
                            <Route
                              path="/settings/ai-reviews/:id"
                              element={<ReviewDetailPage />}
                            />
                            <Route path="/settings" element={<SettingsLayout />}>
                              <Route index element={<SettingsIndexRedirect />} />
                              <Route
                                path=":category/:item"
                                element={<SettingsPanelRoute />}
                              />
                            </Route>
                            <Route
                              path="*"
                              element={<Navigate to="/" replace />}
                            />
                          </Routes>
                        </Suspense>
                      </ErrorBoundary>
                    </AppLayout>
                  </ProtectedRoute>
                }
              />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </MotionConfig>
    </LazyMotion>
  );
}
