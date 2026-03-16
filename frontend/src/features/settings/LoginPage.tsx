import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuthStore } from '../../stores/auth-store';
import { apiFetch } from '../../shared/lib/api';
import { AtlasMindLogo } from '../../shared/components/AtlasMindLogo';

interface OidcConfig {
  enabled: boolean;
  issuer: string | null;
  name: string | null;
}

/** Maps OIDC error codes from callback redirects to user-friendly messages. */
const OIDC_ERROR_MESSAGES: Record<string, string> = {
  oidc_state_invalid: 'SSO session expired. Please try again.',
  oidc_provider_mismatch: 'SSO provider configuration changed. Please try again.',
  oidc_callback_failed: 'SSO authentication failed. Please try again or use local login.',
};

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [oidcConfig, setOidcConfig] = useState<OidcConfig | null>(null);

  // Fetch OIDC config on mount to decide whether to show SSO button
  useEffect(() => {
    fetch('/api/auth/oidc/config')
      .then((r) => r.json())
      .then((data: OidcConfig) => setOidcConfig(data))
      .catch(() => setOidcConfig({ enabled: false, issuer: null, name: null }));
  }, []);

  // Show OIDC error from callback redirect
  useEffect(() => {
    const error = searchParams.get('error');
    if (error && OIDC_ERROR_MESSAGES[error]) {
      toast.error(OIDC_ERROR_MESSAGES[error]);
    }
  }, [searchParams]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login';
      const data = await apiFetch<{ accessToken: string; user: { id: string; username: string; role: 'user' | 'admin' } }>(
        endpoint,
        { method: 'POST', body: JSON.stringify({ username, password }) },
      );
      setAuth(data.accessToken, data.user);
      toast.success(isRegister ? 'Account created' : 'Welcome back');
      navigate('/');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  }

  function handleSsoLogin() {
    // Navigate to backend OIDC authorize endpoint — it redirects to the IdP
    window.location.href = '/api/auth/oidc/authorize';
  }

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="glass-card w-full max-w-md p-8">
        <div className="mb-2 flex flex-col items-center gap-3">
          <AtlasMindLogo size={56} className="text-primary" animated />
          <h1 className="text-center text-2xl font-bold">
            Atlas<span className="font-extrabold">Mind</span>
          </h1>
        </div>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          {isRegister ? 'Create your account' : 'Sign in to your account'}
        </p>

        {/* SSO button — shown when OIDC is enabled */}
        {oidcConfig?.enabled && !isRegister && (
          <>
            <button
              onClick={handleSsoLogin}
              className="mb-4 flex w-full items-center justify-center gap-2 rounded-lg border border-border/50 bg-foreground/5 px-4 py-2.5 text-sm font-medium transition-colors hover:bg-foreground/10"
              data-testid="sso-login-btn"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <polyline points="10 17 15 12 10 7" />
                <line x1="15" y1="12" x2="3" y2="12" />
              </svg>
              Sign in with SSO
            </button>

            <div className="relative mb-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border/50" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-card px-2 text-muted-foreground">or continue with</span>
              </div>
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              className="glass-input"
              placeholder="Enter username"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="glass-input"
              placeholder="Enter password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="glass-button-primary w-full py-2.5"
          >
            {loading ? 'Loading...' : isRegister ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            onClick={() => setIsRegister(!isRegister)}
            className="text-primary hover:underline"
          >
            {isRegister ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </div>
    </div>
  );
}
