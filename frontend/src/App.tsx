import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { useAuthStore } from './stores/auth-store';
import { useSessionInit } from './shared/hooks/useSessionInit';
import { AppLayout } from './shared/components/AppLayout';
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import { LoginPage } from './features/settings/LoginPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { PagesPage } from './features/pages/PagesPage';
import { PageViewPage } from './features/pages/PageViewPage';
import { NewPagePage } from './features/pages/NewPagePage';
import { AiAssistantPage } from './features/ai/AiAssistantPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accessToken = useAuthStore((s) => s.accessToken);
  const [restoring, setRestoring] = useState(!accessToken && isAuthenticated);

  useEffect(() => {
    // On page reload, accessToken is null but isAuthenticated is true
    // (persisted in localStorage). Restore the token via refresh cookie.
    if (!accessToken && isAuthenticated) {
      fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('refresh failed'))))
        .then((data) => useAuthStore.getState().setAuth(data.accessToken, data.user))
        .catch(() => useAuthStore.getState().clearAuth())
        .finally(() => setRestoring(false));
    }
  }, [accessToken, isAuthenticated]);

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (restoring) return null;
  return <>{children}</>;
}

export function App() {
  useSessionInit();

  return (
    <LazyMotion features={domAnimation}>
      <ErrorBoundary>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/*"
            element={
              <ProtectedRoute>
                <AppLayout>
                  <ErrorBoundary>
                    <Routes>
                      <Route path="/" element={<DashboardPage />} />
                      <Route path="/pages" element={<PagesPage />} />
                      <Route path="/pages/new" element={<NewPagePage />} />
                      <Route path="/pages/:id" element={<PageViewPage />} />
                      <Route path="/ai" element={<AiAssistantPage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </ErrorBoundary>
                </AppLayout>
              </ProtectedRoute>
            }
          />
        </Routes>
      </ErrorBoundary>
    </LazyMotion>
  );
}
