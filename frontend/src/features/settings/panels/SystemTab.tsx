import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LoginPageConfigResponseSchema,
  LoginPageConfigSchema,
  type LoginPageConfigResponse,
  type LoginPageVariant,
} from '@compendiq/contracts';
import { toast } from 'sonner';
import { useAuthStore } from '../../../stores/auth-store';
import { apiFetch } from '../../../shared/lib/api';
import { CollabEditingCard } from '../CollabEditingCard';

interface HealthResponse {
  status?: string;
  version?: string;
  edition?: string;
  commit?: string;
  ceCommit?: string;
  builtAt?: string;
}

function useBackendBuildInfo() {
  return useQuery<HealthResponse>({
    queryKey: ['backend', 'build-info'],
    // #1052: /api/health now returns build metadata only to an authenticated
    // admin (anonymous callers get a coarse `{ status }`). This Diagnostics
    // page is admin-only, so attach the access token. 200 (ok) and 503
    // (degraded) both carry the payload, so keep the raw fetch (a helper that
    // threw on 503 would drop the build info during an outage).
    queryFn: async () => {
      const { accessToken } = useAuthStore.getState();
      const response = await fetch('/api/health', {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        credentials: 'include',
      });
      return response.json() as Promise<HealthResponse>;
    },
    staleTime: 60_000,
  });
}

function useLoginPageConfig() {
  // Response schema on the GET, request schema on the PUT — one schema per
  // direction. This panel only reads `variant`; `edition` rides along for the
  // login page's badge and is simply ignored here.
  return useQuery<LoginPageConfigResponse>({
    queryKey: ['login-page-config'],
    queryFn: async () =>
      LoginPageConfigResponseSchema.parse(await apiFetch('/auth/login-page-config')),
    staleTime: 30_000,
  });
}

export function SystemTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: backendBuild } = useBackendBuildInfo();
  const {
    data: loginPageConfig,
    isLoading: loginPageConfigLoading,
    isError: loginPageConfigError,
    refetch: refetchLoginPageConfig,
  } = useLoginPageConfig();
  const [selectedLoginVariant, setSelectedLoginVariant] = useState<LoginPageVariant>('local-loop');

  useEffect(() => {
    if (loginPageConfig) setSelectedLoginVariant(loginPageConfig.variant);
  }, [loginPageConfig]);

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

  function handleRerunSetup() {
    // Invalidate setup status cache so the wizard re-checks
    queryClient.invalidateQueries({ queryKey: ['setup-status'] });
    navigate('/setup?rerun=true');
  }

  const editionLabel = (backendBuild?.edition ?? __APP_EDITION__) === 'enterprise'
    ? 'Enterprise (EE)'
    : 'Community (CE)';

  return (
    <div className="space-y-6">
      <section aria-labelledby="login-experience-heading">
        <h3 id="login-experience-heading" className="text-base font-semibold">
          Login experience
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
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span>
                  <span className="block text-sm font-semibold text-foreground">Local Loop</span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    Explains the path from connected knowledge to a sourced answer.
                  </span>
                </span>
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
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span>
                  <span className="block text-sm font-semibold text-foreground">Change Desk</span>
                  <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                    Shows how source material can become a clearer working page.
                  </span>
                </span>
              </label>
            </fieldset>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => updateLoginPageConfig.mutate(selectedLoginVariant)}
                disabled={
                  updateLoginPageConfig.isPending ||
                  selectedLoginVariant === loginPageConfig?.variant
                }
                className="nm-button-primary px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="apply-login-page-variant"
              >
                {updateLoginPageConfig.isPending ? 'Applying…' : 'Apply login design'}
              </button>
              <span className="text-xs text-muted-foreground">
                Applies to all visitors on their next login-page load.
              </span>
            </div>
          </>
        )}
      </section>

      <CollabEditingCard />

      <div>
        <h3 className="text-base font-semibold">Setup Wizard</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Re-run the initial setup wizard to reconfigure core settings like admin account, LLM provider, and Confluence connection.
        </p>
        <button
          onClick={handleRerunSetup}
          className="nm-button-ghost mt-3 px-4 py-2 text-sm"
          data-testid="rerun-setup-btn"
        >
          Re-run Setup Wizard
        </button>
      </div>

      <div className="border-t border-border pt-6">
        <h3 className="text-base font-semibold">Application Info</h3>
        <div className="mt-3 space-y-2 text-sm text-muted-foreground" data-testid="application-info">
          <div className="flex items-center justify-between">
            <span>Version</span>
            <span className="font-mono" data-testid="app-version">{__APP_VERSION__}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Build edition</span>
            <span className="font-mono" data-testid="app-edition">{editionLabel}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Backend commit</span>
            <span className="font-mono" data-testid="backend-commit">
              {backendBuild?.commit ?? '…'}
            </span>
          </div>
          {backendBuild?.ceCommit && (
            <div className="flex items-center justify-between">
              <span>Backend CE commit</span>
              <span className="font-mono" data-testid="backend-ce-commit">
                {backendBuild.ceCommit}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span>Frontend commit</span>
            <span className="font-mono" data-testid="frontend-commit">{__APP_COMMIT__}</span>
          </div>
          {backendBuild?.builtAt && (
            <div className="flex items-center justify-between">
              <span>Backend built at</span>
              <span className="font-mono text-xs" data-testid="backend-built-at">
                {backendBuild.builtAt}
              </span>
            </div>
          )}
          {__APP_BUILT_AT__ && (
            <div className="flex items-center justify-between">
              <span>Frontend built at</span>
              <span className="font-mono text-xs" data-testid="frontend-built-at">
                {__APP_BUILT_AT__}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
