import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { OidcConfigSchema, type OidcConfig, RegistrationPolicySchema } from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { apiFetch } from '../../shared/lib/api';

/**
 * Friendly copy for the OIDC/OAuth2 error codes an IdP may append to the
 * post-redirect URL (?error=...). We map known codes and fall back to a
 * generic message rather than echoing the raw param, which is
 * attacker-controllable.
 */
const OIDC_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'SSO sign-in was cancelled or denied.',
  login_required: 'SSO sign-in could not be completed. Please try again.',
  interaction_required: 'SSO sign-in could not be completed. Please try again.',
  consent_required: 'Additional consent is required to sign in via SSO.',
  server_error: 'The SSO provider reported an error. Please try again later.',
  temporarily_unavailable: 'SSO is temporarily unavailable. Please try again later.',
};

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oidcConfig, setOidcConfig] = useState<OidcConfig | null>(null);
  // #1051 — fail closed: hide the signup toggle until the server confirms
  // registration is allowed. A fetch/parse failure leaves it hidden.
  const [allowRegistration, setAllowRegistration] = useState(false);

  useEffect(() => {
    const searchError = searchParams.get('error');
    if (searchError) {
      toast.error(
        OIDC_ERROR_MESSAGES[searchError] ?? 'SSO sign-in failed. Please try again or use local login.',
      );
      // Clear the error param so a refresh doesn't re-trigger the toast.
      navigate('/login', { replace: true });
    }
  }, [searchParams, navigate]);

  useEffect(() => {
    async function fetchOidcConfig() {
      try {
        const config = OidcConfigSchema.parse(await apiFetch('/auth/oidc/config'));
        setOidcConfig(config);
      } catch {
        // No/invalid config (e.g. the OIDC route is absent in CE) — leave the SSO button hidden.
      }
    }
    fetchOidcConfig();
  }, []);

  useEffect(() => {
    async function fetchRegistrationPolicy() {
      try {
        const policy = RegistrationPolicySchema.parse(await apiFetch('/auth/registration-policy'));
        setAllowRegistration(policy.allowRegistration);
      } catch {
        // Fail closed — a fetch/parse failure keeps the signup toggle hidden.
      }
    }
    fetchRegistrationPolicy();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();

    // #1051 — refuse to submit a registration the server has disabled. The
    // toggle is normally hidden, but this guards against a stale UI state.
    if (isRegister && !allowRegistration) {
      toast.error('Registration is disabled');
      return;
    }

    // Client-side confirmation check (register mode only) — block the
    // request entirely on mismatch.
    if (isRegister && password !== confirmPassword) {
      setConfirmError("Passwords don't match");
      return;
    }
    setConfirmError(null);
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
          {oidcConfig && oidcConfig.enabled && !oidcConfig.enterpriseRequired && (
            <>
              <button
                type="button"
                onClick={() => {
                  window.location.href = '/api/auth/oidc/authorize';
                }}
                data-testid="sso-login-btn"
                className="nm-button-primary w-full py-2.5"
              >
                Sign in with {oidcConfig.name || 'SSO'}
              </button>

              <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border/40" />
                <span>or continue with credentials</span>
                <div className="h-px flex-1 bg-border/40" />
              </div>
            </>
          )}

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
              onChange={(e) => {
                setPassword(e.target.value);
                setConfirmError(null);
              }}
              required
              minLength={8}
              className="nm-input"
              placeholder="Enter password"
            />
            {isRegister && (
              <p className="mt-1.5 text-xs text-muted-foreground">At least 8 characters</p>
            )}
          </div>

          {isRegister && (
            <div>
              <label htmlFor="login-confirm-password" className="mb-1.5 block text-sm font-medium">Confirm password</label>
              <input
                id="login-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  setConfirmError(null);
                }}
                required
                minLength={8}
                className="nm-input"
                placeholder="Re-enter password"
              />
              {confirmError && (
                <p role="alert" className="mt-1.5 text-xs text-red-500">{confirmError}</p>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="nm-button-ghost w-full py-2.5"
          >
            {loading ? 'Loading...' : isRegister ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        {allowRegistration && (
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              onClick={() => {
                setIsRegister(!isRegister);
                setConfirmPassword('');
                setConfirmError(null);
              }}
              className="text-action hover:underline"
            >
              {isRegister ? 'Sign in' : 'Create one'}
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
