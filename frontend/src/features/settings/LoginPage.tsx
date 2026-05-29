import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuthStore } from '../../stores/auth-store';
import { apiFetch } from '../../shared/lib/api';

interface OidcConfig {
  enabled: boolean;
  issuer: string | null;
  name: string | null;
  enterpriseRequired: boolean;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [oidcConfig, setOidcConfig] = useState<OidcConfig | null>(null);

  useEffect(() => {
    const searchError = searchParams.get('error');
    if (searchError) {
      toast.error(`SSO login failed: ${searchError}`);
      // Clear the error param so a refresh doesn't re-trigger the toast.
      navigate('/login', { replace: true });
    }
  }, [searchParams, navigate]);

  useEffect(() => {
    async function fetchOidcConfig() {
      try {
        const config = await apiFetch<OidcConfig>('/auth/oidc/config');
        setOidcConfig(config);
      } catch {
        // If the config fetch fails (e.g. OIDC route absent in CE), leave the SSO button hidden.
      }
    }
    fetchOidcConfig();
  }, []);

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

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-border/40 bg-card/50 p-8 backdrop-blur-sm">
        <div className="mb-2 flex flex-col items-center">
          <img
            src="/compendiq-lockup-horizontal.svg"
            alt="Compendiq"
            className="h-16 w-auto"
          />
        </div>
        <p className="mb-8 text-center text-sm text-muted-foreground">
          {isRegister ? 'Create your account' : 'Sign in to your account'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-username" className="mb-1.5 block text-sm font-medium">Username</label>
            <input
              id="login-username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
              className="nm-input"
              placeholder="Enter username"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="mb-1.5 block text-sm font-medium">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="nm-input"
              placeholder="Enter password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="nm-button-primary w-full py-2.5"
          >
            {loading ? 'Loading...' : isRegister ? 'Create Account' : 'Sign In'}
          </button>

          {oidcConfig && oidcConfig.enabled && !oidcConfig.enterpriseRequired && (
            <button
              type="button"
              onClick={() => {
                window.location.href = '/api/auth/oidc/authorize';
              }}
              data-testid="sso-login-btn"
              className="w-full rounded-lg border border-border/40 bg-card/30 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-card/60"
            >
              Sign in with {oidcConfig.name || 'SSO'}
            </button>
          )}
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            onClick={() => setIsRegister(!isRegister)}
            className="text-action hover:underline"
          >
            {isRegister ? 'Sign in' : 'Create one'}
          </button>
        </p>
      </div>
    </div>
  );
}
