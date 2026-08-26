import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientInferenceTab } from './ClientInferenceTab';

const apiFetch = vi.fn();

vi.mock('../../../shared/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

vi.mock('../../../shared/lib/client-inference/client-inference-manager', () => ({
  getClientInferenceManager: () => ({
    lastProbe: () => null,
    lastErrorCategory: () => null,
  }),
}));

function renderTab(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ClientInferenceTab />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('ClientInferenceTab', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it('invalidates the manifest after the admin flag is saved', async () => {
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/admin/settings' && init?.method === 'PUT') return {};
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      if (path === '/models/client-assets') {
        return {
          enabled: false,
          models: [{
            id: 'qwen2.5-0.5b-instruct-q4',
            kind: 'onnx',
            bytes: 0,
            installed: false,
            available: false,
            files: [],
          }],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    const client = renderTab();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByText('qwen2.5-0.5b-instruct-q4');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable on-device suggestions' }));
    await waitFor(() => {
      const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]));
      expect(keys.some((k) => k.includes('admin-settings'))).toBe(true);
      expect(keys.some((k) => k.includes('client-assets-manifest'))).toBe(true);
    });
  });

  it('says the list could not be read instead of rendering an empty volume', async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/admin/settings') return { clientInferenceEnabled: false };
      throw new Error('boom');
    });
    renderTab();
    expect(await screen.findByText(/could not read installed assets/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
