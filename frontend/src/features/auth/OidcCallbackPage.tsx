import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth-store';

/**
 * OIDC callback page: exchanges the one-time login code from the URL
 * for JWT tokens via POST /api/auth/oidc/exchange, then stores auth
 * state and redirects to the home page.
 *
 * This route is statically registered in App.tsx so the redirect target
 * exists regardless of edition, but only the EE backend actually handles
 * the /api/auth/oidc/exchange endpoint. In community mode no OIDC login
 * flow can start, so this page is not reached in practice.
 */
export function OidcCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);
  const exchanged = useRef(false);

  useEffect(() => {
    // Prevent double-exchange in React StrictMode
    if (exchanged.current) return;
    exchanged.current = true;

    const loginCode = searchParams.get('login_code');
    if (!loginCode) {
      setError('Missing login code. Please try signing in again.');
      return;
    }

    async function exchangeCode() {
      try {
        const response = await fetch('/api/auth/oidc/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: loginCode }),
          credentials: 'include',
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({ message: 'Exchange failed' }));
          throw new Error(body.message ?? 'SSO login failed');
        }

        const data = await response.json() as {
          accessToken: string;
          user: { id: string; username: string; role: 'user' | 'admin' };
        };

        setAuth(data.accessToken, data.user);
        navigate('/', { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'SSO login failed');
      }
    }

    exchangeCode();
  }, [searchParams, setAuth, navigate]);

  if (error) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-4">
        <div className="nm-card w-full max-w-md p-8 text-center">
          <h1 className="mb-4 text-xl font-bold text-destructive">SSO Login Failed</h1>
          <p className="mb-6 text-sm text-muted-foreground">{error}</p>
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="nm-button-primary px-6 py-2"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="nm-card w-full max-w-md p-8 text-center">
        <div className="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Completing SSO sign-in...</p>
      </div>
    </div>
  );
}
