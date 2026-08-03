import type { FormEvent, RefObject } from 'react';
import type { OidcConfig } from '@compendiq/contracts';
import { ArrowRight, Eye, EyeOff, LoaderCircle } from 'lucide-react';

/**
 * Outcome of the `GET /auth/oidc/config` probe. Like the `vision` tri-state on
 * the AI composers, this must never collapse to "config or null": a *failed*
 * probe is not the same answer as "SSO is disabled". Reporting a dead backend
 * as "no SSO here" silently removes the only sign-in path on an SSO-only
 * deployment, and reads to the user as if the button had been deleted.
 */
export type OidcProbe =
  | { status: 'pending' }
  | { status: 'ready'; config: OidcConfig }
  | { status: 'failed' };

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
  allowRegistration,
  onUsernameChange,
  onPasswordChange,
  onConfirmPasswordChange,
  onShowPasswordChange,
  onModeChange,
  onSubmit,
}: AuthPanelProps) {
  const oidcConfig = oidcProbe.status === 'ready' ? oidcProbe.config : null;
  const showSso = oidcConfig?.enabled && !oidcConfig.enterpriseRequired;

  return (
    <section className="nm-card-elevated w-full max-w-md p-6 sm:p-8" aria-labelledby="auth-panel-title">
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

      {(showSso || oidcProbe.status === 'failed') && (
        <>
          {showSso ? (
            <button
              type="button"
              onClick={() => {
                window.location.href = '/api/auth/oidc/authorize';
              }}
              data-testid="sso-login-btn"
              className="nm-button-primary flex min-h-11 w-full items-center justify-center gap-2 px-4 text-sm font-semibold"
            >
              Sign in with {oidcConfig.name || 'SSO'}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </button>
          ) : (
            <div
              role="status"
              data-testid="sso-probe-failed"
              className="rounded-lg border border-border p-4"
            >
              <p className="text-sm font-medium text-foreground">Single sign-on status unavailable</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                The server did not respond, so we cannot tell whether SSO is configured here.
              </p>
              <button
                type="button"
                onClick={onRetryOidc}
                className="mt-3 rounded-sm text-sm font-semibold text-primary-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Check again
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
