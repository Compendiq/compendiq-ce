import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

interface HealthResponse {
  status?: string;
  version?: string;
  edition?: string;
  commit?: string;
  builtAt?: string;
}

function useBackendBuildInfo() {
  return useQuery<HealthResponse>({
    queryKey: ['backend', 'build-info'],
    // /api/health is public (no auth) and cheap — it's what compose
    // healthchecks hit. We read it once to surface build metadata.
    queryFn: async () => {
      const response = await fetch('/api/health');
      // 200 (ok) and 503 (degraded) both carry the version payload.
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
            <span>Edition</span>
            <span className="font-mono" data-testid="app-edition">{editionLabel}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Backend commit</span>
            <span className="font-mono" data-testid="backend-commit">
              {backendBuild?.commit ?? '…'}
            </span>
          </div>
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
