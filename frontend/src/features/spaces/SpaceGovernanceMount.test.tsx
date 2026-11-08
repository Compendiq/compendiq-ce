import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpaceSettingsPage } from './SpaceSettingsPage';

const state = vi.hoisted(() => ({ entitled: true, api: vi.fn() }));
vi.mock('../../shared/enterprise/use-enterprise', () => ({ useEnterprise: () => ({ isEnterprise: state.entitled, hasFeature: () => state.entitled, license: null }) }));
vi.mock('../../shared/lib/api', () => ({ apiFetch: state.api }));
vi.mock('../../shared/hooks/use-standalone', () => ({ useLocalSpaces: () => ({ data: [] }), useUpdateLocalSpace: () => ({}), useDeleteLocalSpace: () => ({}) }));
function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/spaces/CONFLUENCE/settings']}><Routes><Route path="/spaces/:key/settings" element={<SpaceSettingsPage />} /></Routes></MemoryRouter>
  </QueryClientProvider>);
}
beforeEach(() => { state.entitled = true; state.api.mockReset(); });
describe('mounted nonlocal space governance', () => {
  it('loads backend space capability without requiring a local-space row and respects closed readiness', async () => {
    state.api.mockResolvedValue({ ok: true, spaceKey: 'CONFLUENCE', defaultAiPolicy: 'none', effectiveCreationDefault: 'none', revision: '44', entitled: true, canManage: true, enforcementAvailable: false });
    mount();
    await screen.findByLabelText('Creation policy');
    expect(state.api).toHaveBeenCalledWith('/admin/spaces/CONFLUENCE/default-ai-policy');
    expect(screen.getByText('Preview subtree')).toBeInTheDocument();
    const select = screen.getByLabelText('Creation policy');
    expect(select.querySelector('option[value="none"]')).toBeDisabled();
    fireEvent.change(select, { target: { value: 'all' } });
    expect(screen.getByText('Save creation default')).toBeEnabled();
  });
  it('does not fetch or mount enterprise controls in CE', () => {
    state.entitled = false;
    mount();
    expect(state.api).not.toHaveBeenCalled();
    expect(screen.queryByText('Preview subtree')).not.toBeInTheDocument();
  });
});
