import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EnterpriseProvider } from './context';
import { useEnterprise } from './use-enterprise';
import { _resetForTesting } from './loader';

// Mock the auth store (required by apiFetch)
vi.mock('../../stores/auth-store', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        accessToken: 'test-token',
        setAuth: vi.fn(),
        clearAuth: vi.fn(),
      }),
    {
      getState: () => ({
        accessToken: 'test-token',
        setAuth: vi.fn(),
        clearAuth: vi.fn(),
      }),
    },
  ),
}));

function TestConsumer() {
  const { ui, license, isEnterprise, hasFeature, isLoading } = useEnterprise();
  return (
    <div>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="enterprise">{String(isEnterprise)}</span>
      <span data-testid="ui">{ui === null ? 'null' : 'loaded'}</span>
      <span data-testid="license">{license === null ? 'null' : license.tier}</span>
      <span data-testid="has-oidc">{String(hasFeature('oidc_sso'))}</span>
    </div>
  );
}

describe('EnterpriseProvider (community mode)', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve to community mode when enterprise package is not installed', async () => {
    render(
      <EnterpriseProvider>
        <TestConsumer />
      </EnterpriseProvider>,
    );

    // Initially loading
    expect(screen.getByTestId('loading').textContent).toBe('true');

    // Wait for loading to complete
    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('enterprise').textContent).toBe('false');
    expect(screen.getByTestId('ui').textContent).toBe('null');
    expect(screen.getByTestId('license').textContent).toBe('null');
    expect(screen.getByTestId('has-oidc').textContent).toBe('false');
  });

  it('hasFeature should return false for all features in community mode', async () => {
    render(
      <EnterpriseProvider>
        <TestConsumer />
      </EnterpriseProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    expect(screen.getByTestId('has-oidc').textContent).toBe('false');
  });

  it('should not make API calls in community mode (no enterprise UI loaded)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(
      <EnterpriseProvider>
        <TestConsumer />
      </EnterpriseProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });

    // In community mode, loadEnterpriseUI returns null, so no API call to /admin/license
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('useEnterprise outside provider', () => {
  it('should return default community values', () => {
    render(<TestConsumer />);

    // Without provider, uses default context values
    expect(screen.getByTestId('enterprise').textContent).toBe('false');
    expect(screen.getByTestId('ui').textContent).toBe('null');
    expect(screen.getByTestId('license').textContent).toBe('null');
    expect(screen.getByTestId('has-oidc').textContent).toBe('false');
  });
});
