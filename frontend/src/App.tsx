import { Routes, Route, Navigate } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { useAuthStore } from './stores/auth-store';
import { useSessionInit } from './shared/hooks/useSessionInit';
import { useThemeEffect } from './shared/hooks/useThemeEffect';
import { AppLayout } from './shared/components/AppLayout';
import { ErrorBoundary } from './shared/components/ErrorBoundary';
import { LoginPage } from './features/settings/LoginPage';
// DashboardPage removed — merged into PagesPage (issue #109)
import { SettingsPage } from './features/settings/SettingsPage';
import { PagesPage } from './features/pages/PagesPage';
import { PageViewPage } from './features/pages/PageViewPage';
import { NewPagePage } from './features/pages/NewPagePage';
import { AiAssistantPage } from './features/ai/AiAssistantPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // accessToken is now persisted in localStorage, so new tabs have it
  // immediately. If the token expired, apiFetch's 401 interceptor or
  // useSessionInit will refresh it transparently.
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  useSessionInit();
  useThemeEffect();

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
                      <Route path="/" element={<PagesPage />} />
                      <Route path="/pages" element={<Navigate to="/" replace />} />
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
