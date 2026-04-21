import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProviderListSection } from './ProviderListSection';
import { useAuthStore } from '../../../stores/auth-store';

function createWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const providerA = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  authType: 'bearer' as const,
  verifySsl: true,
  defaultModel: 'qwen3:4b',
  isDefault: true,
  hasApiKey: false,
  keyPreview: null,
  createdAt: '2026-04-20T00:00:00.000Z',
  updatedAt: '2026-04-20T00:00:00.000Z',
};
const providerB = { ...providerA, id: '22222222-2222-2222-2222-222222222222', name: 'OpenAI', isDefault: false };

function mockFetchJson(responses: Array<{ match: (url: string, init: RequestInit) => boolean; body: unknown; status?: number }>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const handler = responses.find((r) => r.match(url, init as RequestInit));
    if (!handler) {
      return new Response(JSON.stringify({ message: `unmocked ${url}` }), { status: 404 });
    }
    return new Response(JSON.stringify(handler.body), {
      status: handler.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('ProviderListSection', () => {
  beforeEach(() => {
    useAuthStore.getState().setAuth('test-token', {
      id: '1',
      username: 'admin',
      role: 'admin',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders providers list with default badge', async () => {
    const Wrapper = createWrapper();
    mockFetchJson([
      { match: (url, init) => url.endsWith('/admin/llm-providers') && (init.method ?? 'GET') === 'GET', body: [providerA, providerB] },
    ]);
    render(<ProviderListSection />, { wrapper: Wrapper });
    await screen.findByText('Ollama');
    expect(screen.getByText('OpenAI')).toBeTruthy();
    // The default badge is a <span>; there's only one in the list.
    expect(screen.getByText(/^default$/i)).toBeTruthy();
  });

  it('delete button disabled for default provider, enabled for non-default', async () => {
    const Wrapper = createWrapper();
    mockFetchJson([
      { match: (url, init) => url.endsWith('/admin/llm-providers') && (init.method ?? 'GET') === 'GET', body: [providerA, providerB] },
    ]);
    render(<ProviderListSection />, { wrapper: Wrapper });
    await screen.findByText('Ollama');
    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
    expect(deleteButtons).toHaveLength(2);
    expect((deleteButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((deleteButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('Add button opens create modal', async () => {
    const Wrapper = createWrapper();
    mockFetchJson([
      { match: (url, init) => url.endsWith('/admin/llm-providers') && (init.method ?? 'GET') === 'GET', body: [] },
    ]);
    render(<ProviderListSection />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: /\+ add/i }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/add provider/i)).toBeTruthy();
  });

  it('set-default mutation POSTs to correct endpoint', async () => {
    const Wrapper = createWrapper();
    const spy = mockFetchJson([
      { match: (url, init) => url.endsWith('/admin/llm-providers') && (init.method ?? 'GET') === 'GET', body: [providerA, providerB] },
      { match: (url, init) => url.includes('/set-default') && init.method === 'POST', body: { ok: true } },
    ]);
    render(<ProviderListSection />, { wrapper: Wrapper });
    await screen.findByText('OpenAI');
    const setDefaultButtons = screen.getAllByRole('button', { name: /set default/i });
    // providerB (index 1) is non-default → button enabled
    fireEvent.click(setDefaultButtons[1]);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining(`/admin/llm-providers/${providerB.id}/set-default`),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  it('test button POSTs to /test endpoint', async () => {
    const Wrapper = createWrapper();
    const spy = mockFetchJson([
      { match: (url, init) => url.endsWith('/admin/llm-providers') && (init.method ?? 'GET') === 'GET', body: [providerA] },
      { match: (url, init) => url.includes('/test') && init.method === 'POST', body: { connected: true, sampleModelsCount: 5 } },
    ]);
    render(<ProviderListSection />, { wrapper: Wrapper });
    await screen.findByText('Ollama');
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining(`/admin/llm-providers/${providerA.id}/test`),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
