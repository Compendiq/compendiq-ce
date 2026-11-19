import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth-store';
import { withAuthCookieLock } from '../../shared/lib/auth-cookie-lock';
import {
  CLIENT_RELOAD_REQUIRED_MESSAGE,
  isClientReloadRequired,
  reloadPage,
  withClientProtocol,
} from '../../shared/lib/client-protocol';

/**
 * OIDC callback page: exchanges the one-time login code from the URL
 * for JWT tokens via POST /api/auth/oidc/exchange, then stores auth
 * state and redirects to the home page.
 *
 * This route is statically registered in App.tsx so the redirect target
 * exists regardless of edition, but only the EE backend actually handles
 * the /api/auth/oidc/exchange endpoint. In community mode no OIDC login
 * flow can start, so this page is not reached in practice.
 *
 * A 409 `client_reload_required` (#1881) means this bundle predates article
 * AI policy enforcement and the backend refused BEFORE consuming the one-time
 * login code. That path keeps `login_code` in the URL on purpose: reloading
 * loads the policy-aware bundle, which exchanges the same code. Every other
 * failure strips the code as before.
 */
export function OidcCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
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
        // The response sets the refresh cookie: serialize with other tabs'
        // refreshes (see auth-cookie-lock).
        const response = await withAuthCookieLock(() => fetch('/api/auth/oidc/exchange', {
          method: 'POST',
          headers: withClientProtocol({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ code: loginCode }),
          credentials: 'include',
        }));

        if (!response.ok) {
          const body = await response.json().catch(() => ({ message: 'Exchange failed' }));
          if (response.status === 409 && isClientReloadRequired(body)) {
            setReloadRequired(true);
            return;
          }
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
        // Strip the one-time login_code from the URL and browser history on the
        // error path too. The success path already drops it via navigate('/');
        // without this, a failed exchange left ?login_code=… in history and the
        // referrer until the user clicked "Back to Login".
        navigate(location.pathname, { replace: true });
      }
    }

    exchangeCode();
  }, [searchParams, setAuth, navigate, location.pathname]);

  if (reloadRequired) {
    return (
      <div className="bg-background flex min-h-screen items-center justify-center p-4">
        <div className="nm-card w-full max-w-md p-8 text-center" data-testid="oidc-reload-required">
          <h1 className="mb-4 text-xl font-bold text-foreground">Reload to continue</h1>
          <p className="mb-6 text-sm text-muted-foreground" role="alert">
            {CLIENT_RELOAD_REQUIRED_MESSAGE} Your sign-in will complete on the reloaded page.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={reloadPage}
              className="nm-button-primary px-6 py-2"
              data-testid="oidc-reload"
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={() => navigate('/login', { replace: true })}
              className="nm-button-ghost px-6 py-2"
            >
              Back to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

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
