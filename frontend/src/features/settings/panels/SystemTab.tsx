import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../../../stores/auth-store';

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

export function SystemTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: backendBuild } = useBackendBuildInfo();

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

      <div className="border-t border-border/40 pt-6">
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
