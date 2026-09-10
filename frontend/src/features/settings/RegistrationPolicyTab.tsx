import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LoginPageConfigResponseSchema,
  LoginPageConfigSchema,
  type LoginPageConfigResponse,
  type LoginPageVariant,
} from '@compendiq/contracts';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';

type RegistrationMode = 'open' | 'closed';

interface AdminSettings {
  registrationMode?: RegistrationMode;
  [key: string]: unknown;
}

/**
 * Issue #1051 — deployment-level self-registration & login page presentation policy.
 *
 * CE-visible sub-tab (no EE gate) under Access Control. Controls whether
 * visitors can register accounts, and the landing-page design story they see.
 */
export function RegistrationPolicyTab() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading: isSettingsLoading } = useQuery<AdminSettings>({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch('/admin/settings'),
  });

  const {
    data: loginPageConfig,
    isLoading: loginPageConfigLoading,
    isError: loginPageConfigError,
    refetch: refetchLoginPageConfig,
  } = useQuery<LoginPageConfigResponse>({
    queryKey: ['login-page-config'],
    queryFn: async () =>
      LoginPageConfigResponseSchema.parse(await apiFetch('/auth/login-page-config')),
    staleTime: 30_000,
  });

  const [mode, setMode] = useState<RegistrationMode>('closed');
  const [selectedLoginVariant, setSelectedLoginVariant] = useState<LoginPageVariant>('local-loop');

  useEffect(() => {
    if (settings?.registrationMode) {
      setMode(settings.registrationMode);
    }
  }, [settings]);

  useEffect(() => {
    if (loginPageConfig) {
      setSelectedLoginVariant(loginPageConfig.variant);
    }
  }, [loginPageConfig]);

  const mutation = useMutation({
    mutationFn: (body: { registrationMode: RegistrationMode }) =>
      apiFetch('/admin/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      toast.success('Registration policy updated');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to update registration policy');
    },
  });

  const updateLoginPageConfig = useMutation({
    mutationFn: async (variant: LoginPageVariant) =>
      LoginPageConfigSchema.parse(
        await apiFetch('/admin/login-page-config', {
          method: 'PUT',
          body: JSON.stringify({ variant }),
        }),
      ),
    onSuccess: (config) => {
      queryClient.setQueryData(['login-page-config'], config);
      setSelectedLoginVariant(config.variant);
      toast.success('Login page design updated');
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not update the login page design');
    },
  });

  const savedMode: RegistrationMode = settings?.registrationMode ?? 'closed';
  const hasModeChanges = mode !== savedMode;

  const savedLoginVariant = loginPageConfig?.variant ?? 'local-loop';
  const hasLoginVariantChanges = selectedLoginVariant !== savedLoginVariant;

  function handleSaveMode() {
    mutation.mutate({ registrationMode: mode });
  }

  if (isSettingsLoading) {
    return <SkeletonFormFields />;
  }

  return (
    <div className="space-y-8">
      {/* Self-registration policy */}
      <section aria-labelledby="registration-policy-heading">
        <h3 id="registration-policy-heading" className="text-base font-semibold text-foreground">
          Self-registration Policy
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Control whether visitors can create their own accounts from the login screen.
          The first account is always allowed to register (initial setup); this setting
          only takes effect once an administrator exists.
        </p>

        <div className="mt-4 rounded-lg border border-border bg-background/50 p-4">
          <label htmlFor="registration-mode" className="mb-1.5 block text-sm font-medium text-foreground">
            Self-registration
          </label>
          <select
            id="registration-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as RegistrationMode)}
            className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            data-testid="registration-mode-select"
          >
            <option value="closed">Closed — only administrators can create accounts</option>
            <option value="open">Open — anyone can create their own account</option>
          </select>

          {mode === 'open' && (
            <div
              role="alert"
              data-testid="registration-open-warning"
              className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning"
            >
              <p className="font-semibold">Anyone who can reach this server can create an account.</p>
              <p className="mt-1">
                Self-registered users can sign in and can view and edit any shared standalone
                pages. Only enable open registration on trusted or internal networks.
              </p>
            </div>
          )}

          <div className="mt-4 flex items-center gap-3 border-t border-border pt-4">
            <button
              onClick={handleSaveMode}
              disabled={!hasModeChanges || mutation.isPending}
              className="nm-button-primary"
              data-testid="registration-policy-save-btn"
            >
              {mutation.isPending ? 'Saving...' : 'Save Registration Policy'}
            </button>
          </div>
        </div>
      </section>

      {/* Login Experience / Landing Page Design */}
      <section aria-labelledby="login-experience-heading" className="border-t border-border pt-6">
        <h3 id="login-experience-heading" className="text-base font-semibold text-foreground">
          Login Experience Design
        </h3>
        <p id="login-experience-description" className="mt-1 max-w-[70ch] text-sm leading-6 text-muted-foreground">
          Choose the landing-page story visitors see before signing in. This changes presentation only; credentials,
          registration, and SSO continue to use the same authentication flow.
        </p>

        {loginPageConfigLoading ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2" aria-label="Loading login page designs">
            <div className="h-24 animate-pulse rounded-lg bg-muted" />
            <div className="h-24 animate-pulse rounded-lg bg-muted" />
          </div>
        ) : loginPageConfigError ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm" role="alert">
            <span className="text-destructive">Couldn’t load the current login page design.</span>
            <button
              type="button"
              onClick={() => void refetchLoginPageConfig()}
              className="nm-button-ghost px-3 py-1.5 text-sm"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <fieldset
              className="mt-4 grid gap-3 sm:grid-cols-2"
              aria-describedby="login-experience-description"
            >
              <legend className="sr-only">Login page design</legend>
              <label
                className={`flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors ${
                  selectedLoginVariant === 'local-loop'
                    ? 'border-primary bg-primary/10'
                    : 'border-border-interactive bg-card hover:border-primary'
                }`}
              >
                <input
                  type="radio"
                  name="login-page-variant"
                  value="local-loop"
                  checked={selectedLoginVariant === 'local-loop'}
                  onChange={() => setSelectedLoginVariant('local-loop')}
                  className="mt-1 accent-primary"
                />
                <div>
                  <span className="text-sm font-medium text-foreground">Local Loop</span>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    A knowledge base designed for fast keyboard-driven search and immediate answers.
                  </p>
                </div>
              </label>

              <label
                className={`flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors ${
                  selectedLoginVariant === 'change-desk'
                    ? 'border-primary bg-primary/10'
                    : 'border-border-interactive bg-card hover:border-primary'
                }`}
              >
                <input
                  type="radio"
                  name="login-page-variant"
                  value="change-desk"
                  checked={selectedLoginVariant === 'change-desk'}
                  onChange={() => setSelectedLoginVariant('change-desk')}
                  className="mt-1 accent-primary"
                />
                <div>
                  <span className="text-sm font-medium text-foreground">Change Desk</span>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    A collaborative documentation system with real-time editing and change tracking.
                  </p>
                </div>
              </label>
            </fieldset>

            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={() => updateLoginPageConfig.mutate(selectedLoginVariant)}
                disabled={!hasLoginVariantChanges || updateLoginPageConfig.isPending}
                className="nm-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="apply-login-page-variant"
              >
                {updateLoginPageConfig.isPending ? 'Updating…' : 'Save Login Design'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
