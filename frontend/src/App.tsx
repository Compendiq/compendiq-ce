import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LazyMotion, domMax } from 'framer-motion';
import { useAuthStore } from './stores/auth-store';
import { useSessionInit } from './shared/hooks/useSessionInit';
import { useThemeEffect } from './shared/hooks/useThemeEffect';
import { useTokenRefreshTimer } from './shared/hooks/useTokenRefreshTimer';
import { AppLayout } from './shared/components/layout/AppLayout';
import { ErrorBoundary } from './shared/components/feedback/ErrorBoundary';

import { LoginPage } from './features/settings/LoginPage';
import { OidcCallbackPage } from './features/auth/OidcCallbackPage';

// Route-based code splitting: lazy-load all page components (#186)
// LoginPage is statically imported — it's the first screen for
// unauthenticated users and lazy-loading it causes a "Loading..." flash.
// DashboardPage removed — merged into PagesPage (issue #109)
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
const SearchPage = lazy(() =>
  import('./features/search/SearchPage').then((m) => ({
    default: m.SearchPage,
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
const OidcSettingsPage = lazy(() =>
  import('./features/admin/OidcSettingsPage').then((m) => ({
    default: m.OidcSettingsPage,
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

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // accessToken is now persisted in localStorage, so new tabs have it
  // immediately. If the token expired, apiFetch's 401 interceptor or
  // useSessionInit will refresh it transparently.
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  useSessionInit();
  useTokenRefreshTimer();
  useThemeEffect();

  return (
    <LazyMotion features={domMax}>
      <ErrorBoundary>
        <Suspense fallback={<PageLoadingFallback />}>
          <Routes>
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
                          <Route path="/search" element={<SearchPage />} />
                          <Route path="/ai" element={<AiAssistantPage />} />
                          <Route path="/graph" element={<GraphPage />} />
                          <Route path="/spaces/new" element={<NewSpacePage />} />
                          <Route path="/spaces/:key/settings" element={<SpaceSettingsPage />} />
                          <Route
                            path="/settings"
                            element={<SettingsPage />}
                          />
                          <Route
                            path="/settings/oidc"
                            element={<AdminRoute><OidcSettingsPage /></AdminRoute>}
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
