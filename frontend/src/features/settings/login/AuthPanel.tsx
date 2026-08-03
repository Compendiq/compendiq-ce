import { useEffect, useRef, type FormEvent, type RefObject } from 'react';
import type { OidcConfig } from '@compendiq/contracts';
import { ArrowRight, Eye, EyeOff, LoaderCircle } from 'lucide-react';

/**
 * Outcome of the `GET /auth/oidc/config` probe. Like the `vision` tri-state on
 * the AI composers, this must never collapse to "config or null": a *failed*
 * probe is not the same answer as "SSO is disabled". Reporting a dead backend
 * as "no SSO here" silently removes the only sign-in path on an SSO-only
 * deployment, and reads to the user as if the button had been deleted.
 *
 * `failed` carries its own in-flight flag rather than dropping back to
 * `pending`: a recheck has to keep the notice — and the button the user just
 * pressed — mounted. Only the first probe of a page load renders nothing.
 */
export type OidcProbe =
  | { status: 'pending' }
  | { status: 'ready'; config: OidcConfig }
  | { status: 'failed'; retrying: boolean };

export interface AuthPanelProps {
  usernameInputRef: RefObject<HTMLInputElement | null>;
  isRegister: boolean;
  username: string;
  password: string;
  confirmPassword: string;
  showPassword: boolean;
  confirmError: string | null;
  loading: boolean;
  oidcProbe: OidcProbe;
  onRetryOidc: () => void;
  /**
   * True once `GET /auth/login-page-config` — an unrelated core route on the
   * same upstream — has failed too. That is what separates "nothing responded"
   * from "the SSO route specifically failed", and it decides which of the two
   * notices is honest: a CE deployment that has never had SSO should not be
   * told its single sign-on is unavailable when the real answer is that the
   * whole API is down.
   */
  serverUnreachable: boolean;
  allowRegistration: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onShowPasswordChange: (show: boolean) => void;
  onModeChange: (register: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function AuthPanel({
  usernameInputRef,
  isRegister,
  username,
  password,
  confirmPassword,
  showPassword,
  confirmError,
  loading,
  oidcProbe,
  onRetryOidc,
  serverUnreachable,
  allowRegistration,
  onUsernameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onShowPasswordChange,
  onModeChange,
  onSubmit,
}: AuthPanelProps) {
  // Non-null exactly when the SSO button should render, so the JSX below keeps
  // its narrowing instead of re-testing the same two fields.
  const ssoConfig =
    oidcProbe.status === 'ready' && oidcProbe.config.enabled && !oidcProbe.config.enterpriseRequired
      ? oidcProbe.config
      : null;
  const showSso = ssoConfig !== null;
  const probeFailed = oidcProbe.status === 'failed';
  const rechecking = oidcProbe.status === 'failed' && oidcProbe.retrying;

  const ssoButtonRef = useRef<HTMLButtonElement>(null);
  const recheckRequestedRef = useRef(false);

  // A successful recheck replaces the button the user just pressed with the SSO
  // button. Without moving focus onto the replacement it falls back to <body>,
  // and a keyboard user has to tab in from the top of the page to reach the
  // control they just recovered.
  useEffect(() => {
    if (showSso && recheckRequestedRef.current) {
      recheckRequestedRef.current = false;
      ssoButtonRef.current?.focus();
    }
  }, [showSso]);

  function handleRecheck() {
    recheckRequestedRef.current = true;
    onRetryOidc();
  }

  const noticeHeading = serverUnreachable
    ? 'Cannot reach the server'
    : 'Single sign-on status unavailable';
  const noticeBody = serverUnreachable
    ? 'Nothing on the API responded, so we cannot tell whether single sign-on is configured here. Credential sign-in will likely fail too until the server is back.'
    : 'The single sign-on check did not complete, so we cannot tell whether it is configured here.';

  return (
    <section className="nm-card-elevated w-full max-w-md p-6 sm:p-8" aria-labelledby="auth-panel-title">
      {/*
        Mounted from the first render on purpose: a live region is announced
        when its *contents* change, and assistive tech is inconsistent about
        regions inserted together with their text. Wording deliberately differs
        from the visible notice so the two never read as one duplicated string.
      */}
      <div role="status" aria-live="polite" data-testid="sso-status-announcer" className="sr-only">
        {probeFailed && !rechecking
          ? `${noticeHeading}. You can still sign in with credentials below.`
          : ''}
      </div>

      <div className="mb-7">
        <p className="mb-2 text-sm font-semibold text-primary-ink">
          {isRegister ? 'New workspace account' : 'Welcome back'}
        </p>
        <h2 id="auth-panel-title" className="font-display text-2xl font-semibold tracking-[-0.02em] text-foreground">
          {isRegister ? 'Create your account' : 'Sign in to Compendiq'}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {isRegister
            ? 'Use the credentials your workspace administrator expects.'
            : 'Continue to your connected knowledge workspace.'}
        </p>
      </div>

      {(ssoConfig || probeFailed) && (
        <>
          {ssoConfig ? (
            <button
              ref={ssoButtonRef}
              type="button"
              onClick={() => {
                window.location.href = '/api/auth/oidc/authorize';
              }}
              data-testid="sso-login-btn"
              className="nm-button-primary flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-semibold"
            >
              Sign in with {ssoConfig.name || 'SSO'}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : (
            <div data-testid="sso-probe-failed" className="rounded-lg border border-border p-4">
              <p className="text-sm font-medium text-foreground">{noticeHeading}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{noticeBody}</p>
              <button
                type="button"
                onClick={handleRecheck}
                disabled={rechecking}
                aria-busy={rechecking}
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-sm text-sm font-semibold text-primary-ink underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring enabled:hover:underline disabled:cursor-not-allowed disabled:opacity-70"
              >
                {rechecking && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
                {rechecking ? 'Checking…' : 'Check again'}
              </button>
            </div>
          )}

          <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            <span>or continue with credentials</span>
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
        </>
      )}

      <form onSubmit={onSubmit} className="space-y-5">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <label htmlFor="login-username" className="text-sm font-medium text-foreground">
              Username
            </label>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Press <kbd className="font-mono text-foreground">/</kbd> to focus
            </span>
          </div>
          <input
            ref={usernameInputRef}
            id="login-username"
            type="text"
            required
            minLength={isRegister ? 3 : undefined}
            autoComplete="username"
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder="Enter username"
            className="nm-input min-h-11 w-full px-3.5 text-sm"
          />
        </div>

        <div>
          <label htmlFor="login-password" className="mb-2 block text-sm font-medium text-foreground">
            Password
          </label>
          <div className="relative">
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              required
              minLength={isRegister ? 8 : undefined}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="Enter password"
              className="nm-input min-h-11 w-full px-3.5 pr-12 text-sm"
            />
            <button
              type="button"
              onClick={() => onShowPasswordChange(!showPassword)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
              className="absolute right-0 top-0 flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
            >
              {showPassword ? (
                <EyeOff aria-hidden="true" className="h-4 w-4" />
              ) : (
                <Eye aria-hidden="true" className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {isRegister && (
          <div>
            <label htmlFor="login-confirm-password" className="mb-2 block text-sm font-medium text-foreground">
              Confirm password
            </label>
            <input
              id="login-confirm-password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => onConfirmPasswordChange(event.target.value)}
              placeholder="Confirm password"
              aria-invalid={Boolean(confirmError)}
              aria-describedby={confirmError ? 'confirm-password-error' : 'password-requirements'}
              className="nm-input min-h-11 w-full px-3.5 text-sm"
            />
            {confirmError ? (
              <p id="confirm-password-error" className="mt-2 text-sm font-medium text-destructive" role="alert">
                {confirmError}
              </p>
            ) : (
              <p id="password-requirements" className="mt-2 text-xs text-muted-foreground">
                At least 8 characters
              </p>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="nm-button-primary flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <>
              <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
              Processing…
            </>
          ) : isRegister ? (
            'Create Account'
          ) : (
            <>
              Sign in
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </>
          )}
        </button>
      </form>

      {allowRegistration && (
        <p className="mt-6 text-center text-sm text-muted-foreground">
          {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button
            type="button"
            onClick={() => onModeChange(!isRegister)}
            className="rounded-sm font-semibold text-primary-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {isRegister ? 'Sign in' : 'Create one'}
          </button>
        </p>
      )}
    </section>
  );
}
