import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArticleAiPolicySection } from './ArticleAiPolicySection';
import { ProviderEditModal } from '../../../features/settings/panels/ProviderEditModal';

const detail = { id: '7', aiPolicy: 'all', aiPolicyRevision: 2, canChangeAiPolicy: true, aiPolicyActivation: 'active' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
  return client;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('mounted article AI policy', () => {
  it('requires explicit capability and active enforcement', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ ...detail, canChangeAiPolicy: false }));
    mount(<ArticleAiPolicySection pageId="7" />);
    await screen.findByTestId('ai-policy-chip');
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('retains selection after 409 and submits the reviewed revision', async () => {
    let revision = 2;
    const writes: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        if (writes.length === 1) { revision = 3; return json({ error: 'ai_policy_conflict' }, 409); }
        return json({ pageId: 7, aiPolicy: 'local_only', aiPolicyRevision: 4 });
      }
      return json({ ...detail, aiPolicyRevision: revision });
    });
    mount(<ArticleAiPolicySection pageId="7" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'local_only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await screen.findByText(/Policy was not saved. Refresh/);
    expect(screen.getByRole('combobox')).toHaveValue('local_only');
    expect(screen.getByTestId('ai-policy-chip')).toHaveTextContent('All AI allowed');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh / review policy' }));
    await screen.findByText(/Current policy refreshed/);
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(writes).toEqual([
      { aiPolicy: 'local_only', expectedRevision: 2 }, { aiPolicy: 'local_only', expectedRevision: 3 },
    ]));
  });

  it('confirms real no-AI removals before sending a mutation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(detail));
    mount(<ArticleAiPolicySection pageId="7" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Historical conversations are not erased');
    expect(dialog).toHaveTextContent('original attachments');
    expect(dialog).toHaveTextContent('cannot be recalled');
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  });
});

describe('mounted provider locality declaration', () => {
  it('defaults external even for loopback and clears Local on endpoint edits', async () => {
    const saved = vi.fn();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => json({ ...JSON.parse(String(init?.body)), id: 'provider' }));
    mount(<ProviderEditModal mode="create" open onClose={() => {}} onSaved={saved} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Local model' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:1234/v1' } });
    expect(screen.getByRole('radio', { name: 'External' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Local / On-premise' }));
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://localhost:4321/v1' } });
    expect(screen.getByRole('radio', { name: 'External' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ locality: 'external' });
  });
});
