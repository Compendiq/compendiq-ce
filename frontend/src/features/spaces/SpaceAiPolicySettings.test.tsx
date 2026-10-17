import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpaceAiPolicySettings } from './SpaceAiPolicySettings';

const state = vi.hoisted(() => ({ enterprise: true, entitled: true, canUpdate: false, api: vi.fn() }));
vi.mock('../../shared/enterprise/use-enterprise', () => ({
  useEnterprise: () => ({ isEnterprise: state.enterprise, hasFeature: () => state.entitled, license: { canUpdate: state.canUpdate } }),
}));
vi.mock('../../shared/lib/api', () => ({ apiFetch: state.api }));
const settings = { ok: true, spaceKey: 'ENG', defaultAiPolicy: 'none', effectiveCreationDefault: 'none', revision: '123', entitled: true, canManage: true, enforcementAvailable: true };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => <QueryClientProvider client={client}><SpaceAiPolicySettings spaceKey="ENG" /></QueryClientProvider>;
  const view = render(ui());
  return () => view.rerender(ui());
}
beforeEach(() => { state.canUpdate = false; state.enterprise = true; state.entitled = true; state.api.mockReset(); state.api.mockResolvedValue(settings); });
describe('space AI creation default', () => {
  it('previews and confirms the exact owner set and discards a refused preview', async () => {
    mount();
    await screen.findByText('Preview subtree');
    fireEvent.change(screen.getByLabelText('Standalone root article ID'), { target: { value: '7' } });
    state.api.mockResolvedValueOnce({ ok: true, rootId: 7, policy: 'all', scope: 'owned_standalone', limitation: 'Other owners excluded', items: [{ pageId: 7, policy: 'none', revision: 3 }] });
    fireEvent.click(screen.getByText('Preview subtree'));
    await screen.findByText('Confirm subtree policy');
    expect(screen.getByText(/1 owned articles will change/)).toBeInTheDocument();
    state.api.mockRejectedValueOnce(new Error('409 stale_set'));
    fireEvent.click(screen.getByText('Confirm subtree policy'));
    await screen.findByText(/No cascade was applied/);
    expect(state.api).toHaveBeenCalledWith('/pages/7/ai-policy/cascade', { method: 'POST', body: JSON.stringify({ policy: 'all', items: [{ pageId: 7, expectedRevision: 3 }] }) });
    expect(screen.queryByText('Confirm subtree policy')).not.toBeInTheDocument();
  });
  it('is inert in CE', () => {
    state.enterprise = false;
    mount();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(state.api).not.toHaveBeenCalled();
  });
  it('sends the displayed revision, retains a choice on conflict, and disables writes on license loss', async () => {
    const rerender = mount();
    const select = await screen.findByRole('combobox', { name: 'Creation policy' });
    fireEvent.change(select, { target: { value: 'all' } });
    state.api.mockRejectedValueOnce(new Error('409'));
    fireEvent.click(screen.getByText('Save creation default'));
    await screen.findByRole('alert');
    expect(state.api).toHaveBeenCalledWith('/admin/spaces/ENG/default-ai-policy', { method: 'PUT', body: JSON.stringify({ policy: 'all', expectedRevision: '123' }) });
    expect(select).toHaveValue('all');
    state.entitled = false;
    state.enterprise = false;
    state.canUpdate = true;
    state.api.mockResolvedValue({ ...settings, entitled: false, canManage: false, effectiveCreationDefault: 'all' });
    rerender();
    expect(screen.getByText(/saved default is inactive/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Save creation default')).toBeDisabled());
    expect(screen.getByText(/Effective creation default: All AI allowed/)).toBeInTheDocument();
  });
  it('does not allow mutation when settings cannot be read', async () => {
    state.api.mockRejectedValue(new Error('unavailable'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Current settings are unavailable');
    expect(screen.queryByText('Save creation default')).not.toBeInTheDocument();
  });
});
