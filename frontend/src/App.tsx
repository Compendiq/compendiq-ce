import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useSearchParams } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { useAuthStore } from './stores/auth-store';
import { useSessionInit } from './shared/hooks/useSessionInit';
import { useThemeEffect } from './shared/hooks/useThemeEffect';
import { useTokenRefreshTimer } from './shared/hooks/useTokenRefreshTimer';
import { useSetupStatus } from './shared/hooks/useSetupStatus';
import { AppLayout } from './shared/components/layout/AppLayout';
import { ErrorBoundary } from './shared/components/feedback/ErrorBoundary';

import { LoginPage } from './features/settings/LoginPage';
import { SetupWizard } from './features/setup/SetupWizard';
// Route-based code splitting: lazy-load all page components (#186)
// LoginPage is statically imported — it's the first screen for
// unauthenticated users and lazy-loading it causes a "Loading..." flash.
const SettingsPage = lazy(() =>
  import('./features/settings/SettingsPage').then((m) => ({
    default: m.SettingsPage,
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
export function PageLoadingFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="glass-card p-8 text-center">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    </div>
  );
}

/**
 * SetupRoute — only accessible when setup is NOT complete.
 * Redirects to "/" once setup has been finished.
 */
function SetupRoute({ children }: { children: React.ReactNode }) {
  const { setupComplete, isLoading } = useSetupStatus();
  const [searchParams] = useSearchParams();
  const isRerun = searchParams.get('rerun') === 'true';
  if (isLoading) return <PageLoadingFallback />;
  if (setupComplete && !isRerun) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { setupComplete, isLoading } = useSetupStatus();

  // While checking setup status, show loading
  if (isLoading) return <PageLoadingFallback />;

  // Redirect to setup wizard if setup is not complete
  if (!setupComplete) return <Navigate to="/setup" replace />;

  // accessToken is now persisted in localStorage, so new tabs have it
  // immediately. If the token expired, apiFetch's 401 interceptor or
  // useSessionInit will refresh it transparently.
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  useSessionInit();
  useTokenRefreshTimer();
  useThemeEffect();

  return (
    <LazyMotion features={domAnimation}>
      <ErrorBoundary>
        <Suspense fallback={<PageLoadingFallback />}>
          <Routes>
            <Route path="/setup" element={<SetupRoute><SetupWizard /></SetupRoute>} />
            <Route path="/login" element={<LoginPage />} />
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
                          <Route
                            path="/settings"
                            element={<SettingsPage />}
                          />
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
    </LazyMotion>
  );
}
