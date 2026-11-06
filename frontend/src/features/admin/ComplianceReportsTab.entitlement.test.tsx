import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { LazyMotion, domMax } from 'framer-motion';
import { toast } from 'sonner';
import { EnterpriseContext } from '../../shared/enterprise/enterprise-context';
import type { LicenseInfo } from '../../shared/enterprise/types';
import { apiFetch } from '../../shared/lib/api';
import { ComplianceReportsTab } from './ComplianceReportsTab';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { vi.restoreAllMocks(); });

// Component integration, not a full-browser or signed-license runtime proof.
// Observe the same license query used by LicenseStatusCard and the provider.
function LicenseObserver() {
  const { data } = useQuery<LicenseInfo>({
    queryKey: ['admin', 'license'], queryFn: () => apiFetch('/admin/license'), staleTime: 60_000,
  });
  return <EnterpriseContext.Provider value={{
    ui: null, license: data ?? null, isLoading: !data,
    isEnterprise: data?.edition === 'enterprise' && data.valid,
    hasFeature: (feature) => data?.valid === true && data.features.includes(feature),
  }}><ComplianceReportsTab /></EnterpriseContext.Provider>;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><LazyMotion features={domMax}><LicenseObserver /></LazyMotion></QueryClientProvider>);
  return client;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('report access refresh after authoritative refusal', () => {
  it('withdraws stale available cards, refreshes license, and restores access without reload', async () => {
    let entitled = true;
    let generations = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/admin/license')) return json({ edition: entitled ? 'enterprise' : 'community', tier: entitled ? 'enterprise' : 'community', valid: true, features: entitled ? ['compliance_reports'] : [] });
      if (url.endsWith('/compliance-reports/generate')) {
        generations++;
        return json({ error: 'EnterpriseRequired', message: 'Live compliance_reports entitlement required' }, 403);
      }
      if (url.endsWith('/compliance-reports')) return entitled
        ? json({ catalogue: ['model_governance'], available: ['model_governance'] })
        : json({ error: 'EnterpriseRequired', message: 'Live compliance_reports entitlement required' }, 403);
      throw new Error(`Unexpected request: ${url}`);
    });
    mount();
    const button = await screen.findByTestId('generate-model_governance');
    expect(button).toBeEnabled();
    // Server changes while the tab's cached license/catalogue still allow access.
    entitled = false;
    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByTestId('generate-model_governance')).not.toBeInTheDocument());
    await screen.findByRole('status');
    expect(screen.queryByTestId('badge-available-model_governance')).not.toBeInTheDocument();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Live compliance_reports entitlement required'));
    expect(generations).toBe(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/admin/license')).length).toBeGreaterThan(1);
    entitled = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh report access' }));
    await waitFor(() => expect(screen.getByTestId('generate-model_governance')).toBeEnabled());
    expect(screen.getByTestId('badge-available-model_governance')).toHaveTextContent('Available');
  });

  it.each([
    [403, { error: 'Forbidden', message: 'Administrator authority required' }],
    [500, { error: 'InternalServerError', message: 'Evidence source unreadable' }],
    [403, null],
  ])('does not revoke features for other failures (%s, %j)', async (status, body) => {
    let licenseReads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/admin/license')) { licenseReads++; return json({ edition: 'enterprise', tier: 'enterprise', valid: true, features: ['compliance_reports'] }); }
      if (url.endsWith('/generate')) return body ? json(body, status) : new Response('Proxy forbidden', { status });
      return json({ catalogue: ['model_governance'], available: ['model_governance'] });
    });
    mount();
    fireEvent.click(await screen.findByTestId('generate-model_governance'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('generate-model_governance')).toBeEnabled());
    expect(screen.getByTestId('badge-available-model_governance')).toBeInTheDocument();
    expect(licenseReads).toBe(1);
  });
});
